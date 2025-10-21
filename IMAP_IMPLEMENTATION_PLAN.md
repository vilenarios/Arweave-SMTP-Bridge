# IMAP Implementation Plan
**Goal**: Simple, robust email polling system that feeds into job queue

---

## Design Principles

1. **Simple** - Single responsibility: fetch emails and queue them
2. **Robust** - Auto-reconnect, error handling, graceful degradation
3. **Stateless** - Use IMAP UIDs to track processed emails (stored in DB)
4. **Async** - Don't block on processing, just queue jobs
5. **Observable** - Structured logging for debugging

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│ IMAP Service (runs continuously)                        │
│                                                          │
│  ┌──────────────┐                                       │
│  │  Connection  │  ← Auto-reconnect on disconnect       │
│  │   Manager    │                                       │
│  └──────┬───────┘                                       │
│         │                                                │
│         ↓                                                │
│  ┌──────────────┐                                       │
│  │    Poller    │  ← Every 30 seconds                   │
│  │ (fetch UNSEEN)│                                       │
│  └──────┬───────┘                                       │
│         │                                                │
│         ↓                                                │
│  ┌──────────────┐                                       │
│  │   UID Check  │  ← Skip if already processed          │
│  └──────┬───────┘                                       │
│         │                                                │
│         ↓                                                │
│  ┌──────────────┐                                       │
│  │  Queue Job   │  → BullMQ (email-processor queue)     │
│  └──────────────┘                                       │
└─────────────────────────────────────────────────────────┘
```

---

## Implementation Details

### 1. Connection Manager
**File**: `src/services/imap-service.ts`

**Responsibilities**:
- Connect to IMAP server (ImapFlow)
- Handle disconnects with exponential backoff
- Emit connection status events
- Graceful shutdown

**Key Features**:
```typescript
class IMAPService {
  private client: ImapFlow | null
  private reconnectTimer: Timer | null
  private reconnectAttempts: number
  private isShuttingDown: boolean

  async connect(): Promise<void>
  async disconnect(): Promise<void>
  private async handleDisconnect(): Promise<void> // Auto-reconnect
  async healthCheck(): Promise<boolean>
}
```

**Reconnect Strategy**:
- Attempt 1: Wait 5 seconds
- Attempt 2: Wait 10 seconds
- Attempt 3: Wait 30 seconds
- Attempt 4+: Wait 60 seconds (max)
- Reset counter on successful connection

---

### 2. Email Poller
**File**: `src/services/imap-service.ts` (same file)

**Responsibilities**:
- Poll every 30 seconds for UNSEEN emails
- Fetch email metadata only (not full body yet)
- Queue job for each new email
- Mark email as SEEN after queuing

**Polling Logic**:
```typescript
async pollForEmails(): Promise<void> {
  // 1. Search for UNSEEN emails from last 7 days
  const messages = await client.search({
    seen: false,
    since: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
  })

  // 2. For each message:
  for (const uid of messages) {
    // 2a. Check if already queued (UID in processed_emails table)
    if (await isEmailProcessed(uid)) continue

    // 2b. Queue job with UID
    await emailQueue.add('process-email', { uid })

    // 2c. Mark as queued in DB (processed_emails table)
    await markEmailAsQueued(uid)

    // 2d. Mark as SEEN in IMAP (prevents re-processing)
    await client.messageFlagsAdd(uid, ['\\Seen'])
  }
}
```

**Why mark as SEEN immediately?**
- Prevents duplicate processing if app crashes
- Gmail already shows it was "opened"
- UID tracking in DB is source of truth

---

### 3. Processed Emails Tracking
**New DB Table**: `processed_emails`

```sql
CREATE TABLE processed_emails (
  id TEXT PRIMARY KEY,
  uid INTEGER NOT NULL UNIQUE,     -- IMAP UID
  message_id TEXT,                  -- Email Message-ID header
  queued_at INTEGER NOT NULL,       -- When we queued the job
  processed_at INTEGER,             -- When job completed
  status TEXT NOT NULL,             -- queued, processing, completed, failed
  created_at INTEGER NOT NULL
)
```

**Purpose**:
- Prevent duplicate processing (check before queueing)
- Track processing status
- Debugging (see what emails were processed)

---

### 4. Job Queue Integration
**File**: `src/jobs/queue.ts`

**Setup**:
```typescript
import { Queue } from 'bullmq'
import { config } from '../config/env'

