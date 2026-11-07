CREATE TABLE `packed_export_chunks` (
	`export_id` text NOT NULL,
	`kind` text NOT NULL,
	`ordinal` integer NOT NULL,
	`data` blob NOT NULL,
	PRIMARY KEY(`export_id`, `kind`, `ordinal`),
	CONSTRAINT "packed_export_chunks_kind_check" CHECK("packed_export_chunks"."kind" IN ('manifest', 'pending', 'source')),
	CONSTRAINT "packed_export_chunks_data_size_check" CHECK(length(data) <= 1000000)
);
--> statement-breakpoint
CREATE TABLE `packed_export_files` (
	`export_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`path` text NOT NULL,
	`rev` integer NOT NULL,
	`hash` text NOT NULL,
	`size` integer NOT NULL,
	`source_type` text NOT NULL,
	PRIMARY KEY(`export_id`, `ordinal`),
	CONSTRAINT "packed_export_files_source_type_check" CHECK("packed_export_files"."source_type" IN ('revision_text', 'revision_blob', 'snapshot_text', 'snapshot_blob'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `packed_export_files_path` ON `packed_export_files` (`export_id`,`path`);
--> statement-breakpoint
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
	`manifest_size` integer NOT NULL,
	`completed_parts` text NOT NULL,
	`error` text,
	CONSTRAINT "packed_exports_status_check" CHECK("packed_exports"."status" IN ('queued', 'uploading', 'complete', 'failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `packed_exports_identity` ON `packed_exports` (`epoch`,`created_at`);
