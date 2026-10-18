/** Generated from Drizzle Kit's versioned initial migration; do not edit. */
export const RELATIONAL_SCHEMA_STATEMENTS = [
	"CREATE TABLE `blob_refs` (\n\t`hash` text PRIMARY KEY,\n\t`size` integer NOT NULL,\n\t`first_ref_at` integer NOT NULL\n);",
	"CREATE TABLE `changes` (\n\t`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,\n\t`op` text NOT NULL,\n\t`path` text NOT NULL,\n\t`rev` integer NOT NULL,\n\t`hash` text NOT NULL,\n\t`from_path` text,\n\t`from_rev` integer,\n\t`origin` text NOT NULL,\n\t`at` integer NOT NULL,\n\tCONSTRAINT \"changes_op_check\" CHECK(\"changes\".\"op\" IN ('put', 'delete', 'rename'))\n);",
	"CREATE TABLE `clients` (\n\t`id` text PRIMARY KEY,\n\t`name` text NOT NULL,\n\t`kind` text NOT NULL,\n\t`created_at` integer NOT NULL,\n\t`last_seen_at` integer,\n\tCONSTRAINT \"clients_kind_check\" CHECK(\"clients\".\"kind\" IN ('device', 'agent', 'app'))\n);",
	"CREATE TABLE `export_pins` (\n\t`export_id` text NOT NULL,\n\t`path` text NOT NULL,\n\t`rev` integer NOT NULL,\n\tPRIMARY KEY(`export_id`, `path`, `rev`)\n);",
	"CREATE TABLE `exports` (\n\t`id` text PRIMARY KEY,\n\t`started_at` integer,\n\t`finished_at` integer,\n\t`status` text,\n\t`head_seq` integer,\n\t`calls_this_hour` integer,\n\t`hour_started_at` integer,\n\t`commit_sha` text,\n\t`error` text\n);",
	'CREATE TABLE `files` (\n\t`path` text PRIMARY KEY,\n\t`path_key` text NOT NULL,\n\t`rev` integer NOT NULL,\n\t`seq` integer NOT NULL,\n\t`hash` text NOT NULL,\n\t`size` integer NOT NULL,\n\t`kind` text NOT NULL,\n\t`content` text,\n\t`blob_hash` text,\n\t`deleted` integer DEFAULT 0 NOT NULL,\n\t`updated_at` integer NOT NULL,\n\t`origin` text NOT NULL,\n\tCONSTRAINT "files_kind_check" CHECK("files"."kind" IN (\'text\', \'blob\'))\n);',
	'CREATE UNIQUE INDEX `files_live_key` ON `files` (`path_key`) WHERE "files"."deleted" = 0;',
	"CREATE INDEX `files_key` ON `files` (`path_key`);",
	"CREATE TABLE `meta` (\n\t`key` text PRIMARY KEY,\n\t`value` text NOT NULL\n);",
	"CREATE TABLE `operation_admissions` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`client_id` text NOT NULL,\n\t`grant_id` text NOT NULL,\n\t`epoch` text NOT NULL,\n\t`fingerprint` text NOT NULL,\n\t`admitted_at` integer NOT NULL,\n\t`expires_at` integer NOT NULL,\n\t`state` text NOT NULL,\n\tCONSTRAINT \"operation_admissions_state_check\" CHECK(\"operation_admissions\".\"state\" IN ('reserved', 'active', 'uncertain'))\n);",
	"CREATE INDEX `operation_admissions_client_expiry` ON `operation_admissions` (`client_id`,`expires_at`);",
	"CREATE INDEX `operation_admissions_expiry` ON `operation_admissions` (`expires_at`);",
	"CREATE TABLE `receipts` (\n\t`client_id` text NOT NULL,\n\t`key` text NOT NULL,\n\t`fingerprint` text NOT NULL,\n\t`status` integer NOT NULL,\n\t`body` text NOT NULL,\n\t`at` integer NOT NULL,\n\tPRIMARY KEY(`client_id`, `key`)\n);",
	"CREATE TABLE `revisions` (\n\t`path` text NOT NULL,\n\t`rev` integer NOT NULL,\n\t`hash` text NOT NULL,\n\t`size` integer NOT NULL,\n\t`kind` text NOT NULL,\n\t`content` text,\n\t`blob_hash` text,\n\t`deleted` integer NOT NULL,\n\t`origin` text NOT NULL,\n\t`at` integer NOT NULL,\n\tPRIMARY KEY(`path`, `rev`)\n);",
	"CREATE TABLE `revoked_grants` (\n\t`grant_id` text PRIMARY KEY,\n\t`at` integer NOT NULL\n);",
] as const;
