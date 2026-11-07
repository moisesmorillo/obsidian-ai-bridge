import { env } from "cloudflare:test";
import type { Env } from "@worker/env";
import worker from "@worker/index";
import { afterEach, describe, expect, it, vi } from "vitest";

/** Scheduled entry contract used to call the Worker handler with a fake Vault namespace. */
type ScheduledWorker = typeof worker & {
	scheduled?: (
		controller: { scheduledTime: number; cron: string },
		env: Env,
		context: ExecutionContext,
	) => Promise<void>;
};

describe("scheduled packed exports", () => {
	afterEach(() => vi.restoreAllMocks());

	it("targets the canonical service vault and records a busy skip", async () => {
		const calls: Array<{ host: string; createdAt: string }> = [];
		const targetHost = "vault.example.test";
		const scheduledAt = Date.parse("2026-11-07T04:00:00.000Z");
		const bindings = {
			...env,
			SERVICE_ORIGIN: `https://${targetHost}`,
			VAULTS: {
				idFromName: (name: string) => name,
				get: (id: string) => ({
					startScheduledPackedExport: async (createdAt: string) => {
						calls.push({ host: id, createdAt });
						return null;
					},
				}),
			} as unknown as Env["VAULTS"],
		} as Env;
		const log = vi.spyOn(console, "info").mockImplementation(() => {});
		const handler = (worker as ScheduledWorker).scheduled;
		expect(handler).toBeTypeOf("function");
		if (!handler) return;

		await handler(
			{ scheduledTime: scheduledAt, cron: "0 * * * *" },
			bindings,
			{} as ExecutionContext,
		);

		expect(calls).toEqual([
			{ host: targetHost, createdAt: "2026-11-07T04:00:00.000Z" },
		]);
		expect(log).toHaveBeenCalledWith(
			JSON.stringify({
				event: "scheduled_export_skipped",
				reason: "export_already_running",
				created_at: "2026-11-07T04:00:00.000Z",
			}),
		);
	});

	it("does not select a vault when the service origin is missing", async () => {
		const idFromName = vi.fn();
		const bindings = {
			...env,
			SERVICE_ORIGIN: undefined,
			VAULTS: { idFromName } as unknown as Env["VAULTS"],
		} as Env;
		const handler = (worker as ScheduledWorker).scheduled;
		expect(handler).toBeTypeOf("function");
		if (!handler) return;

		await handler(
			{
				scheduledTime: Date.parse("2026-11-07T04:00:00.000Z"),
				cron: "0 * * * *",
			},
			bindings,
			{} as ExecutionContext,
		);

		expect(idFromName).not.toHaveBeenCalled();
	});

	it("does not select a vault for a non-origin service URL", async () => {
		const idFromName = vi.fn();
		const bindings = {
			...env,
			SERVICE_ORIGIN: "https://service.example/path",
			VAULTS: { idFromName } as unknown as Env["VAULTS"],
		} as Env;
		const handler = (worker as ScheduledWorker).scheduled;
		expect(handler).toBeTypeOf("function");
		if (!handler) return;

		await handler(
			{
				scheduledTime: Date.parse("2026-11-07T04:00:00.000Z"),
				cron: "0 * * * *",
			},
			bindings,
			{} as ExecutionContext,
		);

		expect(idFromName).not.toHaveBeenCalled();
	});
});
