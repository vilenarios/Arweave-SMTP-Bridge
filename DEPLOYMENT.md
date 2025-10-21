# Server Deployment Guide

This guide will help you deploy ForwARd on a Linux server.

## Prerequisites

- Linux server (Ubuntu 20.04+ recommended)
- SSH access with sudo privileges
- Domain name (optional, for production)
- Arweave wallet with AR balance
- Gmail account with App Password enabled

---

## Step 1: Install Bun Runtime

```bash
# Install Bun
curl -fsSL https://bun.sh/install | bash

# Add to PATH (if not automatically added)
echo 'export BUN_INSTALL="$HOME/.bun"' >> ~/.bashrc
echo 'export PATH="$BUN_INSTALL/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc

# Verify installation
bun --version
```

---

## Step 2: Install Redis

```bash
# Update package list
sudo apt-get update

# Install Redis
sudo apt-get install -y redis-server

# Configure Redis to start on boot
sudo systemctl enable redis-server

# Start Redis
sudo systemctl start redis-server

# Verify Redis is running
redis-cli ping  # Should return "PONG"
```

### Configure Redis (Optional)

For production, you may want to configure Redis:

```bash
sudo nano /etc/redis/redis.conf
```

Recommended settings:
- `bind 127.0.0.1` - Only accept local connections
- `requirepass your-strong-password` - Add authentication
- `maxmemory 256mb` - Limit memory usage
- `maxmemory-policy allkeys-lru` - Evict old keys when full

After changes:
```bash
sudo systemctl restart redis-server
```

If you set a password, update `.env`:
```
REDIS_URL=redis://:your-strong-password@localhost:6379
```

---

## Step 3: Clone Repository

```bash
# Clone from git
cd ~
git clone <your-repo-url> arweave-smtp-bridge
cd arweave-smtp-bridge

# Install dependencies
bun install
```

---

## Step 4: Configure Environment

```bash
# Copy example environment file
cp .env.example .env

# Edit with your settings
nano .env
```

### Required Configuration

```bash
# Environment
NODE_ENV=production

# Logging
LOG_LEVEL=info

# Email Configuration
EMAIL_USER=your-email@gmail.com
EMAIL_PASSWORD=your-app-password  # Gmail App Password
EMAIL_HOST=imap.gmail.com
EMAIL_PORT=993
EMAIL_TLS=true

# Arweave wallet
ARWEAVE_JWK_PATH=./wallet.json

# Database
DATABASE_URL=./data/forward.db

# Redis
REDIS_URL=redis://localhost:6379

# Security - Generate new keys
ENCRYPTION_KEY=<run: openssl rand -hex 32>
API_KEY_SECRET=<run: openssl rand -hex 32>

# Billing
FREE_EMAILS_PER_MONTH=10
COST_PER_EMAIL=0.10

# Email Allowlist
FORWARD_ALLOWED_EMAILS=user@example.com,*@yourdomain.com
```

### Generate Secure Keys

```bash
# Generate encryption key
openssl rand -hex 32

# Generate API key secret
openssl rand -hex 32
```

Copy these values into your `.env` file.

---

## Step 5: Upload Arweave Wallet

**Important**: Keep your wallet secure!

```bash
# Create wallet file (from your local machine)
scp /path/to/wallet.json user@server:~/arweave-smtp-bridge/wallet.json

# Or create it on server
nano wallet.json
# Paste wallet JSON, save with Ctrl+X, Y, Enter

# Set restrictive permissions
chmod 600 wallet.json

# Verify it's valid JSON
cat wallet.json | jq .
```

**Security Note**: Never commit `wallet.json` to git. It's already in `.gitignore`.

---

## Step 6: Initialize Database

```bash
# Run migrations
bun run src/database/migrate.ts

# Verify database was created
ls -lh ./data/forward.db
```

---

## Step 7: Test the Application

```bash
# Test startup
bun start

# You should see:
# 🚀 Starting ForwARd by ArDrive...
# ✅ Database connected
# ✅ Email processor worker started
# ✅ IMAP service started
# 🎉 ForwARd is running!

# Press Ctrl+C to stop
```

