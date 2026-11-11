import { env } from "cloudflare:test";
import {
	isCallToolResult,
	isJSONRPCResultResponse,
} from "@modelcontextprotocol/server";
import {
	McpListBasesResultSchema,
	McpReadBaseResultSchema,
	McpValidateBaseResultSchema,
} from "@vaultwire/protocol";
import { admissionByteSnapshot } from "@worker/application/admission-budget";
import { readSlotCapacitySnapshot } from "@worker/application/read-budget";
import productionWorker from "@worker/index";
import {
	activeAdmissionStates,
	issueToken,
	postMcp,
} from "@worker/test-fixtures/f2-mcp";
import { describe, expect, it, vi } from "vitest";

/** Send a production MCP message with an issued OAuth token. */
function call(token: string, method: string, params?: object) {
	return postMcp(token, { jsonrpc: "2.0", id: 1, method, params });
}

/** Decode a successful JSON-RPC tool response without trusting its wire shape. */
async function structured(response: Response) {
	const message: unknown = await response.json();
	if (!isJSONRPCResultResponse(message) || !isCallToolResult(message.result))
		throw new Error(`Expected tool result: ${JSON.stringify(message)}`);
	const payload: unknown = message.result.structuredContent;
	if (typeof payload !== "object" || payload === null)
		throw new Error("Expected structured tool content");
	return {
		isError: message.result.isError,
		structuredContent: Object.fromEntries(Object.entries(payload)),
	};
}

