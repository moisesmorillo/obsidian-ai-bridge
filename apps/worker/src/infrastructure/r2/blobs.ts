import type { BlobDeclaration } from "@obsidian-ai-bridge/protocol";
import type { BlobEvidence, BlobStore } from "@worker/application/blobs";

/** R2-backed immutable blob capability used by Vault publication. */
export class R2BlobStore implements BlobStore {
	/** Bind one R2 bucket as the immutable blob namespace. */
	constructor(private readonly bucket: R2Bucket) {}

	/** Return verified R2 checksum evidence for one content-addressed key. */
	async head(hash: string): Promise<BlobEvidence | undefined> {
		if (!/^[0-9a-f]{64}$/.test(hash)) return undefined;
		const object = await this.bucket.head(`blobs/${hash}`);
		const checksum = object?.checksums.sha256;
		if (
			!object ||
			object.key !== `blobs/${hash}` ||
			!checksum ||
			checksum.byteLength !== 32
		)
			return undefined;
		const digest = Array.from(new Uint8Array(checksum), (byte) =>
			byte.toString(16).padStart(2, "0"),
		).join("");
		return { hash: digest, size: object.size };
	}

	/** Refuse writes until Task 3 adds the approved bounded streaming adapter. */
	async putVerified(
		_declaration: BlobDeclaration,
		_body: ReadableStream<Uint8Array>,
		_signal: AbortSignal,
	): Promise<BlobEvidence> {
		throw new Error("R2 blob writes are unavailable before streaming support");
	}
}
