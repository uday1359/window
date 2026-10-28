import { ConflictException, ForbiddenException, Injectable, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { hashPassword, randomToken, sha256, verifyPassword } from '../common/crypto';
import { loadConfig } from '../config/config';
import { PERMISSIONS, PermissionId, ROLES } from './rbac';
import type { AuthUser } from './auth.types';

const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MINUTES = 15;
const LAST_SEEN_WRITE_INTERVAL_MS = 60_000;
// Used so that unknown e-mails take as long as known ones (prevents user enumeration by timing).
const DUMMY_HASH = 'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' + Buffer.alloc(64).toString('base64');

@Injectable()
export class AuthService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.seedRbac();
  }

  /** Idempotently syncs roles/permissions from code into MySQL. */
  async seedRbac(): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      for (const [id, description] of Object.entries(PERMISSIONS)) {
        await tx.permission.upsert({ where: { id }, create: { id, description }, update: { description } });
      }
      for (const [id, role] of Object.entries(ROLES)) {
        await tx.role.upsert({ where: { id }, create: { id, description: role.description }, update: { description: role.description } });
        await tx.rolePermission.deleteMany({ where: { roleId: id, permissionId: { notIn: role.permissions } } });
        for (const permissionId of role.permissions) {
          await tx.rolePermission.upsert({
            where: { roleId_permissionId: { roleId: id, permissionId } },
            create: { roleId: id, permissionId },
            update: {},
          });
        }
      }
      await tx.systemState.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
    });
  }

  async needsBootstrap(): Promise<boolean> {
    return (await this.prisma.user.count()) === 0;
  }

  /** Creates the first administrator. Only possible while no users exist. */
  async bootstrapAdmin(email: string, displayName: string, password: string): Promise<{ id: string }> {
    const passwordHash = await hashPassword(password);
    const user = await this.prisma.$transaction(async (tx) => {
      // Row lock serialises concurrent bootstrap attempts.
      await tx.$queryRaw`SELECT id FROM SystemState WHERE id = 1 FOR UPDATE`;
      if ((await tx.user.count()) > 0) throw new ConflictException('Setup has already been completed');
      const created = await tx.user.create({
        data: { email: email.toLowerCase(), displayName, passwordHash, roles: { create: [{ roleId: 'ADMIN' }] } },
      });
      await this.audit.record({ actorType: 'USER', actorId: created.id, action: 'auth.bootstrap', targetType: 'user', targetId: created.id, outcome: 'SUCCESS' }, tx);
      return created;
    });
    return { id: user.id };
  }

  async createUser(actorId: string, email: string, displayName: string, password: string, role: string): Promise<{ id: string }> {
    if (!ROLES[role]) throw new ForbiddenException('Unknown role');
    const passwordHash = await hashPassword(password);
    return this.prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: { email: email.toLowerCase(), displayName, passwordHash, roles: { create: [{ roleId: role }] } },
      });
      await this.audit.record({ actorType: 'USER', actorId, action: 'user.create', targetType: 'user', targetId: created.id, outcome: 'SUCCESS', details: { role } }, tx);
      return { id: created.id };
    });
  }

  async login(email: string, password: string, userAgent: string | undefined): Promise<{ token: string; expiresAt: Date }> {
    const user = await this.prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    const now = new Date();
    if (!user || !user.isActive) {
      await verifyPassword(password, DUMMY_HASH);
      await this.audit.record({ actorType: 'USER', action: 'auth.login', outcome: 'FAILURE', details: { reason: 'unknown_or_inactive' } });
      throw new UnauthorizedException('Invalid email or password');
    }
    if (user.lockedUntil && user.lockedUntil > now) {
      await this.audit.record({ actorType: 'USER', actorId: user.id, action: 'auth.login', outcome: 'DENIED', details: { reason: 'locked' } });
      throw new UnauthorizedException('Account temporarily locked. Try again later.');
    }
    if (!(await verifyPassword(password, user.passwordHash))) {
      const failed = user.failedLogins + 1;
      await this.prisma.user.update({
        where: { id: user.id },
        data: {
          failedLogins: failed >= MAX_FAILED_LOGINS ? 0 : failed,
          lockedUntil: failed >= MAX_FAILED_LOGINS ? new Date(now.getTime() + LOCKOUT_MINUTES * 60_000) : null,
        },
      });
      await this.audit.record({ actorType: 'USER', actorId: user.id, action: 'auth.login', outcome: 'FAILURE', details: { reason: 'bad_password', failed } });
      throw new UnauthorizedException('Invalid email or password');
    }
    const token = randomToken();
    const expiresAt = new Date(now.getTime() + loadConfig().SESSION_TTL_HOURS * 3600_000);
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: user.id }, data: { failedLogins: 0, lockedUntil: null } }),
      this.prisma.userSession.create({
        data: { userId: user.id, tokenHash: sha256(token), userAgent: userAgent?.slice(0, 255), expiresAt },
      }),
    ]);
    await this.audit.record({ actorType: 'USER', actorId: user.id, action: 'auth.login', outcome: 'SUCCESS' });
    return { token, expiresAt };
  }

  /** Resolves an opaque session token into the user and their DB-sourced permissions. */
  async resolveSession(token: string | undefined): Promise<AuthUser | null> {
    if (!token || token.length > 200) return null;
    const session = await this.prisma.userSession.findUnique({
      where: { tokenHash: sha256(token) },
      include: { user: { include: { roles: { include: { role: { include: { permissions: true } } } } } } },
    });
    const now = new Date();
    if (!session || session.revokedAt || session.expiresAt <= now || !session.user.isActive) return null;
    const idleLimit = loadConfig().SESSION_IDLE_MINUTES * 60_000;
    if (now.getTime() - session.lastSeenAt.getTime() > idleLimit) {
      await this.prisma.userSession.update({ where: { id: session.id }, data: { revokedAt: now } });
      return null;
    }
    if (now.getTime() - session.lastSeenAt.getTime() > LAST_SEEN_WRITE_INTERVAL_MS) {
      await this.prisma.userSession.update({ where: { id: session.id }, data: { lastSeenAt: now } });
    }
    const permissions = new Set<PermissionId>();
    for (const ur of session.user.roles) for (const rp of ur.role.permissions) permissions.add(rp.permissionId as PermissionId);
    return {
      id: session.user.id,
      email: session.user.email,
      displayName: session.user.displayName,
      roles: session.user.roles.map((r) => r.roleId),
      permissions,
      sessionId: session.id,
    };
  }

  async logout(sessionId: string, userId: string): Promise<void> {
    await this.prisma.userSession.updateMany({ where: { id: sessionId, userId, revokedAt: null }, data: { revokedAt: new Date() } });
    await this.audit.record({ actorType: 'USER', actorId: userId, action: 'auth.logout', outcome: 'SUCCESS' });
  }

  listSessions(userId: string) {
    return this.prisma.userSession.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      select: { id: true, userAgent: true, createdAt: true, lastSeenAt: true, expiresAt: true },
      orderBy: { lastSeenAt: 'desc' },
    });
  }

  async revokeSession(userId: string, sessionId: string): Promise<boolean> {
    const { count } = await this.prisma.userSession.updateMany({ where: { id: sessionId, userId, revokedAt: null }, data: { revokedAt: new Date() } });
    await this.audit.record({ actorType: 'USER', actorId: userId, action: 'auth.session_revoke', targetType: 'session', targetId: sessionId, outcome: count ? 'SUCCESS' : 'FAILURE' });
    return count > 0;
  }

  async changePassword(user: AuthUser, currentPassword: string, newPassword: string): Promise<void> {
    const record = await this.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    if (!(await verifyPassword(currentPassword, record.passwordHash))) {
      await this.audit.record({ actorType: 'USER', actorId: user.id, action: 'auth.password_change', outcome: 'FAILURE' });
      throw new UnauthorizedException('Current password is incorrect');
    }
    const passwordHash = await hashPassword(newPassword);
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { passwordHash } });
      // Every other session is revoked so a stolen session cannot outlive a password change.
      await tx.userSession.updateMany({ where: { userId: user.id, revokedAt: null, id: { not: user.sessionId } }, data: { revokedAt: new Date() } });
      await this.audit.record({ actorType: 'USER', actorId: user.id, action: 'auth.password_change', outcome: 'SUCCESS' }, tx);
    });
  }

  /** Re-checked immediately before every agent dispatch. */
  async userHasPermission(userId: string, permission: PermissionId): Promise<boolean> {
    const count = await this.prisma.userRole.count({
      where: { userId, user: { isActive: true }, role: { permissions: { some: { permissionId: permission } } } },
    });
    return count > 0;
  }
}
