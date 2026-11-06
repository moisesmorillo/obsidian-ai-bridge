import { describe, expect, it, vi } from "vitest";
import {
	AC19_PHASES,
	createAc19PhaseScripts,
	runAc19Phase,
} from "../tools/ac19-phase-runner";
import {
	authorizedVaults,
	createAc19FixturePaths,
} from "../tools/desktop-acceptance";

const home = undefined;
const target = authorizedVaults()["dev-2"];
const fixture = createAc19FixturePaths(
	"dev-2",
	[],
	"simulated-eviction-p6-20261106-01",
);

/** Executes one generated eval against the supplied synthetic Obsidian host. */
async function evaluateScript(
	app: unknown,
	script: string,
	dateConstructor: DateConstructor = Date,
): Promise<Record<string, unknown>> {
	const evaluate = new Function("app", "Date", `return ${script}`) as (
		host: unknown,
		date: DateConstructor,
	) => Promise<string>;
	const output = await evaluate(app, dateConstructor);
	return JSON.parse(output.slice("OAB8AC19P6:".length)) as Record<
		string,
		unknown
	>;
}

/** Polls one safe phase until its host-side work reaches a terminal checkpoint. */
async function completePhase(
	app: unknown,
	script: string,
	dateConstructor: DateConstructor = Date,
): Promise<Record<string, unknown>> {
	let result: Record<string, unknown>;
	for (let attempt = 0; attempt < 20; attempt += 1) {
		result = await evaluateScript(app, script, dateConstructor);
		if (result.status !== "pending") return result;
		await Promise.resolve();
	}
	throw new Error("Synthetic phase did not settle");
}

/** Mutable desktop host, durable journal, transport observations, and publication effects. */
interface PhaseHost {
	/** Synthetic Obsidian app passed to generated guarded evals. */
	app: unknown;
	/** Mutable service and journal evidence used by assertions. */
	state: {
		epoch: string;
		client_id: string;
		base: Record<string, { deleted: boolean; rev: number; hash: string }>;
		pending_ops: unknown[];
		pending_apply: unknown[];
		attention: Array<{ id: string; path: string }>;
		coexistence_confirmations: Array<{ id: string; path: string }>;
		unavailable_paths: string[];
	};
	/** Service requests received from the host-side transport adapter. */
	manifestReads: number;
	/** Publication changes requested through ordinary plugin synchronization. */
	publicationEffects: string[];
	/** Replaces only the fixed fixture row to test authority changes. */
	changeServiceAuthority(): void;
}

