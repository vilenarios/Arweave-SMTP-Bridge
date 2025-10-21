# Restructuring Plan: Arweave SMTP Bridge → ForwARd Platform

## Vision
Transform the prototype into a production-ready SaaS platform for permanent file storage via email.

---

## Proposed Architecture

### Directory Structure
```
arweave-smtp-bridge/
├── src/
│   ├── config/
│   │   ├── env.ts              # Environment validation with Zod
│   │   ├── database.ts         # DB connection and migrations
│   │   └── logger.ts           # Winston/Pino logger setup
│   ├── core/
│   │   ├── imap-service.ts     # IMAP connection management
│   │   ├── email-parser.ts     # Email parsing logic
│   │   └── auth-service.ts     # Authentication/authorization
│   ├── storage/
│   │   ├── storage-provider.ts # Abstract interface
│   │   ├── turbo-provider.ts   # Turbo SDK implementation
│   │   ├── arweave-provider.ts # Arweave.js implementation
│   │   └── ardrive-provider.ts # ArDrive implementation
│   ├── services/
│   │   ├── upload-service.ts   # Orchestrates upload process
│   │   ├── email-service.ts    # Send confirmation emails
│   │   ├── user-service.ts     # User management
│   │   └── billing-service.ts  # Usage tracking & billing
│   ├── jobs/
│   │   ├── queue.ts            # Job queue setup
│   │   ├── email-processor.ts  # Process email job
│   │   └── upload-processor.ts # Upload file job
│   ├── api/
│   │   ├── routes/
│   │   │   ├── health.ts       # Health check endpoint
│   │   │   ├── uploads.ts      # Upload status API
│   │   │   └── webhooks.ts     # Webhook management
│   │   └── server.ts           # Express/Fastify server
│   ├── database/
│   │   ├── models/
│   │   │   ├── user.ts
│   │   │   ├── upload.ts
│   │   │   └── usage.ts
│   │   └── migrations/
│   ├── utils/
│   │   ├── crypto.ts           # Encryption utilities
│   │   ├── validation.ts       # Input validation
│   │   └── errors.ts           # Custom error classes
│   └── index.ts                # Single entry point
├── tests/
│   ├── unit/
│   ├── integration/
│   └── e2e/
├── scripts/
│   ├── migrate.ts              # Run migrations
│   └── seed.ts                 # Seed test data
├── docker/
│   ├── Dockerfile
│   └── docker-compose.yml
├── .github/
│   └── workflows/
│       ├── test.yml
│       └── deploy.yml
└── docs/
    ├── API.md
    ├── DEPLOYMENT.md
    └── USER_GUIDE.md
```

---

## Technology Stack

### Core
- **Runtime**: Bun (keep current)
- **Language**: TypeScript with strict mode
- **Framework**: Fastify (lightweight API server)

### Data Layer
- **Database**: PostgreSQL (production) / SQLite (development)
- **ORM**: Drizzle ORM (type-safe, Bun-compatible)
- **Migrations**: Drizzle Kit

### Queue & Jobs
- **Queue**: BullMQ with Redis
- **Scheduler**: node-cron for periodic tasks

### Storage
- **Turbo SDK**: @ardrive/turbo-sdk (existing)
- **ArDrive**: ardrive-core-js (existing)
- **Arweave**: arweave (existing)

### Email
- **IMAP**: ImapFlow (more modern than node-imap)
- **SMTP**: Nodemailer (keep current)
- **Parsing**: mailparser (keep current)

### Observability
- **Logging**: Pino (fast structured logging)
- **Metrics**: Prometheus client
- **Tracing**: OpenTelemetry
- **Error Tracking**: Sentry

### Security
- **Validation**: Zod
- **Encryption**: node:crypto with AES-GCM
- **Secrets**: dotenv-vault or Doppler (production)
- **Rate Limiting**: @fastify/rate-limit

