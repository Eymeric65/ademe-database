ALTER TABLE `saved_building` ADD `source` text DEFAULT 'existant' NOT NULL CHECK (`source` in ('existant', 'neuf', 'tertiaire', 'audit'));--> statement-breakpoint
ALTER TABLE `saved_building` ADD `dept` text;--> statement-breakpoint
DROP INDEX IF EXISTS `saved_building_user_dpe_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `saved_building_user_source_key_unique` ON `saved_building` (`user_id`,`source`,`numero_dpe`);
