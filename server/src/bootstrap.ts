import { INestApplication, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { json, type NextFunction, type Request, type Response } from 'express';
import { AppModule } from './app.module';
import { loadConfig, tlsOptions } from './config/config';

// Prisma returns BigInt for audit ids and backup sizes; JSON has no BigInt.
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function (this: bigint) {
  return this.toString();
};

/** Builds the Nest application (shared by main.ts and integration tests). */
export async function createApp(): Promise<INestApplication> {
  const cfg = loadConfig();
  const httpsOptions = tlsOptions(cfg);
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { httpsOptions, logger: cfg.NODE_ENV === 'test' ? ['error', 'warn'] : ['log', 'error', 'warn'] });
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'", 'ws://127.0.0.1:*', 'ws://localhost:*', ...(cfg.PUBLIC_ORIGIN ? [cfg.PUBLIC_ORIGIN.replace(/^http/, 'ws')] : [])],
          frameAncestors: ["'none'"],
          objectSrc: ["'none'"],
        },
      },
      crossOriginEmbedderPolicy: false,
    }),
  );
  app.use(cookieParser());
  // Task creation may carry up to 3 screenshots (1.5 MB each, base64); every other route keeps 2 MB.
  app.use('/api/tasks', json({ limit: '7mb' }));
  app.useBodyParser('json', { limit: '2mb' });
  app.enableShutdownHooks();

  // Production: the server also hosts the built dashboard (reused by the Electron shell).
  const webDist = resolve(cfg.WEB_DIST_DIR ?? join(__dirname, '..', '..', 'web', 'dist'));
  if (existsSync(join(webDist, 'index.html'))) {
    app.useStaticAssets(webDist, { index: false });
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (req.method !== 'GET' || req.path.startsWith('/api') || req.path.startsWith('/ws')) return next();
      res.sendFile(join(webDist, 'index.html'));
    });
    new Logger('Bootstrap').log(`Serving dashboard from ${webDist}`);
  }
  return app;
}
