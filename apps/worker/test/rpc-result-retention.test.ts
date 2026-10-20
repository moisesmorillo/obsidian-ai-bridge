import { env, runInDurableObject } from "cloudflare:test";
import {
	EMPTY_PAYLOAD_HASH,
	type TextMutationResult,
} from "@obsidian-ai-bridge/protocol";
import type { Env } from "@worker/env";
import type { Vault } from "@worker/infrastructure/durable-object/vault";
import { initializeVaultStorage } from "@worker/infrastructure/sqlite/schema";
import { clearTestVault } from "@worker/test-fixtures/admission";
import { TEXT_FIXTURE_EPOCH } from "@worker/test-fixtures/text-files";
import { describe, expect, it } from "vitest";

/** Resolve a caller input gate without retaining any result value. */
function gate() {
	/** Default release does nothing before the Promise executor installs its resolver. */
	let release = () => {};
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

/** Wait for native dispatch, with a deadline that still lets the test release every caller gate. */
async function waitFor(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (!predicate()) {
		if (Date.now() >= deadline)
			throw new Error("Native result witness did not arrive");
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
}

/** Pending native pipeline with one nonserialized test witness, not an application disposer. */
type WitnessPromise = Promise<TextMutationResult> & {
	ok: Promise<boolean>;
	/** Report server reachability without returning the retained content. */
	retentionWitness(): Promise<number>;
};

/** Exercise native result pipelines before caller deserialization, without changing production composition. */
describe("native RPC result ownership", () => {
	it.each([
		{ count: 2, probe: false },
		{ count: 2, probe: true },
		{ count: 34, probe: false },
	])(
		"keeps $count results before deserialization with pipeline probe $probe",
		async ({ count, probe }) => {
			const authority = env.VAULTS.get(env.VAULTS.newUniqueId());
			const authorityId = authority.id.toString();
			const callers = Array.from({ length: count }, () =>
				env.VAULTS.get(env.VAULTS.newUniqueId()),
			);
			const gates = callers.map(() => gate());
			const witnessed = new Set<number>();
			const serialized = new Set<number>();
			let deserialized = 0;
			await runInDurableObject(authority, async (_instance, state) => {
				clearTestVault(state.storage);
				initializeVaultStorage(
					state.storage,
					() => TEXT_FIXTURE_EPOCH,
					Date.now,
				);
				for (let index = 0; index < count; index++) {
					const content =
						String(index).padStart(4, "0") +
						String.fromCharCode(index + 1).repeat(999_996);
					const hash = Array.from(
						new Uint8Array(
							await crypto.subtle.digest(
								"SHA-256",
								new TextEncoder().encode(content),
							),
						),
						(byte) => byte.toString(16).padStart(2, "0"),
					).join("");
					state.storage.sql.exec(
						"INSERT INTO files(path,path_key,rev,seq,hash,size,kind,content,deleted,updated_at,origin) VALUES (?, ?, 1, ?, ?, 1000000, 'text', ?, 0, 1, 'seed')",
						`failure-${index}.md`,
						`failure-${index}.md`,
						index + 1,
						hash,
						content,
					);
				}
			});
			const contexts = callers.map((_, index) => ({
				client_id: `result-client-${index}`,
				grant_id: `result-grant-${index}`,
				scopes: ["vault:read", "vault:write"] as (
					| "vault:read"
					| "vault:write"
				)[],
			}));
			const intents = callers.map((_, index) => ({
				op: "put" as const,
				epoch: TEXT_FIXTURE_EPOCH,
				paths: [`failure-${index}.md`],
				precondition: { kind: "absent" as const },
				payload_hash: EMPTY_PAYLOAD_HASH,
				size: 0,
			}));
			const tickets: string[] = [];
			for (let index = 0; index < count; index++) {
				const context = contexts[index];
				const intent = intents[index];
				if (!context || !intent)
					throw new Error("Missing native caller fixture");
				const reservation = await authority.beginMutation(context, intent);
				if (!reservation.ok) throw new Error(reservation.failure.kind);
				const authorized = await authority.authorize(
					context,
					intent,
					reservation.lease.admission_id,
				);
				if (!authorized.ok) throw new Error(authorized.failure.kind);
				tickets.push(authorized.ticket.id);
			}
			const restore = await runInDurableObject(authority, async (instance) => {
				const prototype = Object.getPrototypeOf(instance) as Pick<
					Vault,
					"commitText"
				>;
				const original = prototype.commitText;
				// The configured TypeScript library omits this pinned native symbol.
				const disposeSymbol: unknown = Reflect.get(Symbol, "dispose");
				if (typeof disposeSymbol !== "symbol")
					throw new Error("Pinned native disposal symbol is absent");
				const nativeDispose: symbol = disposeSymbol;
				// A mock call log would retain result promises and invalidate this ownership test.
				/** Add a nonserialized witness without a disposer, external stub, or retained result log. */
				async function witnessedCommitText(
					this: Vault,
					...args: Parameters<Vault["commitText"]>
				): Promise<TextMutationResult> {
					const result = await original.call(this, ...args);
					if (!result.ok && result.failure.kind === "precondition_failed") {
						const index = Number(
							args[0].client_id.slice("result-client-".length),
						);
						const units = result.failure.content?.length ?? 0;
						Object.defineProperty(result, nativeDispose, {
							configurable: true,
							enumerable: false,
							// This getter records native serialization without an application disposer.
							get: () => {
								serialized.add(index);
								return undefined;
							},
						});
						if (probe)
							Object.defineProperty(result, "retentionWitness", {
								enumerable: false,
								value: () => {
									witnessed.add(index);
									return units;
								},
							});
					}
					return result;
				}
				prototype.commitText = witnessedCommitText;
				return () => {
					prototype.commitText = original;
				};
			});
			const work = callers.map((caller, index) =>
				runInDurableObject(caller, async (instance, state) => {
					// A binding from the runner context cannot cross this native I/O boundary.
					const localEnv = Reflect.get(instance, "env") as Env;
					const localAuthority = localEnv.VAULTS.get(
						localEnv.VAULTS.idFromString(authorityId),
					);
					const context = contexts[index];
					const intent = intents[index];
					const ticket = tickets[index];
					const wait = gates[index];
					if (!context || !intent || !ticket || !wait)
						throw new Error("Missing blocked caller fixture");
					const pending = localAuthority.commitText(
						context,
						intent,
						ticket,
						"",
					) as unknown as WitnessPromise;
					const received = pending.then((result) => {
						deserialized++;
						return result;
					});
					const witness = probe
						? pending.retentionWitness()
						: Promise.resolve(1_000_000);
					await state.blockConcurrencyWhile(() => wait.promise);
					const [result, units] = await Promise.all([received, witness]);
					expect(units).toBe(1_000_000);
					expect(result.ok).toBe(false);
					if (result.ok || result.failure.kind !== "precondition_failed")
						throw new Error("Expected content-bearing refusal");
					expect(result.failure.content?.slice(0, 4)).toBe(
						String(index).padStart(4, "0"),
					);
					expect(result.failure.content?.length).toBe(1_000_000);
					expect(Object.hasOwn(result, "retentionWitness")).toBe(false);
					expect(await pending.ok).toBe(false);
					await localAuthority.finishAdmission(context, ticket, "settled");
				}),
			);
			const completion = Promise.allSettled(work);
			let outcomes: PromiseSettledResult<void>[] = [];
			try {
				await waitFor(() => serialized.size === count);
				if (probe) await waitFor(() => witnessed.size === count);
				expect(deserialized).toBe(0);
				expect(
					await authority.getCurrentEpoch(
						contexts[0] ?? {
							client_id: "probe",
							grant_id: "probe",
							scopes: ["vault:read"],
						},
						"read",
					),
				).toMatchObject({ ok: true });
				expect(deserialized).toBe(0);
				console.info(
					"NATIVE_RESULT_BEFORE_DESERIALIZATION",
					JSON.stringify({
						count,
						probe,
						serialized: serialized.size,
						witnessed: witnessed.size,
						deserialized,
						contentUnits: count * 1_000_000,
					}),
				);
				gates[0]?.release();
				await waitFor(() => deserialized === 1);
				expect(deserialized).toBe(1);
				console.info(
					"NATIVE_RESULT_PARTIAL_RELEASE",
					JSON.stringify({
						count,
						probe,
						deserialized,
						remainingCallerGates: count - 1,
					}),
				);
			} finally {
				for (const wait of gates) wait.release();
				outcomes = await completion;
				restore();
			}
			const failed = outcomes.find((outcome) => outcome.status === "rejected");
			if (failed?.status === "rejected") throw failed.reason;
			expect(deserialized).toBe(count);
			console.info(
				"NATIVE_RESULT_SETTLED",
				JSON.stringify({ count, probe, deserialized }),
			);
		},
		15_000,
	);
});