describe("production MCP Base tools", () => {
	it("discovers all six Base tools", async () => {
		const { token } = await issueToken();
		const response = await call(token, "tools/list");
		const message: unknown = await response.json();
		if (
			!isJSONRPCResultResponse(message) ||
			typeof message.result !== "object" ||
			message.result === null ||
			!("tools" in message.result) ||
			!Array.isArray(message.result.tools)
		)
			throw new Error("Expected tool list");
		const names = message.result.tools.flatMap((tool) =>
			typeof tool === "object" &&
			tool !== null &&
			"name" in tool &&
			typeof tool.name === "string"
				? [tool.name]
				: [],
		);
		expect(names).toEqual([
			"create_note",
			"update_note",
			"append_to_note",
			"append_under_heading",
			"delete_note",
			"restore_note",
			"list_notes",
			"read_note",
			"search_notes",
			"get_history",
			"list_bases",
			"read_base",
			"create_base",
			"update_base",
			"delete_base",
			"validate_base",
		]);
	});

	it("lists, reads, creates, updates, deletes, and validates raw Base files", async () => {
		const { token } = await issueToken("vault:read vault:write vault:delete");
		const epochResult = await structured(
			await call(token, "tools/call", { name: "list_notes", arguments: {} }),
		);
		const epoch = epochResult.structuredContent?.epoch;
		if (typeof epoch !== "string") throw new Error("Expected current epoch");
		const path = "Freelance/Career Ops/Opportunities/pipeline.base";
		const invalidCreate = await structured(
			await call(token, "tools/call", {
				name: "create_base",
				arguments: {
					path: "Freelance/Career Ops/Opportunities/invalid.base",
					content: 'filters:\n  and:\n    - file.ext == "md"\n  or: 7\n',
					epoch,
				},
			}),
		);
		expect(invalidCreate.structuredContent).toMatchObject({
			code: "invalid_request",
			epoch,
		});
		const notePath = "Freelance/Career Ops/Opportunities/context.md";
		await structured(
			await call(token, "tools/call", {
				name: "create_note",
				arguments: {
					path: notePath,
					content: "Unrelated note revision",
					epoch,
				},
			}),
		);
		const noteBefore = await structured(
			await call(token, "tools/call", {
				name: "read_note",
				arguments: { path: notePath },
			}),
		);
		const initial =
			"# Preserve this comment\nproperties:\n  custom.plugin: { keep: true }\nviews:\n  - type: table\n    name: Pipeline\n    filters: 'status == \"Open\" and priority >= 2'\n    formulas:\n      score: 'priority + 1'\n    futureViewSetting: [keep, this]\n  - type: table\n    name: Applied\n    filters: 'status == \"Applied\"'\n  - type: table\n    name: Archived\n    filters: 'status == \"Archived\"'\n";
		const created = await structured(
			await call(token, "tools/call", {
				name: "create_base",
				arguments: {
					path,
					content: initial,
					epoch,
					idempotency_key: "base-create-key-001",
				},
			}),
		);
		expect(created.structuredContent).toMatchObject({ epoch });
		const createdTag = created.structuredContent?.etag;
		expect(typeof createdTag).toBe("string");
		const retry = await structured(
			await call(token, "tools/call", {
				name: "create_base",
				arguments: {
					path,
					content: initial,
					epoch,
					idempotency_key: "base-create-key-001",
				},
			}),
		);
		expect(retry.structuredContent?.etag).toBe(createdTag);
		const duplicate = await structured(
			await call(token, "tools/call", {
				name: "create_base",
				arguments: { path, content: "views: []", epoch },
			}),
		);
		expect(duplicate.isError).toBe(true);
		expect(duplicate.structuredContent).toMatchObject({
			code: "path_occupied",
			epoch,
		});
		const staleEpoch = await structured(
			await call(token, "tools/call", {
				name: "create_base",
				arguments: {
					path: "Freelance/Career Ops/Opportunities/pipeline-copy.base",
					content: initial,
					epoch: "0000000000000000000000000000000a",
				},
			}),
		);
		expect(staleEpoch.structuredContent).toMatchObject({
			code: "epoch_mismatch",
		});
		const missing = await structured(
			await call(token, "tools/call", {
				name: "read_base",
				arguments: { path: "Freelance/Career Ops/Opportunities/missing.base" },
			}),
		);
		expect(missing.structuredContent).toMatchObject({
			code: "not_found",
			epoch,
		});
		const read = McpReadBaseResultSchema.parse(
			(
				await structured(
					await call(token, "tools/call", {
						name: "read_base",
						arguments: { path },
					}),
				)
			).structuredContent,
		);
		expect(read.content).toBe(initial);
		const invalidUpdate = await structured(
			await call(token, "tools/call", {
				name: "update_base",
				arguments: {
					path,
					content: 'filters:\n  and:\n    - file.ext == "md"\n  or: 7\n',
					etag: createdTag,
				},
			}),
		);
		expect(invalidUpdate.structuredContent).toMatchObject({
			code: "invalid_request",
			epoch,
		});
		const next =
			"# Keep all raw text\nproperties:\n  custom.plugin: { keep: true }\nviews:\n  - type: table\n    name: Pipeline\n    filters: 'status == \"Open\" and priority >= 2'\n    formulas:\n      score: 'priority + 1'\n    summaries: { total: 'count()' }\n    futureViewSetting: [keep, this]\n  - type: table\n    name: Applied\n    filters: 'status == \"Applied\"'\n  - type: table\n    name: Archived\n    filters: 'status == \"Archived\"'\n";
		const updated = await structured(
			await call(token, "tools/call", {
				name: "update_base",
				arguments: { path, content: next, etag: createdTag },
			}),
		);
		expect(updated.structuredContent).toMatchObject({ epoch });
		const latestTag = updated.structuredContent?.etag;
		const stale = await structured(
			await call(token, "tools/call", {
				name: "update_base",
				arguments: { path, content: "views: []", etag: createdTag },
			}),
		);
		expect(stale.isError).toBe(true);
		expect(stale.structuredContent).toMatchObject({
			code: "precondition_failed",
			epoch,
		});
		const latest = McpReadBaseResultSchema.parse(
			(
				await structured(
					await call(token, "tools/call", {
						name: "read_base",
						arguments: { path, etag: latestTag },
					}),
				)
			).structuredContent,
		);
		expect(latest.content).toBe(next);
		const noteAfter = await structured(
			await call(token, "tools/call", {
				name: "read_note",
				arguments: { path: notePath },
			}),
		);
		expect(noteAfter.structuredContent?.etag).toBe(
			noteBefore.structuredContent?.etag,
		);
		const bases = McpListBasesResultSchema.parse(
			(
				await structured(
					await call(token, "tools/call", {
						name: "list_bases",
						arguments: { prefix: "Freelance/Career Ops/Opportunities/" },
					}),
				)
			).structuredContent,
		);
		expect(bases.entries.map((entry) => entry.path)).toContain(path);
		expect(bases.entries.every((entry) => entry.path.endsWith(".base"))).toBe(
			true,
		);
		const validation = McpValidateBaseResultSchema.parse(
			(
				await structured(
					await call(token, "tools/call", {
						name: "validate_base",
						arguments: { content: next },
					}),
				)
			).structuredContent,
		);
		expect(validation).toMatchObject({
			epoch,
			valid: true,
			level: "structural-only",
			diagnostics: [],
		});
		expect(validation).not.toHaveProperty("content");
		const deleted = await structured(
			await call(token, "tools/call", {
				name: "delete_base",
				arguments: { path, etag: latestTag },
			}),
		);
		expect(deleted.structuredContent).toMatchObject({ epoch });
	});

	it("holds validation reservations through EOF and cancellation", async () => {
		const { token } = await issueToken("vault:read");
		/** Build a same-isolate request so lease snapshots observe response ownership. */
		const request = () =>
			productionWorker.fetch(
				new Request("https://service.test/mcp", {
					method: "POST",
					headers: {
						authorization: `Bearer ${token}`,
						"content-type": "application/json",
						accept: "application/json, text/event-stream",
					},
					body: JSON.stringify({
						jsonrpc: "2.0",
						id: 1,
						method: "tools/call",
						params: {
							name: "validate_base",
							arguments: { content: "views: []\n" },
						},
					}),
				}),
				env,
			);
		const eofResponse = await request();
		expect(readSlotCapacitySnapshot().held_mcp_slots).toBe(1);
		expect(admissionByteSnapshot().active_reservations).toBe(1);
		await eofResponse.text();
		expect(readSlotCapacitySnapshot().held_mcp_slots).toBe(0);
		expect(admissionByteSnapshot().active_reservations).toBe(0);
		const cancelledResponse = await request();
		const cancel = cancelledResponse.body?.cancel();
		await cancel;
		await vi.waitFor(() => {
			expect(readSlotCapacitySnapshot().held_mcp_slots).toBe(0);
			expect(admissionByteSnapshot().active_reservations).toBe(0);
		});
		vi.useFakeTimers();
		try {
			const expiredResponse = await request();
			expect(readSlotCapacitySnapshot().held_mcp_slots).toBe(1);
			await vi.advanceTimersByTimeAsync(60_000);
			expect(readSlotCapacitySnapshot().held_mcp_slots).toBe(0);
			await expect(expiredResponse.text()).rejects.toThrow();
			expect(admissionByteSnapshot().active_reservations).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("cancels Base list and read owners before releasing their admissions", async () => {
		const { token, clientId } = await issueToken();
		const epochResult = await structured(
			await call(token, "tools/call", {
				name: "list_notes",
				arguments: {},
			}),
		);
		const epoch = epochResult.structuredContent?.epoch;
		if (typeof epoch !== "string") throw new Error("Expected current epoch");
		const path = "Freelance/Career Ops/Opportunities/owner.base";
		await structured(
			await call(token, "tools/call", {
				name: "create_base",
				arguments: { path, content: "views: []\n", epoch },
			}),
		);
		for (const [name, arguments_] of [
			["list_bases", {}],
			["read_base", { path }],
		] as const) {
			const response = await productionWorker.fetch(
				new Request("https://service.test/mcp", {
					method: "POST",
					headers: {
						authorization: `Bearer ${token}`,
						"content-type": "application/json",
						accept: "application/json, text/event-stream",
					},
					body: JSON.stringify({
						jsonrpc: "2.0",
						id: 1,
						method: "tools/call",
						params: { name, arguments: arguments_ },
					}),
				}),
				env,
			);
			expect(response.status, name).toBe(200);
			expect(readSlotCapacitySnapshot().held_mcp_slots, name).toBe(1);
			expect(await activeAdmissionStates(clientId), name).toHaveLength(1);
			await response.body?.cancel();
			await vi.waitFor(async () => {
				expect(readSlotCapacitySnapshot().held_mcp_slots, name).toBe(0);
				expect(admissionByteSnapshot().active_reservations, name).toBe(0);
				expect(await activeAdmissionStates(clientId), name).toEqual([]);
			});
		}
	});

	it("registers Base names in the pre-dispatch scope policy", async () => {
		const { token } = await issueToken("vault:read");
		const response = await call(token, "tools/call", {
			name: "delete_base",
			arguments: {},
		});
		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({ error: "forbidden_scope" });
		for (const name of ["create_base", "update_base"]) {
			const refused = await call(token, "tools/call", { name, arguments: {} });
			expect(refused.status, name).toBe(403);
			expect(await refused.json()).toMatchObject({ error: "forbidden_scope" });
		}
		const { token: writeToken } = await issueToken("vault:read vault:write");
		const deleteRefused = await call(writeToken, "tools/call", {
			name: "delete_base",
			arguments: {},
		});
		expect(deleteRefused.status).toBe(403);
		expect(await deleteRefused.json()).toMatchObject({
			error: "forbidden_scope",
		});
	});
});
