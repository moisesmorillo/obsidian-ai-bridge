import type {
	McpListBasesResult,
	McpListNotesResult,
} from "@vaultwire/protocol";

/** Shared result envelope and payload limits for MCP note and Base listings. */
const MCP_LIST_RESULT_ENTRY_LIMIT = 256;
/** Bound the estimated serialized MCP list envelope and all entry bytes. */
const MCP_LIST_RESULT_BYTE_LIMIT = 65_536;
/** Account for the fixed JSON-RPC result envelope before adding entries. */
const MCP_LIST_RESULT_ENVELOPE_BYTES = 128;

/** Own the shared count, UTF-8 byte, comma, and envelope budget for MCP lists. */
export class McpListResultBudget {
	private count = 0;
	private bytes = MCP_LIST_RESULT_ENVELOPE_BYTES;

	/** Reserve one serialized row or refuse it without changing the budget. */
	add(
		entry:
			| McpListBasesResult["entries"][number]
			| McpListNotesResult["entries"][number],
	): boolean {
		if (this.count >= MCP_LIST_RESULT_ENTRY_LIMIT) return false;
		const entryBytes = new TextEncoder().encode(
			JSON.stringify(entry),
		).byteLength;
		const nextBytes = this.bytes + entryBytes + (this.count > 0 ? 1 : 0);
		if (nextBytes > MCP_LIST_RESULT_BYTE_LIMIT) return false;
		this.count += 1;
		this.bytes = nextBytes;
		return true;
	}
}
