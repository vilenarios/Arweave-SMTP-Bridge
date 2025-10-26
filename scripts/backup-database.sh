#!/bin/bash
# Database Backup Script for ForwARd
# Backs up SQLite database with timestamps and rotation

set -e  # Exit on error

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
DB_FILE="$PROJECT_ROOT/data/forward.db"
BACKUP_DIR="$PROJECT_ROOT/backups"
KEEP_BACKUPS=30  # Keep last 30 backups (30 days if running daily)

# Create backup directory if it doesn't exist
mkdir -p "$BACKUP_DIR"

# Check if database exists
if [ ! -f "$DB_FILE" ]; then
    echo "ERROR: Database file not found: $DB_FILE"
    exit 1
fi

# Generate timestamp
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_FILE="$BACKUP_DIR/forward-backup-$TIMESTAMP.db"

# Create backup using SQLite's .backup command (atomic and consistent)
echo "Creating backup: $BACKUP_FILE"
sqlite3 "$DB_FILE" ".backup '$BACKUP_FILE'"

# Verify backup was created
if [ ! -f "$BACKUP_FILE" ]; then
    echo "ERROR: Backup file was not created"
    exit 1
fi

# Get backup file size
BACKUP_SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
echo "✅ Backup created successfully: $BACKUP_SIZE"

# Rotate old backups (keep only last N backups)
echo "Rotating old backups (keeping last $KEEP_BACKUPS)..."
cd "$BACKUP_DIR"
ls -t forward-backup-*.db 2>/dev/null | tail -n +$((KEEP_BACKUPS + 1)) | xargs -r rm -f

# Count remaining backups
BACKUP_COUNT=$(ls -1 forward-backup-*.db 2>/dev/null | wc -l)
echo "Total backups: $BACKUP_COUNT"

echo "Backup complete!"
