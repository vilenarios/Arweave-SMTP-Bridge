import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { config } from '../config/env';
import { createLogger } from '../config/logger';
import { mkdir } from 'fs/promises';
import { dirname } from 'path';

const logger = createLogger('migrate');

async function runMigrations() {
  try {
    // Ensure data directory exists
    await mkdir(dirname(config.DATABASE_URL), { recursive: true });

    const sqlite = new Database(config.DATABASE_URL);
    const db = drizzle(sqlite);

    logger.info('Running database migrations...');

    await migrate(db, { migrationsFolder: './src/database/migrations' });

    logger.info('✅ Migrations completed successfully');
    process.exit(0);
  } catch (error) {
    logger.error({ error }, '❌ Migration failed');
    process.exit(1);
  }
}

runMigrations();
