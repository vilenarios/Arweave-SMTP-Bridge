import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

// Users table
export const users = sqliteTable('users', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  email: text('email').notNull().unique(),
  emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(false),
  allowed: integer('allowed', { mode: 'boolean' }).notNull().default(true),
  plan: text('plan', { enum: ['free', 'paid'] }).notNull().default('free'),
  stripeCustomerId: text('stripe_customer_id'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
});

// Uploads table
export const uploads = sqliteTable('uploads', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text('user_id').notNull().references(() => users.id),
  emailMessageId: text('email_message_id'), // Original email message ID
  fileName: text('file_name').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  contentType: text('content_type').notNull(),
  status: text('status', { enum: ['pending', 'processing', 'completed', 'failed'] }).notNull().default('pending'),

  // ArDrive specific fields
  driveId: text('drive_id'),
  entityId: text('entity_id'), // ArDrive file entity ID
  dataTxId: text('data_tx_id'), // Transaction ID on Arweave
  fileKey: text('file_key'), // For private uploads
  emailFolderEntityId: text('email_folder_entity_id'), // Parent folder for this email's files

  errorMessage: text('error_message'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
  completedAt: integer('completed_at', { mode: 'timestamp' }),
});

// Usage tracking table (per billing period)
export const usage = sqliteTable('usage', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text('user_id').notNull().references(() => users.id),

  // Billing period
  periodStart: integer('period_start', { mode: 'timestamp' }).notNull(),
  periodEnd: integer('period_end', { mode: 'timestamp' }).notNull(),

  // Usage metrics
  uploadsCount: integer('uploads_count').notNull().default(0),
  bytesUploaded: integer('bytes_uploaded').notNull().default(0),

  // Billing
  costUsd: real('cost_usd').notNull().default(0), // Total cost for this period
  billed: integer('billed', { mode: 'boolean' }).notNull().default(false),

  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
});

// Payment transactions
export const payments = sqliteTable('payments', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text('user_id').notNull().references(() => users.id),

  // Stripe details
  stripePaymentIntentId: text('stripe_payment_intent_id').unique(),
  stripeChargeId: text('stripe_charge_id'),

  amountUsd: real('amount_usd').notNull(),
  status: text('status', { enum: ['pending', 'succeeded', 'failed', 'refunded'] }).notNull(),

  // Link to usage period (optional)
  usageId: text('usage_id').references(() => usage.id),

  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
  completedAt: integer('completed_at', { mode: 'timestamp' }),
});

// ArDrive drives per user (one private drive per user)
export const userDrives = sqliteTable('user_drives', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text('user_id').notNull().references(() => users.id),

  driveId: text('drive_id').notNull().unique(),
  driveType: text('drive_type', { enum: ['private', 'public'] }).notNull(),
  rootFolderId: text('root_folder_id').notNull(),

  // For private drives
  drivePasswordEncrypted: text('drive_password_encrypted'),
  driveKeyBase64: text('drive_key_base64'), // Derived drive key for sharing URLs
  welcomeEmailSent: integer('welcome_email_sent', { mode: 'boolean' }).notNull().default(false),

  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
});

// ArDrive folder cache (year/month folders to avoid recreating)
export const driveFolders = sqliteTable('drive_folders', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text('user_id').notNull().references(() => users.id),
  driveId: text('drive_id').notNull(),

  folderType: text('folder_type', { enum: ['year', 'month'] }).notNull(),
  folderName: text('folder_name').notNull(), // e.g., "2025" or "01"
  parentFolderId: text('parent_folder_id').notNull(), // Parent folder entity ID
  folderEntityId: text('folder_entity_id').notNull(), // This folder's entity ID

  year: integer('year').notNull(), // e.g., 2025
  month: integer('month'), // e.g., 1 (only for month folders)

  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
});

// Processed emails tracking (prevents duplicate processing)
export const processedEmails = sqliteTable('processed_emails', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  uid: integer('uid').notNull().unique(), // IMAP UID
  messageId: text('message_id'), // Email Message-ID header
  sender: text('sender').notNull(), // From address
  subject: text('subject'), // Email subject

  status: text('status', { enum: ['queued', 'processing', 'completed', 'failed'] }).notNull().default('queued'),
  errorMessage: text('error_message'),

  // ArDrive folder and .eml file tracking
  folderEntityId: text('folder_entity_id'), // Email folder in ArDrive (YYYY-MM-DD_HH-MM-SS_Subject)
  emlFileEntityId: text('eml_file_entity_id'), // .eml file entity ID
  emlFileKey: text('eml_file_key'), // File key for .eml (private files)
  folderName: text('folder_name'), // Human-readable folder name

  queuedAt: integer('queued_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
  processedAt: integer('processed_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

export type Upload = typeof uploads.$inferSelect;
export type NewUpload = typeof uploads.$inferInsert;

export type Usage = typeof usage.$inferSelect;
export type NewUsage = typeof usage.$inferInsert;

export type Payment = typeof payments.$inferSelect;
export type NewPayment = typeof payments.$inferInsert;

export type UserDrive = typeof userDrives.$inferSelect;
export type NewUserDrive = typeof userDrives.$inferInsert;

export type ProcessedEmail = typeof processedEmails.$inferSelect;
export type NewProcessedEmail = typeof processedEmails.$inferInsert;

export type DriveFolder = typeof driveFolders.$inferSelect;
export type NewDriveFolder = typeof driveFolders.$inferInsert;
