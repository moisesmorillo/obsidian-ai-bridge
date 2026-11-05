import { afterEach, describe, expect, it, vi } from "vitest";
import { SyncStatusPanel } from "../src/status-panel";
import type { SyncStatusProjection } from "../src/sync/sync-status";

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
		backup: "unknown",
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

afterEach(() => {
	vi.unstubAllGlobals();
	activeElement = null;
});

describe("SyncStatusPanel", () => {
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
		expect(rendered).toContain("30 seconds");
		expect(rendered).toContain("2026-11-09T12:00:00.000Z");
		expect(rendered).toContain("2026-11-09T11:59:00.000Z");
		expect(rendered).not.toContain("Service measurements");
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
		});
		panel.render(container as unknown as HTMLElement, makeStatus());

		expect(container.findButton("Rebuild local index")).toBeNull();
	});
});
