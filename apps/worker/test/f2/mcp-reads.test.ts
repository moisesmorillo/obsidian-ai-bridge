import { env, SELF } from "cloudflare:test";
import productionWorker from "@worker/index";
import {
	activeAdmissionStates,
	issueToken,
	postMcp,
} from "@worker/test-fixtures/f2-mcp";
import { afterEach, describe, expect, it, vi } from "vitest";

/** Hash exact UTF-8 bytes for the local declared-blob REST fixture. */
async function digestHex(bytes: Uint8Array): Promise<string> {
	return Array.from(
		new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice())),
		(byte) => byte.toString(16).padStart(2, "0"),
	).join("");
}

/** Create live notes through the production API to test the bounded MCP list. */
async function seedMcpManifestRows(
	token: string,
	count: number,
	prefix = "Agents/overflow-",
): Promise<void> {
	const auth = { authorization: `Bearer ${token}` };
	const summary = await SELF.fetch("https://service.test/v1/vault", {
		headers: auth,
	});
	const epoch = ((await summary.json()) as { epoch: string }).epoch;
	for (let index = 0; index < count; index++) {
		const path = `${prefix}${String(index).padStart(3, "0")}.md`;
		const created = await SELF.fetch(`https://service.test/v1/files/${path}`, {
			method: "PUT",
			headers: {
				...auth,
				"If-None-Match": "*",
				"X-Vault-Epoch": epoch,
			},
			body: "overflow content",
		});
		expect(created.status).toBe(201);
		await created.text();
	}
}

afterEach(() => vi.unstubAllGlobals());