/** Builds one local fake plugin that follows the observed host API shapes. */
function createPhaseHost(options: { retryAfter?: string } = {}): PhaseHost {
	const { source, placeholder } = fixture;
	const epoch = "a".repeat(32);
	const hash = "b".repeat(64);
	const state: PhaseHost["state"] = {
		epoch,
		client_id: "client-1",
		base: {},
		pending_ops: [],
		pending_apply: [],
		attention: [{ id: "historical-1", path: "oab-10.1/history.md" }],
		coexistence_confirmations: [],
		unavailable_paths: [],
	};
	const files = new Map<string, { path: string }>();
	const directories = new Set<string>();
	const publicationEffects: string[] = [];
	let manifestReads = 0;
	let head = 0;
	let remoteRow: Record<string, unknown> | null = null;
	const remote = {
		manifest: async (pageToken: string | null) => {
			manifestReads += 1;
			if (options.retryAfter && manifestReads === 1) {
				throw Object.assign(new Error("private service body"), {
					name: "SyncTransportError",
					status: 429,
					retryAfter: options.retryAfter,
				});
			}
			const unrelated = {
				path: "unrelated/private.md",
				deleted: false,
				hash: "secret",
			};
			if (pageToken === null)
				return {
					epoch,
					head_seq: head,
					next_page: "page-2",
					entries: [unrelated],
				};
			return {
				epoch,
				head_seq: head,
				next_page: null,
				entries: remoteRow ? [remoteRow] : [],
			};
		},
	};
	const controls: {
		paused: boolean;
		composition: { reconciliation: { remote: typeof remote } } | null;
	} = { paused: true, composition: null };
	const settingsValue = { coexistenceMode: false };
	const desktopSync = {
		isBusy: false,
		syncNow: async () => {
			if (files.has(source) && !state.base[source]) {
				state.base[source] = { deleted: false, rev: 1, hash };
				remoteRow = {
					path: source,
					etag: `"${epoch}.1"`,
					seq: 1,
					hash,
					kind: "text",
					deleted: false,
				};
				head += 1;
				publicationEffects.push("put");
				return;
			}
			if (
				!files.has(source) &&
				files.has(placeholder) &&
				settingsValue.coexistenceMode
			) {
				if (
					!state.coexistence_confirmations.some((item) => item.path === source)
				) {
					state.coexistence_confirmations.push({
						id: "confirmation-1",
						path: source,
					});
					state.unavailable_paths.push(source);
					publicationEffects.push("confirmation");
				}
				return;
			}
			if (
				!files.has(source) &&
				!files.has(placeholder) &&
				!settingsValue.coexistenceMode &&
				!controls.paused
			) {
				state.base[source] = { deleted: true, rev: 2, hash: "" };
				remoteRow = {
					path: source,
					etag: `"${epoch}.2"`,
					seq: 2,
					hash: "",
					kind: "text",
					deleted: true,
				};
				head += 1;
				publicationEffects.push("delete");
			}
		},
	};
	const plugin = {
		journal: {
			snapshot: () => structuredClone(state),
			storage: { readState: async () => structuredClone(state) },
		},
		settingsValue,
		lifecycleGeneration: 1,
		changeCoexistenceMode: async (_generation: number, enabled: boolean) => {
			settingsValue.coexistenceMode = enabled;
		},
		sessionStatus: "connected",
		/** Reports the synthetic controller Pause state. */
		get syncPaused() {
			return controls.paused;
		},
		syncActive: false,
		/** Exposes the active synthetic service composition. */
		get composition() {
			return controls.composition;
		},
		desktopSync,
		coexistence: {
			keepServerState: async (id: string) => {
				state.coexistence_confirmations =
					state.coexistence_confirmations.filter((item) => item.id !== id);
				state.unavailable_paths = state.unavailable_paths.filter(
					(path) => path !== source,
				);
				files.set(source, { path: source });
			},
		},
		settingsTab: {
			syncActions: {
				resume: () => {
					controls.paused = false;
					controls.composition = { reconciliation: { remote } };
				},
				pause: () => {
					controls.paused = true;
					controls.composition = null;
				},
			},
		},
	};
	const app = {
		vault: {
			getName: () => "obsidian-ai-bridge-dev-2",
			adapter: {
				basePath: target,
				getBasePath: () => target,
				stat: async (path: string) =>
					files.get(path) ?? (directories.has(path) ? { path } : null),
				mkdir: async (path: string) => {
					directories.add(path);
				},
			},
			getAbstractFileByPath: (path: string) => files.get(path) ?? null,
			create: async (path: string, _contents: string) => {
				const file = { path };
				files.set(path, file);
				return file;
			},
			createBinary: async (path: string, _data: ArrayBuffer) => {
				files.set(path, { path });
				await desktopSync.syncNow();
			},
			trash: async (file: { path: string }, _system: boolean) => {
				files.delete(file.path);
			},
		},
		plugins: { plugins: { "ai-bridge": plugin } },
	};
	return {
		app,
		state,
		/** Reports each page request received by the synthetic remote. */
		get manifestReads() {
			return manifestReads;
		},
		publicationEffects,
		/** Changes the fixed fixture authority to test revision mismatch refusal. */
		changeServiceAuthority() {
			remoteRow = {
				path: source,
				etag: `"${epoch}.9"`,
				seq: 9,
				hash: "c".repeat(64),
				kind: "text",
				deleted: false,
			};
			head = 9;
		},
	};
}

