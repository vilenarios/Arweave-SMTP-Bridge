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
- emailFolderEntityId (parent email folder for this file)

**usage** - Monthly usage tracking for billing
- id, userId, periodStart, periodEnd
- uploadsCount, bytesUploaded, costUsd, billed

**payments** - Stripe transactions
- id, userId, stripePaymentIntentId, amountUsd, status

**user_drives** - Per-user ArDrive drives
- id, userId, driveId, driveType (private/public), rootFolderId
- drivePasswordEncrypted (AES-256-GCM encrypted)
- driveKeyBase64 (derived drive key for sharing URLs)
- welcomeEmailSent (tracks if drive welcome email was sent)

**drive_folders** - Cached year/month folders (prevents duplicate creation)
- id, userId, driveId, folderType (year/month)
- folderName (e.g., "2025" or "01"), parentFolderId, folderEntityId
- year, month (for querying)

**processed_emails** - Track processed emails (prevents duplicates)
- id, uid (IMAP UID), messageId, sender, subject
- status (queued/processing/completed/failed), errorMessage, queuedAt, processedAt
- folderEntityId (email folder in ArDrive), emlFileEntityId (.eml file entity), emlFileKey (file key for .eml)
- folderName (human-readable folder name)

### Key Services

#### User Service (`src/services/user-service.ts`)
- `getOrCreateUser(email)` - Get or create user, checks allowlist
- `getUserPrivateDrive(userId)` - Get user's private drive with decrypted password and drive key
- `createPrivateDriveForUser(userId, userEmail, driveKeyBase64)` - Create new private drive
- `markWelcomeEmailSent(userId)` - Mark that welcome email was sent
- `isAllowedEmail(email)` - Check email allowlist (supports wildcards like `*@domain.com`)

#### Usage Service (`src/services/usage-service.ts`)
- `getCurrentUsage(userId)` - Get/create current billing period
- `canUserUpload(userId)` - Check if user can upload (within limits)
- `recordUpload(userId, sizeBytes)` - Record upload and calculate cost
- `getUsageSummary(userId)` - Get usage for display ("5/10 free emails used")

#### ArDrive Storage (`src/storage/ardrive-storage.ts`)
- `uploadFilesToArDrive(userId, files, options)` - Upload files to ArDrive with Turbo (creates drive if needed)
- `createFolderInDrive(driveId, folderName, parentFolderId, drivePassword?)` - Create folder in existing drive
- `getDriveShareKey(driveId, drivePassword)` - Derive base64-encoded drive key for sharing URLs
- `uploadFilesToFolder(driveId, folderId, files[], drivePassword?)` - **Batch upload multiple files in ONE Turbo transaction**
- `uploadFileToFolder(driveId, folderId, filepath, filename, drivePassword?)` - Upload single file (wraps batch function)
- Handles both private (encrypted) and public uploads
- Returns entityId, dataTxId, fileKey for each file

#### IMAP Service (`src/services/imap-service.ts`)
- `start()` / `stop()` - Manage IMAP connection lifecycle
- Polls inbox every 30 seconds for new emails (last 7 days)
- Auto-reconnect with exponential backoff on disconnect
- Queues new emails via BullMQ for async processing
- Tracks processed emails in database to prevent duplicates

#### Email Notification Service (`src/services/email-notification.ts`)
- `sendDriveWelcomeEmail(to, driveId, driveKeyBase64, userEmail)` - Send welcome email with drive sharing link (sent once per user)
- `sendUploadConfirmation(to, files, emlFile, driveId, usageSummary, emailSubject)` - Send success email with file links (separate sections for .eml and attachments)
- `sendUsageLimitEmail(to, reason, usageSummary)` - Send limit exceeded notification
- `sendUploadErrorEmail(to, emailSubject, errorMessage, attemptsMade)` - Send error notification after failed retries
- Uses Nodemailer with HTML templates from `email-responses.ts`
- **Two-email system**: Welcome email (drive key) sent once, confirmation emails (file keys) sent per upload

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
- Creates hierarchical folder structure (Year > Month > Email)
- Saves full email as .eml file (RFC 822 format, max 1GB)
- Saves attachments to temp directory
- **Batch uploads .eml + attachments in ONE Turbo transaction** (5-10x faster)
- Records uploads in database and tracks usage
- Sends welcome email (first upload) or confirmation email
- Sends error notification email after final failure
- Handles retries (3 attempts with exponential backoff)
- Implements cache-first pattern for folder creation (handles concurrent/retry scenarios)

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
   - If new drive: derive and store drive key, wait 6s for indexing
                    ↓
6. Usage Check (usage-service.ts)
   - Verify within free tier (10/month)
   - If exceeded, send limit email and stop
                    ↓
7. Create Hierarchical Folder Structure (email-processor.ts)
   - Get/create Year folder (e.g., "2025") - cache-first pattern
   - Get/create Month folder (e.g., "01") - cache-first pattern
   - Create Email folder (YYYY-MM-DD_HH-MM-SS_Subject)
   - Wait 6s after each folder creation for ArDrive indexing
                    ↓
8. Save Email and Attachments to tmp/ directory
   - Save full email as .eml file (RFC 822 format, max 1GB)
   - Save all attachments
                    ↓
9. Batch Upload to ArDrive (ardrive-storage.ts)
   - Upload .eml + ALL attachments in ONE Turbo transaction
   - Upload to email folder via uploadFilesToFolder()
   - Returns: entityId, dataTxId, fileKey for each file
                    ↓
10. Update Database
    - Insert upload records for each file (uploads table)
    - Update processedEmails with folder/file IDs
    - Record usage for billing (usage table)
                    ↓
