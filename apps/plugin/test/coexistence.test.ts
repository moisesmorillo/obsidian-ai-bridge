import { DeviceStateSchema } from "@obsidian-ai-bridge/protocol";
import { describe, expect, it } from "vitest";
import { CoexistenceController } from "../src/sync/coexistence";
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
