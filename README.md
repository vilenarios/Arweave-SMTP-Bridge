# ForwARd - Email to Permanent Storage

ForwARd is an email-to-ArDrive bridge that automatically uploads email attachments to permanent, encrypted storage on Arweave. Simply send an email with attachments to your configured inbox, and they'll be securely stored forever.

**Business Model**: Pay-per-use with free tier
- 10 free emails per month
- $0.10 per email after free tier
- Private ArDrive storage with encryption

## Features

- 📧 **Email-based uploads** - Send attachments via email, get permanent storage
- 🔒 **Private encrypted storage** - Each user gets a private ArDrive with AES-256-GCM encryption
- 💰 **Free tier** - 10 uploads per month free, pay-per-use after
- 🔄 **Reliable processing** - Job queue with automatic retries (3 attempts)
- 📊 **Usage tracking** - Know exactly how many free emails you have left
- 🚀 **Fast uploads** - Uses ArDrive Turbo for bundled transactions
- ✉️ **Confirmation emails** - Get ArDrive links and transaction details
- 🛡️ **Email allowlist** - Restrict access to specific users or domains
- 👛 **Flexible wallet modes** - Single master wallet or per-user isolated wallets with credit sharing

## Requirements

- **Bun runtime** (1.0+)
- **Redis** (for job queue)
- **Gmail account** with App Password enabled
- **Arweave wallet** with AR balance (for storage costs)

## Quick Start

### 1. Install Dependencies

```bash
# Clone repository
git clone <your-repo-url>
cd arweave-smtp-bridge

# Install dependencies
bun install
```

### 2. Install Redis

**Using Docker (recommended):**
```bash
docker run -d --name redis -p 6379:6379 redis:latest
```

**Using system package manager:**
```bash
# Ubuntu/Debian
sudo apt-get install redis-server
sudo systemctl start redis-server

# macOS
brew install redis
brew services start redis

# Verify Redis is running
redis-cli ping  # Should return "PONG"
```

### 3. Configure Environment

```bash
# Copy example environment file
cp .env.example .env

# Edit with your details
nano .env
```

**Required environment variables:**

```bash
# Email Configuration
EMAIL_USER=your-email@gmail.com
EMAIL_PASSWORD=your-app-specific-password
EMAIL_HOST=imap.gmail.com
EMAIL_PORT=993
EMAIL_TLS=true

# Arweave Wallet (path to JWK file)
ARWEAVE_JWK_PATH=./wallet.json

# Wallet Mode
# - 'single': Use master wallet for all uploads (simpler, default)
# - 'multi': Create per-user wallets with Turbo credit sharing (isolated)
WALLET_MODE=single

# Database (SQLite - auto-created)
DATABASE_URL=./data/forward.db

# Redis (for job queue)
REDIS_URL=redis://localhost:6379

# Security - Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
ENCRYPTION_KEY=<64-char-hex-string>
API_KEY_SECRET=<32+-char-random-string>

# Email Allowlist (comma-separated)
# Examples:
#   Single user: user@example.com
#   Multiple users: user1@example.com,user2@example.com
#   Whole domain: *@example.com
FORWARD_ALLOWED_EMAILS=your-email@gmail.com

# Billing Configuration (optional - uses defaults)
FREE_EMAILS_PER_MONTH=10
COST_PER_EMAIL=0.10
```

### 4. Set Up Gmail App Password

