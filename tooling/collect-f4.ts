import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { collectF4Measurements, formatF4Summary } from "@tooling/f4-collection";
import {
	assertAccessCookiePath,
	defaultF4CredentialRoot,
	readAccessCookieFile,
} from "@tooling/f4-credentials";
import {
	type MeasurementResponse,
	MeasurementResponseSchema,
} from "@vaultwire/protocol";

/** Fixed owner endpoint; command arguments cannot change its origin or route. */
const SERVICE_MEASUREMENTS_URL =
	"https://vaultwire.mmorillo.dev/owner/measurements";
/** Caps retained JSON body bytes after decompression. */
const MAX_MEASUREMENT_RESPONSE_BYTES = 262_144;
/** Static command syntax that never repeats user-supplied paths. */
const USAGE = "Usage: collect:f4 --cookie-file <path>";

/** Dependencies allow tests to check the CLI boundary without network or filesystem access. */
export interface F4CollectionCliDependencies {
	/** Absolute owner home used only to build the dedicated credential root. */
	home: string;
	/** Reads one cookie file only after its absolute path passes lexical checks. */
	readCookieFile(path: string, credentialRoot: string): Promise<string>;
	/** Performs one fixed-origin fetch; tests inject a local response. */
	fetch(input: string, init: RequestInit): Promise<Response>;
	/** Writes one allowlisted summary line. */
	writeOutput(line: string): void;
	/** Writes one static diagnostic without secret or path details. */
	writeError(line: string): void;
}

/** Parses only the explicit cookie file option and rejects all other authority inputs. */
function parseArguments(
	args: string[],
): { cookieFile: string } | "help" | null {
	if (args.length === 1 && args[0] === "--help") return "help";
	if (
		args.length !== 2 ||
		args[0] !== "--cookie-file" ||
		!args[1] ||
		!isAbsolute(args[1])
	)
		return null;
	return { cookieFile: args[1] };
}

/** Reads a response body without retaining more than the configured bound. */
async function readBoundedResponse(response: Response): Promise<string> {
	const declaredLength = response.headers.get("content-length");
	if (
		declaredLength !== null &&
		(!/^\d+$/.test(declaredLength) ||
			Number(declaredLength) > MAX_MEASUREMENT_RESPONSE_BYTES)
	) {
		await response.body?.cancel().catch(() => undefined);
		throw new Error("oversized");
	}
	if (!response.body) throw new Error("invalid");
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let totalBytes = 0;
	try {
		while (true) {
			const result = await reader.read();
			if (result.done) break;
			totalBytes += result.value.byteLength;
			if (totalBytes > MAX_MEASUREMENT_RESPONSE_BYTES) {
				await reader.cancel().catch(() => undefined);
				throw new Error("oversized");
			}
			chunks.push(result.value);
		}
	} finally {
		reader.releaseLock();
	}
	const body = new Uint8Array(totalBytes);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder("utf-8", { fatal: true }).decode(body);
}

/** Accepts one single-line Cloudflare Access authorization cookie and no other fields. */
function parseAccessCookieFile(contents: string): string | null {
	const line = contents.endsWith("\n") ? contents.slice(0, -1) : contents;
	const match = /^CF_Authorization=([A-Za-z0-9._~-]+)$/.exec(line);
	return match?.[1] ?? null;
}

/** Converts canonical wire timestamps to ISO UTC text without changing their value. */
function isoTime(value: number | null | undefined): string | null {
	return value === null || value === undefined
		? null
		: new Date(value).toISOString();
}

/** Maps the canonical service response to the local safe presentation contract. */
function toF4Snapshot(response: MeasurementResponse) {
	if (
		(response.day_start === null) !== (response.day_end === null) ||
		(response.observed_from === null) !==
			(response.observed_through === null) ||
		(response.requests.observed_from === null) !==
			(response.requests.observed_through === null)
	)
		throw new Error("invalid");
	const window =
		response.day_start === null || response.day_end === null
			? null
			: {
					start: isoTime(response.day_start) as string,
					end: isoTime(response.day_end) as string,
				};
	const observation =
		response.observed_from === null || response.observed_through === null
			? null
			: {
					start: isoTime(response.observed_from) as string,
					end: isoTime(response.observed_through) as string,
				};
	const requestObservation =
		response.requests.observed_from === null ||
		response.requests.observed_through === null
			? null
			: {
					start: isoTime(response.requests.observed_from) as string,
					end: isoTime(response.requests.observed_through) as string,
				};
	const feedSampleTimes = [
		response.feed_latency.first_sample_at,
		response.feed_latency.last_sample_at,
	]
		.filter((value): value is number => value !== undefined && value !== null)
		.map((value) => isoTime(value) as string)
		.filter(
			(value, index, values) =>
				response.feed_latency.sample_count > 1 ||
				index === 0 ||
				value !== values[index - 1],
		);
	const feedStatus = response.feed_latency.stale
		? "stale"
		: response.feed_latency.status;
	return {
		serviceStatus: response.status,
		coverage: response.coverage,
		window,
		observation,
		requests: {
			status: response.requests.stale ? "stale" : response.requests.status,
			sourceStatus: response.requests.status,
			stale: response.requests.stale,
			count: response.requests.count,
			rest: response.requests.rest_count,
			mcp: response.requests.mcp_count,
			unit: "requests" as const,
			window,
			observation: requestObservation,
			partialDay:
				response.coverage === "partial"
					? true
					: response.coverage === "complete"
						? false
						: null,
			clientCoverage:
				response.requests.status === "unknown"
					? "unknown"
					: response.coverage === "unknown"
						? "incomplete"
						: "complete",
			clients: response.requests.clients.map((client) => ({
				id: client.client_id,
				rest: client.requests_rest,
				mcp: client.requests_mcp,
				lastFeedRequestAt: isoTime(client.last_feed_request_at),
				minPollIntervalMs: client.minimum_poll_interval_ms,
				maxPollIntervalMs: client.maximum_poll_interval_ms,
				pollCadenceIncomplete: client.poll_cadence_incomplete,
			})),
		},
		feedLatency: {
			status: feedStatus,
			sourceStatus: response.feed_latency.status,
			stale: response.feed_latency.stale,
			p95: response.feed_latency.p95,
			unit: "ms" as const,
			window,
			observation:
				feedSampleTimes.length === 0
					? observation
					: {
							start: feedSampleTimes[0] as string,
							end: feedSampleTimes.at(-1) as string,
						},
			partialDay:
				response.coverage === "partial"
					? true
					: response.coverage === "complete"
						? false
						: null,
			retainedSamples: response.feed_latency.sample_count,
			totalSamples: response.feed_latency.total_sample_count,
			retainedSampleTimes: feedSampleTimes,
			capExcluded:
				response.feed_latency.total_sample_count >
				response.feed_latency.sample_count,
			method: "nearest-rank" as const,
			boundary: "service-side response preparation" as const,
			...(response.feed_latency.stale
				? { reason: "stale" as const }
				: response.feed_latency.p95 === null &&
						response.feed_latency.sample_count === 0
					? { reason: "no_samples" as const }
					: response.feed_latency.status === "unknown"
						? { reason: "unavailable" as const }
						: {}),
		},
		storage: {
			databaseBytes: response.storage.database_bytes,
			referencedBlobBytes: response.storage.referenced_blob_bytes,
			meaning:
				"SQLite allocation and deduplicated referenced R2 bytes; not bucket allocation or integrity" as const,
		},
	};
}

