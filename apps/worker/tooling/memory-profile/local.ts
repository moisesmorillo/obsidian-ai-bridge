/**
 * OAB-53 local memory profile runner.
 *
 * Run with Node from `apps/worker`: `node tooling/memory-profile/local.ts --out <dir>`. Node runs
 * the Wrangler and Miniflare JavaScript APIs that this runner needs. Options: `--levels 1,4,8,12`,
 * `--duration-ms 8000`, `--workloads <names>`, `--stall false`, `--stall-hold-ms 125000`, and
 * `--v8-flags "--expose-gc --max-heap-size=128"`.
 *
 * The runner bundles the real `src/index.ts` with `wrangler deploy --dry-run` and the
 * `wrangler.f2.jsonc` config. That config has the production compatibility date and flag and a
 * synthetic Access team. The dry run uploads nothing. The runner uses the Wrangler and Miniflare of
 * the Workers test pool, because the workerd of the pinned deploy Wrangler rejects the production
 * compatibility flag.
 *
 * Miniflare runs the bundle as two Workers in one local workerd process. The `api` Worker serves
 * requests. The `vault` Worker hosts the Vault Durable Object, which `api` reaches through a
 * cross-script binding. Each Worker has its own V8 isolate, like production, where the Worker and
 * the Durable Object run in separate isolates. An outbound service answers only the synthetic
 * Access JWKS fetch. The runner gets a bearer token through the real OAuth registration, consent,
 * and code flow. It does not change product code and does not bypass authentication.
 *
 * Every 50 ms the runner reads `Runtime.getHeapUsage` from both isolates through the workerd
 * inspector and the workerd process RSS from `ps`. Every 500 ms it reads the application
 * reservations from `/owner/measurements?format=json`. Before each level it runs `gc()` in both
 * isolates and records the heap floor. After each level it waits until held leases and reserved
 * bytes reach zero. All state lives in the `--out` directory. The runner uses only loopback
 * addresses.
 */
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type {
	LevelResult,
	ProfileTarget,
} from "@worker/../tooling/memory-profile/workloads";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

/**
 * Workload module loaded by URL at runtime. Node runs this file without tsconfig path aliases, so
 * the alias import above supplies types only and is erased.
 */
const {
	createWorkloads,
	DEFAULT_SEED,
	deleteLoadtestFiles,
	openStalledReads,
	runLevel,
	seedFixtures,
	sleep,
} = (await import(
	new URL("./workloads.ts", import.meta.url).href
)) as typeof import("@worker/../tooling/memory-profile/workloads");

/** Promise form of `execFile` for `ps`, `lsof`, and the dry-run build. */
const run = promisify(execFile);
/** Synthetic service origin from `wrangler.f2.jsonc`. */
const SERVICE_ORIGIN = "https://service.test";
/** Synthetic Access team domain from `wrangler.f2.jsonc`. */
const ACCESS_TEAM = "https://team.test";
/** Synthetic Access audience from `wrangler.f2.jsonc`. */
const ACCESS_AUDIENCE = "synthetic-access-app";
/** Synthetic owner subject from `wrangler.f2.jsonc`. */
const OWNER_SUBJECT = "synthetic-owner";
/** Conservative isolate memory limit from spec §6.5 used for headroom, in bytes. */
const ISOLATE_LIMIT_BYTES = 128_000_000;
/** Isolates sampled separately: the request Worker and the Vault Durable Object host. */
const ISOLATES = ["api", "vault"] as const;
/** Name of one sampled isolate. */
type IsolateName = (typeof ISOLATES)[number];

/** Command-line options; every value has a local-only default. */
interface Options {
	/** Directory for local persistence, the bundle, `results.json`, and `table.md`. */
	out: string;
	/** Loopback port of the Miniflare entry socket. */
	port: number;
	/** Loopback port of the workerd inspector. */
	inspectorPort: number;
	/** Duration of each workload level, in milliseconds. */
	durationMs: number;
	/** Concurrency levels run for every workload. */
	levels: number[];
	/** Workload names to run, or null for the full catalog. */
	workloads: string[] | null;
	/** Whether to run the OAB-58 stalled-read phase. */
	stall: boolean;
	/** Time the stalled reads stay unread before new load, in milliseconds. */
	stallHoldMs: number;
	/** V8 flags passed to workerd through `MINIFLARE_WORKERD_V8_FLAGS`. */
	v8Flags: string;
}

