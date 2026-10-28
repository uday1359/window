import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

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
  STORAGE_DIR: z.string().min(1),
  BACKUP_DIR: z.string().min(1),
  MYSQL_BIN_DIR: z.string().default('C:/Program Files/MySQL/MySQL Server 8.0/bin'),
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

export type AppConfig = z.infer<typeof EnvSchema>;

let cached: AppConfig | undefined;

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
  cached = parsed.data;
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
