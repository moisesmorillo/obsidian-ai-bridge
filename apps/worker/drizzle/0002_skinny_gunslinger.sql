CREATE TABLE `blob_gc` (
	`hash` text PRIMARY KEY NOT NULL,
	`size` integer NOT NULL,
	`marked_at` integer NOT NULL
);
