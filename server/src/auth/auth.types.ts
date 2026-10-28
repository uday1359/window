import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Request } from 'express';
import type { PermissionId } from './rbac';

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  roles: string[];
  permissions: Set<PermissionId>;
  sessionId: string;
}

export interface AuthedRequest extends Request {
  user?: AuthUser;
}

export const SESSION_COOKIE = 'wa_session';
export const CSRF_HEADER = 'x-winagent-csrf';

export const PUBLIC_KEY = 'winagent:public';
export const PERMISSIONS_KEY = 'winagent:permissions';

/** Marks a route as not requiring a session (login, bootstrap, health, agent pairing). */
export const Public = () => SetMetadata(PUBLIC_KEY, true);

/** Requires every listed permission. Permissions come from the DB, never from the client. */
export const RequirePermissions = (...permissions: PermissionId[]) => SetMetadata(PERMISSIONS_KEY, permissions);

export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthUser => {
  const req = ctx.switchToHttp().getRequest<AuthedRequest>();
  if (!req.user) throw new Error('CurrentUser used on a public route');
  return req.user;
});

export function can(user: AuthUser, permission: PermissionId): boolean {
  return user.permissions.has(permission);
}