export const emailQueue = new Queue('email-processor', {
  connection: {
    url: config.REDIS_URL
  },
  defaultJobOptions: {
    attempts: 3,              // Retry failed jobs 3 times
    backoff: {
      type: 'exponential',
      delay: 5000             // 5s, 25s, 125s
    },
    removeOnComplete: {
      age: 7 * 24 * 60 * 60   // Keep completed jobs for 7 days
    },
    removeOnFail: false       // Keep failed jobs for debugging
  }
})
```

**Job Payload**:
```typescript
interface EmailJob {
  uid: number              // IMAP UID
  queuedAt: number         // Timestamp
}
```

---

### 5. Email Processor Job
**File**: `src/jobs/processors/email-processor.ts`

**Responsibilities**:
- Fetch full email from IMAP by UID
- Parse email (attachments, sender, subject)
- Validate sender (allowlist)
- Check usage limits
- Save attachments to temp directory
- Upload to ArDrive
- Send confirmation email
- Update database (uploads, usage)
- Clean up temp files

**Flow**:
```typescript
async function processEmail(job: Job<EmailJob>) {
  const { uid } = job.data

  // 1. Fetch email from IMAP
  const email = await fetchEmailByUID(uid)

  // 2. Validate sender
  const user = await getOrCreateUser(email.from)

  // 3. Check usage limits
  const { allowed, reason } = await canUserUpload(user.id)
  if (!allowed) {
    await sendUsageLimitEmail(email.from, reason)
    return
  }

  // 4. Parse attachments
  const attachments = await saveAttachments(email)

  // 5. Upload to ArDrive
  const results = await uploadFilesToArDrive(user.id, attachments, {
    drivePassword: user.privateDrive?.drivePassword
  })

  // 6. Record usage
  await recordUpload(user.id, totalBytes)

  // 7. Send confirmation
  await sendConfirmationEmail(email.from, results, usage)

  // 8. Clean up
  await cleanupAttachments(attachments)

  // 9. Update processed_emails
  await markEmailAsProcessed(uid)
}
```

---

## Error Handling

### IMAP Connection Errors
```typescript
try {
  await client.connect()
} catch (error) {
  logger.error({ error }, 'IMAP connection failed')
  await scheduleReconnect()
}
```

### Polling Errors
```typescript
try {
  await pollForEmails()
} catch (error) {
  logger.error({ error }, 'Polling failed')
  // Don't crash - just log and continue
  // Next poll will try again
}
```

### Job Processing Errors
```typescript
// BullMQ handles retries automatically
// If all retries fail, job goes to "failed" state
// We can set up a separate worker to handle failed jobs
```

---

## Configuration

### Environment Variables
```bash
# IMAP
EMAIL_HOST=imap.gmail.com
EMAIL_PORT=993
EMAIL_USER=your-email@gmail.com
EMAIL_PASSWORD=app-specific-password
EMAIL_TLS=true

# Polling
IMAP_POLL_INTERVAL=30000  # 30 seconds (optional, default)
IMAP_SEARCH_DAYS=7        # Search emails from last 7 days (optional)

# Redis (for job queue)
REDIS_URL=redis://localhost:6379
```

---

## Database Changes

### Add processed_emails table
```typescript
// src/database/schema.ts
export const processedEmails = sqliteTable('processed_emails', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  uid: integer('uid').notNull().unique(),
  messageId: text('message_id'),
  queuedAt: integer('queued_at', { mode: 'timestamp' }).notNull(),
  processedAt: integer('processed_at', { mode: 'timestamp' }),
  status: text('status', {
    enum: ['queued', 'processing', 'completed', 'failed']
  }).notNull().default('queued'),
  errorMessage: text('error_message'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull()
    .$defaultFn(() => new Date()),
})
```

---

## Testing Strategy

### Unit Tests
- Test connection manager (mock ImapFlow)
- Test UID deduplication logic
- Test job payload creation

### Integration Tests
- Test with real IMAP connection (use test account)
- Test polling detects new emails
- Test job queuing

### E2E Test
```bash
# 1. Send test email to monitored inbox
# 2. Wait for poll (max 30s)
# 3. Verify job was queued
# 4. Verify job completed
# 5. Verify upload in ArDrive
# 6. Verify confirmation email sent
```

---

## Startup Sequence

```typescript
// index.ts
async function start() {
  // 1. Load config
  const config = loadConfig()

  // 2. Connect to database
  await getDb()

  // 3. Connect to Redis
  await initQueue()

  // 4. Start job workers
  await startWorkers()

  // 5. Connect to IMAP and start polling
  const imapService = new IMAPService()
  await imapService.start()

  logger.info('ForwARd is running')
}

start().catch(error => {
  logger.fatal({ error }, 'Failed to start')
  process.exit(1)
})
```

---

## Monitoring & Observability

### Metrics to Log
- IMAP connection status (connected/disconnected)
- Emails processed per hour
- Job queue depth
- Failed job count
- Average processing time
- Usage by user

### Health Check Endpoint (Future)
```typescript
GET /health
{
  "status": "healthy",
  "imap": "connected",
  "redis": "connected",
  "database": "connected",
  "queueDepth": 5,
  "lastPoll": "2025-10-15T12:00:00Z"
}
```

---

## Graceful Shutdown

```typescript
process.on('SIGTERM', async () => {
  logger.info('Shutting down gracefully')

  // 1. Stop polling
  await imapService.stop()

  // 2. Wait for in-flight jobs to complete
  await emailQueue.close()

  // 3. Disconnect IMAP
  await imapService.disconnect()

  // 4. Close DB
  await closeDb()

  logger.info('Shutdown complete')
  process.exit(0)
})
```

---

## Why This Design?

### ✅ Simple
- One poller, one queue, one processor
- Clear separation of concerns
- Easy to understand and debug

### ✅ Robust
- Auto-reconnect on disconnect
- UID tracking prevents duplicates
- Job retries on failure
- Doesn't crash on errors

### ✅ Scalable
- Can run multiple workers for job processing
- Redis queue handles concurrency
- Polling is lightweight (metadata only)

### ✅ Observable
- Structured logging throughout
- Job status tracked in DB
- Easy to add metrics later

---

## Implementation Order

1. **Add processed_emails table** (5 min)
2. **Create job queue setup** (15 min)
3. **Build IMAP service** (1 hour)
   - Connection manager
   - Polling logic
   - UID tracking
4. **Build email processor job** (2 hours)
   - Email fetching
   - Attachment handling
   - Integration with existing services
5. **Test end-to-end** (1 hour)
6. **Add confirmation emails** (1 hour)

**Total: ~5-6 hours of focused work**

---

*End of Implementation Plan*
