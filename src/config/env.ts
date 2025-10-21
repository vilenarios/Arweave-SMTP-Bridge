import { z } from 'zod';
import { existsSync } from 'fs';

const envSchema = z.object({
  // Environment
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  // Logging
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  // Email Configuration
  EMAIL_USER: z.string().email('EMAIL_USER must be a valid email address'),
  EMAIL_PASSWORD: z.string().min(1, 'EMAIL_PASSWORD is required'),
  EMAIL_HOST: z.string().default('imap.gmail.com'),
  EMAIL_PORT: z.coerce.number().int().positive().default(993),
  EMAIL_TLS: z.coerce.boolean().default(true),

  // Arweave Configuration
  ARWEAVE_JWK_PATH: z.string().min(1, 'ARWEAVE_JWK_PATH is required')
    .refine((path) => existsSync(path), {
      message: 'ARWEAVE_JWK_PATH file does not exist'
    }),

  // Database
  DATABASE_URL: z.string().default('./data/forward.db'),

  // Redis (for job queue)
  REDIS_URL: z.string().url().default('redis://localhost:6379'),

  // Security
  ENCRYPTION_KEY: z.string()
    .length(64, 'ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes)')
    .regex(/^[0-9a-fA-F]{64}$/, 'ENCRYPTION_KEY must be valid hex'),
  API_KEY_SECRET: z.string().min(32, 'API_KEY_SECRET must be at least 32 characters'),

  // Stripe (optional for MVP, required for production)
  STRIPE_SECRET_KEY: z.string().startsWith('sk_').optional(),
  STRIPE_WEBHOOK_SECRET: z.string().startsWith('whsec_').optional(),
  STRIPE_PRICE_ID: z.string().startsWith('price_').optional(),

  // Billing Configuration
  FREE_EMAILS_PER_MONTH: z.coerce.number().int().nonnegative().default(10),
  COST_PER_EMAIL: z.coerce.number().positive().default(0.10), // $0.10 per email

  // Email Allowlist (comma-separated)
  // Format: "user1@example.com,user2@example.com,*@example.org"
  FORWARD_ALLOWED_EMAILS: z.string().min(1, 'FORWARD_ALLOWED_EMAILS is required'),

  // Optional: Sentry for error tracking
  SENTRY_DSN: z.string().url().optional(),
});

export type Env = z.infer<typeof envSchema>;

let cachedConfig: Env | null = null;

export function loadConfig(): Env {
  if (cachedConfig) {
    return cachedConfig;
  }

  try {
    cachedConfig = envSchema.parse(process.env);
    return cachedConfig;
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.error('❌ Configuration validation failed:');
      error.errors.forEach((err) => {
        console.error(`  - ${err.path.join('.')}: ${err.message}`);
      });
      process.exit(1);
    }
    throw error;
  }
}

export const config = loadConfig();
