CREATE TABLE `processed_emails` (
	`id` text PRIMARY KEY NOT NULL,
	`uid` integer NOT NULL,
	`message_id` text,
	`sender` text NOT NULL,
	`subject` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`error_message` text,
	`queued_at` integer NOT NULL,
	`processed_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `processed_emails_uid_unique` ON `processed_emails` (`uid`);