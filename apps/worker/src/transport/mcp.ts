import {
	fromJsonSchema,
	type JsonSchemaType,
	McpServer,
} from "@modelcontextprotocol/server";
import type {
	AuthorizationContext,
	McpGetHistoryInput,
	McpListNotesInput,
	McpReadNoteInput,
	McpSearchNotesInput,
} from "@obsidian-ai-bridge/protocol";
import {
	McpAppendToNoteInputSchema,
	McpAppendToNoteToolSchema,
	McpCreateNoteInputSchema,
	McpCreateNoteToolSchema,
	McpDeleteNoteInputSchema,
	McpDeleteNoteToolSchema,
	McpGetHistoryInputSchema,
	McpGetHistoryToolSchema,
	McpHistoryOutputSchema,
	McpListNotesInputSchema,
	McpListNotesOutputSchema,
	McpListNotesToolSchema,
	McpMutationOutputToolSchema,
	McpReadNoteInputSchema,
	McpReadNoteOutputSchema,
	McpReadNoteToolSchema,
	McpRestoreNoteInputSchema,
	McpRestoreNoteToolSchema,
	McpSearchNotesInputSchema,
	McpSearchNotesOutputSchema,
	McpSearchNotesToolSchema,
	McpUpdateNoteInputSchema,
	McpUpdateNoteToolSchema,
} from "@obsidian-ai-bridge/protocol";
import type { BlobContentStore } from "@worker/application/blobs";
import type {
	McpMutationGateway,
	McpMutationOutcome,
} from "@worker/application/mcp-mutations";
import {
	appendMcpNote,
	createMcpNote,
	deleteMcpNote,
	restoreMcpNote,
	updateMcpNote,
} from "@worker/application/mcp-mutations";
import type {
	McpNotesGateway,
	McpReadOutcome,
	McpReadOwner,
} from "@worker/application/mcp-notes";
import {
	currentMcpEpoch,
	historyMcpNote,
	listMcpNotes,
	readMcpNote,
	searchMcpNotes,
} from "@worker/application/mcp-notes";

/** Preserve section 8 vault conventions in each stateless initialize exchange. */
const MCP_INSTRUCTIONS = [
	"Use Agents/ for agent notes and Agents/Log/YYYY-MM-DD.md for daily logs.",
	"New notes need frontmatter with created and source fields.",
	"Search before you create a note.",
	"Pass the exact ETag from read_note to update_note.",
	"Always generate a fresh idempotency key for each append. Reuse that key only to retry the same append with the same text. Receipts last 30 days. A retry after receipt expiry can append the text again.",
].join(" ");

/** Return one canonical failure with bounded details and no note content. */
function toolFailure(failure: { kind: string }, epoch: string) {
	return {
		content: [],
		isError: true,
		structuredContent: {
			epoch,
			code: failure.kind,
			message: failure.kind.slice(0, 128),
		},
	};
}

/** Transfer read ownership before output and resolve failures with the current epoch. */
async function toolOutcome<T extends object>(
	gateway: McpNotesGateway,
	identity: AuthorizationContext,
	outcome: McpReadOutcome<T>,
	reportBoundaryFailure: (kind: string) => void,
	adoptReadOwner: (owner: McpReadOwner) => void,
) {
	if (!identity.scopes.includes("vault:read")) {
		reportBoundaryFailure("forbidden_scope");
		throw new Error("forbidden_scope");
	}
	if (outcome.owner) adoptReadOwner(outcome.owner);
	if (outcome.ok)
		return {
			content: [],
			structuredContent: { epoch: outcome.epoch, ...outcome.value },
		};
	const current = await currentMcpEpoch(gateway, identity);
	if (!current.ok) {
		reportBoundaryFailure(current.failure.kind);
		throw new Error(current.failure.kind);
	}
	return toolFailure(outcome.failure, current.epoch);
}

