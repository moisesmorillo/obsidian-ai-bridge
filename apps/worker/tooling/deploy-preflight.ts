import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { readdir } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { classifyWranglerFailure } from "@worker/../tooling/wrangler-failure";

/** Worker package root used for pinned Wrangler paths and config lookup. */
const workerDirectory = process.cwd();
/** Entrypoint for the installed Wrangler version, launched with Node. */
const wranglerCli = resolve("node_modules/wrangler/bin/wrangler.js");
/** Maximum captured bytes retained for classification or a synchronous build. */
const outputLimit = 64 * 1024;
/** Maximum time for local Worker startup and metadata checks, in milliseconds. */
const timeoutMs = 30_000;
/** Maximum time allowed for the credential-free production dry-run build, in milliseconds. */
const buildTimeoutMs = 120_000;
/** Compatibility flag unsupported by the pinned local runtime only. */
const unsupportedLocalCompatibilityFlag =
	"unhandled_rejection_after_microtask_checkpoint";

/** Remove only the compatibility flag rejected by pinned local workerd. */
export function filterLocalCompatibilityFlags(flags: string[]): string[] {
	return flags.filter((flag) => flag !== unsupportedLocalCompatibilityFlag);
}

/** Return a private temporary root with isolated Wrangler state and home directories. */
export function createTemporaryRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "oab-worker-preflight-"));
	chmodSync(root, 0o700);
	return root;
}

/** Build the only child environment allowed to reach the local Wrangler process. */
export function createSanitizedEnvironment(root: string): NodeJS.ProcessEnv {
	return {
		PATH: process.env.PATH,
		HOME: join(root, "home"),
		XDG_CONFIG_HOME: join(root, "config"),
		XDG_CACHE_HOME: join(root, "cache"),
		WRANGLER_SEND_METRICS: "false",
		CI: "true",
		NO_COLOR: "1",
		CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
	};
}

/** Run Wrangler with bounded captured output and no inherited credentials or dotenv files. */
function runBuild(root: string): string {
	const outputDirectory = join(root, "bundle");
	const build = spawnSync(
		"node",
		[
			wranglerCli,
			"deploy",
			"--dry-run",
			"--config",
			"wrangler.production.jsonc",
			"--outdir",
			outputDirectory,
		],
		{
			cwd: workerDirectory,
			env: createSanitizedEnvironment(root),
			encoding: "utf8",
			maxBuffer: outputLimit,
			timeout: buildTimeoutMs,
		},
	);
	if (build.error || build.status !== 0) {
		throw new Error(
			classifyWranglerFailure(
				`${build.stderr ?? ""}\n${build.stdout ?? ""}`,
			).join("\n"),
		);
	}
	return outputDirectory;
}

/** Select the emitted JavaScript bundle from Wrangler's dry-run output directory. */
async function findBundle(outputDirectory: string): Promise<string> {
	const entries = await readdir(outputDirectory, { withFileTypes: true });
	const bundles = entries.filter(
		(entry) => entry.isFile() && entry.name.endsWith(".js"),
	);
	if (bundles.length !== 1 || !bundles[0])
		throw new Error("unknown_wrangler_failure");
	return join(outputDirectory, bundles[0].name);
}

/** Select an available IPv4 loopback port, then release it for Wrangler to bind. */
export async function availablePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolveListen, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolveListen);
	});
	const address = server.address();
	if (!address || typeof address === "string") {
		server.close();
		throw new Error("unknown_wrangler_failure");
	}
	const port = address.port;
	await new Promise<void>((resolveClose, reject) =>
		server.close((error) => (error ? reject(error) : resolveClose())),
	);
	return port;
}

/** Start Node Wrangler against a temporary config with local-only bindings and persistence. */
export function startLocalWorker(
	root: string,
	bundle: string,
	port: number,
): ChildProcess {
	const origin = `https://127.0.0.1:${port}`;
	const configDirectory = join(root, "local-config");
	mkdirSync(configDirectory, { recursive: true, mode: 0o700 });
	const configPath = join(configDirectory, "wrangler.local.jsonc");
	const config: {
		account_id?: string;
		main: string;
		compatibility_flags: string[];
		vars: Record<string, string>;
	} = JSON.parse(readFileSync(resolve("wrangler.production.jsonc"), "utf8"));
	delete config.account_id;
	config.main = bundle;
	// Pinned local workerd rejects this production flag. The production config stays unchanged.
	config.compatibility_flags = filterLocalCompatibilityFlags(
		config.compatibility_flags,
	);
	config.vars = {
		SERVICE_ORIGIN: origin,
		OWNER_SUBJECT: "preflight-test-owner",
	};
	writeFileSync(configPath, JSON.stringify(config));
	return spawn(
		"node",
		[
			wranglerCli,
			"dev",
			"--config",
			configPath,
			"--local",
			"--no-bundle",
			"--ip",
			"127.0.0.1",
			"--port",
			String(port),
			"--local-protocol",
			"https",
			"--persist-to",
			join(root, "state"),
		],
		{
			cwd: workerDirectory,
			env: createSanitizedEnvironment(root),
			stdio: ["ignore", "pipe", "pipe"],
			detached: true,
		},
	);
}

