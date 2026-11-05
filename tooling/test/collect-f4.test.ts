import { runF4CollectionCli } from "@tooling/collect-f4";
import { describe, expect, it } from "vitest";

/** Complete canonical owner response fixture with stale requests and unknown storage. */
const measurementResponse = {
	status: "observed",
	coverage: "unknown",
	day_start: 1_762_300_800_000,
	day_end: 1_762_387_200_000,
	observed_from: 1_762_304_400_000,
	observed_through: 1_762_307_400_000,
	requests: {
		status: "observed",
		count: 4,
		observed_from: 1_762_304_400_000,
		observed_through: 1_762_307_400_000,
		rest_count: 4,
		mcp_count: 0,
		stale: true,
		clients: [
			{
				client_id: "client_42",
				requests_rest: 4,
				requests_mcp: 0,
				last_feed_request_at: 1_762_307_400_000,
				minimum_poll_interval_ms: null,
				maximum_poll_interval_ms: null,
				poll_cadence_incomplete: true,
			},
		],
	},
	feed_latency: {
		status: "observed",
		unit: "milliseconds",
		sample_count: 1,
		total_sample_count: 3,
		p95: 125,
		first_sample_at: 1_762_305_000_000,
		last_sample_at: 1_762_305_000_000,
		stale: false,
	},
	storage: {
		database_bytes: { status: "observed", value: 2_048 },
		referenced_blob_bytes: { status: "unknown", reason: "storage_error" },
	},
};

/** Builds an injectable command harness and records side effects for assertions. */
function dependencies(response: Response | (() => Promise<Response>)) {
	const output: string[] = [];
	const errors: string[] = [];
	const calls: { path?: string; url?: string; init?: RequestInit } = {};
	return {
		output,
		errors,
		calls,
		deps: {
			home: "/synthetic/home",
			/** Records attempted credential access without reading a local file. */
			async readCookieFile(path: string, root: string) {
				calls.path = `${root}|${path}`;
				return "CF_Authorization=header.payload.signature\n";
			},
			/** Returns the configured synthetic response and records request options. */
			async fetch(url: string | URL | Request, init?: RequestInit) {
				calls.url = String(url);
				calls.init = init;
				return typeof response === "function" ? response() : response;
			},
			/** Captures the command's safe output for assertions. */
			writeOutput(line: string) {
				output.push(line);
			},
			/** Captures static diagnostics without writing to the host terminal. */
			writeError(line: string) {
				errors.push(line);
			},
		},
	};
}

/** Encodes one JSON protocol fixture using the documented media type. */
function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

