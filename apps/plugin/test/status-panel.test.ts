import { afterEach, describe, expect, it, vi } from "vitest";
import { SyncStatusPanel } from "../src/status-panel";
import type { SyncStatusProjection } from "../src/sync/sync-status";

let activeElement: HTMLElement | null = null;

/** Minimal element model for panel rendering and keyboard-focus assertions. */
class FakeElement {
	textContent = "";
	hidden = false;
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
		pendingPaths: [],
		backup: "unknown",
		capacity: "unknown",
		storageFailure: false,
		storageFailureStage: null,
		failure: null,
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
		});
		panel.render(container as unknown as HTMLElement, makeStatus());
		const button = container.findButton("Show unsupported files");

		expect(button?.getAttribute("aria-expanded")).toBe("false");
		button?.click();
		expect(button?.getAttribute("aria-expanded")).toBe("true");
		button?.click();
		expect(button?.getAttribute("aria-expanded")).toBe("false");
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
		});
		panel.render(container as unknown as HTMLElement, makeStatus());

		expect(container.findButton("Rebuild local index")).toBeNull();
	});
});