### Send Test Email

1. From an allowed email address, send email to your configured `EMAIL_USER`
2. Include 1-2 small attachments
3. Watch the logs for processing

Expected output:
```
📧 [imap] Found unseen emails { count: 1 }
⚙️  [email-processor] Processing email...
⚙️  [email-processor] Attachments saved { count: 2 }
⚙️  [ardrive-storage] Files uploaded to ArDrive
✅ [email-processor] Confirmation email sent
```

Check your email for confirmation with ArDrive links.

---

## Step 8: Run as Background Service

### Option A: Using systemd (Recommended)

Create a systemd service file:

```bash
sudo nano /etc/systemd/system/forward.service
```

Paste this configuration (update paths and user):

```ini
[Unit]
Description=ForwARd - Email to Arweave Bridge
After=network.target redis-server.service
Requires=redis-server.service

[Service]
Type=simple
User=your-username
WorkingDirectory=/home/your-username/arweave-smtp-bridge
ExecStart=/home/your-username/.bun/bin/bun run index.ts
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=forward

# Environment
Environment="NODE_ENV=production"

[Install]
WantedBy=multi-user.target
```

Enable and start the service:

```bash
# Reload systemd
sudo systemctl daemon-reload

# Enable service to start on boot
sudo systemctl enable forward

# Start service
sudo systemctl start forward

# Check status
sudo systemctl status forward

# View logs
sudo journalctl -u forward -f
```

### Option B: Using PM2

```bash
# Install PM2 globally
npm install -g pm2

# Start application
pm2 start index.ts --interpreter bun --name forward

# Save process list
pm2 save

# Setup auto-start on reboot
pm2 startup
# Follow the command it outputs

# View logs
pm2 logs forward

# Monitor
pm2 monit
```

### Option C: Using Screen (Simple)

```bash
# Install screen
sudo apt-get install screen

# Start new screen session
screen -S forward

# Start application
bun start

# Detach: Press Ctrl+A, then D

# Reattach later
screen -r forward

# List sessions
screen -ls
```

---

## Step 9: Configure Firewall (Optional)

If running on a public server:

```bash
# Allow SSH
sudo ufw allow 22/tcp

# Enable firewall
sudo ufw enable

# Check status
sudo ufw status
```

**Note**: ForwARd doesn't expose any ports (only connects outbound to IMAP/SMTP/Arweave).

---

## Step 10: Set Up Log Rotation

Prevent logs from filling up disk:

```bash
sudo nano /etc/logrotate.d/forward
```

Paste:

```
/home/your-username/arweave-smtp-bridge/logs/*.log {
    daily
    rotate 7
    compress
    delaycompress
    missingok
    notifempty
    create 0644 your-username your-username
}
```

Test:
```bash
sudo logrotate -d /etc/logrotate.d/forward
```

---

## Monitoring & Maintenance

### View Logs

**Systemd:**
```bash
sudo journalctl -u forward -f
sudo journalctl -u forward --since "1 hour ago"
```

**PM2:**
```bash
pm2 logs forward
pm2 logs forward --lines 100
```

**File logs** (if configured):
```bash
tail -f logs/app.log
```

### Check Database

```bash
# View database
sqlite3 ./data/forward.db

# Common queries
SELECT * FROM users;
SELECT * FROM uploads ORDER BY created_at DESC LIMIT 10;
SELECT * FROM usage ORDER BY billing_month DESC;
SELECT * FROM processed_emails ORDER BY queued_at DESC LIMIT 10;
```

### Check Redis Queue

```bash
redis-cli

# List all keys
KEYS *

# Check queue length
LLEN bull:email-processor:wait

# View completed jobs
LRANGE bull:email-processor:completed 0 10
```

### Monitor Resource Usage

```bash
# CPU and Memory
htop

# Disk usage
df -h
du -sh ./data/

# Redis memory
redis-cli INFO memory
```

---

## Troubleshooting

### Service Won't Start