describe("F4 collection CLI", () => {
	it("fetches the fixed owner route without following redirects and prints only the safe projection", async () => {
		const context = dependencies(jsonResponse(measurementResponse));
		const exitCode = await runF4CollectionCli(
			[
				"--cookie-file",
				"/synthetic/home/.config/obsidian-ai-bridge/f4/access.cookie",
			],
			context.deps,
		);
		expect(exitCode).toBe(0);
		expect(context.calls.url).toBe(
			"https://obsidian-bridge.mmorillo.dev/owner/measurements",
		);
		expect(context.calls.init?.redirect).toBe("manual");
		expect(context.calls.init?.headers).toMatchObject({
			accept: "application/json",
			cookie: "CF_Authorization=header.payload.signature",
		});
		expect(context.output).toHaveLength(1);
		expect(context.output[0]).toContain("Request data: stale (stale)");
		expect(context.output[0]).toContain("Client client_42");
		expect(context.output[0]).toContain("125 ms");
		expect(context.output[0]).toContain("storage_error");
		expect(context.output.join("\n")).not.toContain("header.payload.signature");
	});

	it("keeps equal first and last times when multiple samples share one millisecond", async () => {
		const response = {
			...measurementResponse,
			feed_latency: { ...measurementResponse.feed_latency, sample_count: 2 },
		};
		const context = dependencies(jsonResponse(response));
		await expect(
			runF4CollectionCli(
				[
					"--cookie-file",
					"/synthetic/home/.config/obsidian-ai-bridge/f4/access.cookie",
				],
				context.deps,
			),
		).resolves.toBe(0);
		expect(context.output[0]).toContain("2/3 retained/total samples");
		expect(context.errors).toEqual([]);
	});

	it("preserves unknown windows and null values without creating zero or fresh data", async () => {
		const unknown = {
			...measurementResponse,
			status: "unknown",
			coverage: "unknown",
			day_start: null,
			day_end: null,
			observed_from: null,
			observed_through: null,
			requests: {
				status: "unknown",
				count: null,
				observed_from: null,
				observed_through: null,
				rest_count: null,
				mcp_count: null,
				stale: true,
				clients: [],
			},
			feed_latency: {
				status: "unknown",
				unit: "milliseconds",
				sample_count: 0,
				total_sample_count: 0,
				p95: null,
				stale: true,
			},
		};
		const context = dependencies(jsonResponse(unknown));
		await expect(
			runF4CollectionCli(
				[
					"--cookie-file",
					"/synthetic/home/.config/obsidian-ai-bridge/f4/access.cookie",
				],
				context.deps,
			),
		).resolves.toBe(0);
		expect(context.output[0]).toContain("Request data: stale (stale)");
		expect(context.output[0]).toContain(
			"Feed response preparation p95: stale (no samples)",
		);
		expect(context.output[0]).not.toContain("REST 0");
		expect(context.output[0]).toContain("unknown (storage_error)");
	});

	it.each([
		[401, "Unauthorized"],
		[403, "Forbidden"],
	] as const)(
		"reports HTTP %i with a static error",
		async (status, message) => {
			const context = dependencies(new Response("cookie=SECRET", { status }));
			await expect(
				runF4CollectionCli(
					[
						"--cookie-file",
						"/synthetic/home/.config/obsidian-ai-bridge/f4/access.cookie",
					],
					context.deps,
				),
			).resolves.toBe(1);
			expect(context.errors).toEqual([message]);
			expect(context.errors.join()).not.toContain("SECRET");
			expect(context.output).toEqual([]);
		},
	);

	it("rejects schema failures without printing response fields", async () => {
		const context = dependencies(
			jsonResponse({ ...measurementResponse, secret: "COOKIE_SECRET" }),
		);
		await expect(
			runF4CollectionCli(
				[
					"--cookie-file",
					"/synthetic/home/.config/obsidian-ai-bridge/f4/access.cookie",
				],
				context.deps,
			),
		).resolves.toBe(1);
		expect(context.errors).toEqual(["Service response is invalid"]);
		expect(context.errors.join()).not.toContain("COOKIE_SECRET");
	});

	it("rejects redirects and oversized responses before JSON parsing", async () => {
		const redirect = dependencies(
			new Response("secret", {
				status: 302,
				headers: { location: "https://evil.example/" },
			}),
		);
		await expect(
			runF4CollectionCli(
				[
					"--cookie-file",
					"/synthetic/home/.config/obsidian-ai-bridge/f4/access.cookie",
				],
				redirect.deps,
			),
		).resolves.toBe(1);
		expect(redirect.errors).toEqual(["Service returned a redirect"]);
		const large = dependencies(
			new Response("", {
				headers: {
					"content-length": "999999999",
					"content-type": "application/json",
				},
			}),
		);
		await expect(
			runF4CollectionCli(
				[
					"--cookie-file",
					"/synthetic/home/.config/obsidian-ai-bridge/f4/access.cookie",
				],
				large.deps,
			),
		).resolves.toBe(1);
		expect(large.errors).toEqual(["Service response exceeds the size limit"]);
	});

	it("bounds a streamed response without trusting content-length", async () => {
		const body = new ReadableStream<Uint8Array>({
			/** Emits one oversized chunk to test the response size guard. */
			start(controller) {
				controller.enqueue(new Uint8Array(270_000));
			},
		});
		const context = dependencies(
			new Response(body, { headers: { "content-type": "application/json" } }),
		);
		await expect(
			runF4CollectionCli(
				[
					"--cookie-file",
					"/synthetic/home/.config/obsidian-ai-bridge/f4/access.cookie",
				],
				context.deps,
			),
		).resolves.toBe(1);
		expect(context.errors).toEqual(["Service response exceeds the size limit"]);
	});

	it("rejects malformed cookie files and hides fetch failures", async () => {
		const malformed = dependencies(jsonResponse(measurementResponse));
		malformed.deps.readCookieFile = async () =>
			"CF_Authorization=bad; other=secret";
		await expect(
			runF4CollectionCli(
				[
					"--cookie-file",
					"/synthetic/home/.config/obsidian-ai-bridge/f4/access.cookie",
				],
				malformed.deps,
			),
		).resolves.toBe(1);
		expect(malformed.errors).toEqual(["Cookie file format is invalid"]);
		expect(malformed.calls.url).toBeUndefined();
		const failed = dependencies(async () => {
			throw new Error("cookie=SECRET /private/path");
		});
		await expect(
			runF4CollectionCli(
				[
					"--cookie-file",
					"/synthetic/home/.config/obsidian-ai-bridge/f4/access.cookie",
				],
				failed.deps,
			),
		).resolves.toBe(1);
		expect(failed.errors).toEqual(["Measurement request failed"]);
		expect(failed.errors.join()).not.toContain("SECRET");
		expect(failed.errors.join()).not.toContain("/private/path");
	});

	it.each([
		[],
		["--vault", "/vault"],
		["--cookie-file"],
		["--cookie-file", "one", "--cookie-file", "two"],
	] as string[][])(
		"rejects invalid arguments before file or network access",
		async (...args) => {
			const context = dependencies(jsonResponse(measurementResponse));
			await expect(runF4CollectionCli(args, context.deps)).resolves.toBe(2);
			expect(context.errors).toEqual([
				"Usage: collect:f4 --cookie-file <path>",
			]);
			expect(context.calls.path).toBeUndefined();
			expect(context.calls.url).toBeUndefined();
		},
	);

	it("rejects a cookie path outside its dedicated root before file access", async () => {
		const context = dependencies(jsonResponse(measurementResponse));
		await expect(
			runF4CollectionCli(
				["--cookie-file", "/synthetic/home/vault/.obsidian/cookie"],
				context.deps,
			),
		).resolves.toBe(2);
		expect(context.errors).toEqual(["Credential file path is invalid"]);
		expect(context.calls.path).toBeUndefined();
		expect(context.calls.url).toBeUndefined();
	});
});
