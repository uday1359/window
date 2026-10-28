import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';

/** The project folder (server/src/config or server/dist/config → three levels up). */
export const PROJECT_ROOT = resolve(__dirname, '..', '..', '..');

/** Newest installed MySQL Server bin folder under %ProgramFiles%\MySQL (8.0, 8.4, 9.x), or '' if none. */
export function detectMysqlBinDir(): string {
  const base = join(process.env.ProgramFiles ?? '', 'MySQL');
  if (!process.env.ProgramFiles || !existsSync(base)) return '';
  const versions = readdirSync(base)
    .filter((d) => /^MySQL Server \d+\.\d+$/.test(d) && existsSync(join(base, d, 'bin', 'mysql.exe')))
    .sort((a, b) => parseFloat(b.slice(13)) - parseFloat(a.slice(13)));
  return versions.length ? join(base, versions[0], 'bin') : '';
}

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(0).max(65535).default(3710), // 0 = ephemeral (tests)
  DATABASE_URL: z.string().startsWith('mysql://'),
  AI_SERVICE_URL: z.string().url().default('http://127.0.0.1:8710'),
  AI_SERVICE_TOKEN: z.string().min(32),
  SESSION_TTL_HOURS: z.coerce.number().positive().default(12),
  SESSION_IDLE_MINUTES: z.coerce.number().positive().default(60),
  WEB_ORIGIN: z.string().default('http://127.0.0.1:5173'),
  // Paths may be relative: they are resolved against the project folder, so the same .env works
  // for any Windows user and any install location.
  STORAGE_DIR: z.string().min(1).default('storage'),
  BACKUP_DIR: z.string().min(1).default('backups'),
  /** Defaults to the newest MySQL Server found under %ProgramFiles%\MySQL. */
  MYSQL_BIN_DIR: z.string().optional(),
  WEB_DIST_DIR: z.string().optional(),
  APPROVAL_TTL_MINUTES: z.coerce.number().positive().default(30),
  /** Upper bound applied to every operation's own timeout. */
  OPERATION_TIMEOUT_MS: z.coerce.number().positive().default(120000),
  ORCHESTRATOR_TICK_MS: z.coerce.number().positive().default(1000),
  LOGIN_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(10),
  /** Optional TLS: a PKCS#12 bundle (scripts\new-tls-cert.ps1) or a PEM certificate + key. */
  TLS_PFX_FILE: z.string().optional(),
  TLS_PFX_PASSPHRASE: z.string().optional(),
  TLS_CERT_FILE: z.string().optional(),
  TLS_KEY_FILE: z.string().optional(),
  /** Origin remote browsers use, e.g. https://winagent.example:3710 (added to the WebSocket allow-list). */
  PUBLIC_ORIGIN: z.string().url().optional(),
});

export type AppConfig = Omit<z.infer<typeof EnvSchema>, 'MYSQL_BIN_DIR'> & { MYSQL_BIN_DIR: string };

let cached: AppConfig | undefined;

const fromRoot = (p: string): string => (isAbsolute(p) ? p : resolve(PROJECT_ROOT, p));
const optionalFromRoot = (p: string | undefined): string | undefined => (p ? fromRoot(p) : undefined);

/** Loads server/.env (if present) once, validates it and fails fast on misconfiguration. */
export function loadConfig(): AppConfig {
  if (cached) return cached;
  const envFile = join(__dirname, '..', '..', '.env');
  if (existsSync(envFile) && !process.env.WINAGENT_SKIP_ENV_FILE) {
    process.loadEnvFile(envFile);
  }
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    // Only key names are reported - never values, which may be secrets.
    const keys = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`Invalid server configuration for: ${keys}`);
  }
  const c = parsed.data;
  cached = {
    ...c,
    STORAGE_DIR: fromRoot(c.STORAGE_DIR),
    BACKUP_DIR: fromRoot(c.BACKUP_DIR),
    WEB_DIST_DIR: optionalFromRoot(c.WEB_DIST_DIR),
    TLS_PFX_FILE: optionalFromRoot(c.TLS_PFX_FILE),
    TLS_CERT_FILE: optionalFromRoot(c.TLS_CERT_FILE),
    TLS_KEY_FILE: optionalFromRoot(c.TLS_KEY_FILE),
    MYSQL_BIN_DIR: c.MYSQL_BIN_DIR || detectMysqlBinDir(),
  };
  return cached;
}

/** HTTPS options when TLS is configured, otherwise undefined (plain HTTP on localhost only). */
export function tlsOptions(cfg: AppConfig): { pfx: Buffer; passphrase?: string } | { cert: Buffer; key: Buffer } | undefined {
  if (cfg.TLS_PFX_FILE) return { pfx: readFileSync(cfg.TLS_PFX_FILE), passphrase: cfg.TLS_PFX_PASSPHRASE };
  if (cfg.TLS_CERT_FILE || cfg.TLS_KEY_FILE) {
    if (!cfg.TLS_CERT_FILE || !cfg.TLS_KEY_FILE) throw new Error('TLS_CERT_FILE and TLS_KEY_FILE must be set together');
    return { cert: readFileSync(cfg.TLS_CERT_FILE), key: readFileSync(cfg.TLS_KEY_FILE) };
  }
  return undefined;
}

export const isLoopback = (host: string): boolean => ['127.0.0.1', 'localhost', '::1'].includes(host);

/** Test helper: forget the cached config so env overrides take effect. */
export function resetConfigCache(): void {
  cached = undefined;
}
