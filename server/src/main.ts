import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { createApp } from './bootstrap';
import { isLoopback, loadConfig, tlsOptions } from './config/config';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const tls = tlsOptions(cfg) !== undefined;
  if (!isLoopback(cfg.HOST) && !tls) {
    // Session cookies and device tokens must never cross a network unencrypted.
    throw new Error(`Refusing to listen on ${cfg.HOST} without TLS. Set TLS_PFX_FILE (scripts\\new-tls-cert.ps1) or keep HOST=127.0.0.1.`);
  }
  const app = await createApp();
  await app.listen(cfg.PORT, cfg.HOST);
  new Logger('Bootstrap').log(`WinAgent server listening on ${tls ? 'https' : 'http'}://${cfg.HOST}:${cfg.PORT}`);
}

main().catch((err) => {
  console.error(`Fatal startup error: ${(err as Error).message}`);
  process.exit(1);
});