/** Runs each required phase through eviction and captures its safe output. */
async function reachEviction(
	app: unknown,
	generated: ReturnType<typeof scripts>,
) {
	for (const phase of [
		"preflight",
		"enable-coexistence",
		"resume",
		"service-absence",
		"seed",
		"service-baseline",
		"evict",
	] as const)
		await completePhase(app, generated[phase]);
}

/** Builds the fixed script set without accessing a host or invoking a CLI. */
function scripts() {
	return createAc19PhaseScripts("dev-2", target, home);
}

describe("AC-19 bounded phase runner", () => {
	it("creates short scripts with the full vault guard and fixed fixture", () => {
		const generated = scripts();
		expect(Object.keys(generated)).toEqual(AC19_PHASES);
		for (const phase of AC19_PHASES) {
			const script = generated[phase];
			expect(script).toContain('getName()!=="obsidian-ai-bridge-dev-2"');
			expect(script).toContain("adapter.basePath");
			expect(script).toContain("getBasePath()");
			expect(script.length).toBeLessThan(9_000);
		}
		expect(generated.evict).toContain("simulated-eviction-p6-20261106-01.md");
	});

	it("refuses a non-dev-2 identity before generating a script", () => {
		expect(() => createAc19PhaseScripts("dev-1", target, home)).toThrow(
			"dev-2",
		);
		expect(() =>
			createAc19PhaseScripts("dev-2", "/Users/test/vaults/other", home),
		).toThrow();
	});

	it("checks CLI vault identity and parses decorated safe checkpoints", () => {
		const invoke = vi.fn((_executable: string, args: readonly string[]) => ({
			status: 0,
			stdout: args.includes("info=path")
				? target
				: `=> OAB8AC19P6:${JSON.stringify({ phase: "preflight", status: "ready", at: 123, clientId: "client-1", attentionHash: "a".repeat(64), counts: { operations: 1, applies: 2, attention: 4, confirmations: 0 }, flags: { paused: true, placeholderExcluded: true }, rawBody: "private body", credential: "secret" })}`,
		}));
		const result = runAc19Phase(
			"dev-2",
			"obsidian-ai-bridge-dev-2",
			scripts().preflight,
			{ invoke },
		);
		expect(result).toMatchObject({
			phase: "preflight",
			status: "ready",
			at: 123,
			clientId: "client-1",
			counts: { operations: 1, applies: 2, attention: 4, confirmations: 0 },
			attentionHash: "a".repeat(64),
			flags: { paused: true, placeholderExcluded: true },
		});
		expect(JSON.stringify(result)).not.toContain("private body");
		expect(JSON.stringify(result)).not.toContain("secret");
		expect(invoke).toHaveBeenCalledTimes(2);
	});

	it("treats unknown CLI results as uncertain and never returns private output", () => {
		const invoke = vi.fn((_executable: string, args: readonly string[]) => ({
			status: args.includes("info=path") ? 0 : 1,
			stdout: args.includes("info=path")
				? target
				: "private service body and token",
		}));
		expect(
			runAc19Phase("dev-2", "obsidian-ai-bridge-dev-2", scripts().seed, {
				invoke,
			}),
		).toMatchObject({ phase: "seed", status: "uncertain" });
		expect(invoke).toHaveBeenCalledTimes(2);
	});

	it("treats a checkpoint for the wrong phase as uncertain", () => {
		const invoke = vi.fn((_executable: string, args: readonly string[]) => ({
			status: 0,
			stdout: args.includes("info=path")
				? target
				: `OAB8AC19P6:${JSON.stringify({ phase: "evict", status: "passed" })}`,
		}));
		expect(
			runAc19Phase("dev-2", "obsidian-ai-bridge-dev-2", scripts().seed, {
				invoke,
			}),
		).toMatchObject({ phase: "seed", status: "uncertain" });
		expect(invoke).toHaveBeenCalledTimes(2);
	});

	it("refuses a wrong active vault before plugin access", async () => {
		let pluginAccesses = 0;
		const app = {
			vault: {
				getName: () => "wrong-vault",
				adapter: { basePath: target, getBasePath: () => target },
			},
			/** Counts plugin access so the guard can prove it ran first. */
			get plugins() {
				pluginAccesses += 1;
				return { plugins: {} };
			},
		};
		await expect(evaluateScript(app, scripts().preflight)).rejects.toThrow(
			"AC19P6_TARGET",
		);
		expect(pluginAccesses).toBe(0);
	});

	it("refuses a fixture collision before it reads journal state", async () => {
		let journalReads = 0;
		const app = {
			vault: {
				getName: () => "obsidian-ai-bridge-dev-2",
				adapter: { basePath: target, getBasePath: () => target },
				getAbstractFileByPath: () => ({ path: "fixture" }),
			},
			plugins: {
				plugins: {
					"ai-bridge": {
						journal: {
							snapshot: () => {
								journalReads += 1;
								return {};
							},
						},
					},
				},
			},
		};
		await expect(evaluateScript(app, scripts().preflight)).rejects.toThrow(
			"AC19P6_COLLISION",
		);
		expect(journalReads).toBe(0);
	});

	it("keeps Pause available without case state and blocks later mutation phases", async () => {
		let resumeCalls = 0;
		const plugin: {
			syncPaused: boolean;
			composition: object | null;
			settingsTab: {
				syncActions: {
					/** Moves the synthetic controller into its failure-safe paused state. */
					pause(): void;
					/** Counts an invalid later Resume request. */
					resume(): void;
				};
			};
		} = {
			syncPaused: false,
			composition: {},
			settingsTab: {
				syncActions: {
					/** Simulates a successful plugin Pause command. */
					pause: () => {
						plugin.syncPaused = true;
						plugin.composition = null;
					},
					/** Counts Resume calls that the paused state must reject. */
					resume: () => {
						resumeCalls += 1;
					},
				},
			},
		};
		const app = {
			vault: {
				getName: () => "obsidian-ai-bridge-dev-2",
				adapter: { basePath: target, getBasePath: () => target },
			},
			plugins: { plugins: { "ai-bridge": plugin } },
		};
		const pause = await evaluateScript(app, scripts().pause);
		expect(pause.status).toBe("paused");
		const refused = await evaluateScript(app, scripts().resume);
		expect(refused.status).toBe("paused");
		expect(resumeCalls).toBe(0);
	});

	it("returns pending while a mutation waits and does not issue it twice", async () => {
		const state = {
			epoch: "a".repeat(32),
			client_id: "client-1",
			base: {},
			pending_ops: [],
			pending_apply: [],
			attention: [],
			coexistence_confirmations: [],
			unavailable_paths: [],
		};
		const remote = {
			manifest: async () => ({
				epoch: state.epoch,
				head_seq: 0,
				next_page: null,
				entries: [],
			}),
		};
		let createCalls = 0;
		const hostState: {
			/** Synthetic controller Pause state shared by accessors. */
			syncPaused: boolean;
			/** Synthetic active service composition or null while paused. */
			composition: { reconciliation: { remote: typeof remote } } | null;
		} = { syncPaused: true, composition: null };
		const plugin = {
			journal: { snapshot: () => structuredClone(state) },
			settingsValue: { coexistenceMode: true },
			lifecycleGeneration: 1,
			changeCoexistenceMode: async (_generation: number, enabled: boolean) => {
				plugin.settingsValue.coexistenceMode = enabled;
			},
			sessionStatus: "connected",
			/** Reads the controller Pause state used by the host script. */
			get syncPaused() {
				return hostState.syncPaused;
			},
			/** Updates the shared Pause state when a synthetic action runs. */
			set syncPaused(value: boolean) {
				hostState.syncPaused = value;
			},
			syncActive: false,
			/** Reads whether the synthetic service composition remains active. */
			get composition() {
				return hostState.composition;
			},
			/** Stores the synthetic composition after Resume or Pause. */
			set composition(value: {
				reconciliation: { remote: typeof remote };
			} | null) {
				hostState.composition = value;
			},
			desktopSync: {
				isBusy: false,
				syncNow: () => new Promise<void>(() => {}),
			},
			coexistence: { keepServerState: async () => undefined },
			settingsTab: {
				syncActions: {
					resume: () => {
						hostState.syncPaused = false;
						hostState.composition = { reconciliation: { remote } };
					},
					pause: () => {
						hostState.syncPaused = true;
						hostState.composition = null;
					},
				},
			},
		};
		const files = new Map<string, object>();
		const app = {
			vault: {
				getName: () => "obsidian-ai-bridge-dev-2",
				adapter: {
					basePath: target,
					getBasePath: () => target,
					stat: async (path: string) => files.get(path) ?? null,
					mkdir: async () => undefined,
				},
				getAbstractFileByPath: (path: string) => files.get(path) ?? null,
				create: () => {
					createCalls += 1;
					return new Promise(() => {});
				},
			},
			plugins: { plugins: { "ai-bridge": plugin } },
		};
		const phaseScripts = scripts();
		await evaluateScript(app, phaseScripts.preflight);
		await completePhase(app, phaseScripts["enable-coexistence"]);
		await completePhase(app, phaseScripts.resume);
		await completePhase(app, phaseScripts["service-absence"]);
		expect(
			(app as unknown as { __oabAc19P6: { phase: string } }).__oabAc19P6.phase,
		).toBe("service-absence");
		const started = await evaluateScript(app, phaseScripts.seed);
		const repeated = await evaluateScript(app, phaseScripts.seed);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(started.status).toBe("pending");
		expect(repeated.status).toBe("pending");
		expect(createCalls).toBe(1);
	});

	it("completes eviction proof, durable confirmation, cleanup, and Pause in order", async () => {
		const host = createPhaseHost();
		const phaseScripts = scripts();
		await reachEviction(host.app, phaseScripts);
		const captured = await completePhase(host.app, phaseScripts.capture);
		expect(captured).toMatchObject({
			status: "passed",
			flags: { placeholderExcluded: true, historyUnchanged: true },
		});
		expect(host.state.coexistence_confirmations).toHaveLength(1);
		const serviceProof = await completePhase(
			host.app,
			phaseScripts["service-captured"],
		);
		expect(serviceProof).toMatchObject({
			status: "passed",
			flags: { serviceUnchanged: true, placeholderAbsent: true },
		});
		expect(host.publicationEffects).toEqual(["put", "confirmation"]);
		await completePhase(host.app, phaseScripts.restore);
		const restored = await completePhase(
			host.app,
			phaseScripts["service-restored"],
		);
		expect(restored).toMatchObject({
			status: "passed",
			flags: { historyUnchanged: true, serviceUnchanged: true },
		});
		await completePhase(host.app, phaseScripts["disable-coexistence"]);
		await completePhase(host.app, phaseScripts["cleanup-delete"]);
		const paused = await evaluateScript(host.app, phaseScripts.pause);
		expect(paused.status).toBe("paused");
		const final = await completePhase(host.app, phaseScripts["service-final"]);
		expect(final).toMatchObject({
			status: "passed",
			flags: { tombstoneObserved: true, placeholderAbsent: true, paused: true },
		});
		expect(host.state.base[fixture.source]).toMatchObject({
			deleted: true,
			rev: 2,
		});
		expect(host.publicationEffects).toEqual(["put", "confirmation", "delete"]);
	});

	it("blocks changed history and service authority after simulated eviction", async () => {
		const host = createPhaseHost();
		const phaseScripts = scripts();
		await reachEviction(host.app, phaseScripts);
		host.state.attention.push({
			id: "new-historical",
			path: "oab-10.1/other.md",
		});
		const changedHistory = await completePhase(host.app, phaseScripts.capture);
		expect(changedHistory.status).toBe("failed");

		const otherHost = createPhaseHost();
		const otherScripts = scripts();
		await reachEviction(otherHost.app, otherScripts);
		await completePhase(otherHost.app, otherScripts.capture);
		otherHost.changeServiceAuthority();
		const changedAuthority = await completePhase(
			otherHost.app,
			otherScripts["service-captured"],
		);
		expect(changedAuthority.status).toBe("failed");
		expect(otherHost.publicationEffects).toEqual(["put", "confirmation"]);
	});

	it("retains Retry-After outside eval and retries only the safe manifest read", async () => {
		const host = createPhaseHost({ retryAfter: "3" });
		const phaseScripts = scripts();
		const now = { value: 1_000 };
		const TestDate = Object.assign(
			(value?: string | number) =>
				value === undefined ? new Date() : new Date(value),
			{ now: () => now.value, parse: Date.parse, UTC: Date.UTC },
		) as unknown as DateConstructor;
		for (const phase of ["preflight", "enable-coexistence", "resume"] as const)
			await completePhase(host.app, phaseScripts[phase], TestDate);
		await new Promise((resolve) => setTimeout(resolve, 0));
		await evaluateScript(host.app, phaseScripts["service-absence"], TestDate);
		await new Promise((resolve) => setTimeout(resolve, 0));
		const limited = await evaluateScript(
			host.app,
			phaseScripts["service-absence"],
			TestDate,
		);
		expect(limited).toMatchObject({ status: "pending", retryAfterMs: 3_000 });
		expect(host.manifestReads).toBe(1);
		now.value += 3_000;
		const retried = await completePhase(
			host.app,
			phaseScripts["service-absence"],
			TestDate,
		);
		expect(retried.status).toBe("passed");
		expect(host.manifestReads).toBe(3);
	});

	it("does not retry a manifest read with an invalid Retry-After value", async () => {
		const host = createPhaseHost({ retryAfter: "3.5" });
		const phaseScripts = scripts();
		for (const phase of ["preflight", "enable-coexistence", "resume"] as const)
			await completePhase(host.app, phaseScripts[phase]);
		await evaluateScript(host.app, phaseScripts["service-absence"]);
		await new Promise((resolve) => setTimeout(resolve, 0));
		const failed = await evaluateScript(
			host.app,
			phaseScripts["service-absence"],
		);
		expect(failed.status).toBe("failed");
		expect(host.manifestReads).toBe(1);
		expect(JSON.stringify(failed)).not.toContain("private service body");
	});

	it("rejects a skipped phase after preflight", async () => {
		const state = {
			epoch: "a".repeat(32),
			client_id: "client-1",
			base: {},
			pending_ops: [],
			pending_apply: [],
			attention: [],
			coexistence_confirmations: [],
			unavailable_paths: [],
		};
		const app = {
			vault: {
				getName: () => "obsidian-ai-bridge-dev-2",
				adapter: {
					basePath: target,
					getBasePath: () => target,
					stat: async () => null,
				},
				getAbstractFileByPath: () => null,
			},
			plugins: {
				plugins: {
					"ai-bridge": {
						journal: { snapshot: () => structuredClone(state) },
						desktopSync: {},
						sessionStatus: "connected",
						syncPaused: true,
						syncActive: false,
						composition: null,
						coexistence: {},
						settingsValue: {},
						settingsTab: {
							syncActions: {
								/** Placeholder Resume callback for phase-order refusal. */
								resume() {},
								/** Placeholder Pause callback for required host controls. */
								pause() {},
							},
						},
					},
				},
			},
		};
		await evaluateScript(app, scripts().preflight);
		await expect(evaluateScript(app, scripts().seed)).rejects.toThrow(
			"AC19P6_ORDER",
		);
	});
});