/** Parse `--name value` options. */
function parseOptions(argv: readonly string[]): Options {
	const values = new Map<string, string>();
	for (let index = 0; index < argv.length; index += 2)
		values.set(String(argv[index]).replace(/^--/, ""), String(argv[index + 1]));
	const out = values.get("out");
	if (!out) throw new Error("--out <directory> is required");
	return {
		out: resolve(out),
		port: Number(values.get("port") ?? 18_931),
		inspectorPort: Number(values.get("inspector-port") ?? 19_931),
		durationMs: Number(values.get("duration-ms") ?? 8_000),
		levels: (values.get("levels") ?? "1,4,8,12").split(",").map(Number),
		workloads: values.get("workloads")?.split(",") ?? null,
		stall: values.get("stall") !== "false",
		stallHoldMs: Number(values.get("stall-hold-ms") ?? 125_000),
		v8Flags: values.get("v8-flags") ?? "--expose-gc",
	};
}

/** Resolve the Wrangler entry used by the Workers test pool; its workerd supports the prod flag. */
function wranglerEntry(): string {
	const pluginManifest = realpathSync(
		new URL(
			"../../node_modules/@cloudflare/vitest-plugin/package.json",
			import.meta.url,
		).pathname,
	);
	return createRequire(pluginManifest).resolve("wrangler");
}

/** Read the `version` field of the package that contains a resolved entry file. */
function packageVersion(entry: string, levelsUp: number): string {
	let directory = entry;
	for (let level = 0; level < levelsUp; level++) directory = dirname(directory);
	return (
		JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as {
			version: string;
		}
	).version;
}

/** Synthetic Access signer whose public key the outbound service serves as the team JWKS. */
interface AccessSigner {
	/** Serialized JWKS document with the single public signing key. */
	jwks: string;
	/** Sign a fresh owner Access JWT for the synthetic team, audience, and subject. */
	assertion(): Promise<string>;
}

/** Create one RS256 key pair and an owner-assertion factory. */
async function createAccessSigner(): Promise<AccessSigner> {
	const keys = await generateKeyPair("RS256");
	const jwk = await exportJWK(keys.publicKey);
	return {
		jwks: JSON.stringify({
			keys: [{ ...jwk, kid: "profile-owner", alg: "RS256", use: "sig" }],
		}),
		assertion: () =>
			new SignJWT({})
				.setProtectedHeader({ alg: "RS256", kid: "profile-owner" })
				.setIssuer(ACCESS_TEAM)
				.setAudience(ACCESS_AUDIENCE)
				.setSubject(OWNER_SUBJECT)
				.setIssuedAt(Math.floor(Date.now() / 1000) - 5)
				.setExpirationTime("2h")
				.sign(keys.privateKey),
	};
}

/**
 * Subset of the Miniflare instance API that this runner uses. Miniflare 5 takes a new options
 * format, so the runner passes Miniflare 4 style options through `convertV4MiniflareOptions`.
 */
interface MiniflareInstance {
	/** Resolve with the entry URL once workerd serves requests. */
	readonly ready: Promise<URL>;
	/** Stop workerd and release its ports. */
	dispose(): Promise<void>;
}

/** Started local runtime and its identifying versions. */
interface LocalRuntime {
	readonly miniflare: MiniflareInstance;
	readonly wrangler: string;
	readonly miniflareVersion: string;
	readonly compatibilityDate: string;
	readonly compatibilityFlags: string[];
}

