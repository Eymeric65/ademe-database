ALTER TABLE `user` ADD `plan_next` text DEFAULT 'free' NOT NULL CHECK (`plan_next` in ('free', 'decouverte'));--> statement-breakpoint
UPDATE `user` SET `plan_next` = 'decouverte' WHERE `plan` = 'paid';--> statement-breakpoint
ALTER TABLE `user` DROP COLUMN `plan`;--> statement-breakpoint
ALTER TABLE `user` RENAME COLUMN `plan_next` TO `plan`;
