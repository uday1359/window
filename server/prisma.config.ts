import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig } from 'prisma/config';

// Prisma 7 no longer reads .env itself. Variables already set in the environment win,
// which is how the test and e2e harnesses point the CLI at their own databases.
const envFile = join(__dirname, '.env');
if (existsSync(envFile) && !process.env.DATABASE_URL) process.loadEnvFile(envFile);

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: {
    url: process.env.DATABASE_URL ?? '',
    // Only `migrate dev` needs a shadow database; deploy and validate work without one.
    shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL || undefined,
  },
});