/**
 * Bundle `src/index.ts` with a Wrangler dry run, then start Miniflare with the `api` and `vault`
 * Workers. Both Workers load the same bundle and the bindings, vars, and compatibility settings of
 * `wrangler.f2.jsonc`. Only `vault` hosts the Vault class, so the Durable Object runs in its own
 * isolate.
 */
async function startRuntime(
	options: Options,
	signer: AccessSigner,
): Promise<LocalRuntime> {
	const wrangler = wranglerEntry();
	const configPath = new URL("../../wrangler.f2.jsonc", import.meta.url)
		.pathname;
	const bundle = join(options.out, "bundle");
	await run(
		process.execPath,
		[
			join(dirname(dirname(wrangler)), "bin", "wrangler.js"),
			"deploy",
			"--dry-run",
			"--outdir",
			bundle,
			"--config",
			configPath,
		],
		{ cwd: dirname(configPath), maxBuffer: 16 * 1024 * 1024 },
	);
	const config = JSON.parse(readFileSync(configPath, "utf8")) as {
		compatibility_date: string;
		compatibility_flags: string[];
		vars: Record<string, string>;
	};
	const miniflareEntry = createRequire(wrangler).resolve("miniflare");
	const { Miniflare, convertV4MiniflareOptions } = (await import(
		miniflareEntry
	)) as {
		Miniflare: new (options: unknown) => MiniflareInstance;
		convertV4MiniflareOptions: (options: Record<string, unknown>) => unknown;
	};
	process.env.MINIFLARE_WORKERD_V8_FLAGS = options.v8Flags;
	// Miniflare fails to start the api Worker ("internal error") when the working directory is
	// apps/worker. The cause was not isolated, so the runner starts it from the output directory.
	process.chdir(options.out);
	/** Bindings and settings shared by both Workers. */
	const shared = {
		modules: true,
		scriptPath: join(bundle, "index.js"),
		compatibilityDate: config.compatibility_date,
		compatibilityFlags: config.compatibility_flags,
		bindings: config.vars,
		kvNamespaces: { OAUTH_KV: "oauth-kv" },
		r2Buckets: { R2_BUCKET: "blobs", BACKUP_BUCKET: "backups" },
	};
	const miniflare = new Miniflare(
		convertV4MiniflareOptions({
			host: "127.0.0.1",
			port: options.port,
			inspectorPort: options.inspectorPort,
			upstream: SERVICE_ORIGIN,
			resourcePersistencePath: join(options.out, "state"),
			workers: [
				{
					...shared,
					name: "api",
					durableObjects: {
						VAULTS: { className: "Vault", scriptName: "vault" },
					},
					/** Serve only the synthetic Access JWKS and refuse every other outbound fetch. */
					outboundService: (request: Request) =>
						request.url === `${ACCESS_TEAM}/cdn-cgi/access/certs`
							? new Response(signer.jwks, {
									headers: { "content-type": "application/json" },
								})
							: new Response("blocked", { status: 403 }),
				},
				{
					...shared,
					name: "vault",
					durableObjects: { VAULTS: { className: "Vault", useSQLite: true } },
				},
			],
		}),
	);
	await miniflare.ready;
	return {
		miniflare,
		wrangler: packageVersion(wrangler, 2),
		miniflareVersion: packageVersion(miniflareEntry, 3),
		compatibilityDate: config.compatibility_date,
		compatibilityFlags: config.compatibility_flags,
	};
}

