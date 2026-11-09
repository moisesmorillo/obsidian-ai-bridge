import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

/** Caps credential input before decoding to prevent unbounded local reads. */
const MAX_CREDENTIAL_BYTES = 16_384;

/** Minimal injectable filesystem boundary for checking and reading one credential file. */
export interface CredentialFileAccess {
	/** Checks path type without following a symbolic link. */
	lstat(path: string): Promise<{
		kind: "file" | "directory" | "symlink" | "special";
		size: number;
		/** POSIX mode used to reject group or other access below the credential root. */
		mode: number;
	}>;
	/** Reads a bounded regular file after its opened mode and size pass checks. */
	readBoundedRegularFile(path: string, maxBytes: number): Promise<string>;
}

/** Returns the dedicated credential directory outside the repository and vault. */
export function defaultF4CredentialRoot(home: string): string {
	return resolve(home, ".config", "vaultwire", "f4");
}

/** Checks the lexical file boundary before any filesystem access. */
function validateCredentialPath(
	path: string,
	credentialRoot: string,
): string[] {
	if (!isAbsolute(path) || !isAbsolute(credentialRoot))
		throw new Error("Invalid credential file path");
	const root = resolve(credentialRoot);
	const target = resolve(path);
	const segments = path.split(sep);
	if (segments.includes("..") || target === root)
		throw new Error("Invalid credential file path");
	const rel = relative(root, target);
	if (!rel || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel))
		throw new Error("Invalid credential file path");
	const rootParts = root.split(sep).filter(Boolean);
	const targetParts = rel.split(sep);
	return [
		...rootParts.map(
			(_, index) => `${sep}${rootParts.slice(0, index + 1).join(sep)}`,
		),
		...targetParts.map((_, index) =>
			resolve(root, ...targetParts.slice(0, index + 1)),
		),
	];
}

/** Rejects a cookie path outside the dedicated root before filesystem access. */
export function assertAccessCookiePath(
	path: string,
	credentialRoot: string,
): void {
	validateCredentialPath(path, credentialRoot);
}

/**
 * Reads one bounded regular cookie file and hides filesystem errors and paths.
 * It checks types along the path, rejects group or other access below the dedicated root,
 * and opens the final file without following links. It does not check ancestor mode bits.
 * Parent components are not pinned to open directory handles, so their writers must be trusted.
 */
export async function readAccessCookieFile(
	path: string,
	credentialRoot: string,
	access?: CredentialFileAccess,
): Promise<string> {
	const components = validateCredentialPath(path, credentialRoot);
	const credentialRootComponentIndex = Math.max(
		0,
		resolve(credentialRoot).split(sep).filter(Boolean).length - 1,
	);
	const filesystem = access ?? nativeCredentialFileAccess;
	try {
		for (let index = 0; index < components.length; index += 1) {
			const component = await filesystem.lstat(components[index] as string);
			const isFile = index === components.length - 1;
			if (component.kind === "symlink") throw new Error("unsafe");
			if (isFile && component.kind !== "file") throw new Error("unsafe");
			if (!isFile && component.kind !== "directory") throw new Error("unsafe");
			if (
				index >= credentialRootComponentIndex &&
				!hasPrivatePermissions(component.mode)
			)
				throw new Error("unsafe");
			if (isFile && component.size > MAX_CREDENTIAL_BYTES)
				throw new Error("unsafe");
		}
		return await filesystem.readBoundedRegularFile(path, MAX_CREDENTIAL_BYTES);
	} catch {
		throw new Error("Credential file unavailable");
	}
}

/** Rejects group or other permission bits on the dedicated credential tree. */
function hasPrivatePermissions(mode: number): boolean {
	return (mode & 0o077) === 0;
}

/** Uses no-follow open flags and a fixed-size read for the real credential file. */
const nativeCredentialFileAccess: CredentialFileAccess = {
	/** Reports filesystem object type and size without following links. */
	async lstat(path) {
		const stat = await lstat(path);
		return {
			kind: stat.isSymbolicLink()
				? "symlink"
				: stat.isDirectory()
					? "directory"
					: stat.isFile()
						? "file"
						: "special",
			size: stat.size,
			mode: stat.mode,
		};
	},
	/** Opens without following the final link and reads at most maxBytes plus one. */
	async readBoundedRegularFile(path, maxBytes) {
		const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			const stat = await file.stat();
			if (
				!stat.isFile() ||
				stat.size > maxBytes ||
				!hasPrivatePermissions(stat.mode)
			)
				throw new Error("unsafe");
			const chunks: Buffer[] = [];
			let totalBytes = 0;
			while (totalBytes <= maxBytes) {
				const buffer = Buffer.alloc(Math.min(4_096, maxBytes + 1 - totalBytes));
				const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
				if (bytesRead === 0) break;
				totalBytes += bytesRead;
				if (totalBytes > maxBytes) throw new Error("unsafe");
				chunks.push(buffer.subarray(0, bytesRead));
			}
			return new TextDecoder("utf-8", { fatal: true }).decode(
				Buffer.concat(chunks, totalBytes),
			);
		} finally {
			await file.close();
		}
	},
};
