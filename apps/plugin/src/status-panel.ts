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
	/** Transfers one exact durable observation into the outgoing operation queue. */
	confirmCoexistence(id: string): void;
	/** Clears one decision without changing the server or unavailable-path state. */
	keepServerState(id: string): void;
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
		if (status.coexistenceEnabled) {
			const risk = document.createElement("p");
			risk.textContent =
				"iCloud and this plugin write the same files. Text hash checks protect concurrent edits. Binary writes have a best-effort protection window.";
			container.append(risk);
		}
		for (const path of status.unavailablePaths) {
			const unavailable = document.createElement("p");
			unavailable.textContent = `${path}: Unavailable while iCloud holds a placeholder.`;
			container.append(unavailable);
		}
		for (const confirmation of status.coexistenceConfirmations) {
			const description = document.createElement("p");
			description.textContent = confirmation.unavailable
				? `${confirmation.path}: Unavailable while iCloud holds a placeholder.`
				: confirmation.stale
					? `${confirmation.path}: ${confirmation.stale_reason ?? "Original revision is no longer current."}`
					: confirmation.kind === "rename"
						? `${confirmation.path} to ${confirmation.to}`
						: confirmation.path;
			container.append(description);
			if (confirmation.kind === "delete")
				this.addButton(
					container,
					`Confirm delete ${confirmation.path}`,
					() => this.actions.confirmCoexistence(confirmation.id),
					`coexistence-${confirmation.id}`,
					confirmation.unavailable || confirmation.stale,
				);
			else
				this.addButton(
					container,
					`Confirm rename ${confirmation.path} to ${confirmation.to}`,
					() => this.actions.confirmCoexistence(confirmation.id),
					`coexistence-${confirmation.id}`,
					confirmation.unavailable || confirmation.stale,
				);
			this.addButton(container, `Keep server state ${confirmation.path}`, () =>
				this.actions.keepServerState(confirmation.id),
			);
		}
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
			const details: string[] = [status.failure.transportClass];
			if (status.failure.code) details.push(status.failure.code);
			if (status.failure.retryAfterSeconds)
				details.push(`retry in ${status.failure.retryAfterSeconds} seconds`);
			failure.textContent = `Sync request failed. ${details.join(". ")}.`;
			container.append(failure);
		}
		if (status.lastFailureAt) {
			const lastFailure = document.createElement("p");
			lastFailure.textContent = `Last sync failure (UTC): ${status.lastFailureAt}`;
			container.append(lastFailure);
		}
		if (status.lastSuccessAt) {
			const lastSuccess = document.createElement("p");
			lastSuccess.textContent = `Last successful sync (UTC): ${status.lastSuccessAt}`;
			container.append(lastSuccess);
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
		disabled = false,
	): void {
		const button = document.createElement("button");
		button.type = "button";
		button.textContent = label;
		button.setAttribute("aria-label", label);
		button.setAttribute("data-focus-id", focusId);
		button.disabled = disabled;
		button.addEventListener("click", action);
		container.append(button);
	}
}