/** Issue one access token through the real dynamic registration, Access consent, and PKCE flow. */
async function issueToken(base: string, signer: AccessSigner): Promise<string> {
	const scope = "vault:read vault:write vault:delete";
	const registration = await fetch(`${base}/oauth/register`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			client_name: "OAB-53 local memory profile",
			redirect_uris: ["https://profile.test/callback"],
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: "none",
		}),
	});
	const { client_id: clientId } = (await registration.json()) as {
		client_id: string;
	};
	const verifier = crypto.randomUUID() + crypto.randomUUID();
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(verifier),
	);
	const challenge = Buffer.from(digest).toString("base64url");
	const assertion = await signer.assertion();
	const query = new URLSearchParams({
		response_type: "code",
		client_id: clientId,
		redirect_uri: "https://profile.test/callback",
		scope,
		state: "profile",
		code_challenge: challenge,
		code_challenge_method: "S256",
		resource: SERVICE_ORIGIN,
	});
	const consent = await fetch(`${base}/authorize?${query}`, {
		headers: { "Cf-Access-Jwt-Assertion": assertion },
	});
	const cookie = consent.headers.get("set-cookie")?.split(";")[0] ?? "";
	const handle =
		(await consent.text()).match(/name="handle" value="([^"]+)"/)?.[1] ?? "";
	const approval = await fetch(`${base}/authorize/consent`, {
		method: "POST",
		redirect: "manual",
		headers: {
			"content-type": "application/x-www-form-urlencoded",
			cookie,
			"Cf-Access-Jwt-Assertion": assertion,
		},
		body: new URLSearchParams([
			["handle", handle],
			["decision", "approve"],
			...scope.split(" ").map((value): [string, string] => ["scope", value]),
		]),
	});
	const code =
		new URL(
			approval.headers.get("location") ?? "https://invalid/",
		).searchParams.get("code") ?? "";
	const token = await fetch(`${base}/oauth/token`, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			client_id: clientId,
			code,
			redirect_uri: "https://profile.test/callback",
			code_verifier: verifier,
			resource: SERVICE_ORIGIN,
		}),
	});
	if (token.status !== 200) throw new Error(`token returned ${token.status}`);
	return ((await token.json()) as { access_token: string }).access_token;
}

/** Return the PID of the workerd child of this process; it serves both Workers. */
async function workerdPid(): Promise<number> {
	const { stdout } = await run("ps", ["-ax", "-o", "pid=,ppid=,command="]);
	const match = stdout
		.split("\n")
		.map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
		.find(
			(fields) =>
				fields !== null &&
				Number(fields[2]) === process.pid &&
				fields[3]?.includes("/workerd serve"),
		);
	if (!match) throw new Error("workerd process not found");
	return Number(match[1]);
}

/** One `Runtime.getHeapUsage` reading, in bytes, tagged with wall-clock milliseconds. */
interface HeapSample {
	t: number;
	/** V8 heap bytes in use, including garbage not yet collected. */
	used: number;
	/** V8 heap bytes committed. */
	total: number;
	/** Embedder (C++ managed) heap bytes in use. */
	embedder: number;
	/** ArrayBuffer backing-store bytes outside the JS heap. */
	backing: number;
}

/** Sample series tagged with wall-clock milliseconds. */
interface Samples {
	heap: Record<IsolateName, HeapSample[]>;
	rss: { t: number; bytes: number }[];
	app: { t: number; isolate: Record<string, unknown> }[];
}

/** Minimal Chrome DevTools Protocol client over the global WebSocket. */
class InspectorClient {
	private nextId = 1;
	private readonly pending = new Map<number, (result: unknown) => void>();
	private readonly socket: WebSocket;
	/** Latest execution context id of the isolate; `gc()` evaluation needs it. */
	private contextId: number | undefined;

	/** Wrap an open socket; responses resolve by id and context events update `contextId`. */
	private constructor(socket: WebSocket) {
		this.socket = socket;
		socket.addEventListener("message", (event) => {
			const message = JSON.parse(String(event.data)) as {
				id?: number;
				method?: string;
				params?: { context?: { id?: number } };
				result?: unknown;
				error?: unknown;
			};
			if (message.method === "Runtime.executionContextCreated")
				this.contextId = message.params?.context?.id;
			if (message.id === undefined) return;
			this.pending.get(message.id)?.(
				message.result ?? { error: message.error },
			);
			this.pending.delete(message.id);
		});
	}

