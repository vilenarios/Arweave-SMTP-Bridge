import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { config } from '../config/env';
import { createLogger } from '../config/logger';
import * as schema from './schema';
import { mkdir } from 'fs/promises';
import { dirname } from 'path';

const logger = createLogger('database');

let dbInstance: ReturnType<typeof drizzle> | null = null;

export async function getDb() {
  if (dbInstance) {
    return dbInstance;
  }

  try {
    // Ensure data directory exists
    await mkdir(dirname(config.DATABASE_URL), { recursive: true });

    // Create SQLite connection
    const sqlite = new Database(config.DATABASE_URL);

    // Enable WAL mode for better concurrency
    sqlite.exec('PRAGMA journal_mode = WAL;');
    sqlite.exec('PRAGMA foreign_keys = ON;');

    dbInstance = drizzle(sqlite, { schema });

    logger.info({ path: config.DATABASE_URL }, 'Database connected');

    return dbInstance;
  } catch (error) {
    logger.error({ error }, 'Failed to connect to database');
    throw error;
  }
}

export async function closeDb() {
  if (dbInstance) {
    // Bun's SQLite doesn't have an explicit close method
    dbInstance = null;
    logger.info('Database connection closed');
  }
}