```bash
# Check logs
sudo journalctl -u forward -n 50

# Check environment
sudo systemctl show forward | grep Environment

# Test manually
cd ~/arweave-smtp-bridge
bun start
```

### Redis Connection Failed

```bash
# Check Redis is running
sudo systemctl status redis-server

# Test connection
redis-cli ping

# Check Redis logs
sudo journalctl -u redis-server -n 50
```

### IMAP Connection Failed

```bash
# Check Gmail settings
# - App Password enabled
# - IMAP enabled in Gmail settings

# Test credentials manually
openssl s_client -connect imap.gmail.com:993
# Then: a1 LOGIN your-email@gmail.com your-app-password
```

### Out of Disk Space

```bash
# Check disk usage
df -h

# Clear old logs
sudo journalctl --vacuum-time=7d

# Clear Redis
redis-cli FLUSHDB

# Clear old database entries (be careful!)
sqlite3 ./data/forward.db "DELETE FROM processed_emails WHERE queued_at < datetime('now', '-30 days');"
```

### Application Crashes

```bash
# Check for errors
sudo journalctl -u forward -p err

# Restart service
sudo systemctl restart forward

# Check wallet balance
# Low AR balance can cause upload failures
```

---

## Updating the Application

```bash
# Stop service
sudo systemctl stop forward

# Pull latest changes
git pull origin main

# Install any new dependencies
bun install

# Run migrations (if any)
bun run src/database/migrate.ts

# Start service
sudo systemctl start forward

# Check status
sudo systemctl status forward
```

---

## Backup & Restore

### Backup

```bash
# Create backup directory
mkdir -p ~/backups

# Backup database
cp ./data/forward.db ~/backups/forward-$(date +%Y%m%d).db

# Backup wallet (keep secure!)
cp wallet.json ~/backups/wallet-backup.json

# Backup environment
cp .env ~/backups/.env-backup

# Create full backup
tar -czf ~/backups/forward-full-$(date +%Y%m%d).tar.gz \
  ./data/ .env wallet.json
```

### Restore

```bash
# Stop service
sudo systemctl stop forward

# Restore database
cp ~/backups/forward-20241020.db ./data/forward.db

# Restore environment
cp ~/backups/.env-backup .env

# Start service
sudo systemctl start forward
```

### Automated Backups

```bash
# Add to crontab
crontab -e

# Add this line (daily backup at 2 AM)
0 2 * * * cd ~/arweave-smtp-bridge && cp ./data/forward.db ~/backups/forward-$(date +\%Y\%m\%d).db
```

---

## Performance Tuning

### For High Volume

If processing many emails:

**Redis:**
```bash
# Increase max memory
sudo nano /etc/redis/redis.conf
# Set: maxmemory 512mb
```

**Database:**
```bash
# Increase WAL checkpoint interval
sqlite3 ./data/forward.db
PRAGMA wal_checkpoint(TRUNCATE);
```

**BullMQ Concurrency:**

Edit `src/jobs/processors/email-processor.ts`:
```typescript
concurrency: 3, // Process 3 emails simultaneously
```

---

## Security Best Practices

1. **Wallet Security**
   - Never expose wallet.json
   - Use a dedicated wallet with limited funds
   - Regular backups to secure location

2. **Environment Variables**
   - Never commit .env to git
   - Use strong encryption keys
   - Rotate keys periodically

3. **Redis Security**
   - Enable password authentication
   - Bind to localhost only
   - Regular security updates

4. **Email Security**
   - Use Gmail App Passwords (not regular password)
   - Limit allowlist to known addresses
   - Monitor for abuse

5. **System Security**
   - Keep server updated: `sudo apt-get update && sudo apt-get upgrade`
   - Enable firewall
   - Use SSH keys (disable password auth)
   - Regular security audits

---

## Support & Resources

- **Documentation**: See `CLAUDE.md`, `TESTING.md`
- **Logs**: `sudo journalctl -u forward -f`
- **Database**: `sqlite3 ./data/forward.db`
- **ArDrive**: https://ardrive.io
- **Issues**: Check git repository issues

---

*Ready to deploy!* 🚀