	/**
	 * Connect to one workerd inspector target, such as `core:user:api`, and enable the Runtime
	 * domain so the isolate reports its execution context.
	 */
	static async connect(port: number, target: string): Promise<InspectorClient> {
		const socket = new WebSocket(`ws://127.0.0.1:${port}/${target}`);
		await new Promise((resolve, reject) => {
			socket.addEventListener("open", resolve, { once: true });
			socket.addEventListener("error", reject, { once: true });
		});
		const client = new InspectorClient(socket);
		await client.send("Runtime.enable");
		await sleep(500);
		return client;
	}

	/**
	 * Run a full V8 collection through `gc()` in the isolate context. Workerd does not answer
	 * `HeapProfiler.collectGarbage`, so this needs the `--expose-gc` V8 flag. Returns false when
	 * `gc` is unavailable.
	 */
	async collectGarbage(): Promise<boolean> {
		if (this.contextId === undefined) return false;
		const reply = await this.send<{ result?: { value?: string } }>(
			"Runtime.evaluate",
			{
				contextId: this.contextId,
				expression:
					"typeof gc === 'function' ? (gc(), 'collected') : 'unavailable'",
			},
		).catch(() => ({}) as { result?: { value?: string } });
		return reply.result?.value === "collected";
	}

	/** Send one CDP command; reject after 5 s because workerd ignores some commands. */
	send<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
		const id = this.nextId++;
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`${method} timed out`));
			}, 5_000);
			this.pending.set(id, (result) => {
				clearTimeout(timer);
				resolve(result as T);
			});
			this.socket.send(JSON.stringify({ id, method, params }));
		});
	}

	/** Close the socket. */
	close(): void {
		this.socket.close();
	}
}

/**
 * Start fixed-cadence samplers. Each sampler waits for its previous reading, so slow readings widen
 * the gap instead of overlapping. Returns a stop function.
 */
function startSamplers(
	samples: Samples,
	inspectors: Record<IsolateName, InspectorClient>,
	pid: number,
	base: string,
	signer: AccessSigner,
): () => Promise<void> {
	let running = true;
	/** Repeat one sampler until stopped. */
	const loop = async (intervalMs: number, sample: () => Promise<void>) => {
		while (running) {
			const started = Date.now();
			await sample().catch(() => undefined);
			await sleep(Math.max(0, intervalMs - (Date.now() - started)));
		}
	};
	const loops = [
		...ISOLATES.map((name) =>
			loop(50, async () => {
				const usage = await inspectors[name].send<{
					usedSize: number;
					totalSize: number;
					embedderHeapUsedSize?: number;
					backingStorageSize?: number;
				}>("Runtime.getHeapUsage");
				samples.heap[name].push({
					t: Date.now(),
					used: usage.usedSize,
					total: usage.totalSize,
					embedder: usage.embedderHeapUsedSize ?? 0,
					backing: usage.backingStorageSize ?? 0,
				});
			}),
		),
		loop(50, async () => {
			const { stdout } = await run("ps", ["-o", "rss=", "-p", String(pid)]);
			samples.rss.push({ t: Date.now(), bytes: Number(stdout.trim()) * 1024 });
		}),
		loop(500, async () => {
			const response = await fetch(`${base}/owner/measurements?format=json`, {
				headers: { "Cf-Access-Jwt-Assertion": await signer.assertion() },
			});
			const body = (await response.json()) as {
				worker_isolate?: Record<string, unknown>;
			};
			if (body.worker_isolate)
				samples.app.push({ t: Date.now(), isolate: body.worker_isolate });
		}),
	];
	return async () => {
		running = false;
		await Promise.all(loops);
	};
}

/** Heap peaks of one isolate inside one window, in bytes. */
interface IsolatePeaks {
	used: number;
	total: number;
	/** Peak ArrayBuffer backing-store bytes outside the JS heap. */
	backing: number;
	/** Peak of committed heap plus backing stores in one sample; the closest isolate-memory proxy. */
	isolate: number;
	samples: number;
}