### Testing
- **Unit**: Bun test (keep current)
- **Integration**: Bun test with testcontainers
- **E2E**: Playwright

### Payment
- **Billing**: Stripe API
- **Usage Metering**: Custom implementation

---

## Database Schema

### Users Table
```typescript
{
  id: uuid (PK)
  email: string (unique)
  email_verified: boolean
  allowed: boolean
  created_at: timestamp
  plan: enum('free', 'pro', 'enterprise')
  stripe_customer_id: string?
}
```

### Uploads Table
```typescript
{
  id: uuid (PK)
  user_id: uuid (FK)
  filename: string
  size_bytes: bigint
  content_type: string
  status: enum('pending', 'processing', 'completed', 'failed')
  provider: enum('turbo', 'arweave', 'ardrive')
  transaction_id: string?
  drive_id: string?        // For ArDrive
  entity_id: string?       // For ArDrive
  error_message: string?
  created_at: timestamp
  completed_at: timestamp?
}
```

### Usage Table
```typescript
{
  id: uuid (PK)
  user_id: uuid (FK)
  period_start: timestamp
  period_end: timestamp
  uploads_count: integer
  bytes_uploaded: bigint
  cost_credits: decimal
  billed: boolean
}
```

### Webhooks Table
```typescript
{
  id: uuid (PK)
  user_id: uuid (FK)
  url: string
  events: string[]
  secret: string
  enabled: boolean
  created_at: timestamp
}
```

---

## API Design

### REST Endpoints

#### Public
```
GET  /health              - Health check
GET  /metrics             - Prometheus metrics (internal)
```

#### Authenticated (API Key)
```
POST   /api/v1/uploads          - Create upload via API
GET    /api/v1/uploads/:id      - Get upload status
GET    /api/v1/uploads          - List user uploads
DELETE /api/v1/uploads/:id      - Cancel upload

GET    /api/v1/usage            - Get usage stats
GET    /api/v1/usage/current    - Current billing period

POST   /api/v1/webhooks         - Create webhook
GET    /api/v1/webhooks         - List webhooks
PUT    /api/v1/webhooks/:id     - Update webhook
DELETE /api/v1/webhooks/:id     - Delete webhook
```

### Webhook Events
```
upload.started
upload.completed
upload.failed
usage.limit_reached
```

---

## Configuration Management

### Environment Variables (Validated on Startup)

```typescript
// src/config/env.ts
import { z } from 'zod';

const envSchema = z.object({
  // App
  NODE_ENV: z.enum(['development', 'production', 'test']),
  PORT: z.coerce.number().default(3000),

  // Email
  EMAIL_USER: z.string().email(),
  EMAIL_PASSWORD: z.string().min(1),
  EMAIL_HOST: z.string().default('imap.gmail.com'),
  EMAIL_PORT: z.coerce.number().default(993),

  // Arweave
  ARWEAVE_JWK_PATH: z.string().min(1),
  ARWEAVE_SDK: z.enum(['turbo', 'arweave', 'ardrive']).default('turbo'),

  // Database
  DATABASE_URL: z.string().url(),

  // Redis
  REDIS_URL: z.string().url(),

  // Security
  ENCRYPTION_KEY: z.string().length(64), // hex-encoded 32 bytes
  API_KEY_SECRET: z.string().min(32),

  // Stripe
  STRIPE_SECRET_KEY: z.string().startsWith('sk_'),
  STRIPE_WEBHOOK_SECRET: z.string().startsWith('whsec_'),

  // Observability
  SENTRY_DSN: z.string().url().optional(),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export const config = envSchema.parse(process.env);
```

---

## Business Model Options

### Option 1: Credit-Based (Recommended)
- Users purchase credits upfront
- Each upload deducts credits based on file size
- Simple, predictable pricing
- No subscriptions to manage

**Pricing Example**:
- $5 = 1GB of storage
- $20 = 5GB (20% discount)
- $50 = 15GB (40% discount)

