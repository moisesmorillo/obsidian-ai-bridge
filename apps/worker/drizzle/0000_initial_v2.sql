CREATE TABLE `blob_refs` (
	`hash` text PRIMARY KEY,
	`size` integer NOT NULL,
	`first_ref_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `changes` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`op` text NOT NULL,
	`path` text NOT NULL,
	`rev` integer NOT NULL,
	`hash` text NOT NULL,
	`from_path` text,
	`from_rev` integer,
	`origin` text NOT NULL,
	`at` integer NOT NULL,
	CONSTRAINT "changes_op_check" CHECK("changes"."op" IN ('put', 'delete', 'rename'))
);
--> statement-breakpoint
CREATE TABLE `clients` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_seen_at` integer,
	CONSTRAINT "clients_kind_check" CHECK("clients"."kind" IN ('device', 'agent', 'app'))
);
--> statement-breakpoint
CREATE TABLE `export_pins` (
	`export_id` text NOT NULL,
	`path` text NOT NULL,
	`rev` integer NOT NULL,
	PRIMARY KEY(`export_id`, `path`, `rev`)
);
--> statement-breakpoint
CREATE TABLE `exports` (
	`id` text PRIMARY KEY,
	`started_at` integer,
	`finished_at` integer,
	`status` text,
	`head_seq` integer,
	`calls_this_hour` integer,
	`hour_started_at` integer,
	`commit_sha` text,
	`error` text
);
--> statement-breakpoint
CREATE TABLE `files` (
	`path` text PRIMARY KEY,
	`path_key` text NOT NULL,
	`rev` integer NOT NULL,
	`seq` integer NOT NULL,
	`hash` text NOT NULL,
	`size` integer NOT NULL,
	`kind` text NOT NULL,
	`content` text,
	`blob_hash` text,
	`deleted` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	`origin` text NOT NULL,
	CONSTRAINT "files_kind_check" CHECK("files"."kind" IN ('text', 'blob'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `files_live_key` ON `files` (`path_key`) WHERE "files"."deleted" = 0;--> statement-breakpoint
CREATE INDEX `files_key` ON `files` (`path_key`);--> statement-breakpoint
CREATE TABLE `meta` (
	`key` text PRIMARY KEY,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `operation_admissions` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`grant_id` text NOT NULL,
	`epoch` text NOT NULL,
	`fingerprint` text NOT NULL,
	`admitted_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`state` text NOT NULL,
	CONSTRAINT "operation_admissions_state_check" CHECK("operation_admissions"."state" IN ('reserved', 'active', 'uncertain'))
);
--> statement-breakpoint
CREATE INDEX `operation_admissions_client_expiry` ON `operation_admissions` (`client_id`,`expires_at`);--> statement-breakpoint
CREATE INDEX `operation_admissions_expiry` ON `operation_admissions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `receipts` (
	`client_id` text NOT NULL,
	`key` text NOT NULL,
	`fingerprint` text NOT NULL,
	`status` integer NOT NULL,
	`body` text NOT NULL,
	`at` integer NOT NULL,
	PRIMARY KEY(`client_id`, `key`)
);
--> statement-breakpoint
CREATE TABLE `revisions` (
	`path` text NOT NULL,
	`rev` integer NOT NULL,
	`hash` text NOT NULL,
	`size` integer NOT NULL,
	`kind` text NOT NULL,
	`content` text,
	`blob_hash` text,
	`deleted` integer NOT NULL,
	`origin` text NOT NULL,
	`at` integer NOT NULL,
	PRIMARY KEY(`path`, `rev`)
);
--> statement-breakpoint
CREATE TABLE `revoked_grants` (
	`grant_id` text PRIMARY KEY,
	`at` integer NOT NULL
);
