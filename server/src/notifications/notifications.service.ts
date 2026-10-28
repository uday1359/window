import { Controller, Get, HttpCode, Injectable, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { OfflineStore } from '../offline/offline-store.service';
import { EventsService } from '../realtime/events.service';
import { AuthUser, CurrentUser } from '../auth/auth.types';

@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsService,
    private readonly offline: OfflineStore,
  ) {}

  async notify(userId: string, kind: string, title: string, body: string, link?: string): Promise<void> {
    // An explicit id and time make a queued notification identical when it is replayed later.
    const data = { id: randomUUID(), userId, kind, title: title.slice(0, 200), body: body.slice(0, 1000), link: link ?? null, createdAt: new Date() };
    await this.offline.write('notification', 'create', { data });
    this.events.publish(userId, { type: 'notification', notification: { ...data, readAt: null } });
  }

  list(userId: string, unreadOnly: boolean) {
    return this.prisma.notification.findMany({
      where: { userId, ...(unreadOnly ? { readAt: null } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  async markRead(userId: string, id?: string): Promise<number> {
    const { count } = await this.prisma.notification.updateMany({ where: { userId, readAt: null, ...(id ? { id } : {}) }, data: { readAt: new Date() } });
    return count;
  }
}

@Controller('api/notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query('unread') unread?: string) {
    return this.notifications.list(user.id, unread === '1');
  }

  @Post('read-all')
  @HttpCode(200)
  async readAll(@CurrentUser() user: AuthUser) {
    return { updated: await this.notifications.markRead(user.id) };
  }

  @Post(':id/read')
  @HttpCode(200)
  async read(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return { updated: await this.notifications.markRead(user.id, id) };
  }
}