/** Stop the Wrangler process group before removing its temporary state. */
export async function stopLocalWorker(child: ChildProcess): Promise<void> {
	if (!child.pid) return;
	const pid = child.pid;
	/** Signal the full Wrangler process group, then fall back to its leader. */
	const sendSignal = (signal: NodeJS.Signals): void => {
		try {
			process.kill(-pid, signal);
		} catch {
			child.kill(signal);
		}
	};
	/** Check whether any process still belongs to the Wrangler group. */
	const processGroupExists = (): boolean => {
		try {
			process.kill(-pid, 0);
			return true;
		} catch (error) {
			return !(
				error instanceof Error &&
				"code" in error &&
				error.code === "ESRCH"
			);
		}
	};
	/** Wait for group members to exit for a bounded period. */
	const waitForGroupExit = async (timeoutMs: number): Promise<boolean> => {
		const deadline = Date.now() + timeoutMs;
		while (processGroupExists() && Date.now() < deadline)
			await new Promise((resolveWait) => setTimeout(resolveWait, 25));
		return !processGroupExists();
	};
	sendSignal("SIGTERM");
	if (await waitForGroupExit(2_000)) return;
	sendSignal("SIGKILL");
	if (!(await waitForGroupExit(2_000)))
		throw new Error("unknown_wrangler_failure");
}

/** Supply the loopback request function used by the metadata deadline check. */
type MetadataFetch = (
	input: string,
	init: RequestInit & {
		redirect: "manual";
		tls: { rejectUnauthorized: false };
	},
) => Promise<Response>;

/** Configure shorter deadlines or a request stub for isolated metadata tests. */
type MetadataCheckOptions = {
	timeoutMs?: number;
	fetchRequest?: MetadataFetch;
};

/**
 * Check HTTPS metadata on loopback and fail unless the response status is 200.
 *
 * Redirects are not followed. Request TLS verification is disabled only for this
 * loopback URL, and failed requests wait only until the configured deadline.
 */
export async function checkMetadata(
	child: ChildProcess,
	port: number,
	options: MetadataCheckOptions = {},
): Promise<void> {
	const origin = `https://127.0.0.1:${port}`;
	const endpoint = `${origin}/.well-known/oauth-protected-resource`;
	let failure = "unknown_wrangler_failure";
	let output = "";
	/** Keep only the bounded tail needed for fixed failure classification. */
	const appendOutput = (chunk: Buffer): void => {
		output = `${output}${chunk.toString("utf8")}`.slice(-outputLimit);
	};
	child.stdout?.on("data", appendOutput);
	child.stderr?.on("data", appendOutput);
	const deadline = Date.now() + (options.timeoutMs ?? timeoutMs);
	while (Date.now() < deadline) {
		if (child.exitCode !== null || child.signalCode !== null) {
			await new Promise((resolveNextTick) => setImmediate(resolveNextTick));
			failure = classifyWranglerFailure(output).join("\n");
			break;
		}
		try {
			const response = await (options.fetchRequest ?? fetch)(endpoint, {
				redirect: "manual",
				tls: { rejectUnauthorized: false },
				signal: AbortSignal.timeout(2_000),
			});
			if (response.status === 200) return;
			failure = classifyWranglerFailure(
				`${output}\nmetadata status ${response.status}`,
			).join("\n");
			break;
		} catch {
			await new Promise((resolveWait) =>
				setTimeout(
					resolveWait,
					Math.min(100, Math.max(0, deadline - Date.now())),
				),
			);
		}
	}
	if (Date.now() >= deadline) {
		failure = "wrangler_timeout";
	}
	throw new Error(failure);
}

/** Convert an arbitrary preflight error to the canonical fixed failure labels. */
export function safePreflightFailure(error: unknown): string[] {
	return classifyWranglerFailure(error instanceof Error ? error.message : "");
}

/** Build and run the production bundle locally, then remove all temporary files and state. */
async function main(): Promise<void> {
	let root: string;
	try {
		root = createTemporaryRoot();
	} catch (error) {
		console.error(safePreflightFailure(error).join("\n"));
		process.exitCode = 1;
		return;
	}
	let child: ChildProcess | undefined;
	try {
		const outputDirectory = runBuild(root);
		const bundle = await findBundle(outputDirectory);
		const port = await availablePort();
		child = startLocalWorker(root, bundle, port);
		await checkMetadata(child, port);
	} catch (error) {
		const failure = safePreflightFailure(error).join("\n");
		console.error(failure);
		process.exitCode = 1;
	} finally {
		let cleanupFailed = false;
		try {
			if (child) await stopLocalWorker(child);
		} catch {
			cleanupFailed = true;
		}
		try {
			rmSync(root, { recursive: true, force: true });
		} catch {
			cleanupFailed = true;
		}
		if (cleanupFailed) {
			console.error(classifyWranglerFailure("").join("\n"));
			process.exitCode = 1;
		}
	}
}

if (import.meta.main) await main();
