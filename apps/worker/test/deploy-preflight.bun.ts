/// <reference types="bun" />

import { strict as assert } from "node:assert";
import { type ChildProcess, spawn as spawnProcess } from "node:child_process";
import { EventEmitter, once } from "node:events";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
	availablePort,
	checkMetadata,
	createBuildLaunch,
	createLocalWorkerLaunch,
	createTemporaryRoot,
	filterLocalCompatibilityFlags,
	safePreflightFailure,
	startLocalWorker,
	stopLocalWorker,
} from "@worker/../tooling/deploy-preflight";
import { classifyWranglerFailure } from "@worker/../tooling/wrangler-failure";

/** Run the assertions for deploy failure classification and startup preflight tools. */
async function main(): Promise<void> {
	assert.deepEqual(
		classifyWranglerFailure("Disallowed operation called within global scope"),
		["Disallowed operation called within global scope"],
	);
	assert.deepEqual(
		classifyWranglerFailure("Authentication error: account id and token"),
		["Authentication error"],
	);
	assert.deepEqual(
		classifyWranglerFailure("No such compatibility flag: unsafe-flag"),
		["No such compatibility flag"],
	);
	assert.deepEqual(
		classifyWranglerFailure("Script startup exceeded 1 second"),
		["Script startup exceeded"],
	);
	assert.deepEqual(classifyWranglerFailure("request timed out"), [
		"wrangler_timeout",
	]);
	assert.deepEqual(
		filterLocalCompatibilityFlags([
			"unhandled_rejection_after_microtask_checkpoint",
			"nodejs_compat",
		]),
		["nodejs_compat"],
	);
	assert.deepEqual(classifyWranglerFailure("ordinary Wrangler error"), [
		"unknown_wrangler_failure",
	]);
	assert.deepEqual(
		classifyWranglerFailure(
			"Disallowed operation called within global scope\nRequest timed out",
		),
		["Disallowed operation called within global scope", "wrangler_timeout"],
	);

	const unsafe =
		"https://user:secret@example.test/opaque/id?token=hidden\n" +
		"Authorization: Bearer secret-body\n\u001b[31mDisallowed operation called within global scope\u001b[0m " +
		"lowercase_token_secret_id";
	const labels = classifyWranglerFailure(unsafe);
	assert.deepEqual(labels, ["Disallowed operation called within global scope"]);
	assert.deepEqual(classifyWranglerFailure("private_token_secret_lowercase"), [
		"unknown_wrangler_failure",
	]);
	assert.deepEqual(
		safePreflightFailure(new Error("private_token_secret_lowercase")),
		["unknown_wrangler_failure"],
	);
	assert.deepEqual(
		safePreflightFailure(
			new Error(
				"Disallowed operation called within global scope token=private_secret",
			),
		),
		["Disallowed operation called within global scope"],
	);
	assert.equal(labels.join("\n").includes(unsafe), false);
	assert.equal(labels.join("\n").includes("example.test"), false);
	assert.equal(labels.join("\n").includes("secret"), false);

	const fakeParentEnvironment = {
		PATH: "/test/bin",
		CLOUDFLARE_API_TOKEN: "fake-test-token",
		OWNER_SUBJECT: "fake-test-owner",
	};
	const buildLaunch = createBuildLaunch(
		"/private/preflight-state",
		fakeParentEnvironment,
	);
	assert.deepEqual(buildLaunch.args.slice(-2), ["--env-file", "/dev/null"]);
	assert.equal(buildLaunch.environment.PATH, "/test/bin");
	assert.equal(buildLaunch.environment.CLOUDFLARE_API_TOKEN, undefined);
	assert.equal(buildLaunch.environment.OWNER_SUBJECT, undefined);
	assert.equal(
		buildLaunch.environment.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV,
		"false",
	);
	const devLaunch = createLocalWorkerLaunch(
		"/private/preflight-state",
		12345,
		fakeParentEnvironment,
	);
	assert.deepEqual(devLaunch.args.slice(-2), ["--env-file", "/dev/null"]);
	assert.equal(devLaunch.environment.PATH, "/test/bin");
	assert.equal(devLaunch.environment.CLOUDFLARE_API_TOKEN, undefined);
	assert.equal(devLaunch.environment.OWNER_SUBJECT, undefined);
	assert.equal(
		devLaunch.environment.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV,
		"false",
	);

	const child = Object.assign(new EventEmitter(), {
		exitCode: null,
		signalCode: null,
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		kill: () => true,
	}) as unknown as ChildProcess;
	await checkMetadata(child, 12345, {
		timeoutMs: 100,
		fetchRequest: async () => new Response(null, { status: 200 }),
	});
	await assert.rejects(
		checkMetadata(child, 12345, {
			timeoutMs: 10,
			fetchRequest: async () => new Response(null, { status: 302 }),
		}),
		/unknown_wrangler_failure/,
	);
	await assert.rejects(
		checkMetadata(child, 12345, {
			timeoutMs: 10,
			fetchRequest: async () => {
				throw new Error("private request detail");
			},
		}),
		/wrangler_timeout/,
	);
	const exitedOutput = new PassThrough();
	const exitedChild = Object.assign(new EventEmitter(), {
		exitCode: 1,
		signalCode: null,
		stdout: new PassThrough(),
		stderr: exitedOutput,
		kill: () => true,
	}) as unknown as ChildProcess;
	exitedOutput.write("Disallowed operation called within global scope");
	await assert.rejects(
		checkMetadata(exitedChild, 12345),
		/Disallowed operation called within global scope/,
	);

	const runtimeRoot = createTemporaryRoot();
	try {
		const localConfigDirectory = join(runtimeRoot, "local-config");
		await mkdir(localConfigDirectory, { recursive: true, mode: 0o700 });
		await writeFile(
			join(localConfigDirectory, ".env"),
			"DOTENV_MARKER=must-not-load\n",
		);
		const bundle = join(runtimeRoot, "healthy.js");
		await writeFile(
			bundle,
			'export class Vault { fetch() { return new Response("vault"); } }\nexport default { fetch(_request, env) { return new Response("ok", { status: env.DOTENV_MARKER ? 503 : 200 }); } };',
		);
		const port = await availablePort();
		const worker = startLocalWorker(runtimeRoot, bundle, port);
		const localConfig = JSON.parse(
			await readFile(
				join(localConfigDirectory, "wrangler.local.jsonc"),
				"utf8",
			),
		) as {
			account_id?: string;
			vars: { SERVICE_ORIGIN: string; OWNER_SUBJECT: string };
		};
		assert.equal(localConfig.account_id, undefined);
		assert.equal(localConfig.vars.SERVICE_ORIGIN, `https://127.0.0.1:${port}`);
		assert.deepEqual((await readdir(localConfigDirectory)).sort(), [
			".env",
			"wrangler.local.jsonc",
		]);
		assert.equal(localConfig.vars.OWNER_SUBJECT, "preflight-test-owner");
		try {
			await checkMetadata(worker, port, {
				timeoutMs: 120_000,
				onFailureOutput: (output) =>
					console.error(`healthy worker output:\n${output.slice(-4_000)}`),
			});
		} finally {
			await stopLocalWorker(worker);
		}

		const forbiddenBundle = join(runtimeRoot, "forbidden.js");
		await writeFile(
			forbiddenBundle,
			'crypto.randomUUID(); export class Vault { fetch() { return new Response("vault"); } }\nexport default { fetch() { return new Response("ok"); } };',
		);
		const forbiddenPort = await availablePort();
		const forbiddenWorker = startLocalWorker(
			runtimeRoot,
			forbiddenBundle,
			forbiddenPort,
		);
		try {
			await assert.rejects(
				checkMetadata(forbiddenWorker, forbiddenPort, { timeoutMs: 120_000 }),
				/Disallowed operation called within global scope/,
			);
		} finally {
			await stopLocalWorker(forbiddenWorker);
		}
	} finally {
		await rm(runtimeRoot, { recursive: true, force: true });
	}

	const processGroupLeader = spawnProcess(
		"node",
		[
			"-e",
			`const { spawn } = require("node:child_process"); const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"] , { stdio: "ignore" }); process.stdout.write(String(child.pid)); setTimeout(() => process.exit(0), 25);`,
		],
		{ detached: true, stdio: ["ignore", "pipe", "ignore"] },
	);
	let descendantText = "";
	processGroupLeader.stdout?.on("data", (chunk: Buffer) => {
		descendantText += chunk.toString("utf8");
	});
	try {
		await once(processGroupLeader, "close");
		const descendantPid = Number(descendantText);
		assert.ok(descendantPid > 0);
		let descendantRunning = true;
		try {
			process.kill(descendantPid, 0);
		} catch {
			descendantRunning = false;
		}
		assert.equal(descendantRunning, true);
		await stopLocalWorker(processGroupLeader);
		descendantRunning = true;
		try {
			process.kill(descendantPid, 0);
		} catch {
			descendantRunning = false;
		}
		assert.equal(descendantRunning, false);
	} finally {
		try {
			process.kill(-(processGroupLeader.pid ?? 0), "SIGKILL");
		} catch {
			// The process group can already be gone after successful cleanup.
		}
	}

	const temporaryRootBefore = (await readdir(tmpdir())).filter((entry) =>
		entry.startsWith("oab-worker-preflight-"),
	);
	const preflightResult = Bun.spawnSync(
		[process.execPath, "run", "tooling/deploy-preflight.ts"],
		{
			cwd: join(import.meta.dir, ".."),
			env: {
				PATH: process.env.PATH,
				CLOUDFLARE_API_TOKEN: "test-only-token-value",
				OWNER_SUBJECT: "test-only-real-identity-marker",
			},
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	assert.equal(
		preflightResult.exitCode,
		0,
		"isolated production preflight failed",
	);
	assert.equal(
		preflightResult.stdout.toString().includes("test-only-token-value"),
		false,
	);
	assert.equal(
		preflightResult.stdout
			.toString()
			.includes("test-only-real-identity-marker"),
		false,
	);
	assert.deepEqual(
		(await readdir(tmpdir())).filter((entry) =>
			entry.startsWith("oab-worker-preflight-"),
		),
		temporaryRootBefore,
	);

	const temporaryDirectory = await mkdtemp(
		join(tmpdir(), "oab-preflight-test-"),
	);
	try {
		const input = join(temporaryDirectory, "wrangler-output.txt");
		const output = join(temporaryDirectory, "labels.txt");
		await writeFile(input, unsafe);
		const result = Bun.spawnSync(
			[process.execPath, "run", "tooling/wrangler-failure.ts", input],
			{ cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" },
		);
		assert.equal(result.exitCode, 0, "classifier CLI failed");
		assert.equal(
			result.stdout.toString().trim(),
			"Disallowed operation called within global scope",
		);
		await writeFile(output, result.stdout);
		const rendered = await readFile(output, "utf8");
		assert.equal(rendered.includes("example.test"), false);
	} finally {
		await rm(temporaryDirectory, { recursive: true, force: true });
	}
}

await main();
