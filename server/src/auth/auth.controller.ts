import { Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post, Req, Res, HttpException, HttpStatus } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { parse } from '../common/errors';
import { RateLimiter } from '../common/rate-limit';
import { loadConfig } from '../config/config';
import { AuthService } from './auth.service';
import { AuthUser, CurrentUser, Public, RequirePermissions, SESSION_COOKIE } from './auth.types';

const Password = z.string().min(12, 'Password must be at least 12 characters').max(200);
const Email = z.string().trim().email().max(254);
const BootstrapSchema = z.object({ email: Email, displayName: z.string().trim().min(1).max(100), password: Password });
const LoginSchema = z.object({ email: Email, password: z.string().min(1).max(200) });
const ChangePasswordSchema = z.object({ currentPassword: z.string().min(1).max(200), newPassword: Password });
const CreateUserSchema = BootstrapSchema.extend({ role: z.enum(['ADMIN', 'OPERATOR', 'VIEWER']) });

export function serializeUser(user: AuthUser) {
  return { id: user.id, email: user.email, displayName: user.displayName, roles: user.roles, permissions: [...user.permissions].sort() };
}

@Controller('api/auth')
export class AuthController {
  private readonly loginLimiter = new RateLimiter(loadConfig().LOGIN_RATE_LIMIT_PER_MIN, 60_000);

  constructor(private readonly auth: AuthService) {}

  @Public()
  @Get('status')
  async status() {
    return { needsBootstrap: await this.auth.needsBootstrap() };
  }

  @Public()
  @Post('bootstrap')
  async bootstrap(@Body() body: unknown) {
    const input = parse(BootstrapSchema, body);
    return this.auth.bootstrapAdmin(input.email, input.displayName, input.password);
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    if (!this.loginLimiter.take(req.ip ?? 'unknown')) {
      throw new HttpException('Too many login attempts. Wait a minute and try again.', HttpStatus.TOO_MANY_REQUESTS);
    }
    const input = parse(LoginSchema, body);
    const { token, expiresAt } = await this.auth.login(input.email, input.password, req.header('user-agent'));
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: loadConfig().NODE_ENV === 'production' && req.secure,
      expires: expiresAt,
      path: '/',
    });
    return { ok: true, expiresAt };
  }

  @Post('logout')
  @HttpCode(200)
  async logout(@CurrentUser() user: AuthUser, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(user.sessionId, user.id);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  }

  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return serializeUser(user);
  }

  @Get('sessions')
  async sessions(@CurrentUser() user: AuthUser) {
    const sessions = await this.auth.listSessions(user.id);
    return sessions.map((s) => ({ ...s, current: s.id === user.sessionId }));
  }

  @Delete('sessions/:id')
  async revokeSession(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    if (!(await this.auth.revokeSession(user.id, id))) throw new NotFoundException('Session not found');
    return { ok: true };
  }

  @Post('password')
  @HttpCode(200)
  async changePassword(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const input = parse(ChangePasswordSchema, body);
    await this.auth.changePassword(user, input.currentPassword, input.newPassword);
    return { ok: true };
  }

  @Post('users')
  @RequirePermissions('system:admin')
  async createUser(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const input = parse(CreateUserSchema, body);
    return this.auth.createUser(user.id, input.email, input.displayName, input.password, input.role);
  }
}