describe("production MCP transport", () => {
	it("streams a worst-case escaped note with bounded chunks and JSON-RPC framing", async () => {
		const { token } = await issueToken();
		const auth = { authorization: `Bearer ${token}` };
		const summary = await SELF.fetch("https://service.test/v1/vault", {
			headers: auth,
		});
		const { epoch } = (await summary.json()) as { epoch: string };
		const path = `Escaped/escaped-${crypto.randomUUID()}.canvas`;
		const content = "\0".repeat(1_000_000);
		const written = await SELF.fetch(
			`https://service.test/v1/files/${encodeURIComponent(path)}`,
			{
				method: "PUT",
				headers: {
					...auth,
					"If-None-Match": "*",
					"X-Vault-Epoch": epoch,
				},
				body: content,
			},
		);
		expect(written.status).toBe(201);
		await written.text();
		const longId = `request-${"x".repeat(70_000)}`;
		const response = await productionWorker.fetch(
			new Request("https://service.test/mcp", {
				method: "POST",
				headers: {
					...auth,
					"content-type": "application/json",
					accept: "application/json, text/event-stream",
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: longId,
					method: "tools/call",
					params: { name: "read_note", arguments: { path } },
				}),
			}),
			env,
		);
		expect(response.status).toBe(200);
		const reader = response.body?.getReader();
		if (!reader) throw new Error("MCP response has no stream");
		let encodedBytes = 0;
		let maximumChunkBytes = 0;
		let trailingText = "";
		let echoedLongId = false;
		try {
			for (;;) {
				const item = await reader.read();
				if (item.done) break;
				encodedBytes += item.value.byteLength;
				maximumChunkBytes = Math.max(maximumChunkBytes, item.value.byteLength);
				trailingText = trailingText + new TextDecoder().decode(item.value);
				if (trailingText.includes(longId)) echoedLongId = true;
				trailingText = trailingText.slice(-longId.length);
			}
		} finally {
			await reader.cancel();
		}
		expect(echoedLongId).toBe(true);
		expect(encodedBytes).toBeGreaterThan(6_000_000 + longId.length);
		expect(maximumChunkBytes).toBeLessThanOrEqual(65_536);
	});

	it("rejects an oversized declared envelope before body demand", async () => {
		const { token } = await issueToken();
		let pulls = 0;
		const body = new ReadableStream<Uint8Array>(
			{
				/** Count pulls so the declared-size rejection proves no body demand. */
				pull() {
					pulls += 1;
				},
			},
			{ highWaterMark: 0 },
		);
		const response = await productionWorker.fetch(
			new Request("https://service.test/mcp", {
				method: "POST",
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
					accept: "application/json, text/event-stream",
					"content-length": "6100001",
				},
				body,
			}),
			env,
		);
		expect(response.status).toBe(413);
		expect(pulls).toBe(0);
		await response.body?.cancel();
	});

	it("owns one envelope slot before body demand and rejects competing traffic", async () => {
		const { token } = await issueToken();
		const controller = new AbortController();
		/** Signal that the first request reached its body reader. */
		let firstPull = () => {};
		const reachedBody = new Promise<void>((resolve) => {
			firstPull = resolve;
		});
		const firstBody = new ReadableStream<Uint8Array>(
			{
				/** Hold body demand until the competing request tests admission. */
				pull() {
					firstPull();
				},
			},
			{ highWaterMark: 0 },
		);
		const first = productionWorker.fetch(
			new Request("https://service.test/mcp", {
				method: "POST",
				signal: controller.signal,
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
					accept: "application/json, text/event-stream",
				},
				body: firstBody,
			}),
			env,
		);
		let competingPulls = 0;
		try {
			await reachedBody;
			const competing = await productionWorker.fetch(
				new Request("https://service.test/mcp", {
					method: "POST",
					headers: {
						authorization: `Bearer ${token}`,
						"content-type": "application/json",
						accept: "application/json, text/event-stream",
					},
					body: new ReadableStream<Uint8Array>(
						{
							/** Count competing body demand after the slot refusal. */
							pull() {
								competingPulls += 1;
							},
						},
						{ highWaterMark: 0 },
					),
				}),
				env,
			);
			expect(competing.status).toBe(429);
			expect(competingPulls).toBe(0);
			controller.abort();
			const aborted = await first;
			expect(aborted.status).toBe(500);
			await aborted.body?.cancel();
		} finally {
			controller.abort();
		}
	});

	it("keeps OAuth challenges on unauthenticated MCP requests", async () => {
		const response = await SELF.fetch("https://service.test/mcp", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {},
			}),
		});
		expect(response.status).toBe(401);
		expect(response.headers.get("www-authenticate")).toContain("Bearer");
	});

	it("serves MCP initialization, discovery, and read operations through real OAuth and DO state", async () => {
		const { token, clientId } = await issueToken();
		const auth = { authorization: `Bearer ${token}` };
		const summary = await SELF.fetch("https://service.test/v1/vault", {
			headers: auth,
		});
		const epoch = ((await summary.json()) as { epoch: string }).epoch;
		const path = "Agents/Log/2026-10-24.md";
		const created = await SELF.fetch(`https://service.test/v1/files/${path}`, {
			method: "PUT",
			headers: { ...auth, "If-None-Match": "*", "X-Vault-Epoch": epoch },
			body: "created: 2026-10-24\nsource: mcp-test\n\nInitial mcp note content.",
		});
		expect(created.status).toBe(201);
		await created.text();

		const initialize = await postMcp(token, {
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: "2025-03-26",
				capabilities: {},
				clientInfo: { name: "local-test", version: "1" },
			},
		});
		expect(initialize.status).toBe(200);
		const initialized = (await initialize.json()) as {
			result?: { instructions?: string };
		};
		expect(initialized.result?.instructions).toContain(
			"Agents/Log/YYYY-MM-DD.md",
		);
		expect(initialized.result?.instructions).toContain(
			"frontmatter with created and source fields",
		);
		expect(initialized.result?.instructions).toContain(
			"Search before you create a note",
		);
		expect(initialized.result?.instructions).toContain(
			"Pass the exact ETag from read_note",
		);
		expect(initialized.result?.instructions).toContain("fresh idempotency key");
		expect(initialized.result?.instructions).toContain("Receipts last 30 days");
		const negotiated = await postMcp(token, {
			jsonrpc: "2.0",
			id: 13,
			method: "initialize",
			params: {
				protocolVersion: "2099-01-01",
				capabilities: {},
				clientInfo: { name: "version-test", version: "1" },
			},
		});
		const negotiatedResult = (await negotiated.json()) as {
			result?: { protocolVersion?: string };
			error?: { code?: number };
		};
		expect(negotiated.status).toBe(200);
		expect(negotiatedResult.error).toBeUndefined();
		expect(negotiatedResult.result?.protocolVersion).toMatch(/^202[45]-/);
		expect(
			(
				await postMcp(token, {
					jsonrpc: "2.0",
					method: "notifications/initialized",
				})
			).status,
		).toBe(202);

		const tools = await postMcp(token, {
			jsonrpc: "2.0",
			id: 2,
			method: "tools/list",
		});
		const toolResult = (await tools.json()) as {
			result?: { tools?: { name: string }[] };
		};
		expect(toolResult.result?.tools?.map((tool) => tool.name)).toEqual([
			"create_note",
			"update_note",
			"append_to_note",
			"delete_note",
			"restore_note",
			"list_notes",
			"read_note",
			"search_notes",
			"get_history",
		]);
		const manifestResponse = await SELF.fetch(
			"https://service.test/v1/manifest",
			{ headers: auth },
		);
		const manifestBody: unknown = await manifestResponse.json();
		expect(manifestBody).toHaveProperty("entries.0.path", path);
		expect(manifestBody).not.toHaveProperty("entries.0.updated_at");
		const list = await postMcp(token, {
			jsonrpc: "2.0",
			id: 3,
			method: "tools/call",
			params: { name: "list_notes", arguments: { prefix: "Agents/" } },
		});
		const listed = (await list.json()) as {
			result?: {
				structuredContent?: {
					epoch?: string;
					entries?: { path: string; updated_at: number }[];
				};
			};
		};
		expect(listed.result?.structuredContent?.epoch).toBe(epoch);
		expect(listed.result?.structuredContent?.entries).toEqual([
			expect.objectContaining({ path, updated_at: expect.any(Number) }),
		]);
		const largePath = "Agents/large.md";
		const largeBytes = new TextEncoder().encode(`${"a".repeat(999_999)}💖note`);
		const largeCurrent = await SELF.fetch("https://service.test/v1/vault", {
			headers: auth,
		});
		const largeEpoch = ((await largeCurrent.json()) as { epoch: string }).epoch;
		const largePut = await SELF.fetch(
			`https://service.test/v1/files/${largePath}`,
			{
				method: "PUT",
				headers: {
					...auth,
					"If-None-Match": "*",
					"X-Vault-Epoch": largeEpoch,
					"X-Content-SHA256": await digestHex(largeBytes),
					"X-Content-Size": String(largeBytes.byteLength),
				},
				body: largeBytes,
			},
		);
		expect(largePut.status).toBe(201);
		await largePut.text();
		const defaultLargeList = await postMcp(token, {
			jsonrpc: "2.0",
			id: 33,
			method: "tools/call",
			params: { name: "list_notes", arguments: { prefix: largePath } },
		});
		const defaultLargeRows = (await defaultLargeList.json()) as {
			result?: { structuredContent?: { entries?: { path: string }[] } };
		};
		expect(defaultLargeRows.result?.structuredContent?.entries).toEqual([]);
		const includeLargeList = await postMcp(token, {
			jsonrpc: "2.0",
			id: 34,
			method: "tools/call",
			params: {
				name: "list_notes",
				arguments: { prefix: largePath, include_large: true },
			},
		});
		const includeLargeRows = (await includeLargeList.json()) as {
			result?: { structuredContent?: { entries?: { path: string }[] } };
		};
		expect(includeLargeRows.result?.structuredContent?.entries).toEqual([
			expect.objectContaining({ path: largePath }),
		]);
		await seedMcpManifestRows(token, 256);
		const oversizedList = await postMcp(token, {
			jsonrpc: "2.0",
			id: 16,
			method: "tools/call",
			params: { name: "list_notes", arguments: { prefix: "Agents/" } },
		});
		const oversizedListResult = (await oversizedList.json()) as {
			result?: {
				isError?: boolean;
				structuredContent?: {
					epoch?: string;
					code?: string;
					entries?: unknown[];
				};
			};
		};
		expect(oversizedListResult.result?.isError).toBe(true);
		expect(oversizedListResult.result?.structuredContent?.code).toBe(
			"result_too_large",
		);
		expect(oversizedListResult.result?.structuredContent?.epoch).toMatch(
			/^[0-9a-f]{32}$/,
		);
		expect(
			oversizedListResult.result?.structuredContent?.entries,
		).toBeUndefined();
		const largeRead = await postMcp(token, {
			jsonrpc: "2.0",
			id: 31,
			method: "tools/call",
			params: {
				name: "read_note",
				arguments: { path: largePath, offset: 999_999, length: 2 },
			},
		});
		const largeResult = (await largeRead.json()) as {
			result?: {
				structuredContent?: {
					epoch?: string;
					content?: string;
					truncated?: boolean;
				};
			};
		};
		expect(largeResult.result?.structuredContent?.epoch).toMatch(
			/^[0-9a-f]{32}$/,
		);
		expect(largeResult.result?.structuredContent?.content).toBe("💖");
		expect(largeResult.result?.structuredContent?.truncated).toBe(true);
		const oversizedResult = await postMcp(token, {
			jsonrpc: "2.0",
			id: 32,
			method: "tools/call",
			params: { name: "read_note", arguments: { path: largePath } },
		});
		const oversizedTool = (await oversizedResult.json()) as {
			result?: {
				isError?: boolean;
				structuredContent?: { epoch?: string; code?: string };
			};
		};
		expect(oversizedTool.result?.isError).toBe(true);
		expect(oversizedTool.result?.structuredContent?.epoch).toMatch(
			/^[0-9a-f]{32}$/,
		);
		expect(oversizedTool.result?.structuredContent?.code).toBe(
			"result_too_large",
		);

		const read = await postMcp(token, {
			jsonrpc: "2.0",
			id: 4,
			method: "tools/call",
			params: { name: "read_note", arguments: { path } },
		});
		const readResult = (await read.json()) as {
			result?: {
				structuredContent?: { epoch?: string; etag?: string; content?: string };
			};
		};
		expect(readResult.result?.structuredContent?.epoch).toMatch(
			/^[0-9a-f]{32}$/,
		);
		const etag = readResult.result?.structuredContent?.etag ?? "";
		expect(readResult.result?.structuredContent?.content).toContain(
			"Initial mcp",
		);
		const current = await SELF.fetch("https://service.test/v1/vault", {
			headers: auth,
		});
		const currentEpoch = ((await current.json()) as { epoch: string }).epoch;
		const updated = await SELF.fetch(`https://service.test/v1/files/${path}`, {
			method: "PUT",
			headers: { ...auth, "If-Match": etag, "X-Vault-Epoch": currentEpoch },
			body: 'created: 2026-10-24\nsource: mcp-test\n\nChanged mcp AND "quoted" café note content.',
		});
		expect(updated.status).toBe(200);
		const updatedRevision = (await updated.json()) as { etag: string };
		const stale = await postMcp(token, {
			jsonrpc: "2.0",
			id: 5,
			method: "tools/call",
			params: {
				name: "read_note",
				arguments: { path, etag, offset: 0, length: 4 },
			},
		});
		const staleResult = (await stale.json()) as {
			result?: { structuredContent?: { etag?: string; content?: string } };
		};
		expect(staleResult.result?.structuredContent?.content).toBeUndefined();
		expect(staleResult.result?.structuredContent?.etag).not.toBe(etag);

		const search = await postMcp(token, {
			jsonrpc: "2.0",
			id: 6,
			method: "tools/call",
			params: { name: "search_notes", arguments: { query: "mcp" } },
		});
		const searchResult = (await search.json()) as {
			result?: {
				structuredContent?: {
					epoch?: string;
					results?: { path: string }[];
					indexed_files?: number;
					unindexed_large_files?: number;
				};
			};
		};
		expect(searchResult.result?.structuredContent?.epoch).toMatch(
			/^[0-9a-f]{32}$/,
		);
		expect(searchResult.result?.structuredContent?.results?.[0]?.path).toBe(
			path,
		);
		expect(searchResult.result?.structuredContent?.indexed_files).toBe(257);
		expect(searchResult.result?.structuredContent?.unindexed_large_files).toBe(
			1,
		);
		const literalSearch = await postMcp(token, {
			jsonrpc: "2.0",
			id: 17,
			method: "tools/call",
			params: { name: "search_notes", arguments: { query: 'AND "quoted"' } },
		});
		const literalSearchResult = (await literalSearch.json()) as {
			result?: { structuredContent?: { results?: { path: string }[] } };
		};
		expect(
			literalSearchResult.result?.structuredContent?.results?.[0]?.path,
		).toBe(path);
		const diacriticSearch = await postMcp(token, {
			jsonrpc: "2.0",
			id: 18,
			method: "tools/call",
			params: { name: "search_notes", arguments: { query: "cafe" } },
		});
		const diacriticSearchResult = (await diacriticSearch.json()) as {
			result?: { structuredContent?: { results?: { path: string }[] } };
		};
		expect(
			diacriticSearchResult.result?.structuredContent?.results?.[0]?.path,
		).toBe(path);
		const history = await postMcp(token, {
			jsonrpc: "2.0",
			id: 7,
			method: "tools/call",
			params: { name: "get_history", arguments: { path } },
		});
		const historyResult = (await history.json()) as {
			result?: {
				structuredContent?: { epoch?: string; entries?: unknown[] };
			};
		};
		expect(historyResult.result?.structuredContent?.epoch).toMatch(
			/^[0-9a-f]{32}$/,
		);
		expect(historyResult.result?.structuredContent?.entries).toHaveLength(2);
		const missing = await postMcp(token, {
			jsonrpc: "2.0",
			id: 14,
			method: "tools/call",
			params: { name: "read_note", arguments: { path: "Agents/missing.md" } },
		});
		const missingResult = (await missing.json()) as {
			result?: {
				isError?: boolean;
				structuredContent?: { epoch?: string; code?: string };
			};
		};
		expect(missingResult.result?.isError).toBe(true);
		expect(missingResult.result?.structuredContent?.code).toBe("not_found");
		expect(missingResult.result?.structuredContent?.epoch).toMatch(
			/^[0-9a-f]{32}$/,
		);
		const deleteEpochResponse = await SELF.fetch(
			"https://service.test/v1/vault",
			{ headers: auth },
		);
		const deleteEpoch = (
			(await deleteEpochResponse.json()) as { epoch: string }
		).epoch;
		const { token: deleteToken } = await issueToken("vault:read vault:delete");
		const deleted = await SELF.fetch(`https://service.test/v1/files/${path}`, {
			method: "DELETE",
			headers: {
				authorization: `Bearer ${deleteToken}`,
				"If-Match": updatedRevision.etag,
				"X-Vault-Epoch": deleteEpoch,
			},
		});
		expect(deleted.status).toBe(200);
		await deleted.text();
		const tombstone = await postMcp(token, {
			jsonrpc: "2.0",
			id: 15,
			method: "tools/call",
			params: { name: "read_note", arguments: { path } },
		});
		const tombstoneResult = (await tombstone.json()) as {
			result?: { isError?: boolean; structuredContent?: { code?: string } };
		};
		expect(tombstoneResult.result?.isError).toBe(true);
		expect(tombstoneResult.result?.structuredContent?.code).toBe("not_found");
		const ping = await postMcp(token, {
			jsonrpc: "2.0",
			id: 8,
			method: "ping",
		});
		expect(ping.status).toBe(200);
		await ping.text();

		expect(
			(
				await SELF.fetch("https://service.test/mcp", {
					method: "GET",
					headers: auth,
				})
			).status,
		).toBe(405);
		expect(
			(
				await SELF.fetch("https://service.test/mcp", {
					method: "DELETE",
					headers: auth,
				})
			).status,
		).toBe(405);
		expect(
			(
				await SELF.fetch("https://service.test/mcp", {
					method: "POST",
					headers: {
						...auth,
						"content-type": "text/plain",
						accept: "application/json, text/event-stream",
					},
					body: "{}",
				})
			).status,
		).toBe(415);
		expect(
			(
				await SELF.fetch("https://service.test/mcp", {
					method: "POST",
					headers: {
						...auth,
						"content-type": "application/json",
						accept: "text/plain",
					},
					body: "{}",
				})
			).status,
		).toBe(406);
		expect(
			(
				await SELF.fetch("https://service.test/mcp", {
					method: "POST",
					headers: {
						...auth,
						"content-type": "application/json",
						accept: "application/json",
					},
					body: "{}",
				})
			).status,
		).toBe(406);
		expect(
			(
				await SELF.fetch("https://service.test/mcp", {
					method: "POST",
					headers: {
						...auth,
						origin: "https://attacker.test",
						"content-type": "application/json",
						accept: "application/json",
					},
					body: "{}",
				})
			).status,
		).toBe(403);
		const validOrigin = await postMcp(
			token,
			{ jsonrpc: "2.0", id: 19, method: "ping" },
			{ origin: "https://service.test" },
		);
		expect(validOrigin.status).toBe(200);
		await validOrigin.text();
		const uppercaseMedia = await postMcp(
			token,
			{ jsonrpc: "2.0", id: 20, method: "ping" },
			{
				"content-type": "Application/JSON; charset=utf-8",
				accept: "APPLICATION/JSON, TEXT/EVENT-STREAM",
			},
		);
		expect(uppercaseMedia.status).toBe(200);
		await uppercaseMedia.text();
		const malformedJson = await SELF.fetch("https://service.test/mcp", {
			method: "POST",
			headers: {
				...auth,
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
			},
			body: "{",
		});
		expect(malformedJson.status).toBe(400);
		expect(await malformedJson.text()).toContain("invalid_json");
		const invalidUtf8 = await SELF.fetch("https://service.test/mcp", {
			method: "POST",
			headers: {
				...auth,
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
			},
			body: new Uint8Array([0xff]),
		});
		expect(invalidUtf8.status).toBe(400);
		expect(await invalidUtf8.text()).toContain("invalid_json");
		const malformedMessage = await postMcp(token, null);
		expect(malformedMessage.status).toBe(400);
		expect(await malformedMessage.text()).toContain("invalid_request");
		const oversizedEnvelope = await productionWorker.fetch(
			new Request("https://service.test/mcp", {
				method: "POST",
				headers: {
					...auth,
					"content-type": "application/json",
					accept: "application/json, text/event-stream",
					"content-length": "6100001",
				},
				body: "{}",
			}),
			env,
		);
		expect(oversizedEnvelope.status).toBe(413);
		await oversizedEnvelope.text();
		const unsupportedVersion = await postMcp(
			token,
			{ jsonrpc: "2.0", id: 9, method: "ping" },
			{ "mcp-protocol-version": "2099-01-01" },
		);
		expect(unsupportedVersion.status).toBe(400);
		await unsupportedVersion.text();
		const unknown = await postMcp(token, {
			jsonrpc: "2.0",
			id: 10,
			method: "unknown/method",
		});
		const unknownResult = (await unknown.json()) as {
			error?: { code?: number };
		};
		expect(unknownResult.error?.code).toBe(-32601);
		const invalidToolArguments = await postMcp(token, {
			jsonrpc: "2.0",
			id: 20,
			method: "tools/call",
			params: {
				name: "read_note",
				arguments: { path: "Agents/Log/2026-10-24.md", offset: 1_000_001 },
			},
		});
		const invalidToolResult = (await invalidToolArguments.json()) as {
			result?: {
				content?: unknown[];
				isError?: boolean;
				structuredContent?: { epoch?: string; code?: string };
			};
		};
		expect(invalidToolResult.result?.isError).toBe(true);
		expect(invalidToolResult.result?.content).toEqual([]);
		expect(invalidToolResult.result?.structuredContent?.code).toBe(
			"invalid_request",
		);
		expect(invalidToolResult.result?.structuredContent?.epoch).toMatch(
			/^[0-9a-f]{32}$/,
		);
		const cancelled = await productionWorker.fetch(
			new Request("https://service.test/mcp", {
				method: "POST",
				headers: {
					...auth,
					"content-type": "application/json",
					accept: "application/json, text/event-stream",
				},
				body: JSON.stringify({ jsonrpc: "2.0", id: 11, method: "tools/list" }),
			}),
			env,
		);
		const responseReader = cancelled.body?.getReader();
		await responseReader?.read();
		await responseReader?.cancel();
		const afterCancel = await postMcp(token, {
			jsonrpc: "2.0",
			id: 12,
			method: "ping",
		});
		expect(afterCancel.status).toBe(200);
		await afterCancel.text();
		const vault = env.VAULTS.get(env.VAULTS.idFromName("service.test"));
		await vault.revokeClient("synthetic-owner", clientId);
		for (const message of [
			{ jsonrpc: "2.0", id: 21, method: "tools/list" },
			{
				jsonrpc: "2.0",
				id: 22,
				method: "tools/call",
				params: { name: "list_notes", arguments: {} },
			},
			{
				jsonrpc: "2.0",
				id: 23,
				method: "tools/call",
				params: { name: "read_note", arguments: { path } },
			},
			{
				jsonrpc: "2.0",
				id: 24,
				method: "tools/call",
				params: { name: "search_notes", arguments: { query: "mcp" } },
			},
			{
				jsonrpc: "2.0",
				id: 25,
				method: "tools/call",
				params: { name: "get_history", arguments: { path } },
			},
		]) {
			const revoked = await postMcp(token, message);
			expect(revoked.status, JSON.stringify(message)).toBe(401);
			expect(revoked.headers.get("www-authenticate")).toContain("Bearer");
			expect(await revoked.text()).not.toContain("epoch");
		}
	});

	it("filters late prefix matches across metadata pages", async () => {
		const { token } = await issueToken();
		const prefix = `Z-mcp-late-${crypto.randomUUID()}/`;
		await seedMcpManifestRows(token, 256, `A-mcp-scan-${crypto.randomUUID()}/`);
		await seedMcpManifestRows(token, 2, prefix);
		const listed = await postMcp(token, {
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name: "list_notes", arguments: { prefix } },
		});
		const listedResult = (await listed.json()) as {
			result?: {
				isError?: boolean;
				structuredContent?: { entries?: { path: string }[] };
			};
		};
		expect(listedResult.result?.isError).not.toBe(true);
		expect(listedResult.result?.structuredContent?.entries).toHaveLength(2);
		expect(
			listedResult.result?.structuredContent?.entries?.every((entry) =>
				entry.path.startsWith(prefix),
			),
		).toBe(true);
	});

	it("rejects byte-heavy matching prefixes without partial rows", async () => {
		const { token, clientId } = await issueToken();
		const widePrefix = `MCP-wide-${crypto.randomUUID()}/${"w".repeat(420)}/`;
		await seedMcpManifestRows(token, 256, widePrefix);
		const wideList = await postMcp(token, {
			jsonrpc: "2.0",
			id: 2,
			method: "tools/call",
			params: { name: "list_notes", arguments: { prefix: widePrefix } },
		});
		expect(await activeAdmissionStates(clientId)).toEqual(["active"]);
		const wideResult = (await wideList.json()) as {
			result?: {
				isError?: boolean;
				structuredContent?: { code?: string; entries?: unknown[] };
			};
		};
		expect(wideResult.result?.isError).toBe(true);
		expect(wideResult.result?.structuredContent?.code).toBe("result_too_large");
		expect(wideResult.result?.structuredContent?.entries).toBeUndefined();
		expect(await activeAdmissionStates(clientId)).toEqual([]);
	});

	it("keeps real durable admission until MCP response EOF and cancellation", async () => {
		const { token, clientId } = await issueToken();
		await seedMcpManifestRows(
			token,
			256,
			`MCP-lifecycle-${crypto.randomUUID()}/`,
		);
		/** Start a production list request without consuming its response body. */
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
						params: { name: "list_notes", arguments: {} },
					}),
				}),
				env,
			);

		const response = await request();
		expect(response.status).toBe(200);
		const reader = response.body?.getReader();
		if (!reader) throw new Error("MCP response has no body");
		try {
			expect(await activeAdmissionStates(clientId)).toEqual(["active"]);
			let chunks = 0;
			for (;;) {
				const item = await reader.read();
				if (item.done) break;
				chunks += 1;
				if (chunks === 1)
					expect(await activeAdmissionStates(clientId)).toEqual(["active"]);
			}
			expect(chunks).toBeGreaterThan(1);
			expect(await activeAdmissionStates(clientId)).toEqual([]);
		} finally {
			await reader.cancel();
		}

		const cancelled = await request();
		const cancelledReader = cancelled.body?.getReader();
		if (!cancelledReader) throw new Error("MCP response has no body");
		try {
			expect(await activeAdmissionStates(clientId)).toEqual(["active"]);
			await cancelledReader.read();
			expect(await activeAdmissionStates(clientId)).toEqual(["active"]);
			await cancelledReader.cancel();
			expect(await activeAdmissionStates(clientId)).toEqual([]);
		} finally {
			await cancelledReader.cancel();
		}
	});

	it("keeps MCP and REST reads on the same four isolate slots", async () => {
		const { token } = await issueToken();
		await seedMcpManifestRows(token, 256, `MCP-shared-${crypto.randomUUID()}/`);
		const auth = { authorization: `Bearer ${token}` };
		const restResponses: Response[] = [];
		let mcpResponse: Response | undefined;
		try {
			for (let index = 0; index < 3; index += 1)
				restResponses.push(
					await productionWorker.fetch(
						new Request("https://service.test/v1/manifest", {
							headers: auth,
						}),
						env,
					),
				);
			mcpResponse = await productionWorker.fetch(
				new Request("https://service.test/mcp", {
					method: "POST",
					headers: {
						...auth,
						"content-type": "application/json",
						accept: "application/json, text/event-stream",
					},
					body: JSON.stringify({
						jsonrpc: "2.0",
						id: 1,
						method: "tools/call",
						params: { name: "list_notes", arguments: {} },
					}),
				}),
				env,
			);
			expect(restResponses.every((response) => response.status === 200)).toBe(
				true,
			);
			expect(mcpResponse.status).toBe(200);
			const limited = await productionWorker.fetch(
				new Request("https://service.test/v1/vault", { headers: auth }),
				env,
			);
			expect(limited.status).toBe(429);
			await restResponses[0].body?.cancel();
			const available = await productionWorker.fetch(
				new Request("https://service.test/v1/vault", { headers: auth }),
				env,
			);
			expect(available.status).toBe(200);
			await available.body?.cancel();
		} finally {
			for (const response of restResponses.slice(1))
				await response.body?.cancel();
			await mcpResponse?.body?.cancel();
		}
	});

	it("runs all five conditional mutation tools through OAuth and the production DO", async () => {
		const { token } = await issueToken("vault:read vault:write vault:delete");
		const auth = { authorization: `Bearer ${token}` };
		const summary = await SELF.fetch("https://service.test/v1/vault", {
			headers: auth,
		});
		const { epoch } = (await summary.json()) as { epoch: string };
		const path = "Agents/mcp-mutation-cycle.md";
		/** Send one tool request with the test client's verified bearer token. */
		const call = (name: string, args: Record<string, unknown>) =>
			postMcp(token, {
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name, arguments: args },
			});
		/** Decode the structured mutation receipt from one MCP HTTP response. */
		const result = async (response: Response) =>
			(await response.clone().json()) as {
				result?: { structuredContent?: { epoch?: string; etag?: string } };
			};
		const created = await call("create_note", {
			path,
			content: "first",
			epoch,
		});
		expect(created.status).toBe(200);
		const firstEtag = (await result(created)).result?.structuredContent?.etag;
		expect(firstEtag).toBeTruthy();
		const updated = await call("update_note", {
			path,
			content: "second",
			etag: firstEtag,
		});
		expect(updated.status).toBe(200);
		const secondEtag = (await result(updated)).result?.structuredContent?.etag;
		const staleUpdate = await call("update_note", {
			path,
			content: "stale",
			etag: firstEtag,
		});
		expect(staleUpdate.status).toBe(200);
		expect((await result(staleUpdate)).result?.structuredContent).toMatchObject(
			{ epoch, code: "precondition_failed" },
		);
		expect(
			(await result(staleUpdate)).result?.structuredContent,
		).toHaveProperty("content", "second");
		const staleCreate = await call("create_note", {
			path,
			content: "duplicate",
			epoch: `a${"0".repeat(31)}`,
		});
		expect(staleCreate.status).toBe(200);
		expect((await result(staleCreate)).result?.structuredContent).toMatchObject(
			{ epoch, code: "epoch_mismatch" },
		);
		const appended = await call("append_to_note", {
			path,
			text: " third",
			epoch,
			idempotency_key: "append-key-00001",
		});
		expect(appended.status).toBe(200);
		const thirdEtag = (await result(appended)).result?.structuredContent?.etag;
		const appendRetry = await call("append_to_note", {
			path,
			text: " third",
			epoch,
			idempotency_key: "append-key-00001",
		});
		expect((await result(appendRetry)).result?.structuredContent?.etag).toBe(
			thirdEtag,
		);
		const changedRetry = await call("append_to_note", {
			path,
			text: " changed",
			epoch,
			idempotency_key: "append-key-00001",
		});
		expect(
			(await result(changedRetry)).result?.structuredContent,
		).toMatchObject({
			epoch,
			code: "idempotency_mismatch",
		});
		const secondClient = await issueToken(
			"vault:read vault:write vault:delete",
		);
		const otherClientAppend = await postMcp(secondClient.token, {
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name: "append_to_note",
				arguments: {
					path,
					text: " third",
					epoch,
					idempotency_key: "append-key-00001",
				},
			},
		});
		expect(otherClientAppend.status).toBe(200);
		const otherClientEtag = (await result(otherClientAppend)).result
			?.structuredContent?.etag;
		expect(otherClientEtag).not.toBe(thirdEtag);
		const deleted = await call("delete_note", { path, etag: otherClientEtag });
		expect(deleted.status).toBe(200);
		const deletedEtag = (await result(deleted)).result?.structuredContent?.etag;
		const restored = await call("restore_note", {
			path,
			source_etag: firstEtag,
			current_etag: deletedEtag,
			as_conflict_copy: true,
		});
		expect(restored.status).toBe(200);
		expect((await result(restored)).result?.structuredContent).toMatchObject({
			epoch,
		});
		expect(secondEtag).not.toBe(firstEtag);
	});

	it("denies delete without delete scope while write remains independent", async () => {
		const { token } = await issueToken("vault:write");
		const response = await postMcp(token, {
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name: "delete_note",
				arguments: { path: "Agents/missing.md", etag: `"${"a".repeat(32)}.1"` },
			},
		});
		expect(response.status).toBe(403);
		expect(response.headers.get("www-authenticate")).toContain("Bearer");
		expect(await response.text()).not.toContain("epoch");
	});

	it("allows protocol discovery but denies read calls without read scope", async () => {
		const { token } = await issueToken("vault:write");
		const discovery = await postMcp(token, {
			jsonrpc: "2.0",
			id: 1,
			method: "tools/list",
		});
		expect(discovery.status).toBe(200);
		await discovery.text();
		for (const message of [
			{
				jsonrpc: "2.0",
				id: 2,
				method: "tools/call",
				params: { name: "list_notes", arguments: {} },
			},
			{
				jsonrpc: "2.0",
				id: 3,
				method: "tools/call",
				params: { name: "read_note", arguments: { path: "Agents/a.md" } },
			},
			{
				jsonrpc: "2.0",
				id: 4,
				method: "tools/call",
				params: { name: "search_notes", arguments: { query: "mcp" } },
			},
			{
				jsonrpc: "2.0",
				id: 5,
				method: "tools/call",
				params: { name: "get_history", arguments: { path: "Agents/a.md" } },
			},
		]) {
			const response = await postMcp(token, message);
			expect(response.status).toBe(403);
			expect(response.headers.get("www-authenticate")).toContain("Bearer");
			expect(await response.text()).not.toContain("epoch");
		}
	});
});