/** Peaks inside one time window. */
interface WindowPeaks {
	heap: Record<IsolateName, IsolatePeaks>;
	rss: number;
	/**
	 * RSS minus the committed heaps of both user isolates at the samples nearest the RSS peak. It
	 * includes backing stores, workerd runtime and code, SQLite, local R2 and KV simulation, and
	 * Miniflare internal Workers.
	 */
	nativeAtRssPeak: number;
	restReadBytes: number;
	sharedBytes: number;
	heldRest: number;
	heldMcp: number;
	rssSamples: number;
}

/** Return the sample nearest in time to `t`, if any. */
function nearest<T extends { t: number }>(
	series: readonly T[],
	t: number,
): T | undefined {
	return series.reduce<T | undefined>(
		(best, sample) =>
			!best || Math.abs(sample.t - t) < Math.abs(best.t - t) ? sample : best,
		undefined,
	);
}

/** Compute peaks for samples taken between `from` and `to`. */
function peaks(samples: Samples, from: number, to: number): WindowPeaks {
	/** Keep samples inside the window. */
	const inside = <T extends { t: number }>(series: readonly T[]) =>
		series.filter((sample) => sample.t >= from && sample.t <= to);
	const rss = inside(samples.rss);
	const app = inside(samples.app);
	const rssPeak = rss.reduce<(typeof rss)[number] | undefined>(
		(best, sample) => (!best || sample.bytes > best.bytes ? sample : best),
		undefined,
	);
	/** Read the peak of one numeric isolate snapshot field. */
	const field = (name: string) =>
		Math.max(0, ...app.map((sample) => Number(sample.isolate[name] ?? 0)));
	/** Compute heap peaks for one isolate. */
	const isolatePeaks = (name: IsolateName): IsolatePeaks => {
		const heap = inside(samples.heap[name]);
		return {
			used: Math.max(0, ...heap.map((sample) => sample.used)),
			total: Math.max(0, ...heap.map((sample) => sample.total)),
			backing: Math.max(0, ...heap.map((sample) => sample.backing)),
			isolate: Math.max(
				0,
				...heap.map((sample) => sample.total + sample.backing),
			),
			samples: heap.length,
		};
	};
	const heapsAtPeak = rssPeak
		? ISOLATES.reduce(
				(sum, name) =>
					sum + (nearest(samples.heap[name], rssPeak.t)?.total ?? 0),
				0,
			)
		: 0;
	return {
		heap: { api: isolatePeaks("api"), vault: isolatePeaks("vault") },
		rss: rssPeak?.bytes ?? 0,
		nativeAtRssPeak: rssPeak ? rssPeak.bytes - heapsAtPeak : 0,
		restReadBytes: field("rest_read_bytes"),
		sharedBytes: field("shared_bytes"),
		heldRest: field("held_rest_slots"),
		heldMcp: field("held_mcp_slots"),
		rssSamples: rss.length,
	};
}

/** Return whether a process still exists. */
function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** Format bytes as decimal megabytes with one decimal, the unit of spec §6.5. */
function mb(bytes: number): string {
	return (bytes / 1e6).toFixed(1);
}

/** One row of the final table. */
interface Row {
	label: string;
	level?: LevelResult;
	/** Heap used per isolate right after a forced collection before the window. */
	heapFloor?: Record<IsolateName, number | undefined>;
	/** Time after the window until held leases and reserved bytes reached zero; -1 on timeout. */
	releaseMs?: number;
	peaks: WindowPeaks;
}

