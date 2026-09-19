ALTER TABLE `user` ADD `plan` text DEFAULT 'free' NOT NULL CHECK (`plan` in ('free', 'paid'));
