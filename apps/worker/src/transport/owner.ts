import type {
	BlobGcPreview,
	BlobGcStatus,
	ExportOperationResult,
	ExportSnapshot,
	MeasurementResponse,
} from "@obsidian-ai-bridge/protocol";
import {
	BlobGcOperationFailureSchema,
	BlobGcPreviewSchema,
	BlobGcStatusSchema,
	EpochSchema,
	ExportSnapshotsSchema,
	MeasurementResponseSchema,
	OwnerExportRequestSchema,
} from "@obsidian-ai-bridge/protocol";
import type {
	ClientRegistryGateway,
	OwnerCleanupExternalCallBudget,
} from "@worker/application/clients";
import {
	consumeOwnerCsrf,
	listClientGrants,
	listClients,
	removeClient,
	renameClient,
	revokeClient,
	storeOwnerCsrf,
} from "@worker/application/clients";
import { readSlotCapacitySnapshot } from "@worker/application/read-budget";
import type { Env } from "@worker/env";
import { verifyOwnerAccess } from "@worker/infrastructure/auth/access";
import { createProviderGrantCleanup } from "@worker/infrastructure/auth/oauth";
import { renderBlobGcPage } from "@worker/transport/owner-pages/blob-gc";
import { renderClientsPage } from "@worker/transport/owner-pages/clients";
import { renderExportsPage } from "@worker/transport/owner-pages/exports";
import { renderGrantsPage } from "@worker/transport/owner-pages/grants";
import { renderMeasurementsPage } from "@worker/transport/owner-pages/measurements";
import type { OwnerServiceMetadata } from "@worker/transport/owner-pages/shell";
import { Hono } from "hono";

/** Browser cookie that binds one-use owner form state to this browser. */
const OWNER_BROWSER_COOKIE = "__Host-oab-owner";
/** Owner form state expires after ten minutes. */
const OWNER_STATE_TTL_MS = 10 * 60 * 1000;
/** Maximum accepted owner form body. */
const OWNER_FORM_LIMIT = 4_096;
/** Cap provider KV calls and registry RPCs, including CSRF, but not inner DO SQL. */
const OWNER_CLEANUP_EXTERNAL_CALL_LIMIT = 48;

/** Resolve the authoritative registry for the configured canonical service vault. */
export type OwnerRegistryResolver = (
	env: Env,
	request: Request,
) => ClientRegistryGateway;

/** Resolve owner-only measurements from the host-selected Vault. */
export type OwnerMeasurementResolver = (
	env: Env,
	request: Request,
) => {
	/** Verify owner subject in the Vault before any measurement observation read. */
	readMeasurements(ownerSubject: string): Promise<MeasurementResponse | null>;
};

/** Resolve owner-only snapshot creation, listing, and streamed download capabilities. */
export type OwnerExportResolver = (
	env: Env,
	request: Request,
) => {
	/** Start or replay one timestamp-keyed export for the verified owner. */
	start(
		ownerSubject: string,
		createdAt: string,
	): Promise<ExportOperationResult | null>;
	/** List export outcomes without exposing private R2 object keys. */
	list(ownerSubject: string): Promise<readonly ExportOperationResult[] | null>;
	/** Stream a completed archive only for its exact completed owner record. */
	download(
		ownerSubject: string,
		epoch: string,
		createdAt: string,
	): Promise<{ body: ReadableStream<Uint8Array>; size: number } | null>;
};

/** Resolve owner-only preview, status, and bounded execution for blob collection. */
export type OwnerBlobGcResolver = (
	env: Env,
	request: Request,
) => {
	/** Measure reclaimable objects without changing durable marks. */
	preview(ownerSubject: string): Promise<BlobGcPreview | null>;
	/** Return durable phase and mark measurement for the verified owner. */
	status(ownerSubject: string): Promise<BlobGcStatus | null>;
	/** Start or advance one bounded confirmed collection batch. */
	collect(ownerSubject: string): Promise<BlobGcStatus | null>;
};

/** Escape provider-controlled and owner-controlled strings before HTML rendering. */
function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, (character) => {
		const entities: Record<string, string> = {
			"&": "&amp;",
			"<": "&lt;",
			">": "&gt;",
			'"': "&quot;",
			"'": "&#39;",
		};
		return entities[character] ?? character;
	});
}

