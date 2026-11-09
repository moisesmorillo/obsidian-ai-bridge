import { TFile } from "obsidian";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeviceSession } from "../src/auth/device-session";
import type { OAuthTransportResponse } from "../src/infrastructure/oauth-transport";
import VaultwirePlugin from "../src/main";
import { SyncStatusPanel } from "../src/status-panel";
import { CoexistenceController } from "../src/sync/coexistence";
import { DesktopSyncController } from "../src/sync/desktop-sync";
import { DeviceJournal } from "../src/sync/device-journal";
import { SyncTransportError } from "../src/sync/remote-text";
import {
	projectSyncStatus,
	type SyncStatusProjection,
} from "../src/sync/sync-status";

let activeElement: HTMLElement | null = null;

/** Minimal element model for panel rendering and keyboard-focus assertions. */
class FakeElement {
	textContent = "";
	hidden = false;
	disabled = false;
	type = "";
	readonly children: FakeElement[] = [];
	private readonly attributes = new Map<string, string>();
	private readonly listeners = new Map<string, () => void>();

	/** Creates one synthetic host element with DOM-like content state. */
	constructor(readonly tagName: string) {}

	/** Adds child nodes to this element in their rendered order. */
	append(...elements: FakeElement[]): void {
		this.children.push(...elements);
	}

	/** Replaces current children, matching the panel's refresh operation. */
	replaceChildren(...elements: FakeElement[]): void {
		this.children.splice(0, this.children.length, ...elements);
	}

	/** Stores one accessible attribute for later inspection. */
	setAttribute(name: string, value: string): void {
		this.attributes.set(name, value);
	}

	/** Reads one previously stored accessible attribute. */
	getAttribute(name: string): string | null {
		return this.attributes.get(name) ?? null;
	}

	/** Captures one DOM event callback for deterministic action tests. */
	addEventListener(name: string, listener: () => void): void {
		this.listeners.set(name, listener);
	}

	/** Runs one captured DOM event callback. */
	click(): void {
		this.listeners.get("click")?.();
	}

	/** Assigns keyboard focus to this synthetic element. */
	focus(): void {
		activeElement = this as unknown as HTMLElement;
	}

	/** Returns this subtree's button nodes for the panel's refresh focus lookup. */
	querySelectorAll(selector: string): NodeListOf<HTMLButtonElement> {
		const elements: FakeElement[] = [];
		if (selector === "button" && this.tagName === "button") elements.push(this);
		for (const child of this.children) {
			const nested = child.querySelectorAll(
				selector,
			) as unknown as FakeElement[];
			elements.push(...nested);
		}
		return elements as unknown as NodeListOf<HTMLButtonElement>;
	}

	/** Finds this element or a nested descendant by accessible label. */
	findButton(label: string): FakeElement | null {
		if (this.tagName === "button" && this.getAttribute("aria-label") === label)
			return this;
		for (const child of this.children) {
			const found = child.findButton(label);
			if (found) return found;
		}
		return null;
	}

	/** Reports whether this element owns the current focused node. */
	contains(element: HTMLElement | null): boolean {
		if (element === (this as unknown as HTMLElement)) return true;
		return this.children.some((child) => child.contains(element));
	}
}

const documentStub = {
	/** Returns the currently focused synthetic host node. */
	get activeElement(): HTMLElement | null {
		return activeElement;
	},
	/** Creates one fake element with the same tag used by the real panel. */
	createElement(tagName: string): FakeElement {
		return new FakeElement(tagName);
	},
};

/** Supplies the minimal safe status model needed by the visible panel. */
function makeStatus(): SyncStatusProjection {
	return {
		state: "pending",
		attention: [],
		coexistenceConfirmations: [],
		coexistenceEnabled: false,
		unavailablePaths: [],
		pendingPaths: [],
		capacity: "unknown",
		storageFailure: false,
		storageFailureStage: null,
		deleteResponseDiagnostic: null,
		failure: null,
		lastFailureAt: null,
		lastSuccessAt: null,
		counts: null,
		capacityWarnings: [],
	};
}

