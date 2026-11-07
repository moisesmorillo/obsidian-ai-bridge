import type {
	BlobGcObject,
	BlobGcObjectStore,
} from "@worker/application/blob-gc";

/** Maximum keys returned by one R2 inventory request. */
const R2_BLOB_GC_PAGE_SIZE = 1_000;

/** Lists and deletes only canonical content-addressed keys under the blobs prefix. */
export class R2BlobGcStore implements BlobGcObjectStore {
	/** Bind the existing private bucket without exposing archive keys to GC. */
	constructor(private readonly bucket: R2Bucket) {}

	/** Read one R2 page under `blobs/`; other prefixes, including backups, stay excluded. */
	async list(cursor: string | null): Promise<{
		objects: readonly BlobGcObject[];
		cursor: string | null;
	}> {
		const page = await this.bucket.list({
			prefix: "blobs/",
			limit: R2_BLOB_GC_PAGE_SIZE,
			...(cursor === null ? {} : { cursor }),
		});
		if (
			page.truncated &&
			(typeof page.cursor !== "string" || page.cursor.length === 0)
		)
			throw new Error("R2 blob inventory page lacks its continuation cursor");
		const objects = page.objects.flatMap((object) => {
			const match = /^blobs\/([0-9a-f]{64})$/.exec(object.key);
			return match && Number.isSafeInteger(object.size) && object.size >= 0
				? [{ hash: match[1] ?? "", size: object.size }]
				: [];
		});
		return { objects, cursor: page.truncated ? (page.cursor ?? null) : null };
	}

	/** Delete a bounded set of canonical content keys and never address another prefix. */
	async delete(hashes: readonly string[]): Promise<void> {
		if (
			hashes.length > 100 ||
			hashes.some((hash) => !/^[0-9a-f]{64}$/.test(hash))
		)
			throw new Error("Invalid blob garbage-collection delete batch");
		await this.bucket.delete(hashes.map((hash) => `blobs/${hash}`));
	}
}
