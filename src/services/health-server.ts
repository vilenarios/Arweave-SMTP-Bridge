import http from 'http';
import { createLogger } from '../config/logger';
import { getDb } from '../database/db';
import { emailQueue } from '../jobs/queue';
import { sql } from 'drizzle-orm';

const logger = createLogger('health-server');

export interface HealthStats {
  emails: {
    total: number;
    today: number;
    successRate: string;
    public: number;
    private: number;
    failed: number;
  };
  storage: {
    totalFiles: number;
    totalSizeGB: string;
    averageFileSizeMB: string;
  };
  users: {
    total: number;
    active: number;
  };
  drives: {
    private: number;
    public: number;
  };
}

export interface HealthStatus {
  status: 'healthy' | 'unhealthy' | 'degraded';
  timestamp: string;
  services: {
    database: boolean;
    redis: boolean;
    imap?: boolean;
  };
  queue: {
    waiting: number;
    active: number;
    failed: number;
  };
  uptime: number;
  stats?: HealthStats;
}

// Cache for stats (60 second TTL)
let cachedStats: HealthStats | null = null;
let cacheTime = 0;
const CACHE_TTL = 60000; // 60 seconds

/**
 * Check database connectivity
 */
async function checkDatabase(): Promise<boolean> {
  try {
    const db = await getDb();
    // Simple query to check database is accessible
    await db.all(sql`SELECT 1`);
    return true;
  } catch (error) {
    logger.error({
      errorMessage: error instanceof Error ? error.message : String(error),
      errorStack: error instanceof Error ? error.stack : undefined
    }, 'Database health check failed');
    return false;
  }
}

/**
 * Check Redis connectivity via BullMQ
 */
async function checkRedis(): Promise<boolean> {
  try {
    // Try to get queue count - if this works, Redis is accessible
    await emailQueue.getWaitingCount();
    return true;
  } catch (error) {
    logger.error({
      errorMessage: error instanceof Error ? error.message : String(error),
      errorStack: error instanceof Error ? error.stack : undefined
    }, 'Redis health check failed');
    return false;
  }
}

/**
 * Get queue stats
 */
async function getQueueStats(): Promise<{ waiting: number; active: number; failed: number }> {
  try {
    const [waiting, active, failed] = await Promise.all([
      emailQueue.getWaitingCount(),
      emailQueue.getActiveCount(),
      emailQueue.getFailedCount(),
    ]);

    return { waiting, active, failed };
  } catch (error) {
    logger.error({ error }, 'Failed to get queue stats');
    return { waiting: -1, active: -1, failed: -1 };
  }
}

/**
 * Get application statistics (cached for 60 seconds)
 */
