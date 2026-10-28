import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthService } from './auth.service';
import { AuthedRequest, CSRF_HEADER, PERMISSIONS_KEY, PUBLIC_KEY, SESSION_COOKIE } from './auth.types';
import type { PermissionId } from './rbac';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Global guard: session authentication, CSRF defence and permission checks.
 * CSRF: the session cookie is SameSite=Strict and every state-changing request must
 * carry a custom header, which cross-origin pages cannot send without a CORS preflight
 * (CORS is not enabled).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const targets = [context.getHandler(), context.getClass()];
    if (!SAFE_METHODS.has(req.method) && req.header(CSRF_HEADER) !== '1') {
      throw new ForbiddenException('Missing CSRF header');
    }
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, targets)) return true;

    const user = await this.auth.resolveSession(req.cookies?.[SESSION_COOKIE]);
    if (!user) throw new UnauthorizedException('Authentication required');
    req.user = user;

    const required = this.reflector.getAllAndOverride<PermissionId[]>(PERMISSIONS_KEY, targets) ?? [];
    const missing = required.filter((p) => !user.permissions.has(p));
    if (missing.length) throw new ForbiddenException('You do not have permission to perform this action');
    return true;
  }
}
