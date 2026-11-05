import { DeviceStateSchema } from "@obsidian-ai-bridge/protocol";
import { describe, expect, it } from "vitest";
import { CoexistenceController } from "../src/sync/coexistence";
import { CoexistenceEffectFence } from "../src/sync/coexistence-effect-fence";
import { DeviceJournal } from "../src/sync/device-journal";

const deviceId = "018f47b2-5c00-7000-8000-000000000001";

/** Holds the smallest canonical state used by coexistence schema regressions. */
const oldState = { version: 1, device_id: deviceId, pending_ops: [] };

describe("coexistence journal schema", () => {
	it("defaults old device documents to empty coexistence state", () => {
		expect(DeviceStateSchema.parse(oldState)).toMatchObject({
			coexistence_confirmations: [],
			unavailable_paths: [],
		});
	});

	it("requires rename destinations and unique confirmation ids", () => {
		const confirmation = {
			id: "018f47b2-5c00-7000-8000-000000000002",
			kind: "rename",
			path: "notes/a.md",
			to: "notes/b.md",
			observed_epoch: "b".repeat(32),
			observed_base: { deleted: false, rev: 2, hash: "c".repeat(64) },
			at: 100,
		};
		expect(
			DeviceStateSchema.safeParse({
				...oldState,
				coexistence_confirmations: [confirmation],
			}).success,
		).toBe(true);
		expect(
			DeviceStateSchema.safeParse({
				...oldState,
				coexistence_confirmations: [{ ...confirmation, to: undefined }],
			}).success,
		).toBe(false);
		expect(
			DeviceStateSchema.safeParse({
				...oldState,
				coexistence_confirmations: [confirmation, confirmation],
			}).success,
		).toBe(false);
		expect(
			DeviceStateSchema.safeParse({
				...oldState,
				coexistence_confirmations: [
					{
						...confirmation,
						observed_base: { deleted: false, rev: 0, hash: "c".repeat(64) },
					},
				],
			}).success,
		).toBe(false);
	});
});

