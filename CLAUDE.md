# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

ForwARd (Arweave SMTP Bridge) is a production-ready email-to-permanent-storage service. Users send emails with attachments to a monitored inbox, and the system automatically uploads them to ArDrive (Arweave's encrypted file storage) and sends back confirmation emails with transaction details.

**Business Model**: Pay-per-use with free tier
- 10 free emails per month
- $0.10 per email after free tier
- Monthly billing via Stripe (ready for integration)

## Development Commands

### Running the Application
```bash
bun start              # Start the email monitoring service
bun run dev            # Start with hot reload
```

### Database
```bash
bun run src/database/migrate.ts  # Run migrations
bunx drizzle-kit studio          # View database in browser
bunx drizzle-kit generate        # Generate new migration
```

### Testing
```bash
bun test              # Run test suite
```

## Core Architecture (Rebuilt - 2025-10)

### Tech Stack
- **Runtime**: Bun with TypeScript (strict mode)
- **Database**: SQLite with Drizzle ORM
- **Queue**: BullMQ + Redis (async job processing)
- **Storage**: ArDrive Core JS v3 with Turbo
- **Email**: ImapFlow (IMAP), Nodemailer (SMTP)
- **Logging**: Pino (structured JSON logs)
- **Validation**: Zod (config and input validation)
- **Payments**: Stripe (ready for integration)

### Key Architectural Decisions

**Why SQLite?**
- No separate database server needed (perfect for home server deployment)
- WAL mode enables concurrent reads during writes
- Built into Bun runtime
- Simple backup (just copy the .db file)

**Why BullMQ + Redis?**
- Decouples email monitoring from processing (IMAP connection stays alive)
- Automatic retries with exponential backoff
- Job persistence (won't lose emails if app crashes)
- Can scale to multiple workers if needed

**Why ArDrive Core JS v3 instead of raw Arweave.js?**
- Built-in encryption for private drives
- Automatic folder/file organization
- Turbo integration for faster uploads
- Better developer experience

**Why polling (30s) instead of IMAP IDLE?**
- More reliable (IDLE can timeout and fail silently)
- Simpler reconnection logic
- Still fast enough for user needs (30s latency acceptable)

### Directory Structure

```
src/
├── config/
│   ├── env.ts                        # Environment validation with Zod
│   └── logger.ts                     # Pino logger configuration
├── database/
│   ├── schema.ts                     # Database tables (users, uploads, usage, payments, drives, processedEmails)
│   ├── db.ts                         # SQLite connection with WAL mode
│   ├── migrate.ts                    # Migration runner
│   └── migrations/                   # SQL migrations
├── jobs/                             # BullMQ job queue (fully implemented)
│   ├── queue.ts                      # Queue setup + job interfaces
│   └── processors/
│       └── email-processor.ts        # Email processing worker
├── services/
│   ├── user-service.ts               # User management + allowlist
│   ├── usage-service.ts              # Billing + usage tracking
│   ├── imap-service.ts               # IMAP monitoring with ImapFlow
│   ├── email-notification.ts         # Send confirmation/error emails
│   ├── email-responses.ts            # Email template generation
│   ├── file-prep.ts                  # Attachment handling utilities
│   ├── crypto.ts                     # Legacy crypto (use utils/crypto.ts)
│   ├── email-upload.ts               # Legacy (to be removed)
│   ├── arweave-upload.ts             # Legacy (to be removed)
│   ├── ardrive-upload.ts             # Legacy (to be removed)
│   └── user-manager.ts               # Legacy (to be removed)
├── storage/
│   └── ardrive-storage.ts            # ArDrive v3 uploads with Turbo
├── utils/
│   └── crypto.ts                     # AES-256-GCM encryption
└── index.ts                          # Entry point + graceful shutdown
```

### Database Schema (SQLite)

**users** - User accounts
- id, email, emailVerified, allowed (allowlist), plan (free/paid), stripeCustomerId

**uploads** - Track every file upload
- id, userId, fileName, sizeBytes, contentType, status (pending/processing/completed/failed)
- driveId, entityId (ArDrive file ID), dataTxId (Arweave TX), fileKey (private files)

**usage** - Monthly usage tracking for billing
- id, userId, periodStart, periodEnd
- uploadsCount, bytesUploaded, costUsd, billed

**payments** - Stripe transactions
- id, userId, stripePaymentIntentId, amountUsd, status

**user_drives** - Per-user ArDrive drives
- id, userId, driveId, driveType (private/public), rootFolderId
- drivePasswordEncrypted (AES-256-GCM encrypted)

**processed_emails** - Track processed emails (prevents duplicates)
- id, uid (IMAP UID), messageId, sender, subject
- status (queued/processing/completed/failed), errorMessage, queuedAt, processedAt

### Key Services

#### User Service (`src/services/user-service.ts`)
- `getOrCreateUser(email)` - Get or create user, checks allowlist
- `getUserPrivateDrive(userId)` - Get user's private drive with decrypted password
- `createPrivateDriveForUser()` - Create new private drive
- `isAllowedEmail(email)` - Check email allowlist (supports wildcards like `*@domain.com`)

#### Usage Service (`src/services/usage-service.ts`)
- `getCurrentUsage(userId)` - Get/create current billing period
- `canUserUpload(userId)` - Check if user can upload (within limits)
- `recordUpload(userId, sizeBytes)` - Record upload and calculate cost
- `getUsageSummary(userId)` - Get usage for display ("5/10 free emails used")

#### ArDrive Storage (`src/storage/ardrive-storage.ts`)
- `uploadFilesToArDrive(userId, files, options)` - Upload files to ArDrive with Turbo
- Creates drive/folder automatically if doesn't exist
- Handles both private (encrypted) and public uploads
- Returns entityId, dataTxId, fileKey for each file

#### IMAP Service (`src/services/imap-service.ts`)
- `start()` / `stop()` - Manage IMAP connection lifecycle
- Polls inbox every 30 seconds for new emails (last 7 days)
- Auto-reconnect with exponential backoff on disconnect
- Queues new emails via BullMQ for async processing
- Tracks processed emails in database to prevent duplicates

#### Email Notification Service (`src/services/email-notification.ts`)
- `sendUploadConfirmation(to, files, driveId, usageSummary)` - Send success email with ArDrive links
- `sendUsageLimitEmail(to, reason, usageSummary)` - Send limit exceeded notification
- Uses Nodemailer with HTML templates from `email-responses.ts`

#### Crypto Utils (`src/utils/crypto.ts`)
- `encrypt(text)` / `decrypt(text)` - AES-256-GCM authenticated encryption
- Used ONLY for encrypting ArDrive drive passwords in database
- ArDrive Core JS handles all file encryption/decryption automatically
- `generateDrivePassword()` - Random password for new private drives
- `hashEmail(email)` - Consistent user ID hashing

#### Email Processor (`src/jobs/processors/email-processor.ts`)
- BullMQ worker that processes queued emails
- Fetches full email content via IMAP
- Validates user authorization and usage limits
- Saves attachments to temp directory
- Uploads files to ArDrive
- Records uploads in database and tracks usage
- Sends confirmation email
- Handles retries (3 attempts with exponential backoff)

### Configuration

Environment variables (validated on startup with Zod):

**Required**:
- `EMAIL_USER` / `EMAIL_PASSWORD` - Gmail IMAP/SMTP credentials
- `ARWEAVE_JWK_PATH` - Path to Arweave wallet JWK file
- `ENCRYPTION_KEY` - 64-char hex string for encrypting drive passwords (auto-generated in .env)
- `API_KEY_SECRET` - 32+ char secret for API keys
- `FORWARD_ALLOWED_EMAILS` - Comma-separated allowlist (supports `*@domain.com`)

**Optional**:
- `DATABASE_URL` - Defaults to `./data/forward.db`
- `REDIS_URL` - Defaults to `redis://localhost:6379`
- `LOG_LEVEL` - info, debug, warn, error (default: info)
- `FREE_EMAILS_PER_MONTH` - Default: 10
- `COST_PER_EMAIL` - Default: 0.10 (USD)
- `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` - For payment processing

### Upload Flow (Current Architecture)

```
1. Email arrives in monitored inbox
                    ↓
2. IMAP Service (imap-service.ts)
   - Polls every 30s for new emails
   - Checks if already processed (processedEmails table)
                    ↓
3. Queue email job (queue.ts)
   - Add to BullMQ queue with UID
   - Mark as 'queued' in processedEmails
                    ↓
4. Email Processor Worker (email-processor.ts)
   - Fetch full email content via IMAP
   - Parse attachments with mailparser
                    ↓
5. User Authorization (user-service.ts)
   - Check email allowlist (supports wildcards)
   - Get or create user + private drive
                    ↓
6. Usage Check (usage-service.ts)
   - Verify within free tier (10/month)
   - If exceeded, send limit email and stop
                    ↓
7. Save attachments to tmp/ directory
                    ↓
8. Upload to ArDrive (ardrive-storage.ts)
   - Use existing drive or create new private drive
   - Upload via ArDrive Core JS v3 with Turbo
   - Returns: entityId, dataTxId, fileKey
                    ↓
9. Update Database
   - Insert upload records (uploads table)
   - Record usage for billing (usage table)
                    ↓
10. Send Confirmation Email (email-notification.ts)
    - ArDrive file links
    - Usage summary (e.g., "5/10 free emails used")
    - Transaction details
                    ↓
11. Cleanup
    - Delete temp files
    - Mark email as 'completed' in processedEmails
```

### ArDrive Integration Details

**Private Drives** (One per user):
- Created on first upload by a user
- ArDrive Core JS v3 handles encryption/decryption automatically
- Drive password stored encrypted (AES-256-GCM) in `user_drives` table
- All files uploaded to same drive (organized by folder if needed)
- Confirmation email includes file key for private files

**Turbo Integration**:
- Enabled via `turboSettings: {}` (uses default Turbo settings)
- Faster uploads using bundled transactions
- Cost-effective for multiple files
- Automatically handles payment for uploads via wallet balance

**Important**: ArDrive Core JS manages all file-level cryptography. Our crypto utils are ONLY for application-layer encryption (drive passwords in database).

### Billing Logic

1. **Free Tier**: First 10 emails/month are free
2. **Paid Usage**: $0.10/email after free tier
3. **Billing Period**: Calendar month (resets 1st of each month)
4. **Recording**: Every upload increments counter and calculates cost
5. **Future**: Stripe integration to charge users

### Security Features

- **AES-256-GCM encryption** for drive passwords in database
- **Email allowlist** with wildcard domain support
- **Zod validation** on all config and inputs
- **Strict TypeScript** mode throughout
- **No hardcoded secrets** (validated at startup)
- **WAL mode** on SQLite for concurrent access

### Application Startup Flow

When you run `bun start` or `bun run dev`, the application (`index.ts`) starts in this order:

1. **Load & Validate Configuration** - Zod validates all env vars (fails fast if invalid)
2. **Initialize Database** - Connect to SQLite, ensure migrations are run
3. **Start Email Processor Worker** - BullMQ worker connects to Redis, ready to process jobs
4. **Start IMAP Service** - Connect to email inbox, begin polling for new emails
5. **Graceful Shutdown Handlers** - Register SIGTERM/SIGINT handlers for clean shutdown

**Shutdown Order** (reverse of startup):
1. Stop IMAP service (prevents new emails from being queued)
2. Stop email processor (allows current jobs to finish)
3. Close queue connections (Redis)

### Common Development Tasks

#### Add a new environment variable
1. Add to `src/config/env.ts` Zod schema
2. Add to `.env.example`
3. Update `CLAUDE.md` and user documentation

#### Add a new database table
1. Define in `src/database/schema.ts`
2. Run `bunx drizzle-kit generate` to create migration
3. Run `bun run src/database/migrate.ts` to apply

#### Test ArDrive upload locally
```typescript
import { uploadFilesToArDrive } from './src/storage/ardrive-storage';

const result = await uploadFilesToArDrive('user-id', [
  { filepath: './test.txt', filename: 'test.txt' }
], {
  drivePassword: 'test-password',
  driveName: 'Test Drive'
});
```

### Important Implementation Notes

1. **Processing Flow**: All email processing goes through BullMQ job queue (fully implemented)
   - IMAP service queues emails → Email processor worker handles async
   - 3 retry attempts with exponential backoff (5s, 25s, 125s)
   - Failed jobs kept in queue for debugging
2. **User Creation**: Users are auto-created on first email if they're in allowlist
3. **Drive Creation**: Private drives are created lazily on first upload (handled by email-processor.ts)
   - **CRITICAL**: After creating a new drive, must wait 10 seconds for ArDrive to index it before uploading files (see email-processor.ts:188-190)
   - Drive creation and file upload are now separate operations to prevent indexing errors
4. **Cost Calculation**: Happens in `recordUpload()` - always called after successful upload
5. **Error Handling**: All services use structured logging (Pino) - logs output to console
6. **Database**: Uses SQLite with WAL mode - no external DB server needed
7. **Testing**: Database tests should use in-memory SQLite (`:memory:`)
8. **Duplicate Prevention**: `processedEmails` table tracks IMAP UIDs to prevent reprocessing
9. **Graceful Shutdown**: Application handles SIGTERM/SIGINT - stops IMAP, waits for jobs to finish
10. **Temp Files**: Attachments saved to `tmp/` directory, cleaned up after processing

### Legacy Code (To Be Removed)

**Currently in use but should be refactored/removed:**
- `src/services/email-upload.ts` - Old monolithic email processor (not used by current flow)
- `src/services/arweave-upload.ts` - Legacy Turbo/Arweave.js upload (replaced by ardrive-storage.ts)
- `src/services/ardrive-upload.ts` - Old ArDrive v2 code (replaced by ardrive-storage.ts)
- `src/services/user-manager.ts` - Old user management with broken GraphQL (replaced by user-service.ts)
- `src/services/crypto.ts` - Duplicate crypto utils (use `src/utils/crypto.ts` instead)

**Archived (not in use):**
- `archive/index_og.ts` - Original implementation
- `archive/index_broken.ts` - Broken experimental implementation
- `archive/index_cron.ts` - Cron-based polling attempt
- `archive/index_imapflow.ts` - Early ImapFlow experiment

**Note**: The current production flow uses `email-processor.ts`, `imap-service.ts`, and `ardrive-storage.ts`. Legacy services above are NOT imported by `index.ts`.

### Migration from Old Architecture

**Old (v1)**:
- JSON file for user storage (`user-store/users.json`)
- Multiple upload methods (Turbo, Arweave.js, ArDrive)
- No billing/usage tracking
- Hardcoded secrets
- No job queue
- GraphQL syntax errors

**New (v2)**:
- SQLite database with proper schema
- Single upload method (ArDrive v3 with Turbo)
- Full billing/usage tracking
- Validated configuration
- Job queue for async processing
- Fixed all critical bugs

### Testing Strategy

- **Unit Tests**: Test services in isolation with mocked dependencies
  - `src/services/__tests__/` - Contains existing tests for email-upload, qr-code, arweave-sdk-selector
  - Run with `bun test`
- **Integration Tests**: Test with real SQLite database (in-memory or temp file)
  - Test user-service.ts with actual database operations
  - Test usage-service.ts billing calculations
- **E2E Tests**: Test full flow with test email account
  - Send test email → verify upload → check confirmation email
  - Requires: Redis, test email account, Arweave wallet with AR balance
  - See `TESTING.md` for detailed end-to-end testing guide

### Deployment (Home Server)

Requirements:
- Bun runtime
- Redis server (for job queue)
- SQLite (built into Bun)
- Arweave wallet JWK file
- Gmail account with app password

See `DEPLOYMENT.md` for detailed deployment guide.

---

## Troubleshooting

**"Configuration validation failed"**
- Check `.env` file has all required fields
- Run `bun run src/config/env.ts` to see specific errors

**"Database locked"**
- WAL mode should prevent this, but check no other processes are using DB
- Restart application

**"Email not authorized"**
- Check `FORWARD_ALLOWED_EMAILS` in `.env`
- Supports exact match or wildcard: `*@example.com`

**ArDrive upload fails**
- Check wallet has sufficient AR balance
- Check `ARWEAVE_JWK_PATH` points to valid JWK file
- Check console output for detailed error messages

**"Job failed" errors**
- Check Redis is running: `redis-cli ping`
- View failed jobs in Redis or via BullMQ dashboard
- Check `processedEmails` table for error messages

### Monitoring and Debugging

**View Database Contents**:
```bash
bunx drizzle-kit studio  # Opens web UI at http://localhost:4983
```

**Check Redis Queue Status**:
```bash
redis-cli
> KEYS bull:email-processor:*
> LLEN bull:email-processor:waiting
> LLEN bull:email-processor:failed
```

**View Recent Uploads**:
```sql
-- Run in Drizzle Studio or sqlite3 ./data/forward.db
SELECT * FROM uploads ORDER BY created_at DESC LIMIT 10;
SELECT * FROM processed_emails ORDER BY created_at DESC LIMIT 10;
```

**Debug Email Processing**:
- Set `LOG_LEVEL=debug` in `.env` for verbose logging
- Check `processedEmails` table for status and error messages
- Monitor console output while sending test email

---

*Last Updated: 2025-10-23*