/** Runs the fixed-origin owner collector and writes only safe summaries or static errors. */
export async function runF4CollectionCli(
	args: string[],
	dependencies: F4CollectionCliDependencies,
): Promise<number> {
	const parsed = parseArguments(args);
	if (parsed === "help") {
		dependencies.writeOutput(USAGE);
		return 0;
	}
	if (!parsed || !isAbsolute(dependencies.home)) {
		dependencies.writeError(USAGE);
		return 2;
	}
	const credentialRoot = defaultF4CredentialRoot(dependencies.home);
	try {
		assertAccessCookiePath(parsed.cookieFile, credentialRoot);
	} catch {
		dependencies.writeError("Credential file path is invalid");
		return 2;
	}
	let cookieFile: string;
	try {
		cookieFile = await dependencies.readCookieFile(
			parsed.cookieFile,
			credentialRoot,
		);
	} catch {
		dependencies.writeError("Credential file unavailable");
		return 1;
	}
	const token = parseAccessCookieFile(cookieFile);
	if (!token) {
		dependencies.writeError("Cookie file format is invalid");
		return 1;
	}
	let response: Response;
	try {
		response = await dependencies.fetch(SERVICE_MEASUREMENTS_URL, {
			method: "GET",
			redirect: "manual",
			headers: {
				accept: "application/json",
				cookie: `CF_Authorization=${token}`,
			},
		});
	} catch {
		dependencies.writeError("Measurement request failed");
		return 1;
	}
	if (
		(response.status >= 300 && response.status < 400) ||
		response.type === "opaqueredirect"
	) {
		await response.body?.cancel().catch(() => undefined);
		dependencies.writeError("Service returned a redirect");
		return 1;
	}
	if (response.status === 401) {
		await response.body?.cancel().catch(() => undefined);
		dependencies.writeError("Unauthorized");
		return 1;
	}
	if (response.status === 403) {
		await response.body?.cancel().catch(() => undefined);
		dependencies.writeError("Forbidden");
		return 1;
	}
	if (response.status !== 200) {
		await response.body?.cancel().catch(() => undefined);
		dependencies.writeError("Service request failed");
		return 1;
	}
	if (
		response.headers
			.get("content-type")
			?.split(";")[0]
			?.trim()
			.toLowerCase() !== "application/json"
	) {
		await response.body?.cancel().catch(() => undefined);
		dependencies.writeError("Service response is invalid");
		return 1;
	}
	let payload: unknown;
	try {
		payload = JSON.parse(await readBoundedResponse(response));
	} catch (error) {
		dependencies.writeError(
			error instanceof Error && error.message === "oversized"
				? "Service response exceeds the size limit"
				: "Service response is invalid",
		);
		return 1;
	}
	const canonical = MeasurementResponseSchema.safeParse(payload);
	if (!canonical.success) {
		dependencies.writeError("Service response is invalid");
		return 1;
	}
	try {
		const safe = await collectF4Measurements(async () =>
			toF4Snapshot(canonical.data),
		);
		dependencies.writeOutput(formatF4Summary(safe));
		return 0;
	} catch {
		dependencies.writeError("Service response is invalid");
		return 1;
	}
}

/** Starts the CLI only when Bun executes this file as the entry point. */
async function main(): Promise<void> {
	const dependencies: F4CollectionCliDependencies = {
		home: process.env.HOME ?? "",
		readCookieFile: readAccessCookieFile,
		fetch: globalThis.fetch,
		writeOutput: (line) => process.stdout.write(`${line}\n`),
		writeError: (line) => process.stderr.write(`${line}\n`),
	};
	process.exitCode = await runF4CollectionCli(
		process.argv.slice(2),
		dependencies,
	);
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
	await main();
}
