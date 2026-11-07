/// <reference types="bun" />

import { strict as assert } from "node:assert";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
	availablePort,
	checkMetadata,
	createSanitizedEnvironment,
	createTemporaryRoot,
	startLocalWorker,
	stopLocalWorker,
} from "../tooling/deploy-preflight";
import { classifyWranglerFailure } from "../tooling/wrangler-failure";

/** Run the assertions for deploy failure classification and startup preflight tools. */
async function main(): Promise<void> {
	assert.deepEqual(
		classifyWranglerFailure("Disallowed operation called within global scope"),
		["worker_global_scope_error"],
	);
	assert.deepEqual(classifyWranglerFailure("ordinary Wrangler error"), [
		"unknown_wrangler_failure",
	]);
	assert.deepEqual(
		classifyWranglerFailure(
			"Disallowed operation called within global scope\nRequest timed out",
		),
		["worker_global_scope_error", "wrangler_timeout"],
	);

	const unsafe =
		"https://user:secret@example.test/opaque/id?token=hidden\n" +
		"Authorization: Bearer secret-body\n\u001b[31mDisallowed operation called within global scope\u001b[0m";
	const labels = classifyWranglerFailure(unsafe);
	assert.deepEqual(labels, ["worker_global_scope_error"]);
	assert.equal(labels.join("\n").includes(unsafe), false);
	assert.equal(labels.join("\n").includes("example.test"), false);
	assert.equal(labels.join("\n").includes("secret"), false);

	const safeEnvironment = createSanitizedEnvironment(
		"/private/preflight-state",
	);
	assert.equal(safeEnvironment.CLOUDFLARE_API_TOKEN, undefined);
	assert.equal(safeEnvironment.OWNER_SUBJECT, undefined);

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
		/worker_global_scope_error/,
	);

	const runtimeRoot = createTemporaryRoot();
	try {
		const bundle = join(runtimeRoot, "healthy.js");
		await writeFile(
			bundle,
			'export default { fetch() { return new Response("ok", { status: 200 }); } };',
		);
		const port = await availablePort();
		const worker = startLocalWorker(runtimeRoot, bundle, port);
		const localConfig = JSON.parse(
			await readFile(join(runtimeRoot, "wrangler.local.jsonc"), "utf8"),
		) as {
			account_id?: string;
			vars: { SERVICE_ORIGIN: string; OWNER_SUBJECT: string };
		};
		assert.equal(localConfig.account_id, undefined);
		assert.equal(localConfig.vars.SERVICE_ORIGIN, `https://127.0.0.1:${port}`);
		assert.equal(localConfig.vars.OWNER_SUBJECT, "preflight-test-owner");
		try {
			await checkMetadata(worker, port, { timeoutMs: 30_000 });
		} finally {
			await stopLocalWorker(worker);
		}

		const forbiddenBundle = join(runtimeRoot, "forbidden.js");
		await writeFile(
			forbiddenBundle,
			'crypto.randomUUID(); export default { fetch() { return new Response("ok"); } };',
		);
		const forbiddenPort = await availablePort();
		const forbiddenWorker = startLocalWorker(
			runtimeRoot,
			forbiddenBundle,
			forbiddenPort,
		);
		try {
			await assert.rejects(
				checkMetadata(forbiddenWorker, forbiddenPort, { timeoutMs: 30_000 }),
				/worker_global_scope_error/,
			);
		} finally {
			await stopLocalWorker(forbiddenWorker);
		}
	} finally {
		await rm(runtimeRoot, { recursive: true, force: true });
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
		assert.equal(result.stdout.toString().trim(), "worker_global_scope_error");
		await writeFile(output, result.stdout);
		const rendered = await readFile(output, "utf8");
		assert.equal(rendered.includes("example.test"), false);
	} finally {
		await rm(temporaryDirectory, { recursive: true, force: true });
	}
}

await main();