/** Build the MCP server and transfer each read owner to response production. */
export function createMcpServer(
	identity: AuthorizationContext,
	gateway: McpNotesGateway,
	store: BlobContentStore,
	adoptReadOwner: (owner: McpReadOwner) => void,
	responseProduction: Promise<void>,
	resolveResponseProduction: () => void,
	signal?: AbortSignal,
	reportBoundaryFailure: (kind: string) => void = () => {},
): McpServer {
	const server = new McpServer(
		{ name: "obsidian-ai-bridge", version: "1.0.0" },
		{ instructions: MCP_INSTRUCTIONS },
	);
	const mutationGateway = gateway as McpNotesGateway & McpMutationGateway;
	/** Transfer one mutation owner and encode its authorized receipt or failure. */
	const mutationResult = async (outcome: McpMutationOutcome) => {
		adoptReadOwner({
			...outcome.owner,
			finish: async (completion) => {
				try {
					return await outcome.owner.finish(completion);
				} finally {
					resolveResponseProduction();
				}
			},
		});
		if (outcome.ok)
			return {
				content: [],
				structuredContent: { epoch: outcome.epoch, etag: outcome.etag },
			};
		if (
			outcome.failure.kind === "forbidden_scope" ||
			outcome.failure.kind === "revoked"
		) {
			reportBoundaryFailure(outcome.failure.kind);
			throw new Error(outcome.failure.kind);
		}
		if (outcome.epoch === undefined) {
			reportBoundaryFailure(outcome.failure.kind);
			throw new Error(outcome.failure.kind);
		}
		return toolFailure(outcome.failure, outcome.epoch);
	};
	/** Enforce the tool scope in Worker before calling the durable application path. */
	const mutationCall = async (
		scope: "vault:write" | "vault:delete",
		run: () => Promise<McpMutationOutcome>,
	) => {
		if (!identity.scopes.includes(scope)) {
			reportBoundaryFailure("forbidden_scope");
			throw new Error("forbidden_scope");
		}
		return mutationResult(await run());
	};
	server.registerTool(
		"create_note",
		{
			description: "Create a note only at an absent path and current epoch.",
			inputSchema: fromJsonSchema(McpCreateNoteToolSchema as JsonSchemaType),
			outputSchema: fromJsonSchema(
				McpMutationOutputToolSchema as JsonSchemaType,
			),
		},
		async (input: unknown) =>
			mutationCall("vault:write", () =>
				createMcpNote(
					mutationGateway,
					identity,
					McpCreateNoteInputSchema.parse(input),
					responseProduction,
				),
			),
	);
	server.registerTool(
		"update_note",
		{
			description: "Replace a note at its exact current ETag.",
			inputSchema: fromJsonSchema(McpUpdateNoteToolSchema as JsonSchemaType),
			outputSchema: fromJsonSchema(
				McpMutationOutputToolSchema as JsonSchemaType,
			),
		},
		async (input: unknown) =>
			mutationCall("vault:write", () =>
				updateMcpNote(
					mutationGateway,
					identity,
					McpUpdateNoteInputSchema.parse(input),
					responseProduction,
				),
			),
	);
	server.registerTool(
		"append_to_note",
		{
			description: "Append one immutable payload using its required retry key.",
			inputSchema: fromJsonSchema(McpAppendToNoteToolSchema as JsonSchemaType),
			outputSchema: fromJsonSchema(
				McpMutationOutputToolSchema as JsonSchemaType,
			),
		},
		async (input: unknown) =>
			mutationCall("vault:write", () =>
				appendMcpNote(
					mutationGateway,
					identity,
					McpAppendToNoteInputSchema.parse(input),
					responseProduction,
				),
			),
	);
	server.registerTool(
		"delete_note",
		{
			description: "Delete a note at its exact current ETag.",
			inputSchema: fromJsonSchema(McpDeleteNoteToolSchema as JsonSchemaType),
			outputSchema: fromJsonSchema(
				McpMutationOutputToolSchema as JsonSchemaType,
			),
		},
		async (input: unknown) =>
			mutationCall("vault:delete", () =>
				deleteMcpNote(
					mutationGateway,
					identity,
					McpDeleteNoteInputSchema.parse(input),
					responseProduction,
				),
			),
	);
	server.registerTool(
		"restore_note",
		{
			description:
				"Restore a retained revision under exact current and source ETags.",
			inputSchema: fromJsonSchema(McpRestoreNoteToolSchema as JsonSchemaType),
			outputSchema: fromJsonSchema(
				McpMutationOutputToolSchema as JsonSchemaType,
			),
		},
		async (input: unknown) =>
			mutationCall("vault:write", () =>
				restoreMcpNote(
					mutationGateway,
					identity,
					McpRestoreNoteInputSchema.parse(input),
					responseProduction,
				),
			),
	);
	server.registerTool(
		"list_notes",
		{
			description: "List live Markdown and Canvas notes.",
			inputSchema: fromJsonSchema(McpListNotesToolSchema as JsonSchemaType),
			outputSchema: fromJsonSchema(McpListNotesOutputSchema as JsonSchemaType),
		},
		async (input: unknown) => {
			const parsed: McpListNotesInput = McpListNotesInputSchema.parse(input);
			return toolOutcome(
				gateway,
				identity,
				await listMcpNotes(
					gateway,
					identity,
					parsed.prefix,
					parsed.include_large,
					signal,
				),
				reportBoundaryFailure,
				adoptReadOwner,
			);
		},
	);
	server.registerTool(
		"read_note",
		{
			description: "Read a note or a bounded UTF-16 fragment.",
			inputSchema: fromJsonSchema(McpReadNoteToolSchema as JsonSchemaType),
			outputSchema: fromJsonSchema(McpReadNoteOutputSchema as JsonSchemaType),
		},
		async (input: unknown) => {
			const parsed: McpReadNoteInput = McpReadNoteInputSchema.parse(input);
			return toolOutcome(
				gateway,
				identity,
				await readMcpNote(gateway, identity, parsed, store, signal),
				reportBoundaryFailure,
				adoptReadOwner,
			);
		},
	);
	server.registerTool(
		"search_notes",
		{
			description: "Search note content using literal substring semantics.",
			inputSchema: fromJsonSchema(McpSearchNotesToolSchema as JsonSchemaType),
			outputSchema: fromJsonSchema(
				McpSearchNotesOutputSchema as JsonSchemaType,
			),
		},
		async (input: unknown) => {
			const parsed: McpSearchNotesInput =
				McpSearchNotesInputSchema.parse(input);
			return toolOutcome(
				gateway,
				identity,
				await searchMcpNotes(
					gateway,
					identity,
					parsed.query,
					parsed.limit,
					signal,
				),
				reportBoundaryFailure,
				adoptReadOwner,
			);
		},
	);
	server.registerTool(
		"get_history",
		{
			description: "List retained revisions for a note.",
			inputSchema: fromJsonSchema(McpGetHistoryToolSchema as JsonSchemaType),
			outputSchema: fromJsonSchema(McpHistoryOutputSchema as JsonSchemaType),
		},
		async (input: unknown) => {
			const parsed: McpGetHistoryInput = McpGetHistoryInputSchema.parse(input);
			return toolOutcome(
				gateway,
				identity,
				await historyMcpNote(gateway, identity, parsed.path, signal),
				reportBoundaryFailure,
				adoptReadOwner,
			);
		},
	);
	return server;
}