1. Go to [Google Account Settings](https://myaccount.google.com/)
2. Navigate to **Security** → **2-Step Verification**
3. Scroll to **App passwords**
4. Create password for "Mail" / "Other" → Name it "ForwARd"
5. Copy the generated password to `EMAIL_PASSWORD` in `.env`

### 5. Run Database Migrations

```bash
bun run src/database/migrate.ts
```

### 6. Start the Application

```bash
# Development (with hot reload)
bun run dev

# Production
bun start
```

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
```

## How to Use

### Send an Email

1. Send an email **to** the address configured in `EMAIL_USER`
2. Attach one or more files
3. The sender email must be in your `FORWARD_ALLOWED_EMAILS` list

### What Happens Next

1. **IMAP service** detects the new email (polls every 30 seconds)
2. **Job queue** processes the email asynchronously
3. **Authorization check** validates sender is in allowlist
4. **Usage check** verifies you haven't exceeded free tier
5. **Upload to ArDrive** creates/uses your private encrypted drive
6. **Database records** the upload and tracks usage
7. **Confirmation email** sent with:
   - ArDrive file links
   - Transaction details
   - Usage summary (e.g., "You've used 5/10 free emails this month")

## Wallet Modes

ForwARd supports two wallet modes via the `WALLET_MODE` environment variable:

### Single Wallet Mode (Default)
```bash
WALLET_MODE=single
```
- All uploads use the master wallet (specified in `ARWEAVE_JWK_PATH`)
- Simpler setup, no per-user wallet management
- All users share the same wallet for storage costs
- **Recommended for**: Personal use or small teams with centralized billing

### Multi-Wallet Mode
```bash
WALLET_MODE=multi
```
- Each user gets their own custodied Arweave wallet
- Wallets auto-generated on first upload (12-word seed phrase stored encrypted)
- Uses Turbo credit sharing with 30-day expiration for just-in-time funding
- Perfect isolation between users
- Wallet address shown in welcome email
- **Recommended for**: Production deployments with multiple independent users

**Note**: When switching modes, existing users will continue working. New users will use the new mode's wallet strategy.

## Email Allowlist

The `FORWARD_ALLOWED_EMAILS` variable controls who can use your ForwARd instance.

**Examples:**

```bash
# Single user
FORWARD_ALLOWED_EMAILS=alice@example.com

# Multiple users
FORWARD_ALLOWED_EMAILS=alice@example.com,bob@example.com

# Everyone at a domain
FORWARD_ALLOWED_EMAILS=*@example.com

# Mix of specific users and domain
FORWARD_ALLOWED_EMAILS=alice@gmail.com,*@mycompany.com
```

## Billing & Usage

### Free Tier
- **10 emails per month** are free
- Resets on the 1st of each month
- Usage tracked per sender email address

### Paid Usage
- **$0.10 per email** after free tier
- Cost calculated automatically
- Track usage in confirmation emails

### View Usage

**Check database:**
```bash
bunx drizzle-kit studio
# Opens web UI at http://localhost:4983
# View 'usage' and 'uploads' tables
```

**In confirmation emails:**
```
You've used 12/10 free emails this month
Cost for this upload: $0.20
Total cost this month: $0.20
```

## Development

### Run Tests

```bash
bun test
```

### View Database

```bash
# Opens web UI to browse all tables
bunx drizzle-kit studio
```

### Generate New Migration

```bash
# After modifying src/database/schema.ts
bunx drizzle-kit generate
bun run src/database/migrate.ts
```

### Debug Logging

Set log level in `.env`:
```bash
LOG_LEVEL=debug  # Options: debug, info, warn, error
```

### Monitor Redis Queue

```bash
redis-cli
> KEYS bull:email-processor:*
> LLEN bull:email-processor:waiting
> LLEN bull:email-processor:failed
```

## Production Deployment

See [DEPLOYMENT.md](./DEPLOYMENT.md) for detailed server setup instructions.

**Quick production setup:**

```bash
# Using PM2 process manager
npm install -g pm2
pm2 start bun --name "forward" -- start
pm2 save
pm2 startup
```

## Architecture

```
Email Arrives
    ↓
IMAP Service (polls every 30s)
    ↓
Job Queue (BullMQ + Redis)
    ↓
Email Processor Worker
    ├── Check allowlist
    ├── Check usage limits
    ├── Save attachments to tmp/
    ├── Upload to ArDrive (encrypted)
    ├── Record in database
    ├── Send confirmation email
    └── Cleanup temp files
```

### Tech Stack

- **Runtime**: Bun with TypeScript
- **Database**: SQLite with Drizzle ORM
- **Queue**: BullMQ + Redis
- **Storage**: ArDrive Core JS v3 with Turbo
- **Email**: ImapFlow (IMAP) + Nodemailer (SMTP)
- **Encryption**: AES-256-GCM for drive passwords
- **Validation**: Zod for configuration

## Troubleshooting

### "Configuration validation failed"
- Check all required variables are in `.env`
- Run `bun run src/config/env.ts` to see specific errors

### "IMAP connection failed"
- Verify Gmail App Password is correct
- Check `EMAIL_USER` and `EMAIL_PASSWORD`
- Ensure 2-step verification is enabled in Google

### "Redis connection failed"
- Verify Redis is running: `redis-cli ping`
- Check `REDIS_URL` in `.env`

### "Email not authorized"
- Add sender email to `FORWARD_ALLOWED_EMAILS`
- Use exact email or wildcard: `*@example.com`

### "ArDrive upload failed"
- Check wallet has sufficient AR balance
- Verify `ARWEAVE_JWK_PATH` points to valid JWK file
- Check console logs for detailed error

### Email not being processed
- Wait up to 30 seconds (polling interval)
- Check `processedEmails` table in database
- View Redis queue: `redis-cli LLEN bull:email-processor:waiting`
- Check logs for errors

## Database Schema

See [CLAUDE.md](./CLAUDE.md) for detailed schema documentation.

**Tables:**
- `users` - User accounts with plan info and optional wallet data
- `uploads` - File upload records
- `usage` - Monthly usage tracking
- `payments` - Payment transactions (Stripe ready)
- `user_drives` - ArDrive drive info per user
- `processed_emails` - Email processing status
- `drive_folders` - Cached year/month folders for hierarchical organization
- `credit_shares` - Turbo credit sharing records (multi-wallet mode)

## Security

- ✅ **AES-256-GCM encryption** for drive passwords in database
- ✅ **Email allowlist** prevents unauthorized access
- ✅ **Zod validation** on all configuration
- ✅ **Private ArDrive** encryption via ArDrive Core JS
- ✅ **No hardcoded secrets** - validated at startup
- ✅ **WAL mode** SQLite for safe concurrent access

## Roadmap

- [ ] Stripe payment integration (infrastructure ready)
- [ ] Web dashboard for usage/billing
- [ ] API endpoints for programmatic uploads
- [ ] Multiple storage provider support
- [ ] Webhook notifications
- [ ] Email to SMS notifications

## Contributing

See [CLAUDE.md](./CLAUDE.md) for development guide and architecture details.

## License

MIT

## Acknowledgments

- [ArDrive](https://ardrive.io/) for encrypted permanent storage
- [Arweave](https://arweave.org/) for the permaweb
- [BullMQ](https://bullmq.io/) for reliable job processing
