import http from 'http';
import { createLogger } from '../config/logger';
import { getDb } from '../database/db';
import { emailQueue } from '../jobs/queue';

const logger = createLogger('health-server');

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
}

/**
 * Check database connectivity
 */
async function checkDatabase(): Promise<boolean> {
  try {
    const db = await getDb();
    // Simple query to check database is accessible
    await db.execute('SELECT 1');
    return true;
  } catch (error) {
    logger.error({ error }, 'Database health check failed');
    return false;
  }
}

/**
 * Check Redis connectivity via BullMQ
 */
async function checkRedis(): Promise<boolean> {
  try {
    const isReady = await emailQueue.isReady();
    return isReady;
  } catch (error) {
    logger.error({ error }, 'Redis health check failed');
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
  const [dbHealthy, redisHealthy, queueStats] = await Promise.all([
    checkDatabase(),
    checkRedis(),
    getQueueStats(),
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