/** Opens a validated in-memory journal for real coexistence controller regressions. */
async function openJournal() {
	let persisted: unknown = null;
	return DeviceJournal.open({
		readState: async () => persisted,
		writeState: async (state) => {
			persisted = structuredClone(state);
		},
		readPayload: async () => new Uint8Array(),
		writePayload: async () => undefined,
	});
}

/** Projects durable controller state without granting it remote-head authority. */
function projectJournal(journal: Awaited<ReturnType<typeof openJournal>>) {
	return projectSyncStatus({
		state: journal.snapshot(),
		session: "connected",
		head: null,
		persisted: true,
		active: false,
		paused: false,
		revoked: false,
		coexistenceEnabled: true,
	});
}

/** Builds the synthetic authenticated transport response used by plugin composition tests. */
function makeTransportResponse(
	body: unknown,
	status = 200,
	extraHeaders: Record<string, string> = {},
): OAuthTransportResponse {
	return {
		status,
		headers: { "content-type": "application/json", ...extraHeaders },
		text: JSON.stringify(body),
	};
}

afterEach(() => {
	vi.unstubAllGlobals();
	activeElement = null;
});

describe("SyncStatusPanel", () => {
	it("shows stable dismiss actions for each attention item and bulk dismissal", () => {
		vi.stubGlobal("document", documentStub);
		const container = new FakeElement("div");
		const dismissed: string[] = [];
		let dismissAll = 0;
		const panel = new SyncStatusPanel({
			syncNow: () => undefined,
			pause: () => undefined,
			resume: () => undefined,
			reconnect: () => undefined,
			openPath: () => undefined,
			unsupportedFiles: () => [],
			excludedFiles: () => [],
			confirmCoexistence: () => undefined,
			keepServerState: () => undefined,
			dismissAttention: (key) => dismissed.push(key),
			dismissInformationalAttention: () => dismissAll++,
		});
		panel.render(container as unknown as HTMLElement, {
			...makeStatus(),
			attention: [
				{
					key: "stable-key-1",
					path: "notes/a.md",
					reason: "reason",
					informational: true,
					action: "open",
				},
				{
					key: "stable-key-2",
					path: "notes/a.md",
					reason: "other",
					informational: false,
					action: "open",
				},
			],
		});

		container.findButton("Dismiss notes/a.md: reason")?.click();
		container.findButton("Dismiss all informational attention")?.click();

		expect(dismissed).toEqual(["stable-key-1"]);
		expect(dismissAll).toBe(1);
	});

	it("opens only the indexed TFile through an Obsidian leaf", async () => {
		const plugin = new VaultwirePlugin({} as never, {} as never);
		const file = Object.assign(new TFile(), { path: "notes/indexed.md" });
		const opened: unknown[] = [];
		let createLeaf = false;
		Reflect.set(plugin, "app", {
			vault: { getAbstractFileByPath: () => file },
			workspace: {
				getLeaf: (newLeaf: boolean) => {
					createLeaf = newLeaf;
					return { openFile: async (value: unknown) => opened.push(value) };
				},
			},
		});

		await Reflect.apply(Reflect.get(plugin, "openAttentionPath"), plugin, [
			file.path,
		]);

		expect(createLeaf).toBe(true);
		expect(opened).toEqual([file]);
	});

	it.each([
		[".obsidian/plugins/test.md", "config"],
		["notes/missing.md", "missing"],
		["notes/folder", "folder"],
	])("shows a safe Open notice for %s", async (path) => {
		const plugin = new VaultwirePlugin({} as never, {} as never);
		const notices: string[] = [];
		const opened: unknown[] = [];
		Reflect.set(plugin, "app", {
			vault: {
				getAbstractFileByPath: (candidate: string) =>
					candidate === "notes/folder" ? { children: [] } : null,
			},
			workspace: {
				getLeaf: () => ({
					openFile: async (file: unknown) => opened.push(file),
				}),
			},
		});
		Reflect.set(plugin, "notice", (message: string) => notices.push(message));
		await Reflect.apply(Reflect.get(plugin, "openAttentionPath"), plugin, [
			path,
		]);

		expect(notices).toEqual([expect.stringContaining(path)]);
		expect(opened).toEqual([]);
	});
	it("keeps the active action focused after a status refresh", () => {
		vi.stubGlobal("document", documentStub);
		const container = new FakeElement("div");
		const panel = new SyncStatusPanel({
			syncNow: () => undefined,
			pause: () => undefined,
			resume: () => undefined,
			reconnect: () => undefined,
			openPath: () => undefined,
			unsupportedFiles: () => [],
			excludedFiles: () => [],
			confirmCoexistence: () => undefined,
			keepServerState: () => undefined,
			dismissAttention: () => undefined,
			dismissInformationalAttention: () => undefined,
		});
		panel.render(container as unknown as HTMLElement, makeStatus());
		container.findButton("Show unsupported files")?.focus();

		panel.render(container as unknown as HTMLElement, makeStatus());

		expect(activeElement).toBe(container.findButton("Show unsupported files"));
	});

	it("moves focus from Pause to Resume after a pause status refresh", () => {
		vi.stubGlobal("document", documentStub);
		const container = new FakeElement("div");
		const panel = new SyncStatusPanel({
			syncNow: () => undefined,
			pause: () => undefined,
			resume: () => undefined,
			reconnect: () => undefined,
			openPath: () => undefined,
			unsupportedFiles: () => [],
			excludedFiles: () => [],
			confirmCoexistence: () => undefined,
			keepServerState: () => undefined,
			dismissAttention: () => undefined,
			dismissInformationalAttention: () => undefined,
		});
		panel.render(container as unknown as HTMLElement, makeStatus());
		container.findButton("Pause")?.focus();

		panel.render(container as unknown as HTMLElement, {
			...makeStatus(),
			state: "paused",
		});

		expect(activeElement).toBe(container.findButton("Resume"));
	});

	it("tracks disclosure state on the file-list toggle", () => {
		vi.stubGlobal("document", documentStub);
		const container = new FakeElement("div");
		const panel = new SyncStatusPanel({
			syncNow: () => undefined,
			pause: () => undefined,
			resume: () => undefined,
			reconnect: () => undefined,
			openPath: () => undefined,
			unsupportedFiles: () => ["large.md"],
			excludedFiles: () => [],
			confirmCoexistence: () => undefined,
			keepServerState: () => undefined,
			dismissAttention: () => undefined,
			dismissInformationalAttention: () => undefined,
		});
		panel.render(container as unknown as HTMLElement, makeStatus());
		const button = container.findButton("Show unsupported files");

		expect(button?.getAttribute("aria-expanded")).toBe("false");
		button?.click();
		expect(button?.getAttribute("aria-expanded")).toBe("true");
		button?.click();
		expect(button?.getAttribute("aria-expanded")).toBe("false");
	});

	it("shows safe confirmation actions and the coexistence risk notice", () => {
		vi.stubGlobal("document", documentStub);
		const container = new FakeElement("div");
		const confirmed: string[] = [];
		const kept: string[] = [];
		const panel = new SyncStatusPanel({
			syncNow: () => undefined,
			pause: () => undefined,
			resume: () => undefined,
			reconnect: () => undefined,
			openPath: () => undefined,
			unsupportedFiles: () => [],
			excludedFiles: () => [],
			confirmCoexistence: (id) => confirmed.push(id),
			keepServerState: (id) => kept.push(id),
			dismissAttention: () => undefined,
			dismissInformationalAttention: () => undefined,
		});
		panel.render(container as unknown as HTMLElement, {
			...makeStatus(),
			coexistenceEnabled: true,
			unavailablePaths: ["notes/placeholder.md"],
			coexistenceConfirmations: [
				{
					id: "delete-id",
					kind: "delete",
					path: "notes/a.md",
					observed_epoch: null,
					observed_base: null,
					at: 1,
					unavailable: true,
					stale: true,
				},
				{
					id: "rename-id",
					kind: "rename",
					path: "notes/b.md",
					to: "notes/c.md",
					observed_epoch: null,
					observed_base: null,
					at: 2,
					unavailable: false,
					stale: false,
				},
			],
		});
		expect(
			container.children.some((child) =>
				child.textContent.includes(
					"iCloud and this plugin write the same files",
				),
			),
		).toBe(true);
		expect(
			container.children.some((child) =>
				child.textContent.includes("notes/placeholder.md: Unavailable"),
			),
		).toBe(true);
		expect(container.findButton("Confirm delete notes/a.md")?.disabled).toBe(
			true,
		);
		container.findButton("Keep server state notes/a.md")?.click();
		container.findButton("Confirm rename notes/b.md to notes/c.md")?.click();
		expect(kept).toEqual(["delete-id"]);
		expect(confirmed).toEqual(["rename-id"]);
	});

	it("renders bounded diagnostics and UTC cycle times without service measurements", () => {
		vi.stubGlobal("document", documentStub);
		const container = new FakeElement("div");
		const panel = new SyncStatusPanel({
			syncNow: () => undefined,
			pause: () => undefined,
			resume: () => undefined,
			reconnect: () => undefined,
			openPath: () => undefined,
			unsupportedFiles: () => [],
			excludedFiles: () => [],
			confirmCoexistence: () => undefined,
			keepServerState: () => undefined,
			dismissAttention: () => undefined,
			dismissInformationalAttention: () => undefined,
		});
		panel.render(container as unknown as HTMLElement, {
			...makeStatus(),
			failure: {
				transportClass: "4xx",
				code: "admission_limited",
				retryAfterSeconds: "30",
			},
			lastFailureAt: "2026-11-09T12:00:00.000Z",
			lastSuccessAt: "2026-11-09T11:59:00.000Z",
		});

		const rendered = container.children
			.map((child) => child.textContent)
			.join(" ");
		expect(rendered).toContain("4xx");
		expect(rendered).toContain("admission_limited");
		expect(rendered).toContain("retry in 30 s");
		expect(rendered).toContain("2026-11-09T12:00:00.000Z");
		expect(rendered).toContain("2026-11-09T11:59:00.000Z");
		expect(rendered).not.toContain("Service measurements");
	});

	it("shows a network class without any host failure detail", () => {
		vi.stubGlobal("document", documentStub);
		const container = new FakeElement("div");
		const panel = new SyncStatusPanel({
			syncNow: () => undefined,
			pause: () => undefined,
			resume: () => undefined,
			reconnect: () => undefined,
			openPath: () => undefined,
			unsupportedFiles: () => [],
			excludedFiles: () => [],
			confirmCoexistence: () => undefined,
			keepServerState: () => undefined,
			dismissAttention: () => undefined,
			dismissInformationalAttention: () => undefined,
		});
		panel.render(container as unknown as HTMLElement, {
			...makeStatus(),
			failure: {
				transportClass: "network",
				code: null,
				retryAfterSeconds: null,
			},
		});

		const rendered = container.children
			.map((child) => child.textContent)
			.join(" ");
		expect(rendered).toContain("network");
		expect(rendered).not.toContain("retry in");
		expect(rendered).not.toContain("private.test");
		expect(rendered).not.toContain("secret");
	});

	it("renders bounded retry timing from a real failed sync cycle", async () => {
		vi.stubGlobal("document", documentStub);
		const container = new FakeElement("div");
		const failure: { value: SyncTransportError | null } = { value: null };
		let shouldFail = true;
		const controller = new DesktopSyncController({
			cycle: async () => {
				if (shouldFail)
					throw new SyncTransportError(429, "admission_limited", null, "30");
			},
			host: {
				setTimeout: () => 1,
				clearTimeout: () => undefined,
				setInterval: () => 1,
				clearInterval: () => undefined,
			},
			onError: (error) => {
				if (error instanceof SyncTransportError) failure.value = error;
			},
		});
		await controller.syncNow().catch(() => undefined);
		await controller.waitForIdle();
		if (!failure.value)
			throw new Error("Sync controller did not report its failure");
		const status = projectSyncStatus({
			state: await openJournal().then((journal) => journal.snapshot()),
			session: "connected",
			head: null,
			persisted: true,
			active: false,
			failure: {
				transportClass: "4xx",
				code: failure.value.code,
				retryAfterSeconds: failure.value.retryAfter,
			},
			paused: false,
			revoked: false,
		});
		new SyncStatusPanel({
			syncNow: () => undefined,
			pause: () => undefined,
			resume: () => undefined,
			reconnect: () => undefined,
			openPath: () => undefined,
			unsupportedFiles: () => [],
			excludedFiles: () => [],
			confirmCoexistence: () => undefined,
			keepServerState: () => undefined,
			dismissAttention: () => undefined,
			dismissInformationalAttention: () => undefined,
		}).render(container as unknown as HTMLElement, status);

		const failureParagraph = container.children.find((child) =>
			child.textContent.includes("Sync request failed."),
		);
		expect(failureParagraph?.textContent).toContain("4xx");
		expect(failureParagraph?.textContent).toContain("admission_limited");
		expect(failureParagraph?.textContent).toContain("retry in 30 s");
		shouldFail = false;
		await controller.syncNow();
		const recovered = projectSyncStatus({
			state: await openJournal().then((journal) => journal.snapshot()),
			session: "connected",
			head: null,
			persisted: true,
			active: false,
			failure: null,
			paused: false,
			revoked: false,
		});
		new SyncStatusPanel({
			syncNow: () => undefined,
			pause: () => undefined,
			resume: () => undefined,
			reconnect: () => undefined,
			openPath: () => undefined,
			unsupportedFiles: () => [],
			excludedFiles: () => [],
			confirmCoexistence: () => undefined,
			keepServerState: () => undefined,
			dismissAttention: () => undefined,
			dismissInformationalAttention: () => undefined,
		}).render(container as unknown as HTMLElement, recovered);
		expect(
			container.children.some((child) =>
				child.textContent.includes("retry in"),
			),
		).toBe(false);
	});

	it("projects and renders live composition state through a 429 failure and recovery", async () => {
		vi.stubGlobal("window", {
			setTimeout: () => 1,
			clearTimeout: () => undefined,
			setInterval: () => 2,
			clearInterval: () => undefined,
			addEventListener: () => undefined,
			removeEventListener: () => undefined,
		});
		vi.stubGlobal("document", {
			...documentStub,
			visibilityState: "visible",
			hasFocus: () => true,
			addEventListener: () => undefined,
			removeEventListener: () => undefined,
		});
		const plugin = new VaultwirePlugin({} as never, {} as never);
		const journal = await openJournal();
		let rejectNextSummary = true;
		const session = {
			requestResponse: async (url: string): Promise<OAuthTransportResponse> => {
				const path = new URL(url).pathname;
				if (path === "/v1/vault" && rejectNextSummary) {
					rejectNextSummary = false;
					return makeTransportResponse(
						{
							error: "admission_limited",
							message: "The vault cannot accept another operation now.",
						},
						429,
						{ "retry-after": "30" },
					);
				}
				if (path === "/v1/vault")
					return makeTransportResponse({
						epoch: "c".repeat(32),
						head_seq: 0,
						counts: { live: 0, deleted: 0 },
						limits: {
							manifest_page: 256,
							feed_page: 1000,
							text_bytes: 1_000_000,
							blob_bytes: 25_000_000,
						},
						capacity: {
							database_bytes: 512,
							database_limit_bytes: 2_000_000_000,
							live_file_limit: 10_000,
							history_pressure_bytes: 0,
							referenced_blob_bytes: 0,
						},
						attention: [],
					});
				if (path === "/v1/manifest")
					return makeTransportResponse({
						epoch: "c".repeat(32),
						head_seq: 0,
						entries: [],
						next_page: null,
					});
				if (path === "/v1/changes")
					return makeTransportResponse({
						epoch: "c".repeat(32),
						head_seq: 0,
						entries: [],
					});
				throw new Error(`Unexpected status test request: ${path}`);
			},
			close: () => undefined,
		};
		const vault = {
			getFiles: () => [],
			getAbstractFileByPath: () => null,
			on: () => ({}),
			offref: () => undefined,
			adapter: {
				stat: async () => null,
				list: async () => ({ files: [], folders: [] }),
				readBinary: async () => new ArrayBuffer(0),
				writeBinary: async () => undefined,
				remove: async () => undefined,
			},
		};
		Reflect.set(plugin, "app", { vault });
		Reflect.set(plugin, "journal", journal);
		Reflect.set(plugin, "session", session as unknown as DeviceSession);
		Reflect.set(plugin, "sessionStatus", "connected");
		/** Reads the projection created by the real plugin composition owner. */
		const getStatus = (): SyncStatusProjection | null =>
			Reflect.apply(
				Reflect.get(plugin, "syncStatus") as () => SyncStatusProjection | null,
				plugin,
				[],
			);
		const container = new FakeElement("div");
		const panel = new SyncStatusPanel({
			syncNow: () => undefined,
			pause: () => undefined,
			resume: () => undefined,
			reconnect: () => undefined,
			openPath: () => undefined,
			unsupportedFiles: () => [],
			excludedFiles: () => [],
			confirmCoexistence: () => undefined,
			keepServerState: () => undefined,
			dismissAttention: () => undefined,
			dismissInformationalAttention: () => undefined,
		});
		/** Renders the plugin's current composed projection and returns that projection. */
		const render = () => {
			const status = getStatus();
			if (!status) throw new Error("Plugin status projection was unavailable");
			panel.render(container as unknown as HTMLElement, status);
			return status;
		};

		const unknown = render();
		expect(unknown).not.toHaveProperty("backup");
		expect(unknown.capacity).toBe("unknown");
		expect(container.children.map((child) => child.textContent)).toContain(
			"Capacity: unknown.",
		);
		expect(
			container.children.some((child) => child.textContent.includes("Backup:")),
		).toBe(false);

		Reflect.apply(Reflect.get(plugin, "startSync") as () => void, plugin, []);
		const controller = Reflect.get(
			plugin,
			"desktopSync",
		) as DesktopSyncController;
		await controller.waitForIdle();
		const failed = render();
		expect(failed.failure).toEqual({
			transportClass: "4xx",
			code: "admission_limited",
			retryAfterSeconds: "30",
		});
		const failureParagraph = container.children.find((child) =>
			child.textContent.includes("Sync request failed."),
		);
		expect(failureParagraph?.textContent).toContain("4xx");
		expect(failureParagraph?.textContent).toContain("admission_limited");
		expect(failureParagraph?.textContent).toContain("retry in 30 s");

		await controller.syncNow();
		const recovered = render();
		expect(recovered.failure).toBeNull();
		expect(recovered.capacity).toEqual({ used: 512, limit: 2_000_000_000 });
		expect(container.children.map((child) => child.textContent)).toContain(
			"Capacity: 512 of 2000000000 bytes used.",
		);
		expect(
			container.children.some((child) =>
				child.textContent.includes("retry in"),
			),
		).toBe(false);
		expect(
			container.children.some((child) => child.textContent.includes("Backup:")),
		).toBe(false);
		plugin.onunload();
	});

	it("shows both coexistence counts when either controller count is non-zero", async () => {
		vi.stubGlobal("document", documentStub);
		const journal = await openJournal();
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
		const container = new FakeElement("div");
		/** Renders the current durable controller state in the panel. */
		const render = () =>
			new SyncStatusPanel({
				syncNow: () => undefined,
				pause: () => undefined,
				resume: () => undefined,
				reconnect: () => undefined,
				openPath: () => undefined,
				unsupportedFiles: () => [],
				excludedFiles: () => [],
				confirmCoexistence: () => undefined,
				keepServerState: () => undefined,
				dismissAttention: () => undefined,
				dismissInformationalAttention: () => undefined,
			}).render(container as unknown as HTMLElement, projectJournal(journal));
		/** Finds the single optional coexistence count paragraph. */
		const summary = () =>
			container.children.filter((child) =>
				child.textContent.startsWith("Coexistence confirmations:"),
			);

		await controller.observe({ type: "delete", path: "notes/confirm.md" });
		unavailable.add("notes/placeholder.md");
		await controller.observe({
			type: "create",
			path: "notes/placeholder.md.icloud",
		});
		render();
		expect(summary()).toHaveLength(1);
		expect(summary()[0]?.textContent).toBe(
			"Coexistence confirmations: 1. Unavailable paths: 1.",
		);
		expect(
			container.findButton("Confirm delete notes/confirm.md")?.disabled,
		).toBe(true);

		await controller.keepServerState(
			journal.snapshot().coexistence_confirmations[0]?.id ?? "missing",
		);
		render();
		expect(summary()).toHaveLength(1);
		expect(summary()[0]?.textContent).toBe(
			"Coexistence confirmations: 0. Unavailable paths: 1.",
		);
		unavailable.delete("notes/placeholder.md");
		await controller.observe({
			type: "create",
			path: "notes/placeholder.md.icloud",
		});
		render();
		expect(summary()).toHaveLength(0);
	});

	it("shows confirmation-only counts and clears the summary when durable state clears", async () => {
		vi.stubGlobal("document", documentStub);
		const journal = await openJournal();
		const controller = new CoexistenceController(
			journal,
			{ isUnavailable: async () => false, size: async () => null },
			() => true,
			() => 100,
		);
		const container = new FakeElement("div");
		/** Renders the current durable controller state in the panel. */
		const render = () =>
			new SyncStatusPanel({
				syncNow: () => undefined,
				pause: () => undefined,
				resume: () => undefined,
				reconnect: () => undefined,
				openPath: () => undefined,
				unsupportedFiles: () => [],
				excludedFiles: () => [],
				confirmCoexistence: () => undefined,
				keepServerState: () => undefined,
				dismissAttention: () => undefined,
				dismissInformationalAttention: () => undefined,
			}).render(container as unknown as HTMLElement, projectJournal(journal));

		await controller.observe({
			type: "rename",
			path: "notes/a.md",
			to: "notes/b.md",
		});
		render();
		expect(
			container.children.filter((child) =>
				child.textContent.startsWith("Coexistence confirmations:"),
			),
		).toHaveLength(1);
		expect(
			container.children.find((child) =>
				child.textContent.startsWith("Coexistence confirmations:"),
			)?.textContent,
		).toBe("Coexistence confirmations: 1. Unavailable paths: 0.");
		await controller.keepServerState(
			journal.snapshot().coexistence_confirmations[0]?.id ?? "missing",
		);
		render();
		expect(
			container.children.some((child) =>
				child.textContent.startsWith("Coexistence confirmations:"),
			),
		).toBe(false);
	});

	it("does not render a Rebuild action", () => {
		vi.stubGlobal("document", documentStub);
		const container = new FakeElement("div");
		const panel = new SyncStatusPanel({
			syncNow: () => undefined,
			pause: () => undefined,
			resume: () => undefined,
			reconnect: () => undefined,
			openPath: () => undefined,
			unsupportedFiles: () => [],
			excludedFiles: () => [],
			confirmCoexistence: () => undefined,
			keepServerState: () => undefined,
			dismissAttention: () => undefined,
			dismissInformationalAttention: () => undefined,
		});
		panel.render(container as unknown as HTMLElement, makeStatus());

		expect(container.findButton("Rebuild local index")).toBeNull();
		expect(
			container.children.some(
				(child) => child.textContent === "Capacity: unknown.",
			),
		).toBe(true);
		expect(
			container.children.some((child) => child.textContent.includes("Backup:")),
		).toBe(false);
		panel.render(container as unknown as HTMLElement, {
			...makeStatus(),
			capacity: { used: 512, limit: 4096 },
		});
		expect(
			container.children.some(
				(child) => child.textContent === "Capacity: 512 of 4096 bytes used.",
			),
		).toBe(true);
	});
});
