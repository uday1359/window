import { join, resolve } from 'node:path';
import { loadConfig, PROJECT_ROOT, resetConfigCache } from './config';

describe('loadConfig paths', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
    resetConfigCache();
  });

  function load(extra: Record<string, string>) {
    process.env = { ...saved, WINAGENT_SKIP_ENV_FILE: '1', DATABASE_URL: 'mysql://u:p@127.0.0.1:3306/winagent', AI_SERVICE_TOKEN: 'x'.repeat(40), ...extra };
    delete process.env.STORAGE_DIR;
    delete process.env.BACKUP_DIR;
    Object.assign(process.env, extra);
    resetConfigCache();
    return loadConfig();
  }

  it('resolves relative paths against the project folder, not the current directory', () => {
    const cfg = load({ STORAGE_DIR: 'storage', BACKUP_DIR: 'backups', TLS_PFX_FILE: 'data/tls/server.pfx' });
    expect(PROJECT_ROOT).toBe(resolve(__dirname, '..', '..', '..'));
    expect(cfg.STORAGE_DIR).toBe(join(PROJECT_ROOT, 'storage'));
    expect(cfg.BACKUP_DIR).toBe(join(PROJECT_ROOT, 'backups'));
    expect(cfg.TLS_PFX_FILE).toBe(join(PROJECT_ROOT, 'data', 'tls', 'server.pfx'));
  });

  it('defaults storage and backups to project folders and keeps absolute paths as given', () => {
    expect(load({}).STORAGE_DIR).toBe(join(PROJECT_ROOT, 'storage'));
    const elsewhere = resolve(PROJECT_ROOT, '..', 'winagent-data');
    expect(load({ BACKUP_DIR: elsewhere }).BACKUP_DIR).toBe(elsewhere);
  });
});