### Option 2: Subscription Tiers
- Free: 100MB/month
- Pro: $10/month - 5GB/month
- Enterprise: $50/month - 50GB/month

### Option 3: Pay-Per-Upload
- $0.05 per MB uploaded
- Good for occasional users
- Higher per-unit cost

### Recommended: Hybrid Model
- Free tier: 100MB/month (email only)
- Credit packs: Available for purchase (email + API)
- Enterprise: Custom pricing with dedicated support

---

## Migration Strategy

### Phase 1: Foundation (Week 1-2)
**Goal**: Fix critical bugs, establish solid foundation

**Tasks**:
1. Set up proper TypeScript config (strict mode)
2. Implement Zod-based config validation
3. Fix GraphQL syntax errors in user-manager
4. Consolidate to single entry point
5. Delete experimental files (index_cron, index_imapflow, index.ts)
6. Rename index_og.ts → index.ts
7. Set up proper logging (Pino)
8. Add .gitignore for wallet files
9. Set up testing framework
10. Write unit tests for core utilities

**Deliverable**: Application starts reliably with validation

---

### Phase 2: Database & Queue (Week 3)
**Goal**: Replace JSON storage with real database

**Tasks**:
1. Set up Drizzle ORM with PostgreSQL
2. Create migration for users, uploads, usage tables
3. Implement UserService with DB queries
4. Set up Redis + BullMQ
5. Create email-processor job
6. Create upload-processor job
7. Refactor email-upload.ts to use queue
8. Add proper error handling and retries
9. Write integration tests for database

**Deliverable**: Async job processing with persistence

---

### Phase 3: Security Hardening (Week 4)
**Goal**: Fix all critical vulnerabilities

**Tasks**:
1. Upgrade encryption to AES-GCM
2. Add input validation with Zod
3. Fix GraphQL injection (use proper client)
4. Implement rate limiting
5. Add API key authentication
6. Use secure random for temp files
7. Add CSRF protection
8. Security audit with npm audit
9. Add secrets rotation mechanism
10. Write security tests

**Deliverable**: Production-grade security

---

### Phase 4: API & Webhooks (Week 5)
**Goal**: Programmatic access

**Tasks**:
1. Set up Fastify server
2. Implement REST API endpoints
3. Add API key generation/management
4. Create webhook system
5. Add webhook delivery with retries
6. Write API documentation (OpenAPI)
7. Create API client SDK (TypeScript)
8. Add API rate limiting
9. Write API tests

**Deliverable**: Full API for programmatic uploads

---

### Phase 5: Billing & Payments (Week 6)
**Goal**: Monetization infrastructure

**Tasks**:
1. Integrate Stripe
2. Implement credit purchase flow
3. Create usage tracking system
4. Add usage quotas and limits
5. Build billing service
6. Create invoice generation
7. Add payment webhooks
8. Implement usage alerts
9. Create admin dashboard (basic)
10. Write billing tests

**Deliverable**: Revenue generation capability

---

### Phase 6: Observability (Week 7)
**Goal**: Production monitoring

**Tasks**:
1. Set up Sentry error tracking
2. Add Prometheus metrics
3. Create health check endpoint
4. Add structured logging throughout
5. Set up log aggregation
6. Create alerting rules
7. Add performance monitoring
8. Create operational dashboard
9. Write runbooks for common issues

**Deliverable**: Full observability stack

---

### Phase 7: Deployment & DevOps (Week 8)
**Goal**: Automated deployment

**Tasks**:
1. Create Dockerfile
2. Set up docker-compose for local dev
3. Write deployment documentation
4. Create GitHub Actions CI/CD
5. Set up staging environment
6. Create backup strategy
7. Add database migration automation
8. Set up CDN for static assets
9. Create rollback procedures
10. Load testing and optimization

**Deliverable**: Production deployment

---

## Quick Wins (Can Start Immediately)

These fixes can be done right now with minimal effort:

### 1. Fix Entry Point (30 minutes)
```bash
mv index.ts index_broken.ts
mv index_og.ts index.ts
rm index_cron.ts index_imapflow.ts
```

### 2. Fix GraphQL Queries (15 minutes)
**File**: `src/services/user-manager.ts`

Change line 156:
```typescript
// Before
transactions(
  owners:[${owner}])
  tags: [

// After
transactions(
  owners:["${owner}"],
  tags: [
```

### 3. Add Config Validation (1 hour)
```bash
bun add zod
```

Create `src/config/env.ts` with validation, call on startup.

### 4. Fix Type Errors (5 minutes)
**File**: `src/services/utils.ts:47`
```typescript
export function sleep(ms: number): Promise<void> {
```

### 5. Re-enable Tests (30 minutes)
Remove `.skip` from tests and fix mocks to match current implementation.

### 6. Secure Defaults (15 minutes)
**File**: `src/services/user-manager.ts:8`
```typescript
const SYSTEM_SECRET = process.env.FORWARD_ENCRYPTION_SECRET;
if (!SYSTEM_SECRET) {
  throw new Error('FORWARD_ENCRYPTION_SECRET is required');
}
```

---

## Team Composition Needed

For 8-week timeline:

- **1 Senior Backend Engineer** (Full-time)
  - Owns architecture, database, security

- **1 Mid-level Full-stack Engineer** (Full-time)
  - API, webhooks, frontend dashboard

- **1 DevOps Engineer** (Part-time, 20 hrs/week)
  - Deployment, monitoring, infrastructure

- **1 Product Manager** (Part-time, 10 hrs/week)
  - Pricing, features, user research

---

## Cost Estimate (Infrastructure)

### Development/Staging
- DigitalOcean/Render: $50/month
- Redis Cloud: Free tier
- PostgreSQL: Included
- **Total**: ~$50/month

### Production (MVP - 100 users)
- App hosting: $100/month (2 instances)
- PostgreSQL: $50/month (managed)
- Redis: $20/month
- Sentry: $26/month (team plan)
- Stripe: 2.9% + $0.30 per transaction
- Domain + SSL: $20/year
- **Total**: ~$200/month + transaction fees

### Production (Scale - 1000 users)
- App hosting: $400/month (autoscaling)
- PostgreSQL: $150/month
- Redis: $50/month
- Sentry: $89/month
- CDN: $50/month
- Monitoring: $100/month
- **Total**: ~$850/month + transaction fees

---

## Risk Mitigation

### Technical Risks
- **Arweave API changes**: Pin SDK versions, test upgrades
- **Email provider blocks**: Support multiple providers
- **Scale issues**: Load test before launch, use queue for async processing
- **Data loss**: Implement backup strategy from day 1

### Business Risks
- **Insufficient demand**: Start with waitlist, validate pricing
- **Competitor undercuts pricing**: Focus on unique features (email bridge)
- **Arweave costs increase**: Pass costs to users transparently

---

## Success Metrics

### Technical
- 99.9% uptime
- < 2 min email-to-upload latency
- < 100ms API response time
- Zero data loss

### Business
- 100 paying users in first 3 months
- $5k MRR in first 6 months
- < 5% churn rate
- Net Promoter Score > 50

---

## Next Steps

1. **Review this plan** with stakeholders
2. **Answer business questions** from CODE_AUDIT.md
3. **Prioritize features** - What's MVP?
4. **Approve budget** for infrastructure and team
5. **Set timeline** - Can we commit 8 weeks?
6. **Kick off Phase 1** - Fix critical bugs

---

## Decision Points

Before starting, we need decisions on:

1. **User wallet strategy**: Use per-user wallets or centralized?
2. **Primary upload method**: Turbo, ArDrive, or both?
3. **Pricing model**: Credits, subscription, or hybrid?
4. **Target market**: Individuals, developers, or enterprises?
5. **MVP feature set**: Email-only or email + API?

---

*End of Restructuring Plan*
