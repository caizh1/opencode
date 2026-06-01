ALTER TABLE `todo` ADD `id` text DEFAULT '' NOT NULL;--> statement-breakpoint
UPDATE `todo` SET `id` = 'todo_' || lower(hex(randomblob(16))) WHERE `id` = '';
