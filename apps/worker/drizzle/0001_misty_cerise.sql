CREATE TABLE `packed_export_files` (
	`export_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`path` text NOT NULL,
	`rev` integer NOT NULL,
	`hash` text NOT NULL,
	`size` integer NOT NULL,
	PRIMARY KEY(`export_id`, `ordinal`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `packed_export_files_path` ON `packed_export_files` (`export_id`,`path`);--> statement-breakpoint
CREATE TABLE `packed_exports` (
	`id` text PRIMARY KEY NOT NULL,
	`epoch` text NOT NULL,
	`created_at` text NOT NULL,
	`head_seq` integer NOT NULL,
	`status` text NOT NULL,
	`object_key` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`size` integer,
	`upload_id` text,
	`zip_state` text NOT NULL,
	`pending_part` blob NOT NULL,
	`completed_parts` text NOT NULL,
	`manifest` text NOT NULL,
	`error` text,
	CONSTRAINT "packed_exports_status_check" CHECK("packed_exports"."status" IN ('queued', 'uploading', 'complete', 'failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `packed_exports_identity` ON `packed_exports` (`epoch`,`created_at`);