11. Send Email Notifications (email-notification.ts)
    - If first upload: send welcome email with drive sharing link
    - Send confirmation email with file sharing links
    - Separate sections for .eml file and attachments
    - If final failure: send error notification
                    ↓
12. Cleanup
    - Delete temp files
    - Mark email as 'completed' in processedEmails
```

### ArDrive Integration Details

**Private Drives** (One per user):
- Created on first upload by a user
- ArDrive Core JS v3 handles encryption/decryption automatically
- Drive password stored encrypted (AES-256-GCM) in `user_drives` table
- Drive key derived and stored (base64-encoded) for sharing URLs
- All files uploaded to same drive, organized in hierarchical folders
- Welcome email (sent once) includes drive sharing link with drive key
- Confirmation emails include individual file sharing links with file keys

**Hierarchical Folder Structure**:
- **Year Folder** (e.g., "2025") - Created once per year, cached in `drive_folders` table
- **Month Folder** (e.g., "01") - Created once per month, cached in `drive_folders` table
- **Email Folder** (e.g., "2025-10-23_14-30-45_Project_Update") - Created per email
  - Format: `YYYY-MM-DD_HH-MM-SS_Subject` (sanitized, max 100 chars)
  - Contains .eml file + all attachments
- Cache-first pattern: Check database before creating folders (prevents duplicates on retries)
- 6-second wait after folder creation for ArDrive indexing

**.eml Email Backup**:
- Full email saved as .eml file (RFC 822 format)
- Includes email headers, body, and original attachments
- Filename: `YYYY-MM-DD_Subject.eml` (sanitized, max 100 chars)
- Max size: 1GB (larger emails skipped with warning)
- Can be imported into any email client (Gmail, Outlook, Thunderbird, etc.)
- Uploaded in same Turbo transaction as attachments

**Turbo Integration & Batch Uploads**:
- Enabled via `turboSettings: {}` (uses default Turbo settings)
- **Batch uploads**: .eml + ALL attachments uploaded in ONE Turbo transaction
- Uses `uploadFilesToFolder()` for efficient multi-file uploads
- 5-10x faster than sequential uploads, lower cost, better atomicity
- Automatically handles payment for uploads via wallet balance
- Supports files up to 10GB (we limit .eml to 1GB)

**Sharing URLs**:
- **Drive Link**: `https://app.ardrive.io/#/drives/{driveId}?driveKey={driveKeyBase64}`
- **Private File Link**: `https://app.ardrive.io/#/file/{entityId}/view?fileKey={fileKey}`
- **Public File Link**: `https://app.ardrive.io/#/file/{entityId}/view`

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
   - Error notification sent to user after final failure

2. **User Creation**: Users are auto-created on first email if they're in allowlist
   - Welcome email sent on first upload with drive sharing link
   - Drive key stored in database for future reference

3. **Folder Indexing Wait Times** (Performance Optimized):
   - **Drive creation**: 6 seconds (reduced from 10s)
   - **Year folder creation**: 6 seconds (reduced from 10s)
   - **Month folder creation**: 6 seconds (reduced from 10s)
   - **Email folder creation**: 6 seconds (reduced from 10s)
   - First email: ~24 seconds total (drive + year + month + email folders)
   - Subsequent emails in same month: ~6 seconds (only email folder)
   - **CRITICAL**: Must wait for ArDrive to index folders before uploading files

4. **Batch Upload Strategy** (Performance Critical):
   - **ALWAYS use `uploadFilesToFolder()` (plural) for multiple files**
   - .eml file + ALL attachments uploaded in ONE Turbo transaction
   - 5-10x faster than sequential uploads, lower cost, better atomicity
   - Single file uploads automatically use batch function under the hood

5. **Error Recovery & Cache-First Pattern**:
   - Year/month folder creation wrapped in try-catch
   - On error: check database cache for existing folder (handles retries/concurrency)
   - Prevents duplicate folders and unnecessary API calls
   - Gracefully degrades when folder creation fails mid-retry

6. **Cost Calculation**: Happens in `recordUpload()` - always called after successful upload

7. **Error Handling & User Notifications**:
   - All services use structured logging (Pino) - logs output to console
   - Email processor tracks `userEmail` and `emailSubject` for error notifications
   - After 3 failed retry attempts: `sendUploadErrorEmail()` notifies user
   - Error email includes actionable troubleshooting steps

8. **Database**: Uses SQLite with WAL mode - no external DB server needed
   - `drive_folders` table caches year/month folders to prevent duplicates

9. **Testing**: Database tests should use in-memory SQLite (`:memory:`)

10. **Duplicate Prevention**: `processedEmails` table tracks IMAP UIDs to prevent reprocessing

11. **Graceful Shutdown**: Application handles SIGTERM/SIGINT - stops IMAP, waits for jobs to finish

12. **Temp Files**: Attachments and .eml files saved to `tmp/` directory, cleaned up after processing

13. **.eml Size Limit**: Max 1GB per email (Turbo supports up to 10GB, but we limit for practical reasons)



### Testing Strategy

- **Unit Tests**: Test services in isolation with mocked dependencies
  - Create tests in `src/__tests__/` or `src/[module]/__tests__/`
  - Run with `bun test`
- **Integration Tests**: Test with real SQLite database (in-memory or temp file)
  - Test user-service.ts with actual database operations
  - Test usage-service.ts billing calculations
  - Test email-processor.ts with mocked IMAP/ArDrive calls
- **E2E Tests**: Test full flow with test email account
  - Send test email → verify upload → check confirmation email
  - Requires: Redis, test email account, Arweave wallet with AR balance
  - Verify hierarchical folder structure and .eml backup
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

*Last Updated: 2025-10-23* (v2.1 - Hierarchical email archiving with .eml backup and batch uploads)
