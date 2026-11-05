import {
	defaultF4CredentialRoot,
	readAccessCookieFile,
} from "@tooling/f4-credentials";
import { describe, expect, it } from "vitest";

const root = "/synthetic/config/f4";

/** Creates an in-memory filesystem double and records every access for boundary tests. */
function access(
	files: Record<
		string,
		{ kind: "file" | "directory" | "symlink" | "special"; text?: string }
	>,
) {
	const visited: string[] = [];
	return {
		visited,
		/** Returns the synthetic file type without resolving symbolic links. */
		async lstat(path: string) {
			visited.push(path);
			const entry = files[path];
			if (!entry)
				throw Object.assign(new Error("missing path"), { code: "ENOENT" });
			return { kind: entry.kind, size: entry.text?.length ?? 0 };
		},
		/** Returns synthetic bytes only when they fit the reader's byte limit. */
		async readBoundedRegularFile(path: string, maxBytes: number) {
			visited.push(path);
			const text = files[path]?.text;
			if (text === undefined) throw new Error("missing bytes");
			if (text.length > maxBytes) throw new Error("too large");
			return text;
		},
	};
}

describe("F4 credential file reader", () => {
	it("uses the dedicated per-user directory outside the vault and repository", () => {
		expect(defaultF4CredentialRoot("/synthetic/home")).toBe(
			"/synthetic/home/.config/obsidian-ai-bridge/f4",
		);
	});

	it("reads only a bounded regular file under the dedicated root", async () => {
		const io = access({
			"/synthetic": { kind: "directory" },
			"/synthetic/config": { kind: "directory" },
			"/synthetic/config/f4": { kind: "directory" },
			"/synthetic/config/f4/access.cookie": {
				kind: "file",
				text: "session=example",
			},
		});
		expect(await readAccessCookieFile(`${root}/access.cookie`, root, io)).toBe(
			"session=example",
		);
	});

	it.each([
		["traversal", `${root}/../vault/cookie`],
		["outside path", "/synthetic/vault/.obsidian/cookie"],
		["absolute path mismatch", `${root}/nested/../access.cookie`],
	])("rejects %s before filesystem access", async (_name, path) => {
		const io = access({});
		await expect(readAccessCookieFile(path, root, io)).rejects.toThrow(
			"Invalid credential file path",
		);
		expect(io.visited).toEqual([]);
	});

	it.each([
		["symlink directory", "symlink", `${root}/nested/access.cookie`],
		["symlink file", "symlink", `${root}/access.cookie`],
		["special file", "special", `${root}/access.cookie`],
	])("rejects %s", async (_name, kind, path) => {
		const io = access({
			"/synthetic": { kind: "directory" },
			"/synthetic/config": { kind: "directory" },
			"/synthetic/config/f4": { kind: "directory" },
			[`${root}/nested`]: {
				kind: kind === "symlink" ? "symlink" : "directory",
			},
			[path]: { kind: kind as "symlink" | "special" },
		});
		await expect(readAccessCookieFile(path, root, io)).rejects.toThrow(
			"Credential file unavailable",
		);
	});

	it("rejects oversized content with a static error", async () => {
		const io = access({
			"/synthetic": { kind: "directory" },
			"/synthetic/config": { kind: "directory" },
			"/synthetic/config/f4": { kind: "directory" },
			[`${root}/access.cookie`]: { kind: "file", text: "x".repeat(16_385) },
		});
		await expect(
			readAccessCookieFile(`${root}/access.cookie`, root, io),
		).rejects.toThrow("Credential file unavailable");
	});
});
