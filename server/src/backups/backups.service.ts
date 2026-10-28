import { Controller, Get, HttpCode, Injectable, InternalServerErrorException, Logger, NotFoundException, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { execFile, spawn } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { loadConfig } from '../config/config';
import { sha256 } from '../common/crypto';
import { AuthUser, CurrentUser, RequirePermissions } from '../auth/auth.types';

const execFileAsync = promisify(execFile);
const RESTORE_DB = 'winagent_restore_check';

interface DbCreds {
  host: string;
  port: string;
  user: string;
  password: string;
  database: string;
}

export function parseDbUrl(url: string): DbCreds {
  const u = new URL(url);
  return { host: u.hostname, port: u.port || '3306', user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), database: u.pathname.replace(/^\//, '') };
}

/** MySQL backup + restore verification. Passwords go through MYSQL_PWD, never the command line. */
@Injectable()
export class BackupsService {
  private readonly logger = new Logger('Backups');

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private bin(name: string): string {
    return join(loadConfig().MYSQL_BIN_DIR, `${name}.exe`);
  }

  private env(creds: DbCreds): NodeJS.ProcessEnv {
    return { ...process.env, MYSQL_PWD: creds.password };
  }

  private async sqlCount(creds: DbCreds, database: string): Promise<Record<string, number>> {
    const { stdout } = await execFileAsync(
      this.bin('mysql'),
      ['-h', creds.host, '-P', creds.port, '-u', creds.user, '-N', '-B', '-e', `SELECT table_name FROM information_schema.tables WHERE table_schema='${database}' ORDER BY table_name`],
      { env: this.env(creds) },
    );
    const tables = stdout.split(/\r?\n/).filter((t) => /^[A-Za-z0-9_]+$/.test(t));
    const counts: Record<string, number> = {};
    for (const t of tables) {
      const r = await execFileAsync(this.bin('mysql'), ['-h', creds.host, '-P', creds.port, '-u', creds.user, '-N', '-B', database, '-e', `SELECT COUNT(*) FROM \`${t}\``], { env: this.env(creds) });
      // Windows MySQL stores table names in lower case (lower_case_table_names=1).
      counts[t.toLowerCase()] = Number(r.stdout.trim());
    }
    return counts;
  }

  async backupDatabase(userId: string | null) {
    const cfg = loadConfig();
    const creds = parseDbUrl(cfg.DATABASE_URL);
    mkdirSync(cfg.BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = join(cfg.BACKUP_DIR, `winagent-db-${stamp}.sql`);
    try {
      await execFileAsync(this.bin('mysqldump'), ['-h', creds.host, '-P', creds.port, '-u', creds.user, '--single-transaction', '--no-tablespaces', '--routines', '--default-character-set=utf8mb4', `--result-file=${file}`, creds.database], { env: this.env(creds), maxBuffer: 16 * 1024 * 1024 });
    } catch (err) {
      await this.audit.record({ actorType: userId ? 'USER' : 'SYSTEM', actorId: userId, action: 'backup.database', outcome: 'FAILURE', details: { error: (err as Error).message.slice(0, 300) } });
      throw new InternalServerErrorException('Database backup failed; see server logs');
    }
    const content = await readFile(file);
    const record = await this.prisma.configBackup.create({ data: { kind: 'database', filePath: file, sizeBytes: BigInt(content.length), sha256: sha256(content), createdById: userId } });
    await this.audit.record({ actorType: userId ? 'USER' : 'SYSTEM', actorId: userId, action: 'backup.database', targetType: 'backup', targetId: record.id, outcome: 'SUCCESS', details: { sizeBytes: content.length } });
    return record;
  }

  /** Exports non-secret configuration (models, policies, preferences) as JSON. */
  async backupConfig(userId: string) {
    const cfg = loadConfig();
    mkdirSync(cfg.BACKUP_DIR, { recursive: true });
    const [models, policies, preferences] = await Promise.all([
      this.prisma.modelConfig.findMany(),
      this.prisma.permissionPolicy.findMany({ where: { revokedAt: null } }),
      this.prisma.userPreference.findMany(),
    ]);
    const body = JSON.stringify({ exportedAt: new Date().toISOString(), note: 'Secrets are not included; they live in the DPAPI secret store.', models, policies, preferences }, null, 2);
    const file = join(cfg.BACKUP_DIR, `winagent-config-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    await writeFile(file, body, 'utf8');
    const record = await this.prisma.configBackup.create({ data: { kind: 'config', filePath: file, sizeBytes: BigInt(Buffer.byteLength(body)), sha256: sha256(body), createdById: userId } });
    await this.audit.record({ actorType: 'USER', actorId: userId, action: 'backup.config', targetType: 'backup', targetId: record.id, outcome: 'SUCCESS' });
    return record;
  }

  /**
   * Restores a database backup into a scratch database and compares it with the live one:
   * same tables, same migration history, and no table with more rows than the source.
   */
  async verifyRestore(id: string, userId: string | null) {
    const backup = await this.prisma.configBackup.findUnique({ where: { id } });
    if (!backup || backup.kind !== 'database') throw new NotFoundException('Database backup not found');
    if (!existsSync(backup.filePath)) throw new NotFoundException('Backup file is missing');
    const content = await readFile(backup.filePath);
    const problems: string[] = [];
    if (sha256(content) !== backup.sha256) problems.push('checksum mismatch (file modified or corrupted)');
    const creds = parseDbUrl(loadConfig().DATABASE_URL);
    if (problems.length === 0) {
      await execFileAsync(this.bin('mysql'), ['-h', creds.host, '-P', creds.port, '-u', creds.user, '-e', `DROP DATABASE IF EXISTS ${RESTORE_DB}; CREATE DATABASE ${RESTORE_DB} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`], { env: this.env(creds) });
      try {
        await new Promise<void>((resolve, reject) => {
          const child = spawn(this.bin('mysql'), ['-h', creds.host, '-P', creds.port, '-u', creds.user, '--default-character-set=utf8mb4', RESTORE_DB], { env: this.env(creds), stdio: ['pipe', 'ignore', 'pipe'] });
          let stderr = '';
          child.stderr.on('data', (d) => (stderr += d.toString()));
          child.on('error', reject);
          child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`mysql exited ${code}: ${stderr.slice(0, 300)}`))));
          createReadStream(backup.filePath).pipe(child.stdin);
        });
        const [restored, live] = await Promise.all([this.sqlCount(creds, RESTORE_DB), this.sqlCount(creds, creds.database)]);
        const liveTables = Object.keys(live).sort().join(',');
        const restoredTables = Object.keys(restored).sort().join(',');
        if (liveTables !== restoredTables) problems.push('table list differs from live database');
        if (restored._prisma_migrations !== live._prisma_migrations) problems.push('migration history differs');
        for (const [t, n] of Object.entries(restored)) if (live[t] !== undefined && n > live[t]) problems.push(`${t} has more rows than live`);
        if (!restored.user) problems.push('no users restored');
      } catch (err) {
        problems.push(`restore failed: ${(err as Error).message.replace(/MYSQL_PWD\S*/g, '')}`.slice(0, 300));
      } finally {
        await execFileAsync(this.bin('mysql'), ['-h', creds.host, '-P', creds.port, '-u', creds.user, '-e', `DROP DATABASE IF EXISTS ${RESTORE_DB};`], { env: this.env(creds) }).catch(() => undefined);
      }
    }
    const result = problems.length ? `FAILED: ${problems.join('; ')}` : 'PASSED: restored into scratch database and matched live schema and migrations';
    const updated = await this.prisma.configBackup.update({ where: { id }, data: { restoreTestedAt: new Date(), restoreTestResult: result.slice(0, 1000) } });
    await this.audit.record({ actorType: userId ? 'USER' : 'SYSTEM', actorId: userId, action: 'backup.verify_restore', targetType: 'backup', targetId: id, outcome: problems.length ? 'FAILURE' : 'SUCCESS', details: { result } });
    this.logger.log(`Restore verification for ${id}: ${problems.length ? 'FAILED' : 'PASSED'}`);
    return updated;
  }

  list() {
    return this.prisma.configBackup.findMany({ orderBy: { createdAt: 'desc' }, take: 50 }).then((rows) =>
      rows.map((r) => ({ ...r, fileExists: existsSync(r.filePath), currentSize: existsSync(r.filePath) ? statSync(r.filePath).size : null })),
    );
  }
}

@Controller('api/backups')
export class BackupsController {
  constructor(private readonly backups: BackupsService) {}

  @Get()
  @RequirePermissions('system:admin')
  list() {
    return this.backups.list();
  }

  @Post('database')
  @RequirePermissions('system:admin')
  database(@CurrentUser() user: AuthUser) {
    return this.backups.backupDatabase(user.id);
  }

  @Post('config')
  @RequirePermissions('system:admin')
  config(@CurrentUser() user: AuthUser) {
    return this.backups.backupConfig(user.id);
  }

  @Post(':id/verify-restore')
  @HttpCode(200)
  @RequirePermissions('system:admin')
  verify(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.backups.verifyRestore(id, user.id);
  }
}