/** Read one named cookie without treating unrelated cookie data as trusted input. */
function readCookie(request: Request, name: string): string | null {
	for (const item of request.headers.get("cookie")?.split(";") ?? []) {
		const [key, ...rest] = item.trim().split("=");
		if (key === name) return rest.join("=");
	}
	return null;
}

/** Select completed export rows and build Access-protected download links. */
function completedSnapshots(
	results: readonly ExportOperationResult[],
): ExportSnapshot[] {
	return ExportSnapshotsSchema.parse(
		results.flatMap((result) =>
			result.status === "complete" && result.size !== null
				? [
						{
							epoch: result.epoch,
							created_at: result.created_at,
							size: result.size,
							download_url: `/owner/exports/${encodeURIComponent(result.epoch)}/${encodeURIComponent(result.created_at)}/download`,
						},
					]
				: [],
		),
	);
}

/** Return the escaped service facts that the current handler can prove. */
function ownerServiceMetadata(env: Env): OwnerServiceMetadata {
	if (!env.SERVICE_ORIGIN) return {};
	try {
		return { serviceHost: new URL(env.SERVICE_ORIGIN).host };
	} catch {
		return {};
	}
}

/** Find one client in at most 32 existing bounded registry pages. */
async function findListedClient(
	registry: ClientRegistryGateway,
	ownerSubject: string,
	clientId: string,
): Promise<
	| Awaited<ReturnType<ClientRegistryGateway["listClients"]>>["clients"][number]
	| null
> {
	let cursor: string | undefined;
	for (let pageNumber = 0; pageNumber < 32; pageNumber += 1) {
		const page = await registry.listClients(ownerSubject, cursor);
		const client = page.clients.find(
			(candidate) => candidate.client_id === clientId,
		);
		if (client) return client;
		if (page.next_cursor === null || page.next_cursor === cursor) return null;
		cursor = page.next_cursor;
	}
	return null;
}

/** One supported Accept range and its validated quality weight. */
interface OwnerAcceptRange {
	type: string;
	subtype: string;
	quality: number;
}

