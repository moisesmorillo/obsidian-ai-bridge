import {
	mergeRelationalMigrations,
	relationalSchemaDefinitions,
} from "@worker/infrastructure/sqlite/migration-chain";
import { describe, expect, it } from "vitest";

describe("versioned relational migration chain", () => {
	it("merges sequential migration statements and rejects a missing version", () => {
		const migrations = [
			{
				name: "0000_initial.sql",
				sql: "CREATE TABLE `meta` (`key` text);",
			},
			{
				name: "0001_exports.sql",
				sql: "CREATE TABLE `packed_exports` (`id` text);",
			},
		];
		expect(mergeRelationalMigrations(migrations)).toEqual([
			"CREATE TABLE `meta` (`key` text);",
			"CREATE TABLE `packed_exports` (`id` text);",
		]);
		expect(relationalSchemaDefinitions(migrations)).toEqual(
			new Map([
				["meta", "CREATE TABLE `meta` (`key` text)"],
				["packed_exports", "CREATE TABLE `packed_exports` (`id` text)"],
			]),
		);
		const first = migrations[0];
		const second = migrations[1];
		if (!first || !second) throw new Error("Migration fixture is incomplete");
		expect(() =>
			mergeRelationalMigrations([
				first,
				{ ...second, name: "0002_exports.sql" },
			]),
		).toThrow("Expected sequential relational migration files");
	});
});
