import { env, runInDurableObject } from "cloudflare:test";
import type { AuthorizationContext } from "@obsidian-ai-bridge/protocol";
import {
	FileCommandSchema,
	VaultReadResultSchema,
} from "@obsidian-ai-bridge/protocol";
import { executeBlobPut } from "@worker/application/blobs";
import { tryAcquireBodySlot } from "@worker/application/body-budget";
import {
	executeFileCommand,
	type HistoryVaultGateway,
} from "@worker/application/history";
import type { TextVaultGateway } from "@worker/application/text-files";
import { executeTextMutation } from "@worker/application/text-files";
import { prepareTextPayload } from "@worker/application/text-payload";
import { R2BlobStore } from "@worker/infrastructure/r2/blobs";
import { initializeVaultStorage } from "@worker/infrastructure/sqlite/schema";
import { clearTestVault } from "@worker/test-fixtures/admission";
import {
	seedLiveTextState,
	TEXT_FIXTURE_EPOCH,
} from "@worker/test-fixtures/text-files";
import { readInlineBody } from "@worker/transport/body";
import { withMutationResponse } from "@worker/transport/mutation-response";
import { createWorker } from "@worker/transport/worker";
import { describe, expect, it } from "vitest";

/** Resolve controlled waits without retaining request bytes. */
function gate() {
	/** Default release does nothing until the Promise executor installs its resolver. */
	let release = () => {};
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}
/** Initialize one real authority per host, with command source history. */
async function initialize(host: string) {
	const stub = env.VAULTS.get(env.VAULTS.idFromName(host));
	await runInDurableObject(stub, async (_instance, state) => {
		clearTestVault(state.storage);
		state.storage.sql.exec("PRAGMA foreign_keys = ON");
		initializeVaultStorage(
			state.storage,
			() => TEXT_FIXTURE_EPOCH,
			() => 10_000,
		);
		await seedLiveTextState(state.storage, { path: "source.md", content: "" });
		state.storage.sql.exec("DELETE FROM mutation_claims");
		state.storage.sql.exec("DELETE FROM operation_admissions");
	});
}
/** Observe native byte-source demand while holding EOF across active storage or body work. */
function source(size: number, fill: number, prefix?: Uint8Array) {
	const reached = gate();
	const resume = gate();
	let supplied = 0;
	let reads = 0;
	let maxView = 0;
	let pending = 0;
	let maxPending = 0;
	const body = new ReadableStream<Uint8Array>(
		{
			type: "bytes",
			/** Supply only the requested native BYOB view and stop at a controlled EOF wait. */
			async pull(controller) {
				reads++;
				pending++;
				maxPending = Math.max(maxPending, pending);
				try {
					if (!("byobRequest" in controller))
						throw new Error("Expected byte source controller");
					const request = controller.byobRequest;
					if (!request?.view) throw new Error("Expected a native BYOB request");
					const view = new Uint8Array(
						request.view.buffer,
						request.view.byteOffset,
						request.view.byteLength,
					);
					maxView = Math.max(maxView, view.byteLength);
					if (supplied === size) {
						reached.release();
						await resume.promise;
						controller.close();
						request.respond(0);
						return;
					}
					const length = Math.min(size - supplied, view.byteLength);
					view.fill(fill, 0, length);
					if (prefix && supplied < prefix.byteLength)
						view.set(
							prefix.subarray(
								supplied,
								Math.min(prefix.byteLength, supplied + length),
							),
						);
					supplied += length;
					request.respond(length);
				} finally {
					pending--;
				}
			},
		},
		{ highWaterMark: 0 },
	);
	return {
		body,
		reached: reached.promise,
		resume: resume.release,
		stats: () => ({ supplied, reads, maxView, pending, maxPending }),
	};
}
/** Hash generated fixture bytes without allocating a complete blob in the test isolate. */
async function repeatedHash(size: number, fill: number) {
	const digest = new (
		crypto as Crypto & { DigestStream: typeof DigestStream }
	).DigestStream("SHA-256");
	const writer = digest.getWriter();
	const chunk = new Uint8Array(65_536).fill(fill);
	for (let offset = 0; offset < size; offset += chunk.byteLength)
		await writer.write(
			chunk.subarray(0, Math.min(chunk.byteLength, size - offset)),
		);
	await writer.close();
	return Array.from(new Uint8Array(await digest.digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}
/** Distinct request headers select distinct test-only identities, never the production entry. */
async function identity(request: Request): Promise<AuthorizationContext> {
	const client = request.headers.get("X-Aggregate-Client") ?? "aggregate-fifth";
	return {
		client_id: client,
		grant_id: `${client}-grant`,
		scopes: ["vault:read", "vault:write", "vault:delete"],
	};
}
/** Inspect admission ownership before any held request completes. */
async function admissions(host: string) {
	return runInDurableObject(
		env.VAULTS.get(env.VAULTS.idFromName(host)),
		async (_instance, state) =>
			state.storage.sql.exec("SELECT * FROM operation_admissions").toArray(),
	);
}
/** Shared isolate ownership and native source observations cover all body-bearing operations. */
describe("aggregate body ownership", () => {
	it.each(["rename", "restore"] as const)(
		"shares_pending_response_producers_across_PUT_blob_append_and_%s",
		async (command) => {
			const host = `response-shared-${command}.invalid`;
			await initialize(host);
			const stub = env.VAULTS.get(env.VAULTS.idFromName(host));
			await runInDurableObject(stub, async (_instance, state) => {
				state.storage.sql.exec(
					"INSERT INTO revoked_grants(grant_id, at) VALUES (?, ?)",
					"response-revoked",
					10,
				);
			});
			const context: AuthorizationContext = {
				client_id: "response-client",
				grant_id: "response-revoked",
				scopes: ["vault:read", "vault:write"],
			};
			const descriptor = {
				op: "put",
				epoch: TEXT_FIXTURE_EPOCH,
				paths: ["new.md"],
				precondition: { kind: "absent" },
			} as const;
			const declaration = { payload_hash: "0".repeat(64), size: 1 };
			const producers = Array.from({ length: 4 }, () => source(1, 65));
			const responses = await Promise.all(
				producers.map((producer, index) =>
					withMutationResponse(async (done) => {
						const result =
							index === 0
								? await executeTextMutation(
										stub,
										context,
										{ ...descriptor, paths: ["new.md"] },
										undefined,
										async () => {
											throw new Error("Revoked body demand");
										},
										undefined,
										done,
									)
								: index === 1
									? await executeBlobPut(
											stub,
											new R2BlobStore(env.R2_BUCKET),
											context,
											{ ...descriptor, paths: ["new.bin"] },
											undefined,
											declaration,
											new Blob([]).stream(),
											new AbortController().signal,
											done,
										)
									: await executeFileCommand(
											stub,
											context,
											index === 2
												? {
														op: "append",
														epoch: TEXT_FIXTURE_EPOCH,
														paths: ["source.md"],
														precondition: { kind: "none" },
													}
												: command === "rename"
													? {
															path: "source.md",
															if_match: `"${TEXT_FIXTURE_EPOCH}.1"`,
														}
													: {
															op: "restore",
															epoch: TEXT_FIXTURE_EPOCH,
															paths: ["source.md"],
															precondition: {
																kind: "match",
																etag: `"${TEXT_FIXTURE_EPOCH}.1"`,
															},
														},
											"response-command",
											async () => {
												throw new Error("Revoked command demand");
											},
											done,
										);
						expect(result).toMatchObject({
							ok: false,
							failure: { kind: "revoked" },
						});
						return new Response(producer.body);
					}),
				),
			);
			const worker = createWorker(
				identity,
				() => stub,
				() => new R2BlobStore(env.R2_BUCKET),
			);
			const fifth = source(1, 66);
			try {
				const refused = await worker.fetch(
					new Request(`https://${host}/v1/files/fifth.md`, {
						method: "PUT",
						headers: {
							"If-None-Match": "*",
							"X-Vault-Epoch": TEXT_FIXTURE_EPOCH,
						},
						body: fifth.body,
					}),
					env,
				);
				expect(refused.status).toBe(429);
				expect(refused.headers.get("Retry-After")).toBe("1");
				expect(await refused.json()).toMatchObject({
					error: "admission_limited",
				});
				expect(fifth.stats().reads).toBe(0);
				expect(await admissions(host)).toHaveLength(0);
				await responses[0]?.body?.cancel();
				const next = await worker.fetch(
					new Request(`https://${host}/v1/files/next.md`, {
						method: "PUT",
						headers: {
							"If-None-Match": "*",
							"X-Vault-Epoch": TEXT_FIXTURE_EPOCH,
						},
						body: "new",
					}),
					env,
				);
				expect(next.status).toBe(201);
				const full = tryAcquireBodySlot();
				full?.();
				expect(full).toBeUndefined();
				await next.text();
				const free = tryAcquireBodySlot();
				try {
					expect(free).toBeTypeOf("function");
					const extra = tryAcquireBodySlot();
					extra?.();
					expect(extra).toBeUndefined();
				} finally {
					free?.();
				}
			} finally {
				for (const producer of producers) producer.resume();
				for (const response of responses) await response.body?.cancel();
			}
		},
	);
	it("holds four distinct native 25 MB uploads across clients, hosts, and router instances", async () => {
		const hosts = Array.from(
			{ length: 5 },
			(_, index) => `aggregate-blob-${index}.invalid`,
		);
		for (const host of hosts) await initialize(host);
		let pendingPuts = 0;
		let maxPendingPuts = 0;
		const r2Calls = { head: 0, get: 0, put: 0, delete: 0, list: 0 };
		const rpcCalls = new Map<string, number>();
		/** Count each actual Durable Object RPC by host and method for upload admission. */
		function observeVault(host: string): ReturnType<typeof env.VAULTS.get> {
			const stub = env.VAULTS.get(env.VAULTS.idFromName(host));
			return new Proxy(stub, {
				/** Count one forwarded RPC method without changing its arguments or result. */
				get(target, property) {
					const method = Reflect.get(target, property, target);
					if (typeof method !== "function" || typeof property !== "string")
						return method;
					return (...args: unknown[]) => {
						const key = `${host}:${property}`;
						rpcCalls.set(key, (rpcCalls.get(key) ?? 0) + 1);
						return Reflect.apply(method, target, args);
					};
				},
			});
		}
		/** Forward native operations and count storage calls separately from pending writes. */
		const bucket: R2Bucket = {
			/** Count one native metadata lookup and forward the exact key. */
			head: (...args) => {
				r2Calls.head += 1;
				return env.R2_BUCKET.head(...args);
			},
			/** Count one native object read and forward the exact request. */
			get: (...args: Parameters<R2Bucket["get"]>) => {
				r2Calls.get += 1;
				return env.R2_BUCKET.get(...args);
			},
			/** Count native uploads and measure concurrent pending PUT calls. */
			put: async (...args) => {
				r2Calls.put += 1;
				pendingPuts++;
				maxPendingPuts = Math.max(maxPendingPuts, pendingPuts);
				try {
					return await env.R2_BUCKET.put(...args);
				} finally {
					pendingPuts--;
				}
			},
			/** Count one native object delete and forward the exact request. */
			delete: (...args) => {
				r2Calls.delete += 1;
				return env.R2_BUCKET.delete(...args);
			},
			/** Count one native listing request and forward its options. */
			list: (...args) => {
				r2Calls.list += 1;
				return env.R2_BUCKET.list(...args);
			},
			/** Forward unused multipart creation without changing bucket behavior. */
			createMultipartUpload: (...args) =>
				env.R2_BUCKET.createMultipartUpload(...args),
			/** Forward unused multipart resume without changing bucket behavior. */
			resumeMultipartUpload: (...args) =>
				env.R2_BUCKET.resumeMultipartUpload(...args),
		};
		const sources = Array.from({ length: 5 }, (_, index) =>
			source(25_000_000, 31 + index),
		);
		const hashes = await Promise.all(
			sources.map((_, index) => repeatedHash(25_000_000, 31 + index)),
		);
		const workers = sources.map(() =>
			createWorker(
				identity,
				(_bindings, request) => observeVault(new URL(request.url).host),
				() => new R2BlobStore(bucket),
			),
		);
		const uploads = sources.slice(0, 4).map((item, index) => {
			const worker = workers[index];
			if (!worker) throw new Error("Expected router");
			return Promise.resolve(
				worker.fetch(
					new Request(`https://${hosts[index]}/v1/files/content.bin`, {
						method: "PUT",
						headers: {
							"If-None-Match": "*",
							"X-Vault-Epoch": TEXT_FIXTURE_EPOCH,
							"X-Content-SHA256": hashes[index] ?? "",
							"X-Content-Size": "25000000",
							"X-Aggregate-Client": `aggregate-${index}`,
						},
						body: item.body,
					}),
					env,
				),
			);
		});
		try {
			await Promise.all(sources.slice(0, 4).map((item) => item.reached));
			expect(pendingPuts).toBe(4);
			expect(maxPendingPuts).toBe(4);
			const fifth = sources[4];
			const worker = workers[4];
			if (!fifth || !worker) throw new Error("Expected fifth request");
			const refused = await worker.fetch(
				new Request(`https://${hosts[4]}/v1/files/fifth.bin`, {
					method: "PUT",
					headers: {
						"If-None-Match": "*",
						"X-Vault-Epoch": TEXT_FIXTURE_EPOCH,
						"X-Content-SHA256": hashes[4] ?? "",
						"X-Content-Size": "25000000",
					},
					body: fifth.body,
				}),
				env,
			);
			expect(refused.status).toBe(429);
			expect(refused.headers.get("Retry-After")).toBe("1");
			expect(fifth.stats().reads).toBe(0);
			expect(await admissions(hosts[4] ?? "")).toHaveLength(0);
			for (const item of sources.slice(0, 4)) {
				expect(item.stats().supplied).toBe(25_000_000);
				expect(item.stats().maxView).toBeLessThanOrEqual(65_536);
				expect(item.stats().maxPending).toBe(1);
				expect(item.stats().pending).toBe(1);
			}
			console.info(
				"AGGREGATE_NATIVE_BLOB",
				JSON.stringify({
					sources: sources.map((item) => item.stats()),
					pendingPuts,
					maxPendingPuts,
					r2Calls,
				}),
			);
		} finally {
			for (const item of sources) item.resume();
			for (const response of await Promise.all(uploads)) await response.text();
		}
		const results = await Promise.all(uploads);
		expect(results.map((result) => result.status)).toEqual([
			201, 201, 201, 201,
		]);
		expect(pendingPuts).toBe(0);
		expect(r2Calls).toEqual({
			head: 4,
			get: 0,
			put: 4,
			delete: 0,
			list: 0,
		});
		for (const host of hosts.slice(0, 4)) {
			expect(
				Object.fromEntries(
					[...rpcCalls]
						.filter(([key]) => key.startsWith(`${host}:`))
						.map(([key, count]) => [key.slice(host.length + 1), count]),
				),
			).toEqual({
				beginMutation: 1,
				authorizeBlob: 1,
				commitBlob: 1,
				finishAdmission: 1,
			});
		}
	}, 15_000);
	it.each(["rename", "restore"] as const)(
		"shares slots across inline PUT, blob PUT, append, and %s",
		async (command) => {
			const hosts = Array.from(
				{ length: 5 },
				(_, index) => `aggregate-${command}-${index}.invalid`,
			);
			for (const host of hosts) await initialize(host);
			const bodyPrefix = new TextEncoder().encode(
				command === "rename"
					? '{"to":"target.md"}'
					: '{"source_rev":1,"as_conflict_copy":true}',
			);
			const sources = [
				source(1_000_000, 97),
				source(1_000_001, 101),
				source(1_000_000, 97),
				source(1_000_000, 32, bodyPrefix),
				source(1, 97),
			];
			const worker = createWorker(
				identity,
				(bindings, request) =>
					bindings.VAULTS.get(
						bindings.VAULTS.idFromName(new URL(request.url).host),
					),
				(bindings) => new R2BlobStore(bindings.R2_BUCKET),
			);
			const hash = await repeatedHash(1_000_001, 101);
			const uploads = sources.slice(0, 4).map((item, index) => {
				const operation = index === 2 ? "append" : command;
				const path =
					index < 2
						? `content-${index}.${index === 0 ? "md" : "bin"}`
						: `source.md:${operation}`;
				const headers = new Headers({
					"X-Vault-Epoch": TEXT_FIXTURE_EPOCH,
					"X-Aggregate-Client": `mixed-${index}`,
				});
				if (index < 2) headers.set("If-None-Match", "*");
				if (index === 1) {
					headers.set("X-Content-SHA256", hash);
					headers.set("X-Content-Size", "1000001");
				}
				if (index === 2) headers.set("Idempotency-Key", "aggregate-append-key");
				if (index === 3) headers.set("If-Match", `"${TEXT_FIXTURE_EPOCH}.1"`);
				return Promise.resolve(
					worker.fetch(
						new Request(`https://${hosts[index]}/v1/files/${path}`, {
							method: index < 2 ? "PUT" : "POST",
							headers,
							body: item.body,
						}),
						env,
					),
				);
			});
			try {
				await Promise.all(sources.slice(0, 4).map((item) => item.reached));
				const fifth = sources[4];
				if (!fifth) throw new Error("Expected fifth body");
				const refused = await worker.fetch(
					new Request(
						`https://${hosts[4]}/v1/files/source.md:${command === "rename" ? "restore" : "rename"}`,
						{
							method: "POST",
							headers: {
								"If-Match": `"${TEXT_FIXTURE_EPOCH}.1"`,
								"X-Vault-Epoch": TEXT_FIXTURE_EPOCH,
							},
							body: fifth.body,
						},
					),
					env,
				);
				expect(refused.status).toBe(429);
				expect(fifth.stats().reads).toBe(0);
				expect(await admissions(hosts[4] ?? "")).toHaveLength(0);
				for (const item of sources.slice(0, 4)) {
					expect(item.stats().maxView).toBeLessThanOrEqual(65_536);
					expect(item.stats().maxPending).toBe(1);
				}
				console.info(
					"AGGREGATE_NATIVE_MIXED",
					command,
					JSON.stringify(sources.map((item) => item.stats())),
				);
			} finally {
				for (const item of sources) item.resume();
				for (const response of await Promise.all(uploads))
					await response.text();
			}
			expect(
				(await Promise.all(uploads)).map((response) => response.status),
			).toEqual([201, 201, 200, command === "rename" ? 201 : 200]);
		},
		15_000,
	);
	it("bounds four inline payloads and full failure bodies across native RPC delivery waits", async () => {
		const hosts = Array.from(
			{ length: 5 },
			(_, index) => `aggregate-inline-rpc-${index}.invalid`,
		);
		const waits = hosts.slice(0, 4).map(() => gate());
		const entered = hosts.slice(0, 4).map(() => gate());
		const observed: {
			inputUnits: number;
			failureUnits: number;
			inputBytes: number;
		}[] = [];
		const rpcCalls = {
			beginMutation: 0,
			authorize: 0,
			commitText: 0,
			finishAdmission: 0,
		};
		for (const host of hosts) {
			const stub = env.VAULTS.get(env.VAULTS.idFromName(host));
			await runInDurableObject(stub, async (_instance, state) => {
				clearTestVault(state.storage);
				state.storage.sql.exec("PRAGMA foreign_keys = ON");
				initializeVaultStorage(
					state.storage,
					() => TEXT_FIXTURE_EPOCH,
					() => 10_000,
				);
				await seedLiveTextState(state.storage, {
					path: "source.md",
					content: "\0".repeat(1_000_000),
				});
				state.storage.sql.exec("DELETE FROM mutation_claims");
				state.storage.sql.exec("DELETE FROM operation_admissions");
			});
		}
		const sources = hosts.map(() => source(1_000_000, 0));
		const requests = sources.map(
			(item, index) =>
				new Request(`https://${hosts[index]}/v1/files/source.md`, {
					method: "PUT",
					body: item.body,
				}),
		);
		const uploads = requests.slice(0, 4).map((request, index) => {
			const stub = env.VAULTS.get(env.VAULTS.idFromName(hosts[index] ?? ""));
			const authority: TextVaultGateway = {
				getCurrentEpoch: (...args) => stub.getCurrentEpoch(...args),
				beginMutation: (...args) => {
					rpcCalls.beginMutation += 1;
					return stub.beginMutation(...args);
				},
				authorize: (...args) => {
					rpcCalls.authorize += 1;
					return stub.authorize(...args);
				},
				authorizeBlob: (...args) => stub.authorizeBlob(...args),
				commitBlob: (...args) => stub.commitBlob(...args),
				readBlobMetadata: (...args) => stub.readBlobMetadata(...args),
				readText: (...args) => stub.readText(...args),
				finishAdmission: (...args) => {
					rpcCalls.finishAdmission += 1;
					return stub.finishAdmission(...args);
				},
				commitText: async (...args) => {
					rpcCalls.commitText += 1;
					const result = await stub.commitText(...args);
					expect(result).toMatchObject({
						ok: false,
						failure: { kind: "precondition_failed" },
					});
					if (result.ok || result.failure.kind !== "precondition_failed")
						throw new Error("Expected full observed failure");
					observed.push({
						inputUnits: args[3]?.length ?? 0,
						failureUnits: result.failure.content?.length ?? 0,
						inputBytes: new TextEncoder().encode(args[3]).byteLength,
					});
					entered[index]?.release();
					await waits[index]?.promise;
					return result;
				},
			};
			return executeTextMutation(
				authority,
				{
					client_id: `rpc-client-${index}`,
					grant_id: `rpc-grant-${index}`,
					scopes: ["vault:read", "vault:write"],
				},
				{
					op: "put",
					epoch: TEXT_FIXTURE_EPOCH,
					paths: ["source.md"],
					precondition: { kind: "absent" },
				},
				undefined,
				async () => prepareTextPayload(await readInlineBody(request)),
			);
		});
		for (const item of sources.slice(0, 4)) item.resume();
		try {
			await Promise.all(entered.map((item) => item.promise));
			expect(rpcCalls).toEqual({
				beginMutation: 4,
				authorize: 4,
				commitText: 4,
				finishAdmission: 0,
			});
			expect(observed).toHaveLength(4);
			for (const item of observed)
				expect(item).toEqual({
					inputUnits: 1_000_000,
					failureUnits: 1_000_000,
					inputBytes: 1_000_000,
				});
			const readWorker = createWorker(
				identity,
				(bindings, request) =>
					bindings.VAULTS.get(
						bindings.VAULTS.idFromName(new URL(request.url).host),
					),
				(bindings) => new R2BlobStore(bindings.R2_BUCKET),
			);
			const metadataResponses = await Promise.all(
				hosts
					.slice(0, 4)
					.map((host) =>
						readWorker.fetch(new Request(`https://${host}/v1/vault`), env),
					),
			);
			expect(metadataResponses.map((response) => response.status)).toEqual([
				200, 200, 200, 200,
			]);
			const fifthRead = await readWorker.fetch(
				new Request(`https://${hosts[4]}/v1/vault`),
				env,
			);
			expect(fifthRead.status).toBe(429);
			expect(fifthRead.headers.get("Retry-After")).toBe("1");
			await fifthRead.text();
			for (const response of metadataResponses) await response.body?.cancel();
			const fifth = requests[4];
			if (!fifth) throw new Error("Expected fifth request");
			const denied = await executeTextMutation(
				env.VAULTS.get(env.VAULTS.idFromName(hosts[4] ?? "")),
				{
					client_id: "rpc-fifth",
					grant_id: "rpc-fifth-grant",
					scopes: ["vault:write"],
				},
				{
					op: "put",
					epoch: TEXT_FIXTURE_EPOCH,
					paths: ["fifth.md"],
					precondition: { kind: "absent" },
				},
				undefined,
				async () => prepareTextPayload(await readInlineBody(fifth)),
			);
			expect(denied).toMatchObject({
				ok: false,
				failure: { kind: "admission_limited" },
			});
			expect(sources[4]?.stats().reads).toBe(0);
			expect(await admissions(hosts[4] ?? "")).toHaveLength(0);
			console.info("AGGREGATE_INLINE_RPC_DELIVERY", JSON.stringify(observed));
		} finally {
			for (const wait of waits) wait.release();
			await Promise.all(uploads);
		}
		const results = await Promise.all(uploads);
		expect(rpcCalls).toEqual({
			beginMutation: 4,
			authorize: 4,
			commitText: 4,
			finishAdmission: 4,
		});
		for (const result of results)
			expect(result).toMatchObject({
				ok: false,
				failure: { kind: "precondition_failed" },
			});
	});
	it("holds four routed PUT and metadata slots until response cleanup settles", async () => {
		const hosts = Array.from(
			{ length: 5 },
			(_, index) => `aggregate-http-slots-${index}.invalid`,
		);
		for (const host of hosts) await initialize(host);
		const commitEntered = hosts.slice(0, 4).map(() => gate());
		const commitResume = hosts.slice(0, 4).map(() => gate());
		const finishEntered = gate();
		const finishResume = gate();
		const commitHold = new Map(
			hosts.slice(0, 4).map((host, index) => [host, index]),
		);
		const calls = new Map<string, number>();
		let holdFirstReadCleanup = false;
		/** Delay selected real DO responses while recording RPC starts per host. */
		function observedVault(host: string): ReturnType<typeof env.VAULTS.get> {
			const stub = env.VAULTS.get(env.VAULTS.idFromName(host));
			return new Proxy(stub, {
				/** Count a real authority call and gate its result at the selected lifecycle point. */
				get(target, property) {
					const method = Reflect.get(target, property, target);
					if (typeof method !== "function" || typeof property !== "string")
						return method;
					return async (...args: unknown[]) => {
						const key = `${host}:${property}`;
						calls.set(key, (calls.get(key) ?? 0) + 1);
						const result = await Reflect.apply(method, target, args);
						const index = commitHold.get(host);
						if (property === "commitText" && index !== undefined) {
							commitEntered[index]?.release();
							await commitResume[index]?.promise;
						}
						if (
							property === "finishAdmission" &&
							host === hosts[0] &&
							holdFirstReadCleanup
						) {
							finishEntered.release();
							await finishResume.promise;
						}
						return result;
					};
				},
			});
		}
		const worker = createWorker(
			identity,
			(_bindings, request) => observedVault(new URL(request.url).host),
			(bindings) => new R2BlobStore(bindings.R2_BUCKET),
		);
		const sources = hosts.map((_, index) => source(1_000_000, 31 + index));
		const mutationRequests = sources.slice(0, 4).map((item, index) =>
			worker.fetch(
				new Request(`https://${hosts[index]}/v1/files/inline.md`, {
					method: "PUT",
					headers: {
						"If-None-Match": "*",
						"X-Vault-Epoch": TEXT_FIXTURE_EPOCH,
						"X-Aggregate-Client": `aggregate-http-${index}`,
					},
					body: item.body,
				}),
				env,
			),
		);
		const mutationResponses: Response[] = [];
		const metadataResponses: Response[] = [];
		const deniedBody = source(1, 66);
		try {
			await Promise.all(sources.slice(0, 4).map((item) => item.reached));
			for (const item of sources.slice(0, 4)) item.resume();
			await Promise.all(commitEntered.map((item) => item.promise));

			for (const [index, host] of hosts.slice(0, 4).entries()) {
				const response = await worker.fetch(
					new Request(
						index < 3
							? `https://${host}/v1/files/inline.md`
							: `https://${host}/v1/vault`,
						index < 3
							? { headers: { "X-Vault-Epoch": TEXT_FIXTURE_EPOCH } }
							: undefined,
					),
					env,
				);
				expect(response.status).toBe(200);
				metadataResponses.push(response);
			}
			const mutationOwners = 4;
			const maximumMutationPhaseBytes = 4_000_000;
			const inlineReadOwners = 3;
			const maximumInlineUtf16Bytes = 1_000_000 * 2;
			const stringWindowBytes = 8_192 * 2;
			const escapedWindowBytes = 8_192 * 6 * 2;
			const encodedStringBytes = 8_192 * 6;
			const responseChunkBytes = 65_536;
			const inlineReadEncoderBytes =
				stringWindowBytes +
				escapedWindowBytes * 2 +
				encodedStringBytes +
				responseChunkBytes;
			const safeInteger = Number.MAX_SAFE_INTEGER;
			const maximumMetadataSummary = VaultReadResultSchema.parse({
				epoch: TEXT_FIXTURE_EPOCH,
				head_seq: safeInteger,
				counts: { live: safeInteger, deleted: safeInteger },
				limits: {
					manifest_page: 256,
					feed_page: 1_000,
					text_bytes: 1_000_000,
					blob_bytes: 25_000_000,
				},
				capacity: {
					database_bytes: safeInteger,
					database_limit_bytes: 2_000_000_000,
					live_file_limit: 10_000,
					history_pressure_bytes: safeInteger,
					referenced_blob_bytes: safeInteger,
				},
				attention: [
					"storage_high",
					"capacity_exceeded",
					"history_reduced",
					"blob_storage_high",
				],
			});
			const metadataSummaryBytes = new TextEncoder().encode(
				JSON.stringify(maximumMetadataSummary),
			).byteLength;
			const metadataResponseOwnerBytes =
				metadataSummaryBytes * 2 + responseChunkBytes;
			const simultaneousOwnedPayloadBytes =
				mutationOwners * maximumMutationPhaseBytes +
				inlineReadOwners * (maximumInlineUtf16Bytes + inlineReadEncoderBytes) +
				metadataResponseOwnerBytes;
			const refusedRead = await worker.fetch(
				new Request(`https://${hosts[4]}/v1/vault`),
				env,
			);
			expect(refusedRead.status).toBe(429);
			expect(refusedRead.headers.get("Retry-After")).toBe("1");
			await refusedRead.text();
			const refusedReadHost = hosts[4];
			if (!refusedReadHost) throw new Error("Expected fifth host");
			expect(
				[...calls.keys()].some((key) => key.startsWith(`${refusedReadHost}:`)),
			).toBe(false);

			const refusedBody = await worker.fetch(
				new Request(`https://${hosts[4]}/v1/files/fifth.md`, {
					method: "PUT",
					headers: {
						"If-None-Match": "*",
						"X-Vault-Epoch": TEXT_FIXTURE_EPOCH,
					},
					body: deniedBody.body,
				}),
				env,
			);
			expect(refusedBody.status).toBe(429);
			expect(refusedBody.headers.get("Retry-After")).toBe("1");
			await refusedBody.json();
			expect(deniedBody.stats().reads).toBe(0);
			expect(
				[...calls.keys()].some((key) => key.startsWith(`${refusedReadHost}:`)),
			).toBe(false);

			for (const release of commitResume) release.release();
			mutationResponses.push(...(await Promise.all(mutationRequests)));
			expect(mutationResponses).toHaveLength(4);
			expect(metadataResponses).toHaveLength(4);
			expect(metadataSummaryBytes).toBeLessThan(1_024);
			expect(simultaneousOwnedPayloadBytes).toBeLessThan(24_000_000);
			expect(mutationResponses.map((response) => response.status)).toEqual([
				201, 201, 201, 201,
			]);

			const refusedAfterCommit = await worker.fetch(
				new Request(`https://${hosts[4]}/v1/files/still-held.md`, {
					method: "PUT",
					headers: {
						"If-None-Match": "*",
						"X-Vault-Epoch": TEXT_FIXTURE_EPOCH,
					},
					body: deniedBody.body,
				}),
				env,
			);
			expect(refusedAfterCommit.status).toBe(429);
			await refusedAfterCommit.text();
			expect(deniedBody.stats().reads).toBe(0);
			expect(
				[...calls.keys()].some((key) => key.startsWith(`${refusedReadHost}:`)),
			).toBe(false);

			const firstRead = metadataResponses[0];
			if (!firstRead?.body) throw new Error("Expected metadata response body");
			holdFirstReadCleanup = true;
			const readCleanup = firstRead.body.cancel();
			await finishEntered.promise;
			const refusedDuringCleanup = await worker.fetch(
				new Request(`https://${hosts[4]}/v1/vault`),
				env,
			);
			expect(refusedDuringCleanup.status).toBe(429);
			await refusedDuringCleanup.text();
			holdFirstReadCleanup = false;
			finishResume.release();
			await readCleanup;
			const recoveredRead = await worker.fetch(
				new Request(`https://${hosts[4]}/v1/vault`),
				env,
			);
			expect(recoveredRead.status).toBe(200);
			await recoveredRead.body?.cancel();

			const firstMutation = mutationResponses[0];
			if (!firstMutation?.body)
				throw new Error("Expected mutation response body");
			await firstMutation.body.cancel();
			const recoveredBody = await worker.fetch(
				new Request(`https://${hosts[4]}/v1/files/recovered.md`, {
					method: "PUT",
					headers: {
						"If-None-Match": "*",
						"X-Vault-Epoch": TEXT_FIXTURE_EPOCH,
					},
					body: "recovered",
				}),
				env,
			);
			expect(recoveredBody.status).toBe(201);
			await recoveredBody.body?.cancel();
		} finally {
			holdFirstReadCleanup = false;
			finishResume.release();
			for (const release of commitResume) release.release();
			for (const item of sources) item.resume();
			await Promise.allSettled(mutationRequests);
			for (const response of mutationResponses) await response.body?.cancel();
			for (const response of metadataResponses) await response.body?.cancel();
		}
	}, 20_000);
	it.each(["append", "rename", "restore"] as const)(
		"keeps %s charged until non-cancellable authority cleanup delivery settles",
		async (op) => {
			const host = `command-lifetime-${op}.invalid`;
			await initialize(host);
			const stub = env.VAULTS.get(env.VAULTS.idFromName(host));
			const entered = gate();
			const resume = gate();
			const body =
				op === "append"
					? ""
					: JSON.stringify(
							op === "rename"
								? { to: "target.md" }
								: { source_rev: 1, as_conflict_copy: true },
						);
			const bytes = new TextEncoder().encode(body);
			const hash = Array.from(
				new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
				(byte) => byte.toString(16).padStart(2, "0"),
			).join("");
			const match = { kind: "match", etag: `"${TEXT_FIXTURE_EPOCH}.1"` };
			const command = FileCommandSchema.parse({
				op,
				intent: {
					op,
					epoch: TEXT_FIXTURE_EPOCH,
					paths: op === "rename" ? ["source.md", "target.md"] : ["source.md"],
					precondition: op === "append" ? { kind: "none" } : match,
					payload_hash: hash,
					size: bytes.byteLength,
				},
				key: "lifetime-command",
				...(op === "append" ? { content: "" } : { body: JSON.parse(body) }),
			});
			const {
				payload_hash: _hash,
				size: _size,
				...descriptor
			} = command.intent;
			const authority: HistoryVaultGateway = {
				beginMutation: (...args) => stub.beginMutation(...args),
				beginRenameSource: (...args) => stub.beginRenameSource(...args),
				authorize: (...args) => stub.authorize(...args),
				authorizeRenameSource: (...args) => stub.authorizeRenameSource(...args),
				commitFileCommand: (...args) => stub.commitFileCommand(...args),
				readHistory: (...args) => stub.readHistory(...args),
				finishAdmission: async (...args) => {
					const result = await stub.finishAdmission(...args);
					entered.release();
					await resume.promise;
					return result;
				},
			};
			const context: AuthorizationContext = {
				client_id: `lifetime-${op}`,
				grant_id: `lifetime-${op}-grant`,
				scopes: ["vault:read", "vault:write"],
			};
			const operation = executeFileCommand(
				authority,
				context,
				op === "rename"
					? { path: "source.md", if_match: match.etag }
					: descriptor,
				"lifetime-command",
				async () => command,
			);
			await entered.promise;
			const held = [
				tryAcquireBodySlot(),
				tryAcquireBodySlot(),
				tryAcquireBodySlot(),
			];
			let bodyReads = 0;
			try {
				expect(held.every((release) => release !== undefined)).toBe(true);
				const refused = await executeTextMutation(
					stub,
					context,
					{
						op: "put",
						epoch: TEXT_FIXTURE_EPOCH,
						paths: ["fifth.md"],
						precondition: { kind: "absent" },
					},
					undefined,
					async () => {
						bodyReads++;
						return prepareTextPayload(new Uint8Array());
					},
				);
				expect(refused).toMatchObject({
					ok: false,
					failure: { kind: "admission_limited" },
				});
				expect(bodyReads).toBe(0);
				expect(await admissions(host)).toHaveLength(0);
			} finally {
				resume.release();
				for (const release of held) release?.();
				await operation;
			}
			expect((await operation).ok).toBe(true);
		},
	);
});