/** Parse complete media ranges and ignore malformed entries without widening them. */
function parseOwnerAccept(header: string | null): OwnerAcceptRange[] {
	if (!header?.trim()) return [];
	const ranges: OwnerAcceptRange[] = [];
	for (const entry of header.toLowerCase().split(",")) {
		const [mediaType = "", ...parameters] = entry.trim().split(";");
		const mediaParts = mediaType.trim().split("/");
		if (mediaParts.length !== 2) continue;
		const [type = "", subtype = ""] = mediaParts.map((part) => part.trim());
		const validMediaRange =
			(type === "*" && subtype === "*") ||
			(type !== "*" &&
				/^[!#$%&'+.^_`|~0-9a-z-]+$/.test(type) &&
				(subtype === "*" || /^[!#$%&'+.^_`|~0-9a-z-]+$/.test(subtype)));
		if (!validMediaRange) continue;
		let quality = 1;
		let qualitySeen = false;
		let valid = true;
		for (const parameter of parameters) {
			const [name = "", ...values] = parameter.trim().split("=");
			if (name.trim() !== "q") continue;
			const value = values.length === 1 ? values[0]?.trim() : undefined;
			if (
				qualitySeen ||
				value === undefined ||
				!/^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(value)
			) {
				valid = false;
				break;
			}
			qualitySeen = true;
			quality = Number(value);
		}
		if (valid) ranges.push({ type, subtype, quality });
	}
	return ranges;
}

/** Apply media specificity before comparing the quality of one representation. */
function acceptedQuality(
	ranges: readonly OwnerAcceptRange[],
	candidate: "text/html" | "application/json",
): number {
	const [candidateType, candidateSubtype] = candidate.split("/");
	let bestSpecificity = -1;
	let bestQuality = 0;
	for (const range of ranges) {
		if (
			(range.type !== candidateType && range.type !== "*") ||
			(range.subtype !== candidateSubtype && range.subtype !== "*")
		)
			continue;
		const specificity = range.type === "*" ? 0 : range.subtype === "*" ? 1 : 2;
		if (specificity > bestSpecificity) {
			bestSpecificity = specificity;
			bestQuality = range.quality;
		} else if (specificity === bestSpecificity) {
			bestQuality = Math.max(bestQuality, range.quality);
		}
	}
	return bestQuality;
}

/** Resolve HTML only when its Accept quality exceeds JSON quality. */
function prefersMeasurementHtml(accept: string | null): boolean {
	const ranges = parseOwnerAccept(accept);
	return (
		acceptedQuality(ranges, "text/html") >
		acceptedQuality(ranges, "application/json")
	);
}

/** Return a no-store response with a safely rendered finite client page. */
export function createOwnerHandler(
	resolveRegistry: OwnerRegistryResolver,
	resolveMeasurements?: OwnerMeasurementResolver,
	resolveExports?: OwnerExportResolver,
	resolveBlobGc?: OwnerBlobGcResolver,
): ExportedHandler<Env> {
	const app = new Hono<{ Bindings: Env }>();
	app.get("/owner/clients", async (context) => {
		const owner = await verifyOwnerAccess(context.req.raw, context.env);
		if (!owner) return context.text("Unauthorized", 401);
		const origin = context.env.SERVICE_ORIGIN;
		if (!origin || new URL(context.req.url).origin !== origin)
			return context.text("Not found", 404);
		const browserId =
			readCookie(context.req.raw, OWNER_BROWSER_COOKIE) ?? crypto.randomUUID();
		if (!isUuid(browserId)) return context.text("Unauthorized", 401);
		const state = crypto.randomUUID();
		const registry = resolveRegistry(context.env, context.req.raw);
		await storeOwnerCsrf(registry, {
			owner_subject: owner.subject,
			browser_id: browserId,
			state,
			expires_at: Date.now() + OWNER_STATE_TTL_MS,
		});
		const page = await listClients(
			registry,
			owner.subject,
			context.req.query("cursor"),
		);
		const html = renderClientsPage({
			service: ownerServiceMetadata(context.env),
			csrf: state,
			nextCursor: page.next_cursor,
			encodedCursor: page.next_cursor
				? encodeURIComponent(page.next_cursor)
				: null,
			clients: page.clients.map((client) => ({
				clientId: escapeHtml(client.client_id),
				encodedId: encodeURIComponent(client.client_id),
				name: escapeHtml(client.name),
				generation: client.generation,
				grantCount: client.grant_count,
				activeGrantCount: client.active_grant_count,
				cleanupPendingCount: client.cleanup_pending_count,
			})),
		});
		return new Response(html, {
			headers: {
				"content-type": "text/html; charset=utf-8",
				"cache-control": "no-store",
				"set-cookie": `${OWNER_BROWSER_COOKIE}=${browserId}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=600`,
			},
		});
	});

	app.get("/owner/exports", async (context) => {
		const owner = await verifyOwnerAccess(context.req.raw, context.env);
		if (!owner) return noStoreText("Unauthorized", 401);
		if (!isCanonicalOwnerOrigin(context.req.raw, context.env))
			return noStoreText("Not found", 404);
		if (!resolveExports) return noStoreText("Unavailable", 503);
		try {
			const gateway = resolveExports(context.env, context.req.raw);
			const results = await gateway.list(owner.subject);
			if (!results) return noStoreText("Forbidden", 403);
			const snapshots = completedSnapshots(results);
			const failedExports = results.filter(
				(result) => result.status === "failed",
			);
			const browserId =
				readCookie(context.req.raw, OWNER_BROWSER_COOKIE) ??
				crypto.randomUUID();
			if (!isUuid(browserId)) return noStoreText("Unauthorized", 401);
			const state = crypto.randomUUID();
			await storeOwnerCsrf(resolveRegistry(context.env, context.req.raw), {
				owner_subject: owner.subject,
				browser_id: browserId,
				state,
				expires_at: Date.now() + OWNER_STATE_TTL_MS,
			});
			const nextRun = new Date(Date.now());
			nextRun.setUTCHours(nextRun.getUTCHours() + 1, 0, 0, 0);
			const html = renderExportsPage({
				service: ownerServiceMetadata(context.env),
				csrf: state,
				nextRun: nextRun.toISOString(),
				lastSnapshot:
					snapshots[0] === undefined
						? null
						: escapeHtml(snapshots[0].created_at),
				retainedCount: snapshots.length === 0 ? null : snapshots.length,
				totalBytes:
					snapshots.length === 0
						? null
						: snapshots.reduce((total, snapshot) => total + snapshot.size, 0),
				snapshots: snapshots.map((snapshot) => ({
					createdAt: escapeHtml(snapshot.created_at),
					size: snapshot.size,
					downloadUrl: escapeHtml(snapshot.download_url),
				})),
				failedExports: failedExports.map((result) => ({
					createdAt: escapeHtml(result.created_at),
					failure: escapeHtml(result.failure?.kind ?? "unknown"),
				})),
			});
			return new Response(html, {
				headers: {
					"content-type": "text/html; charset=utf-8",
					"cache-control": "no-store",
					"set-cookie": `${OWNER_BROWSER_COOKIE}=${browserId}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=600`,
				},
			});
		} catch {
			return noStoreText("Unavailable", 503);
		}
	});

	app.post("/owner/exports", async (context) => {
		if (!isSameOrigin(context.req.raw, context.env))
			return noStoreText("Forbidden", 403);
		const owner = await verifyOwnerAccess(context.req.raw, context.env);
		if (!owner) return noStoreText("Unauthorized", 401);
		if (!resolveExports) return noStoreText("Unavailable", 503);
		const form = await readForm(context.req.raw);
		if (!form) return noStoreText("Invalid owner form", 400);
		const browserId = readCookie(context.req.raw, OWNER_BROWSER_COOKIE);
		if (!browserId || !isUuid(browserId) || !isUuid(form.state))
			return noStoreText("Invalid owner form", 400);
		const registry = resolveRegistry(context.env, context.req.raw);
		const accepted = await consumeOwnerCsrf(registry, {
			owner_subject: owner.subject,
			browser_id: browserId,
			state: form.state,
			now: Date.now(),
		});
		if (!accepted) return noStoreText("Invalid owner form", 403);
		try {
			const gateway = resolveExports(context.env, context.req.raw);
			const request = OwnerExportRequestSchema.parse({
				created_at: new Date().toISOString(),
			});
			const result = await gateway.start(owner.subject, request.created_at);
			if (!result) return noStoreText("Forbidden", 403);
			return new Response(null, {
				status: 303,
				headers: {
					location: `${context.env.SERVICE_ORIGIN}/owner/exports`,
					"cache-control": "no-store",
				},
			});
		} catch {
			return noStoreText("Unavailable", 503);
		}
	});

	app.get("/owner/exports/:epoch/:createdAt/download", async (context) => {
		const owner = await verifyOwnerAccess(context.req.raw, context.env);
		if (!owner) return noStoreText("Unauthorized", 401);
		if (!isCanonicalOwnerOrigin(context.req.raw, context.env))
			return noStoreText("Not found", 404);
		if (!resolveExports) return noStoreText("Unavailable", 503);
		const epoch = EpochSchema.safeParse(context.req.param("epoch"));
		const identity = OwnerExportRequestSchema.safeParse({
			created_at: context.req.param("createdAt"),
		});
		if (!epoch.success || !identity.success)
			return noStoreText("Not found", 404);
		try {
			const gateway = resolveExports(context.env, context.req.raw);
			const archive = await gateway.download(
				owner.subject,
				epoch.data,
				identity.data.created_at,
			);
			if (!archive)
				return noStoreText(
					"This packed export is no longer available. Return to /owner/exports to create a new export.",
					404,
				);
			return new Response(archive.body, {
				headers: {
					"cache-control": "no-store",
					"content-type": "application/zip",
					"content-length": String(archive.size),
					"content-disposition": `attachment; filename="packed-baseline-${epoch.data}-${identity.data.created_at.replace(/[:.]/g, "-")}.zip"`,
				},
			});
		} catch {
			return noStoreText("Unavailable", 503);
		}
	});

	app.get("/owner/blob-gc", async (context) => {
		const owner = await verifyOwnerAccess(context.req.raw, context.env);
		if (!owner) return noStoreText("Unauthorized", 401);
		if (!isCanonicalOwnerOrigin(context.req.raw, context.env))
			return noStoreText("Not found", 404);
		if (!resolveBlobGc) return noStoreText("Unavailable", 503);
		try {
			const gateway = resolveBlobGc(context.env, context.req.raw);
			const [observedPreview, observedStatus] = await Promise.all([
				gateway.preview(owner.subject),
				gateway.status(owner.subject),
			]);
			if (!observedPreview || !observedStatus)
				return noStoreText("Forbidden", 403);
			const preview = BlobGcPreviewSchema.parse(observedPreview);
			const status = BlobGcStatusSchema.parse(observedStatus);
			const browserId =
				readCookie(context.req.raw, OWNER_BROWSER_COOKIE) ??
				crypto.randomUUID();
			if (!isUuid(browserId)) return noStoreText("Unauthorized", 401);
			const state = crypto.randomUUID();
			await storeOwnerCsrf(resolveRegistry(context.env, context.req.raw), {
				owner_subject: owner.subject,
				browser_id: browserId,
				state,
				expires_at: Date.now() + OWNER_STATE_TTL_MS,
			});
			return new Response(
				renderBlobGcPage({
					csrf: state,
					service: ownerServiceMetadata(context.env),
					preview,
					status,
				}),
				{
					headers: {
						"content-type": "text/html; charset=utf-8",
						"cache-control": "no-store",
						"set-cookie": `${OWNER_BROWSER_COOKIE}=${browserId}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=600`,
					},
				},
			);
		} catch {
			return Response.json(
				BlobGcOperationFailureSchema.parse({
					kind: "blob_gc_unavailable",
					retry_after_seconds: 1,
				}),
				{
					status: 503,
					headers: { "cache-control": "no-store", "retry-after": "1" },
				},
			);
		}
	});

	app.post("/owner/blob-gc", async (context) => {
		if (!isSameOrigin(context.req.raw, context.env))
			return noStoreText("Forbidden", 403);
		const owner = await verifyOwnerAccess(context.req.raw, context.env);
		if (!owner) return noStoreText("Unauthorized", 401);
		if (!resolveBlobGc) return noStoreText("Unavailable", 503);
		const form = await readForm(context.req.raw);
		if (!form) return noStoreText("Invalid owner form", 400);
		const browserId = readCookie(context.req.raw, OWNER_BROWSER_COOKIE);
		if (!browserId || !isUuid(browserId) || !isUuid(form.state))
			return noStoreText("Invalid owner form", 400);
		const registry = resolveRegistry(context.env, context.req.raw);
		const accepted = await consumeOwnerCsrf(registry, {
			owner_subject: owner.subject,
			browser_id: browserId,
			state: form.state,
			now: Date.now(),
		});
		if (!accepted) return noStoreText("Invalid owner form", 403);
		try {
			const observedStatus = await resolveBlobGc(
				context.env,
				context.req.raw,
			).collect(owner.subject);
			if (!observedStatus) return noStoreText("Forbidden", 403);
			BlobGcStatusSchema.parse(observedStatus);
			return new Response(null, {
				status: 303,
				headers: {
					location: `${context.env.SERVICE_ORIGIN}/owner/blob-gc`,
					"cache-control": "no-store",
				},
			});
		} catch {
			return Response.json(
				BlobGcOperationFailureSchema.parse({
					kind: "blob_gc_unavailable",
					retry_after_seconds: 1,
				}),
				{
					status: 503,
					headers: { "cache-control": "no-store", "retry-after": "1" },
				},
			);
		}
	});

	app.get("/owner/measurements", async (context) => {
		const owner = await verifyOwnerAccess(context.req.raw, context.env);
		if (!owner) return noStoreText("Unauthorized", 401);
		if (!isCanonicalOwnerOrigin(context.req.raw, context.env))
			return noStoreText("Not found", 404);
		if (!resolveMeasurements) return noStoreText("Unavailable", 503);
		try {
			const gateway = resolveMeasurements(context.env, context.req.raw);
			const response = await gateway.readMeasurements(owner.subject);
			if (!response) return noStoreText("Forbidden", 403);
			const parsed = MeasurementResponseSchema.parse({
				...response,
				worker_isolate: readSlotCapacitySnapshot(),
			});
			const format = context.req.query("format");
			if (
				format === "html" ||
				(format !== "json" &&
					prefersMeasurementHtml(context.req.header("accept") ?? null))
			)
				return new Response(
					renderMeasurementsPage({
						...parsed,
						service: ownerServiceMetadata(context.env),
						requests: {
							...parsed.requests,
							clients: parsed.requests.clients.map((client) => ({
								...client,
								client_id: escapeHtml(client.client_id),
							})),
						},
						worker_isolate: parsed.worker_isolate
							? {
									...parsed.worker_isolate,
									isolate_id: escapeHtml(parsed.worker_isolate.isolate_id),
								}
							: undefined,
					}),
					{
						headers: {
							"content-type": "text/html; charset=utf-8",
							"cache-control": "no-store",
						},
					},
				);
			return new Response(JSON.stringify(parsed), {
				headers: {
					"content-type": "application/json; charset=utf-8",
					"cache-control": "no-store",
				},
			});
		} catch {
			return noStoreText("Unavailable", 503);
		}
	});

	app.get("/owner/clients/:clientId/grants", async (context) => {
		const owner = await verifyOwnerAccess(context.req.raw, context.env);
		if (!owner) return context.text("Unauthorized", 401);
		const registry = resolveRegistry(context.env, context.req.raw);
		const clientId = context.req.param("clientId");
		const [page, listedClient] = await Promise.all([
			listClientGrants(
				registry,
				owner.subject,
				clientId,
				context.req.query("cursor"),
			),
			findListedClient(registry, owner.subject, clientId),
		]);
		const html = renderGrantsPage({
			service: ownerServiceMetadata(context.env),
			clientId: escapeHtml(clientId),
			clientName: escapeHtml(listedClient?.name ?? "Unknown client"),
			clientKind: "Unknown",
			activeGrantCount: listedClient?.active_grant_count ?? null,
			cleanupPendingCount: listedClient?.cleanup_pending_count ?? null,
			encodedClientId: encodeURIComponent(clientId),
			nextCursor: page.next_cursor,
			encodedCursor: page.next_cursor
				? encodeURIComponent(page.next_cursor)
				: null,
			grants: page.grants.map((grant) => ({
				grantId: escapeHtml(grant.grant_id),
				createdAt: grant.created_at,
				revoked: grant.revoked,
				cleanupPending: grant.cleanup_pending,
			})),
		});
		return new Response(html, {
			headers: {
				"content-type": "text/html; charset=utf-8",
				"cache-control": "no-store",
			},
		});
	});

	app.post("/owner/clients/:clientId/rename", async (context) => {
		if (!isSameOrigin(context.req.raw, context.env))
			return context.text("Forbidden", 403);
		const owner = await verifyOwnerAccess(context.req.raw, context.env);
		if (!owner) return context.text("Unauthorized", 401);
		const form = await readForm(context.req.raw);
		if (!form) return context.text("Invalid owner form", 400);
		const browserId = readCookie(context.req.raw, OWNER_BROWSER_COOKIE);
		if (!browserId || !isUuid(browserId) || !isUuid(form.state))
			return context.text("Invalid owner form", 400);
		const registry = resolveRegistry(context.env, context.req.raw);
		const accepted = await consumeOwnerCsrf(registry, {
			owner_subject: owner.subject,
			browser_id: browserId,
			state: form.state,
			now: Date.now(),
		});
		if (!accepted) return context.text("Invalid owner form", 403);
		if (!form.name || form.name.trim().length > 80)
			return context.text("Invalid client name", 400);
		if (
			!(await renameClient(
				registry,
				owner.subject,
				context.req.param("clientId"),
				form.name.trim(),
			))
		)
			return context.text("Client not found", 404);
		return Response.redirect(
			`${context.env.SERVICE_ORIGIN}/owner/clients`,
			303,
		);
	});

	app.post("/owner/clients/:clientId/remove", async (context) => {
		if (!isSameOrigin(context.req.raw, context.env))
			return context.text("Forbidden", 403);
		const owner = await verifyOwnerAccess(context.req.raw, context.env);
		if (!owner) return context.text("Unauthorized", 401);
		const form = await readForm(context.req.raw);
		if (!form) return context.text("Invalid owner form", 400);
		const browserId = readCookie(context.req.raw, OWNER_BROWSER_COOKIE);
		if (!browserId || !isUuid(browserId) || !isUuid(form.state))
			return context.text("Invalid owner form", 400);
		const registry = resolveRegistry(context.env, context.req.raw);
		const accepted = await consumeOwnerCsrf(registry, {
			owner_subject: owner.subject,
			browser_id: browserId,
			state: form.state,
			now: Date.now(),
		});
		if (!accepted) return context.text("Invalid owner form", 403);
		if (
			!(await removeClient(
				registry,
				owner.subject,
				context.req.param("clientId"),
			))
		)
			return context.text(
				"Client removal needs revocation and complete provider cleanup",
				409,
			);
		return Response.redirect(
			`${context.env.SERVICE_ORIGIN}/owner/clients`,
			303,
		);
	});

	app.post("/owner/clients/:clientId/revoke", async (context) => {
		if (!isSameOrigin(context.req.raw, context.env))
			return context.text("Forbidden", 403);
		const owner = await verifyOwnerAccess(context.req.raw, context.env);
		if (!owner) return context.text("Unauthorized", 401);
		const form = await readForm(context.req.raw);
		if (!form) return context.text("Invalid owner form", 400);
		const browserId = readCookie(context.req.raw, OWNER_BROWSER_COOKIE);
		if (!browserId || !isUuid(browserId) || !isUuid(form.state))
			return context.text("Invalid owner form", 400);
		const registry = resolveRegistry(context.env, context.req.raw);
		const budget: OwnerCleanupExternalCallBudget = {
			remainingCalls: OWNER_CLEANUP_EXTERNAL_CALL_LIMIT,
		};
		budget.remainingCalls -= 1;
		const accepted = await consumeOwnerCsrf(registry, {
			owner_subject: owner.subject,
			browser_id: browserId,
			state: form.state,
			now: Date.now(),
		});
		if (!accepted) return context.text("Invalid owner form", 403);
		if (!context.env.OAUTH_KV)
			return context.text("OAuth cleanup is unavailable", 503);
		const provider = createProviderGrantCleanup(context.env);
		const result = await revokeClient(
			registry,
			provider,
			owner.subject,
			context.req.param("clientId"),
			budget,
		);
		if (!result) return context.text("Client not found", 404);
		return Response.redirect(
			`${context.env.SERVICE_ORIGIN}/owner/clients`,
			303,
		);
	});
	return app;
}

/** Return a text response that cannot be stored by a browser or intermediary. */
function noStoreText(body: string, status: number): Response {
	return new Response(body, {
		status,
		headers: { "cache-control": "no-store" },
	});
}

/** Check the canonical service origin before any owner measurement read. */
function isCanonicalOwnerOrigin(request: Request, env: Env): boolean {
	return Boolean(
		env.SERVICE_ORIGIN && new URL(request.url).origin === env.SERVICE_ORIGIN,
	);
}

/** Accept state changes only when both the request URL and Origin match configured service origin. */
function isSameOrigin(request: Request, env: Env): boolean {
	if (!env.SERVICE_ORIGIN) return false;
	try {
		return (
			new URL(request.url).origin === env.SERVICE_ORIGIN &&
			request.headers.get("origin") === env.SERVICE_ORIGIN
		);
	} catch {
		return false;
	}
}

/** Read one bounded URL-encoded form and reject duplicate CSRF or name fields. */
async function readForm(
	request: Request,
): Promise<{ state: string; name?: string } | null> {
	if (
		request.headers.get("content-type")?.split(";", 1)[0] !==
		"application/x-www-form-urlencoded"
	)
		return null;
	const declared = request.headers.get("content-length");
	if (
		declared !== null &&
		(!/^\d+$/.test(declared) || Number(declared) > OWNER_FORM_LIMIT)
	)
		return null;
	const reader = request.body?.getReader();
	if (!reader) return null;
	const chunks: Uint8Array[] = [];
	let byteLength = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			byteLength += value.byteLength;
			if (byteLength > OWNER_FORM_LIMIT) {
				await reader.cancel();
				return null;
			}
			chunks.push(value);
		}
		const bytes = new Uint8Array(byteLength);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.byteLength;
		}
		const body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		const form = new URLSearchParams(body);
		const states = form.getAll("csrf");
		const names = form.getAll("name");
		if (states.length !== 1 || names.length > 1) return null;
		return { state: states[0] ?? "", name: names[0] };
	} catch {
		return null;
	} finally {
		reader.releaseLock();
	}
}

/** Validate a canonical UUID form-state identifier. */
function isUuid(value: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
		value,
	);
}
