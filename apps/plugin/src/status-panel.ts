import type { SyncStatusProjection } from "@plugin/sync/sync-status";

/** Keyboard actions the status panel can request from its lifecycle owner. */
export interface SyncStatusActions {
	/** Starts one immediate serialized recovery and sync cycle. */
	syncNow(): void;
	/** Fences polling and effect admission while retaining queued event intent. */
	pause(): void;
	/** Waits for prior work and resumes queued event intent and recovery. */
	resume(): void;
	/** Starts browser authorization for a revoked or disconnected device. */
	reconnect(): void;
	/** Opens a local path without changing its synchronization authority. */
	openPath(path: string): void;
	/** Lists too-large in-scope paths only after the owner asks to see them. */
	unsupportedFiles(): string[];
	/** Lists excluded vault paths only after the owner asks to see them. */
	excludedFiles(): string[];
}

/** Renders plain-text sync state and labelled actions without owning sync effects. */
export class SyncStatusPanel {
	/** Creates no host resources until render receives an Obsidian-owned element. */
	constructor(private readonly actions: SyncStatusActions) {}

	/** Replaces panel content with current safe status and keyboard-operable controls. */
	render(container: HTMLElement, status: SyncStatusProjection): void {
		const active = document.activeElement;
		const activeFocusId =
			active?.tagName.toUpperCase() === "BUTTON" && container.contains(active)
				? (active.getAttribute("data-focus-id") ??
					active.getAttribute("aria-label"))
				: null;
		container.replaceChildren();
		const heading = document.createElement("h3");
		heading.textContent = `Sync status: ${status.state}`;
		container.append(heading);
		const telemetry = document.createElement("p");
		telemetry.textContent = `Backup: ${status.backup}. Capacity: ${typeof status.capacity === "string" ? status.capacity : `${status.capacity.used} of ${status.capacity.limit} bytes used`}.`;
		container.append(telemetry);
		if (status.counts) {
			const counts = document.createElement("p");
			counts.textContent = `Server files: ${status.counts.live} live, ${status.counts.deleted} deleted.`;
			container.append(counts);
		}
		for (const warning of status.capacityWarnings) {
			const warningText = document.createElement("p");
			warningText.textContent = `Server capacity warning: ${warning}`;
			container.append(warningText);
		}
		if (status.failure) {
			const failure = document.createElement("p");
			failure.textContent = status.failure;
			container.append(failure);
		}
		if (status.storageFailure) {
			const failure = document.createElement("p");
			failure.textContent =
				"Local sync state could not be verified. Publishing is paused.";
			container.append(failure);
		}
		this.addButton(container, "Sync now", () => this.actions.syncNow());
		this.addButton(
			container,
			status.state === "paused" ? "Resume" : "Pause",
			() =>
				status.state === "paused"
					? this.actions.resume()
					: this.actions.pause(),
			"pause-resume",
		);
		if (status.state === "revoked" || status.state === "disconnected")
			this.addButton(container, "Reconnect", () => this.actions.reconnect());
		this.addFileList(container, "Show unsupported files", () =>
			this.actions.unsupportedFiles(),
		);
		this.addFileList(container, "Show excluded files", () =>
			this.actions.excludedFiles(),
		);
		for (const path of status.pendingPaths)
			this.addButton(container, `Open pending file ${path}`, () =>
				this.actions.openPath(path),
			);
		for (const item of status.attention) {
			const detail = document.createElement("p");
			detail.textContent = `${item.path}: ${item.reason}`;
			container.append(detail);
			this.addButton(container, `Open ${item.path}`, () =>
				this.actions.openPath(item.path),
			);
		}
		if (activeFocusId) {
			const replacement = Array.from(container.querySelectorAll("button")).find(
				(button) => button.getAttribute("data-focus-id") === activeFocusId,
			);
			replacement?.focus();
		}
	}

	/** Shows one requested file category as plain text without treating files as sync authority. */
	private addFileList(
		container: HTMLElement,
		label: string,
		getPaths: () => string[],
	): void {
		const button = document.createElement("button");
		button.type = "button";
		button.textContent = label;
		button.setAttribute("aria-label", label);
		button.setAttribute("data-focus-id", label);
		button.setAttribute("aria-expanded", "false");
		const list = document.createElement("ul");
		list.hidden = true;
		button.addEventListener("click", () => {
			list.replaceChildren();
			for (const path of getPaths()) {
				const item = document.createElement("li");
				item.textContent = path;
				list.append(item);
			}
			list.hidden = !list.hidden;
			button.setAttribute("aria-expanded", String(!list.hidden));
		});
		container.append(button, list);
	}

	/** Adds one labelled action with stable identity across status-driven label changes. */
	private addButton(
		container: HTMLElement,
		label: string,
		action: () => void,
		focusId = label,
	): void {
		const button = document.createElement("button");
		button.type = "button";
		button.textContent = label;
		button.setAttribute("aria-label", label);
		button.setAttribute("data-focus-id", focusId);
		button.addEventListener("click", action);
		container.append(button);
	}
}
