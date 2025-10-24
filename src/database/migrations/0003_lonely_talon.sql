CREATE TABLE `credit_shares` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`approval_data_item_id` text NOT NULL,
	`approved_winc_amount` integer NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `users` ADD `user_wallet_address` text;--> statement-breakpoint
ALTER TABLE `users` ADD `user_wallet_seed_phrase_encrypted` text;--> statement-breakpoint
ALTER TABLE `users` ADD `user_wallet_jwk_encrypted` text;--> statement-breakpoint
ALTER TABLE `users` ADD `seed_phrase_downloaded_at` integer;