describe("CoexistenceController", () => {
	it("does not persist a confirmation or latch the fence for a proved event", async () => {
		let persisted: unknown = null;
		const journal = await DeviceJournal.open({
			readState: async () => persisted,
			writeState: async (state) => {
				persisted = structuredClone(state);
			},
			readPayload: async () => new Uint8Array(),
			writePayload: async () => undefined,
		});
		const fence = new CoexistenceEffectFence(
			() => journal.snapshot().coexistence_confirmations.length > 0,
		);
		const controller = new CoexistenceController(
			journal,
			{ isUnavailable: async () => false, size: async () => null },
			() => true,
			() => 500,
			fence,
		);
		const event = { type: "delete", path: "notes/a.md" } as const;
		/** Releases the proof after capture has frozen event authority. */
		let resolveProof: (result: boolean) => void = () => undefined;
		const proof = new Promise<boolean>((resolve) => {
			resolveProof = resolve;
		});
		controller.registerOriginProof(event, proof);
		const observing = controller.observe(event);
		expect(controller.observe(event)).toBe(observing);

		expect(fence.isBlocked()).toBe(true);
		expect(journal.snapshot().coexistence_confirmations).toEqual([]);
		resolveProof(true);
		await expect(observing).resolves.toBe(true);
		expect(journal.snapshot().coexistence_confirmations).toEqual([]);
		expect(fence.isBlocked()).toBe(false);
		await expect(controller.observe(event)).resolves.toBe(true);
		expect(journal.snapshot().coexistence_confirmations).toEqual([]);
		expect(fence.isBlocked()).toBe(false);
		journal.close();
	});
	it("keeps event-time authority when a rejected rename proof spans a base change", async () => {
		let persisted: unknown = null;
		let at = 100;
		const journal = await DeviceJournal.open({
			readState: async () => persisted,
			writeState: async (state) => {
				persisted = structuredClone(state);
			},
			readPayload: async () => new Uint8Array(),
			writePayload: async () => undefined,
		});
		const epoch = "f".repeat(32);
		await journal.resetEpoch(epoch);
		await journal.setBase("notes/source.md", {
			deleted: false,
			rev: 2,
			hash: "a".repeat(64),
		});
		const fence = new CoexistenceEffectFence(
			() => journal.snapshot().coexistence_confirmations.length > 0,
		);
		const controller = new CoexistenceController(
			journal,
			{ isUnavailable: async () => false, size: async () => null },
			() => true,
			() => at,
			fence,
		);
		const event = {
			type: "rename",
			path: "notes/source.md",
			to: "notes/destination.md",
		} as const;
		/** Rejects proof only after the source base advances. */
		let rejectProof: (error: Error) => void = () => undefined;
		controller.registerOriginProof(
			event,
			new Promise<boolean>((_resolve, reject) => {
				rejectProof = reject;
			}),
		);
		const observing = controller.observe(event);
		expect(fence.isBlocked()).toBe(true);
		at = 900;
		await journal.setBase("notes/source.md", {
			deleted: false,
			rev: 3,
			hash: "b".repeat(64),
		});
		rejectProof(new Error("uncertain host proof"));
		await expect(observing).resolves.toBe(true);

		const captured = journal.snapshot().coexistence_confirmations[0];
		expect(captured).toMatchObject({
			kind: "rename",
			path: "notes/source.md",
			to: "notes/destination.md",
			observed_epoch: epoch,
			observed_base: { deleted: false, rev: 2, hash: "a".repeat(64) },
			at: 100,
		});
		expect(DeviceStateSchema.safeParse(journal.snapshot()).success).toBe(true);
		expect(fence.isBlocked()).toBe(true);
		journal.close();
	});

	it("keeps the effect fence blocked when uncertain confirmation persistence fails", async () => {
		let persisted: unknown = null;
		let failWrites = false;
		const journal = await DeviceJournal.open({
			readState: async () => persisted,
			writeState: async (state) => {
				if (failWrites) throw new Error("storage write failed");
				persisted = structuredClone(state);
			},
			readPayload: async () => new Uint8Array(),
			writePayload: async () => undefined,
		});
		const fence = new CoexistenceEffectFence(
			() => journal.snapshot().coexistence_confirmations.length > 0,
		);
		const controller = new CoexistenceController(
			journal,
			{ isUnavailable: async () => false, size: async () => null },
			() => true,
			() => 1,
			fence,
		);
		const event = { type: "delete", path: "notes/a.md" } as const;
		controller.registerOriginProof(event, Promise.resolve(false));
		failWrites = true;

		await expect(controller.observe(event)).rejects.toThrow(
			"storage write failed",
		);
		expect(fence.isBlocked()).toBe(true);
		journal.close();
	});

	it("preserves an existing confirmation when another event is proved", async () => {
		let persisted: unknown = null;
		const journal = await DeviceJournal.open({
			readState: async () => persisted,
			writeState: async (state) => {
				persisted = structuredClone(state);
			},
			readPayload: async () => new Uint8Array(),
			writePayload: async () => undefined,
		});
		await journal.resetEpoch("9a".repeat(16));
		await journal.setBase("notes/old.md", {
			deleted: false,
			rev: 1,
			hash: "c".repeat(64),
		});
		const existing = await journal.captureCoexistenceEvent(
			{ type: "delete", path: "notes/old.md" },
			10,
		);
		const fence = new CoexistenceEffectFence(
			() => journal.snapshot().coexistence_confirmations.length > 0,
		);
		const controller = new CoexistenceController(
			journal,
			{ isUnavailable: async () => false, size: async () => null },
			() => true,
			() => 20,
			fence,
		);
		const event = { type: "delete", path: "notes/new.md" } as const;
		controller.registerOriginProof(event, Promise.resolve(true));

		await expect(controller.observe(event)).resolves.toBe(true);
		expect(journal.snapshot().coexistence_confirmations).toEqual([existing]);
		expect(fence.isBlocked()).toBe(true);
		journal.close();
	});

	it("clears a proved plugin delete without changing confirmation queues", async () => {
		let persisted: unknown = null;
		const journal = await DeviceJournal.open({
			readState: async () => persisted,
			writeState: async (state) => {
				persisted = structuredClone(state);
			},
			readPayload: async () => new Uint8Array(),
			writePayload: async () => undefined,
		});
		await journal.resetEpoch("d".repeat(32));
		await journal.setBase("notes/a.md", {
			deleted: false,
			rev: 7,
			hash: "e".repeat(64),
		});
		const controller = new CoexistenceController(
			journal,
			{ isUnavailable: async () => false, size: async () => null },
			() => true,
			() => 500,
		);
		const event = { type: "delete", path: "notes/a.md" } as const;
		controller.registerOriginProof(event, Promise.resolve(true));

		await expect(controller.observe(event)).resolves.toBe(true);
		expect(journal.snapshot().coexistence_confirmations).toEqual([]);
		expect(journal.snapshot().base["notes/a.md"]).toEqual({
			deleted: false,
			rev: 7,
			hash: "e".repeat(64),
		});
		journal.close();
	});
	it("captures exact delete authority and placeholder metadata before event admission", async () => {
		let persisted: unknown = null;
		const journal = await DeviceJournal.open({
			readState: async () => persisted,
			writeState: async (state) => {
				persisted = structuredClone(state);
			},
			readPayload: async () => new Uint8Array(),
			writePayload: async () => undefined,
		});
		const epoch = "b".repeat(32);
		await journal.resetEpoch(epoch);
		await journal.setBase("notes/a.md", {
			deleted: false,
			rev: 4,
			hash: "c".repeat(64),
		});
		const unavailable = new Set<string>();
		const controller = new CoexistenceController(
			journal,
			{
				isUnavailable: async (path) => unavailable.has(path),
				size: async () => null,
			},
			() => true,
			() => 100,
		);
		unavailable.add("notes/a.md");
		await controller.observe({ type: "create", path: "notes/a.md.icloud" });
		await controller.observe({ type: "delete", path: "notes/a.md" });
		const captured = journal.snapshot().coexistence_confirmations[0];
		const state = journal.snapshot();
		expect(captured?.observed_epoch).toBe(epoch);
		expect(captured?.observed_base).toEqual({
			deleted: false,
			rev: 4,
			hash: "c".repeat(64),
		});
		expect(state.unavailable_paths).toContain("notes/a.md");
		expect(journal.snapshot().coexistence_confirmations).toHaveLength(1);
		unavailable.delete("notes/a.md");
		await controller.observe({ type: "delete", path: "notes/a.md.icloud" });
		expect(journal.snapshot().unavailable_paths).not.toContain("notes/a.md");
		await journal.setBase("notes/source.md", {
			deleted: false,
			rev: 2,
			hash: "d".repeat(64),
		});
		unavailable.add("notes/destination.md");
		await controller.observe({
			type: "rename",
			path: "notes/source.md",
			to: "notes/.destination.md.icloud",
		});
		expect(journal.snapshot().coexistence_confirmations).toHaveLength(2);
		expect(journal.snapshot().unavailable_paths).toContain(
			"notes/destination.md",
		);
		const renameConfirmation = journal.snapshot().coexistence_confirmations[1];
		expect(await controller.confirm(renameConfirmation.id)).toBeNull();
		expect(journal.snapshot().coexistence_confirmations[1]?.stale_reason).toBe(
			"The rename destination is excluded from synchronization.",
		);
		await controller.observe({
			type: "delete",
			path: "notes/deleted.md.icloud",
		});
		expect(journal.snapshot().coexistence_confirmations).toHaveLength(2);
		journal.close();
	});
});
