import {
	fromJsonSchema,
	type JsonSchemaType,
	McpServer,
} from "@modelcontextprotocol/server";
import type {
	AuthorizationContext,
	FileFailure,
	McpGetHistoryInput,
	McpListNotesInput,
	McpReadNoteInput,
	McpSearchNotesInput,
} from "@obsidian-ai-bridge/protocol";
import {
	encodeFileFailure,
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
	McpToolErrorSchema,
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

/** One Worker scope policy for mutation dispatch and invalid-input refusals. */
const MCP_MUTATION_SCOPES = new Map<string, "vault:write" | "vault:delete">([
	["create_note", "vault:write"],
	["update_note", "vault:write"],
	["append_to_note", "vault:write"],
	["delete_note", "vault:delete"],
	["restore_note", "vault:write"],
]);

/** Select the mutation scope before SDK argument validation can return a tool error. */
export function mcpMutationScope(name: unknown) {
	return typeof name === "string" ? MCP_MUTATION_SCOPES.get(name) : undefined;
}

/** Preserve canonical authorized failure details without another text representation. */
function toolFailure(
	failure:
		| FileFailure
		| { kind: "result_too_large" }
		| { kind: "internal_error" },
	epoch: string,
	createOnly = false,
) {
	const body =
		failure.kind === "result_too_large"
			? {
					error: failure.kind,
					message: "Narrow the request to reduce the result size.",
				}
			: encodeFileFailure(failure).body;
	const { error, ...details } = body;
	const occupied = createOnly && error === "precondition_failed";
	return {
		content: [],
		isError: true,
		structuredContent: McpToolErrorSchema.parse({
			epoch,
			...details,
			...(occupied
				? {
						content: undefined,
						message: encodeFileFailure({ kind: "path_occupied" }).body.message,
					}
				: {}),
			code: occupied ? "path_occupied" : error,
		}),
	};
}

/** Classify canonical mutation validation failures that need a specific public condition. */
export function mutationInputFailure(
	name: unknown,
	input: unknown,
): FileFailure | undefined {
	const schema =
		name === "create_note"
			? McpCreateNoteInputSchema
			: name === "update_note"
				? McpUpdateNoteInputSchema
				: name === "append_to_note"
					? McpAppendToNoteInputSchema
					: undefined;
	if (!schema) return undefined;
	const parsed = schema.safeParse(input);
	if (parsed.success) return undefined;
	if (
		name === "append_to_note" &&
		(typeof input !== "object" ||
			input === null ||
			!("idempotency_key" in input))
	)
		return { kind: "idempotency_key_required" };
	if (
		parsed.error.issues.some(
			(issue) =>
				issue.code === "custom" && issue.params?.failure === "text_too_large",
		)
	)
		return { kind: "text_too_large" };
	return undefined;
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
	const mutationGateway: McpMutationGateway = gateway;
	/** Transfer one mutation owner and encode its authorized receipt or failure. */
	const mutationResult = async (
		outcome: McpMutationOutcome,
		createOnly: boolean,
	) => {
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
		return toolFailure(outcome.failure, outcome.epoch, createOnly);
	};
	/** Enforce the tool scope in Worker before calling the durable application path. */
	const mutationCall = async (
		name: string,
		run: () => Promise<McpMutationOutcome>,
		createOnly = false,
	) => {
		const scope = mcpMutationScope(name);
		if (scope === undefined || !identity.scopes.includes(scope)) {
			reportBoundaryFailure("forbidden_scope");
			throw new Error("forbidden_scope");
		}
		return mutationResult(await run(), createOnly);
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
			mutationCall(
				"create_note",
				() =>
					createMcpNote(
						mutationGateway,
						identity,
						McpCreateNoteInputSchema.parse(input),
						responseProduction,
					),
				true,
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
			mutationCall("update_note", () =>
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
			mutationCall("append_to_note", () =>
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
			mutationCall("delete_note", () =>
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
			mutationCall("restore_note", () =>
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