async function getStats(): Promise<HealthStats> {
  try {
    const db = await getDb();

    // All queries run in parallel for performance
    const [
      emailStats,
      storageStats,
      userStats,
      driveStats
    ] = await Promise.all([
      // Email statistics
      db.all(sql`
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN DATE(queued_at) = DATE('now') THEN 1 ELSE 0 END) as today,
          SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
        FROM processed_emails
      `),

      // Storage statistics
      db.all(sql`
        SELECT
          COUNT(*) as total_files,
          COALESCE(SUM(size_bytes), 0) as total_bytes,
          COALESCE(AVG(size_bytes), 0) as avg_bytes
        FROM uploads
        WHERE status = 'completed'
      `),

      // User statistics
      db.all(sql`
        SELECT
          COUNT(*) as total,
          COUNT(CASE WHEN created_at >= datetime('now', '-30 days') THEN 1 END) as active
        FROM users
      `),

      // Drive statistics
      db.all(sql`
        SELECT
          SUM(CASE WHEN drive_type = 'private' THEN 1 ELSE 0 END) as private,
          SUM(CASE WHEN drive_type = 'public' THEN 1 ELSE 0 END) as public
        FROM user_drives
      `)
    ]);

    const emailRow = emailStats[0] as any;
    const storageRow = storageStats[0] as any;
    const userRow = userStats[0] as any;
    const driveRow = driveStats[0] as any;

    const total = Number(emailRow.total) || 0;
    const completed = Number(emailRow.completed) || 0;
    const successRate = total > 0 ? ((completed / total) * 100).toFixed(1) : '0.0';

    const totalBytes = Number(storageRow.total_bytes) || 0;
    const avgBytes = Number(storageRow.avg_bytes) || 0;

    return {
      emails: {
        total,
        today: Number(emailRow.today) || 0,
        successRate: `${successRate}%`,
        public: 0, // We don't track this in processed_emails currently
        private: 0, // We don't track this in processed_emails currently
        failed: Number(emailRow.failed) || 0
      },
      storage: {
        totalFiles: Number(storageRow.total_files) || 0,
        totalSizeGB: (totalBytes / 1024 / 1024 / 1024).toFixed(2),
        averageFileSizeMB: (avgBytes / 1024 / 1024).toFixed(2)
      },
      users: {
        total: Number(userRow.total) || 0,
        active: Number(userRow.active) || 0
      },
      drives: {
        private: Number(driveRow.private) || 0,
        public: Number(driveRow.public) || 0
      }
    };
  } catch (error) {
    logger.error({
      errorMessage: error instanceof Error ? error.message : String(error),
      errorStack: error instanceof Error ? error.stack : undefined
    }, 'Failed to get stats');
    // Return empty stats on error
    return {
      emails: { total: 0, today: 0, successRate: '0.0%', public: 0, private: 0, failed: 0 },
      storage: { totalFiles: 0, totalSizeGB: '0.00', averageFileSizeMB: '0.00' },
      users: { total: 0, active: 0 },
      drives: { private: 0, public: 0 }
    };
  }
}

/**
 * Get cached stats (or fetch if cache expired)
 */
async function getCachedStats(): Promise<HealthStats> {
  const now = Date.now();

  if (!cachedStats || (now - cacheTime) > CACHE_TTL) {
    cachedStats = await getStats();
    cacheTime = now;
    logger.debug('Stats cache refreshed');
  }

  return cachedStats;
}

/**
 * IMAP health check interface
 * To be injected by main application
 */
let imapHealthCheck: (() => Promise<boolean>) | null = null;

export function setImapHealthCheck(check: () => Promise<boolean>): void {
  imapHealthCheck = check;
}

/**
 * Get overall health status
 */
export async function getHealthStatus(): Promise<HealthStatus> {
  const [dbHealthy, redisHealthy, queueStats, stats] = await Promise.all([
    checkDatabase(),
    checkRedis(),
    getQueueStats(),
    getCachedStats(),
  ]);

  const imapHealthy = imapHealthCheck ? await imapHealthCheck() : undefined;

  const allHealthy = dbHealthy && redisHealthy && (imapHealthy === undefined || imapHealthy);
  const someHealthy = dbHealthy || redisHealthy || imapHealthy;

  const status: HealthStatus = {
    status: allHealthy ? 'healthy' : someHealthy ? 'degraded' : 'unhealthy',
    timestamp: new Date().toISOString(),
    services: {
      database: dbHealthy,
      redis: redisHealthy,
      ...(imapHealthy !== undefined && { imap: imapHealthy }),
    },
    queue: queueStats,
    uptime: process.uptime(),
    stats,
  };

  return status;
}

/**
 * Start health check HTTP server
 */
export function startHealthServer(port: number = 3000): http.Server {
  const server = http.createServer(async (req, res) => {
    // CORS headers for browser access
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    if (req.url === '/health' && req.method === 'GET') {
      try {
        const health = await getHealthStatus();
        const statusCode = health.status === 'healthy' ? 200 : health.status === 'degraded' ? 207 : 503;

        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(health, null, 2));
      } catch (error) {
        logger.error({ error }, 'Health check failed');
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'unhealthy', error: 'Health check failed' }));
      }
    } else if (req.url === '/ping' && req.method === 'GET') {
      // Simple ping endpoint for uptime monitors
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('pong');
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    }
  });

  server.listen(port, () => {
    logger.info({ port }, '✅ Health check server started');
  });

  return server;
}
