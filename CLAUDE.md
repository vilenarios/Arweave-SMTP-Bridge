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

### Directory Structure

```
src/
├── config/
│   ├── env.ts              # Environment validation with Zod
│   └── logger.ts           # Pino logger configuration
├── database/
│   ├── schema.ts           # Database tables (users, uploads, usage, payments, drives)
│   ├── db.ts               # SQLite connection with WAL mode
│   ├── migrate.ts          # Migration runner
│   └── migrations/         # SQL migrations
├── services/
│   ├── user-service.ts     # User management + allowlist
│   ├── usage-service.ts    # Billing + usage tracking
│   ├── email-upload.ts     # Legacy (to be refactored)
│   └── ...                 # Other legacy services
├── storage/
│   └── ardrive-storage.ts  # ArDrive v3 uploads with Turbo
├── utils/
│   └── crypto.ts           # AES-256-GCM encryption
├── jobs/                   # (To be implemented)
│   ├── queue.ts
│   └── processors/
└── index.ts                # Entry point
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

#### Crypto Utils (`src/utils/crypto.ts`)
- `encrypt(text)` / `decrypt(text)` - AES-256-GCM authenticated encryption
- Used ONLY for encrypting ArDrive drive passwords in database
- ArDrive Core JS handles all file encryption/decryption automatically
- `generateDrivePassword()` - Random password for new private drives
- `hashEmail(email)` - Consistent user ID hashing

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
Email arrives → IMAP Service (ImapFlow)
                    ↓
              Job Queue (BullMQ/Redis)
                    ↓
         Email Processor Job
                    ↓
    ┌───────────────┴───────────────┐
    ↓                               ↓
Authorization                  Usage Check
(allowlist via                (free tier limit via
user-service.ts)              usage-service.ts)
    ↓                               ↓
    └───────────────┬───────────────┘
                    ↓
          Upload to ArDrive (Turbo)
          (ardrive-storage.ts)
                    ↓
          Update Database
          (uploads + usage tables)
                    ↓
          Send Confirmation Email
          (with usage summary + ArDrive links)
```

### ArDrive Integration Details

**Private Drives** (One per user):
- Created on first upload by a user
- ArDrive Core JS v3 handles encryption/decryption automatically
- Drive password stored encrypted (AES-256-GCM) in `user_drives` table
- All files uploaded to same drive (organized by folder if needed)
- Confirmation email includes file key for private files

**Turbo Integration**:
- Enabled via `turboSettings: { turboWalletFactory: new TurboWalletFactory() }`
- Faster uploads using bundled transactions
- Cost-effective for multiple files

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

1. **Processing Flow**: All email processing should go through job queue (BullMQ) for async handling and retries
2. **User Creation**: Users are auto-created on first email if they're in allowlist
3. **Drive Creation**: Private drives are created lazily on first upload
4. **Cost Calculation**: Happens in `recordUpload()` - always called after successful upload
5. **Error Handling**: All services use structured logging (Pino) - check logs/ directory
6. **Database**: Uses SQLite with WAL mode - no external DB server needed
7. **Testing**: Database tests should use in-memory SQLite (`:memory:`)

### Legacy Code (To Be Removed)

These files are in `src/services/` but will be replaced:
- `email-upload.ts` - Old monolithic email processor (375 lines, does everything)
- `arweave-upload.ts` - Legacy Turbo/Arweave.js upload (replaced by ardrive-storage.ts)
- `ardrive-upload.ts` - Old ArDrive v2 code (replaced by ardrive-storage.ts)
- `user-manager.ts` - Old user management with broken GraphQL (replaced by user-service.ts)

Files in `archive/`:
- `index_broken.ts`, `index_cron.ts`, `index_imapflow.ts` - Experimental implementations

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
- **Integration Tests**: Test with real SQLite database (in-memory or temp file)
- **E2E Tests**: Test full flow with test email account

### Deployment (Home Server)

Requirements:
- Bun runtime
- Redis server (for job queue)
- SQLite (built into Bun)
- Arweave wallet JWK file
- Gmail account with app password

See `RESTRUCTURING_PLAN.md` for detailed deployment guide.

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
- Check logs in `logs/` directory for detailed error

---

*Last Updated: 2025-10-15*
