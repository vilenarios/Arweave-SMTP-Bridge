# Testing Guide

This guide will help you test the ForwARd email-to-Arweave bridge end-to-end.

## Prerequisites

### 1. Install and Start Redis

Redis is required for the job queue system (BullMQ).

#### Option A: Using Docker (Recommended)

```bash
# Start Redis in Docker
docker run -d --name redis -p 6379:6379 redis:latest

# Check if it's running
docker ps | grep redis
```

#### Option B: Using Windows Subsystem for Linux (WSL)

```bash
# In WSL terminal
sudo apt-get update
sudo apt-get install redis-server
redis-server --daemonize yes

# Test connection
redis-cli ping  # Should return "PONG"
```

#### Option C: Using Memurai (Native Windows)

1. Download Memurai (Redis alternative for Windows): https://www.memurai.com/get-memurai
2. Install and start the service
3. It will run on localhost:6379 by default

### 2. Verify Configuration

Ensure your `.env` file has all required variables:

```bash
# Check critical variables
cat .env | grep -E "(EMAIL_USER|EMAIL_PASSWORD|ARWEAVE_JWK_PATH|REDIS_URL)"
```

### 3. Verify Database

The database should already be initialized. Verify:

```bash
# Check database file exists
ls -lh ./data/forward.db

# Optional: View database in Drizzle Studio
bunx drizzle-kit studio
# Opens at http://localhost:4983
```

## Running the Application

### Start the Application

```bash
# Production mode
bun start

# Development mode (with auto-reload)
bun run dev
```

### Expected Startup Output

You should see:

```
🚀 Starting ForwARd by ArDrive...
📦 Initializing database...
✅ Database connected
⚙️  Starting email processor worker...
✅ Email processor worker started
📧 Starting IMAP service...
✅ IMAP service started

🎉 ForwARd is running!
📬 Monitoring inbox for new emails...

Environment: development
Email: ardriveforwardtest@gmail.com
Free emails per month: 10
Cost per email: $0.10

Press Ctrl+C to stop
```

## Testing the Upload Flow

### 1. Send a Test Email

From an allowed email address (check `FORWARD_ALLOWED_EMAILS` in `.env`):

1. Open your email client
2. Compose a new email to: `ardriveforwardtest@gmail.com`
3. **Subject**: Can be anything
4. **Attachments**: Add 1-3 small files (images, PDFs, etc.)
5. **Send**

### 2. Monitor the Logs

Watch the application logs for:

```
📧 [imap] Found unseen emails { count: 1 }
📧 [imap] Email queued { uid: 123, from: "user@example.com", subject: "Test" }
⚙️  [email-processor] Processing email... { uid: 123 }
⚙️  [email-processor] Email fetched { uid: 123, from: "user@example.com" }
⚙️  [email-processor] User validated { userId: "...", email: "user@example.com" }
⚙️  [email-processor] Attachments saved { uid: 123, count: 2 }
⚙️  [ardrive-storage] Files uploaded to ArDrive { userId: "...", count: 2 }
✅ [email-processor] Confirmation email sent { userId: "..." }
✅ [email-processor] Email processing complete { uid: 123 }
```

### 3. Check Your Email

You should receive a confirmation email with:

- List of uploaded files
- Preview links for each file on ArDrive
- File keys (if private drive)
- Usage summary (emails used this month, cost)
- Link to view your private drive

### 4. Verify on ArDrive

Click the "View Your Drive" link in the confirmation email to see your files on ArDrive.

## Testing Different Scenarios

### Test 1: First-Time User

- Send email from a new allowed address
- Should create new user, new private drive
- Should upload files and send confirmation

### Test 2: Existing User

- Send another email from the same address
- Should upload to existing drive
- Should increment usage count

### Test 3: Usage Limits

- Configure `FREE_EMAILS_PER_MONTH=1` in `.env`
- Send 2 emails from the same address
- First should succeed with confirmation
- Second should be rejected with usage limit email

### Test 4: No Attachments

- Send email without attachments
- Should log "No attachments to process"
- Should mark as completed without uploading

### Test 5: Not Allowed Email

- Send email from an address NOT in `FORWARD_ALLOWED_EMAILS`
- Should fail during user validation
- Check logs for "Email not in allowlist" error

## Monitoring

### View Database

```bash
# Open Drizzle Studio
bunx drizzle-kit studio

# Navigate to:
# - users: See created users
# - uploads: See uploaded files with transaction IDs
# - usage: See monthly usage tracking
# - user_drives: See created drives
# - processed_emails: See processing status
```

### View Job Queue

Install BullMQ Board for a web UI:

```bash
npm install -g bull-board

# Or use Redis CLI to inspect queues
redis-cli
> KEYS bull:email-processor:*
> LRANGE bull:email-processor:completed 0 10
```

### Check Logs

Logs use Pino with pretty printing in development:

```bash
# Filter by module
bun start | grep "imap"
bun start | grep "email-processor"

# Save logs to file
bun start > logs/app.log 2>&1
```

## Troubleshooting

### Redis Connection Failed

**Error**: `Error: connect ECONNREFUSED ::1:6379`

**Solution**: Start Redis (see Prerequisites above)

### IMAP Connection Failed

**Error**: `Failed to connect to IMAP`

**Solutions**:
- Check `EMAIL_USER` and `EMAIL_PASSWORD` in `.env`
- For Gmail, ensure "App Passwords" is enabled (not regular password)
- Check firewall isn't blocking port 993

### Files Not Uploading

**Error**: `Failed to upload to ArDrive`

**Solutions**:
- Verify `ARWEAVE_JWK_PATH` points to valid wallet file
- Ensure wallet has sufficient AR balance for uploads
- Check wallet balance: `arweave balance $(cat wallet.json | jq -r .n)`

### Confirmation Email Not Sent

**Error**: `Failed to send confirmation email`

**Solutions**:
- Check SMTP credentials (Gmail uses same as IMAP)
- Enable "Less secure app access" or use App Passwords
- Check firewall for port 587/465

### Database Locked

**Error**: `database is locked`

**Solutions**:
- Ensure only one instance is running
- WAL mode should prevent this (check db.ts:49)
- Stop Drizzle Studio if running

## Clean Up

### Reset Database

```bash
# Stop application
# Delete database
rm -rf ./data/

# Restart application (will recreate DB)
bun start
```

### Clear Job Queue

```bash
redis-cli FLUSHDB
```

### Stop Redis

```bash
# Docker
docker stop redis

# WSL
redis-cli shutdown

# Memurai
# Use Windows Services to stop
```

## Next Steps

Once basic testing is complete:

1. **Stress Testing**: Send multiple emails rapidly to test queue handling
2. **Large Files**: Test with larger attachments (up to ArDrive limits)
3. **Error Recovery**: Kill process mid-upload, restart, verify no duplicates
4. **Billing**: Test usage tracking across monthly boundaries
5. **Production**: Deploy to home server, configure systemd/pm2 for auto-restart

## Getting Help

Check logs in:
- Console output (Pino pretty-printed)
- Database `processed_emails` table (status, error_message)
- Redis queue (failed jobs)

Common issues are documented in `CLAUDE.md` under "Troubleshooting".