/** Render rows as a Markdown table in decimal megabytes. */
function table(rows: readonly Row[]): string {
	const columns = [
		"Workload",
		"C",
		"Ops",
		"Statuses",
		"API floor",
		"API used",
		"API total",
		"API backing",
		"API total+backing",
		"Vault floor",
		"Vault used",
		"Vault total",
		"Vault backing",
		"Vault total+backing",
		"RSS",
		"RSS−heaps",
		"REST read",
		"Shared",
		"Held R/M",
		"Release ms",
		"API headroom",
		"Vault headroom",
	];
	const lines = rows.map(({ label, level, heapFloor, releaseMs, peaks: p }) =>
		[
			label,
			level?.concurrency ?? "",
			level?.operations ?? "",
			level
				? Object.entries(level.statuses)
						.map(([status, count]) => `${status}×${count}`)
						.join(" ")
				: "",
			heapFloor?.api === undefined ? "" : mb(heapFloor.api),
			mb(p.heap.api.used),
			mb(p.heap.api.total),
			mb(p.heap.api.backing),
			mb(p.heap.api.isolate),
			heapFloor?.vault === undefined ? "" : mb(heapFloor.vault),
			mb(p.heap.vault.used),
			mb(p.heap.vault.total),
			mb(p.heap.vault.backing),
			mb(p.heap.vault.isolate),
			mb(p.rss),
			mb(p.nativeAtRssPeak),
			mb(p.restReadBytes),
			mb(p.sharedBytes),
			`${p.heldRest}/${p.heldMcp}`,
			releaseMs ?? "",
			mb(ISOLATE_LIMIT_BYTES - p.heap.api.isolate),
			mb(ISOLATE_LIMIT_BYTES - p.heap.vault.isolate),
		].join(" | "),
	);
	return [
		`| ${columns.join(" | ")} |`,
		`| ${columns.map((_, index) => (index === 0 || index === 3 || index === 18 ? "---" : "---:")).join(" | ")} |`,
		...lines.map((line) => `| ${line} |`),
	].join("\n");
}

