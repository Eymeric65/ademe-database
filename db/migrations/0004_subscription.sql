CREATE TABLE `subscription` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`subscription_id` text,
	`customer_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`paid_until` integer,
	`cancel_at_period_end` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "subscription_status_known" CHECK("subscription"."status" in ('pending', 'incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused'))
);
--> statement-breakpoint
CREATE INDEX `subscription_user_idx` ON `subscription` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `subscription_subscription_id_unique` ON `subscription` (`subscription_id`);