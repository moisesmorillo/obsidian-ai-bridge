import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migratePluginData } from "../tools/migrate-plugin";

const temporaryRoots: string[] = [];

/** Creates an isolated Obsidian vault fixture for migration behavior. */
function createVault(): string {
	const root = mkdtempSync(join(tmpdir(), "vaultwire-migration-"));
	temporaryRoots.push(root);
	mkdirSync(join(root, ".obsidian/plugins/ai-bridge"), { recursive: true });
	return root;
}

afterEach(() => {
	for (const root of temporaryRoots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

describe("offline plugin data migration", () => {
	it("backs up data and copies it without changing the old folder or pending payloads", async () => {
		const root = createVault();
		const oldData = join(root, ".obsidian/plugins/ai-bridge/data.json");
		const pending = join(root, ".ai-bridge/pending/operation-payload");
		mkdirSync(join(root, ".ai-bridge/pending"), { recursive: true });
		writeFileSync(oldData, '{"serverUrl":"https://example.invalid"}');
		writeFileSync(pending, "unsynced-edit");

		const result = await migratePluginData(root);

		expect(
			readFileSync(join(root, ".obsidian/plugins/vaultwire/data.json"), "utf8"),
		).toBe(readFileSync(oldData, "utf8"));
		expect(
			readFileSync(join(result.backupDirectory, "data.json"), "utf8"),
		).toBe(readFileSync(oldData, "utf8"));
		expect(readFileSync(pending, "utf8")).toBe("unsynced-edit");
		expect(readFileSync(oldData, "utf8")).toContain("example.invalid");
	});

	it("refuses a target that is not an Obsidian vault", async () => {
		const root = mkdtempSync(join(tmpdir(), "not-a-vault-"));
		temporaryRoots.push(root);
		await expect(migratePluginData(root)).rejects.toThrow(/Obsidian vault/);
	});

	it("refuses an existing Vaultwire folder without changing either folder", async () => {
		const root = createVault();
		const oldData = join(root, ".obsidian/plugins/ai-bridge/data.json");
		const newData = join(root, ".obsidian/plugins/vaultwire/data.json");
		mkdirSync(join(root, ".obsidian/plugins/vaultwire"));
		writeFileSync(oldData, "old");
		writeFileSync(newData, "new");

		await expect(migratePluginData(root)).rejects.toThrow(/already exists/);
		expect(readFileSync(oldData, "utf8")).toBe("old");
		expect(readFileSync(newData, "utf8")).toBe("new");
	});

	it("keeps a complete backup and source after the staged copy fails", async () => {
		const root = createVault();
		const oldData = join(root, ".obsidian/plugins/ai-bridge/data.json");
		writeFileSync(oldData, "shared-settings");
		let copies = 0;
		/** Fails only the staged copy after the recovery backup succeeds. */
		const failSecondCopy: typeof copyFile = async (
			source,
			destination,
			mode,
		) => {
			copies += 1;
			if (copies === 2) throw new Error("simulated copy failure");
			return copyFile(source, destination, mode);
		};

		await expect(migratePluginData(root, failSecondCopy)).rejects.toThrow(
			/simulated copy failure/,
		);
		expect(readFileSync(oldData, "utf8")).toBe("shared-settings");
		expect(
			readFileSync(
				join(root, ".obsidian/plugins/ai-bridge-vaultwire-backup/data.json"),
				"utf8",
			),
		).toBe("shared-settings");
		expect(() =>
			readFileSync(join(root, ".obsidian/plugins/vaultwire/data.json")),
		).toThrow();
	});
});
