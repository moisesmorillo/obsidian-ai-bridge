import {
	EpochSchema,
	ETagSchema,
	PathSchema,
	parseETag,
} from "@vaultwire/protocol";

/** Frozen entry shape from the plugin 1.0.3 manifest page contract. */
interface LegacyManifestEntry {
	path: string;
	etag: string;
	seq: number;
	hash: string;
	size: number;
	kind: "text" | "blob";
	deleted: boolean;
	large: boolean;
}

/** Frozen page shape from the plugin 1.0.3 manifest page contract. */
interface LegacyManifestPage {
	epoch: string;
	head_seq: number;
	entries: LegacyManifestEntry[];
	next_page: string | null;
}

/** Compare validated vault paths in the byte order used by SQLite and main's page schema. */
function compareSqliteBinaryPath(left: string, right: string): number {
	const encoder = new TextEncoder();
	const leftBytes = encoder.encode(left);
	const rightBytes = encoder.encode(right);
	const sharedLength = Math.min(leftBytes.length, rightBytes.length);
	for (let index = 0; index < sharedLength; index += 1) {
		if (leftBytes[index] !== rightBytes[index])
			return leftBytes[index] - rightBytes[index];
	}
	return leftBytes.length - rightBytes.length;
}

/** Frozen main-branch 1.0.3 manifest validator for compatibility tests. */
export function parseLegacyPlugin103ManifestPage(
	value: unknown,
): LegacyManifestPage | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		return undefined;
	const page = value as Record<string, unknown>;
	if (
		Object.keys(page).sort().join(",") !== "entries,epoch,head_seq,next_page" ||
		!EpochSchema.safeParse(page.epoch).success ||
		!Number.isSafeInteger(page.head_seq) ||
		(page.head_seq as number) < 0 ||
		!Array.isArray(page.entries) ||
		page.entries.length > 256 ||
		!(
			page.next_page === null ||
			(typeof page.next_page === "string" && page.next_page.length <= 4096)
		)
	)
		return undefined;
	const entries: LegacyManifestEntry[] = [];
	for (const item of page.entries) {
		if (typeof item !== "object" || item === null || Array.isArray(item))
			return undefined;
		const entry = item as Record<string, unknown>;
		if (
			Object.keys(entry).sort().join(",") !==
				"deleted,etag,hash,kind,large,path,seq,size" ||
			!PathSchema.safeParse(entry.path).success ||
			!ETagSchema.safeParse(entry.etag).success ||
			!Number.isSafeInteger(entry.seq) ||
			(entry.seq as number) <= 0 ||
			!(
				typeof entry.hash === "string" &&
				(entry.hash === "" || /^[0-9a-f]{64}$/.test(entry.hash))
			) ||
			!Number.isSafeInteger(entry.size) ||
			(entry.size as number) < 0 ||
			!(entry.kind === "text" || entry.kind === "blob") ||
			typeof entry.deleted !== "boolean" ||
			typeof entry.large !== "boolean"
		)
			return undefined;
		const typedEntry = entry as unknown as LegacyManifestEntry;
		if (
			(typedEntry.deleted &&
				(typedEntry.hash !== "" ||
					typedEntry.size !== 0 ||
					typedEntry.large)) ||
			(!typedEntry.deleted && typedEntry.hash === "") ||
			(typedEntry.large &&
				(typedEntry.deleted ||
					typedEntry.kind !== "blob" ||
					typedEntry.size <= 1_000_000 ||
					!/\.(?:md|canvas)$/i.test(typedEntry.path))) ||
			(!typedEntry.deleted && typedEntry.hash.length !== 64)
		)
			return undefined;
		if (parseETag(typedEntry.etag).epoch !== page.epoch) return undefined;
		const previous = entries.at(-1);
		if (
			previous &&
			compareSqliteBinaryPath(previous.path, typedEntry.path) >= 0
		)
			return undefined;
		entries.push(typedEntry);
	}
	return {
		epoch: page.epoch as string,
		head_seq: page.head_seq as number,
		entries,
		next_page: page.next_page as string | null,
	};
}