/** Run the full local profile and write `results.json` and `table.md` into `--out`. */
async function main(): Promise<void> {
	const options = parseOptions(process.argv.slice(2));
	mkdirSync(options.out, { recursive: true });
	const signer = await createAccessSigner();
	const runtime = await startRuntime(options, signer);
	const base = `http://127.0.0.1:${options.port}`;
	const target: ProfileTarget = {
		origin: base,
		token: await issueToken(base, signer),
	};
	const pid = await workerdPid();
	const inspectors = {
		api: await InspectorClient.connect(options.inspectorPort, "core:user:api"),
		vault: await InspectorClient.connect(
			options.inspectorPort,
			"core:user:vault",
		),
	};
	const samples: Samples = { heap: { api: [], vault: [] }, rss: [], app: [] };
	const stop = startSamplers(samples, inspectors, pid, base, signer);
	const rows: Row[] = [];
	const gcAvailable: Record<string, boolean> = {};
	const phases: { label: string; from: number; to: number }[] = [];
	/** Record one time window as a table row. */
	const record = (
		label: string,
		from: number,
		to: number,
		level?: LevelResult,
		heapFloor?: Row["heapFloor"],
	) => {
		phases.push({ label, from, to });
		rows.push({ label, level, heapFloor, peaks: peaks(samples, from, to) });
		console.log(
			label,
			level?.concurrency ?? "",
			JSON.stringify(rows.at(-1)?.peaks),
		);
	};
	/** Collect garbage in both isolates, idle, and return the post-collection heap used. */
	const floor = async (): Promise<Row["heapFloor"]> => {
		for (const name of ISOLATES)
			gcAvailable[name] = await inspectors[name].collectGarbage();
		await sleep(2_000);
		return {
			api: samples.heap.api.at(-1)?.used,
			vault: samples.heap.vault.at(-1)?.used,
		};
	};
	/**
	 * Wait until the isolate snapshot shows no held lease and no reserved bytes, for at most lease
	 * plus grace plus 15 s. Returns the wait in ms, or -1 on timeout. A held lease from one level
	 * would refuse the next level, so levels wait for release.
	 */
	const waitForRelease = async () => {
		const started = Date.now();
		for (;;) {
			const latest = samples.app.at(-1);
			if (
				latest &&
				latest.t > started &&
				Number(latest.isolate.held_rest_slots ?? 0) === 0 &&
				Number(latest.isolate.held_mcp_slots ?? 0) === 0 &&
				Number(latest.isolate.rest_read_bytes ?? 0) === 0 &&
				Number(latest.isolate.shared_bytes ?? 0) === 0
			)
				return latest.t - started;
			if (Date.now() - started > 135_000) return -1;
			await sleep(250);
		}
	};
	/** Record the release wait on the latest row. */
	const noteRelease = async () => {
		const releaseMs = await waitForRelease();
		const row = rows.at(-1);
		if (row) row.releaseMs = releaseMs;
		console.log("release wait ms", releaseMs);
	};
	try {
		const coldFrom = Date.now();
		await sleep(3_000);
		record("idle-cold", coldFrom, Date.now());
		const seedFrom = Date.now();
		const fixtures = await seedFixtures(target, DEFAULT_SEED);
		record("seed", seedFrom, Date.now());
		const order = ["rest", "mcp", "upload", "slow", "cancel"];
		const workloads = createWorkloads(fixtures)
			.filter(
				(workload) =>
					!options.workloads || options.workloads.includes(workload.name),
			)
			.sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category));
		for (const workload of workloads)
			if (workload.category === "rest" || workload.category === "mcp")
				await workload.run(target, { level: "warmup", worker: 0, sequence: 0 });
		const baselineFloor = await floor();
		await sleep(3_000);
		const baselineFrom = Date.now();
		await sleep(5_000);
		record(
			"baseline-idle-after-warmup",
			baselineFrom,
			Date.now(),
			undefined,
			baselineFloor,
		);
		for (const workload of workloads)
			for (const concurrency of options.levels) {
				if (!alive(pid)) throw new Error("workerd exited");
				const heapFloor = await floor();
				const level = await runLevel(
					target,
					workload,
					concurrency,
					options.durationMs,
				);
				await sleep(500);
				record(workload.name, level.startedAt, Date.now(), level, heapFloor);
				await noteRelease();
			}
		// Stalled reads run last: they hold leases until the OAB-58 reclaim deadline.
		if (options.stall) {
			const heapFloor = await floor();
			const stallFrom = Date.now();
			const stalled = await openStalledReads(target, fixtures, 4, 8);
			console.log(
				"stalled statuses",
				stalled.map((read) => read.status),
			);
			await sleep(options.stallHoldMs);
			record(
				`stall-hold-${options.stallHoldMs}ms`,
				stallFrom,
				Date.now(),
				undefined,
				heapFloor,
			);
			const onTop = workloads.filter((workload) =>
				["rest-text-1mb", "mcp-read-note-1mb"].includes(workload.name),
			);
			const loadFrom = Date.now();
			const levels = await Promise.all(
				onTop.map((workload) =>
					runLevel(
						target,
						workload,
						workload.category === "mcp" ? 8 : 4,
						options.durationMs,
					),
				),
			);
			const loadTo = Date.now();
			for (const level of levels)
				record(
					`stall+${level.workload} (shared window)`,
					loadFrom,
					loadTo,
					level,
				);
			const releaseFrom = Date.now();
			await Promise.all(stalled.map((read) => read.release()));
			await sleep(2_000);
			record("stall-client-release", releaseFrom, Date.now());
			await noteRelease();
		}
		const cleanupFrom = Date.now();
		const cleanup = await deleteLoadtestFiles(target);
		record("cleanup", cleanupFrom, Date.now());
		console.log("cleanup", JSON.stringify(cleanup));
		rows.push({ label: "overall", peaks: peaks(samples, 0, Date.now()) });
		writeFileSync(
			join(options.out, "results.json"),
			JSON.stringify(
				{
					runtime: {
						wrangler: runtime.wrangler,
						miniflare: runtime.miniflareVersion,
						compatibilityDate: runtime.compatibilityDate,
						compatibilityFlags: runtime.compatibilityFlags,
						node: process.version,
						workerdPid: pid,
						v8Flags: options.v8Flags,
						gcAvailable,
					},
					phases,
					rows,
					samples,
				},
				null,
				1,
			),
		);
		writeFileSync(join(options.out, "table.md"), table(rows));
		console.log(table(rows));
	} finally {
		await stop();
		for (const name of ISOLATES) inspectors[name].close();
		await runtime.miniflare.dispose();
	}
}

await main();
