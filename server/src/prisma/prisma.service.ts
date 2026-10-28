import { Global, Injectable, Logger, Module, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import { PrismaClient } from '../generated/prisma/client';
import { loadConfig } from '../config/config';

/**
 * MySQL driver adapter (required since Prisma 7). Also used by the test and e2e harnesses so
 * every client connects the same way.
 */
export function createAdapter(databaseUrl: string, connectionLimit = 10): PrismaMariaDb {
  const url = new URL(databaseUrl);
  // Bounded pool keeps MySQL connection usage predictable on a desktop machine. Callers that rely
  // on session settings (SET FOREIGN_KEY_CHECKS) pass 1 so every statement shares one connection.
  if (!url.searchParams.has('connectionLimit')) url.searchParams.set('connectionLimit', String(connectionLimit));
  // MySQL 8's default caching_sha2_password needs the server's RSA key on non-TLS connections.
  // Safe here: the server and MySQL talk over localhost only.
  if (!url.searchParams.has('allowPublicKeyRetrieval')) url.searchParams.set('allowPublicKeyRetrieval', 'true');
  return new PrismaMariaDb(url.toString());
}

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    super({ adapter: createAdapter(loadConfig().DATABASE_URL), log: ['warn', 'error'] });
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.$connect();
    } catch (err) {
      // The server still starts: important writes go to the offline queue and are replayed
      // when MySQL is reachable (OfflineStore). Queries reconnect automatically.
      new Logger('Prisma').warn(`MySQL is not reachable at startup (${(err as Error).name}); continuing and retrying in the background`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}

@Global()
@Module({ providers: [PrismaService], exports: [PrismaService] })
export class PrismaModule {}
