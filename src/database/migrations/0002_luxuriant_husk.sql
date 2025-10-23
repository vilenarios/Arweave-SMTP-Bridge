CREATE TABLE `drive_folders` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`drive_id` text NOT NULL,
	`folder_type` text NOT NULL,
	`folder_name` text NOT NULL,
	`parent_folder_id` text NOT NULL,
	`folder_entity_id` text NOT NULL,
	`year` integer NOT NULL,
	`month` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `processed_emails` ADD `folder_entity_id` text;--> statement-breakpoint
ALTER TABLE `processed_emails` ADD `eml_file_entity_id` text;--> statement-breakpoint
ALTER TABLE `processed_emails` ADD `eml_file_key` text;--> statement-breakpoint
ALTER TABLE `processed_emails` ADD `folder_name` text;--> statement-breakpoint
ALTER TABLE `uploads` ADD `email_folder_entity_id` text;--> statement-breakpoint
ALTER TABLE `user_drives` ADD `drive_key_base64` text;--> statement-breakpoint
ALTER TABLE `user_drives` ADD `welcome_email_sent` integer DEFAULT false NOT NULL;