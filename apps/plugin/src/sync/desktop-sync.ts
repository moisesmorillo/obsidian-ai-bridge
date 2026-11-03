import type { PublicationEvent } from "@plugin/sync/publication";

/** Host-owned timer functions used to test scheduling without platform globals. */
export interface DesktopSyncHost {
	/** Schedules one-shot work in milliseconds and returns its host handle. */
	setTimeout(callback: () => void, delay: number): number;
	/** Cancels one one-shot callback by its returned handle. */
	clearTimeout(handle: number): void;
	/** Schedules recurring work in milliseconds and returns its host handle. */
	setInterval(callback: () => void, delay: number): number;
	/** Cancels one recurring callback by its returned handle. */
	clearInterval(handle: number): void;
	/** Reports whether foreground polling can use the visible-window budget. */
	isVisible?(): boolean;
	/** Reports host suspension, which disables polling until a later resume trigger. */
	isSuspended?(): boolean;
}

/** Serialized effect boundary shared by polling, explicit commands, and events. */
export interface DesktopSyncOptions {
	/** Runs shared recovery, scan, publication, and feed effects as one cycle. */
	cycle(): Promise<void>;
	/** Runs complete manifest reconciliation for the explicit rebuild command. */
	rebuild?(): Promise<void>;
	/** Admits explicit local event intent before the next full sync cycle. */
	onEvent?(event: PublicationEvent): Promise<void>;
	/** Owns platform timer and foreground-state capabilities. */
	host: DesktopSyncHost;
	/** Receives fixed-policy failures without forcing a successful cycle. */
	onError?(error: unknown): void;
	/** Refreshes presentation when local intent or lifecycle activity changes. */
	onStateChanged?(): void;
}

/** Owns one serialized desktop loop and queues explicit local intent while paused. */
export class DesktopSyncController {
	private tail: Promise<void> = Promise.resolve();
	private events: PublicationEvent[] = [];
	private interval: number | null = null;
	private debounce: number | null = null;
	private closed = false;
	private paused = false;
	private started = false;
	private activeSince: number | null = null;
	private cyclePromise: Promise<void> | null = null;
	private workActive = false;

	/** True while a cycle, event debounce, or retained local intent blocks settlement. */
	get isBusy(): boolean {
		return (
			this.workActive ||
			this.cyclePromise !== null ||
			this.events.length > 0 ||
			this.debounce !== null
		);
	}

	/** Binds effects to one host lifecycle; closing fences later work but cannot cancel started effects. */
	constructor(private readonly options: DesktopSyncOptions) {}

	/** Starts immediate recovery and installs host polling exactly once. */
	start(): Promise<void> {
		if (this.closed) return Promise.resolve();
		if (!this.started) {
			this.started = true;
			this.schedulePolling();
		}
		return this.syncNow();
	}

	/** Adds one cycle to the lifecycle queue. Concurrent requests share that queued cycle. */
	syncNow(): Promise<void> {
		if (this.closed || this.paused) return Promise.resolve();
		if (this.events.length > 0) {
			if (this.debounce !== null) this.options.host.clearTimeout(this.debounce);
			this.debounce = null;
			return this.drainEvents();
		}
		if (this.cyclePromise) return this.cyclePromise;
		const run = this.tail.then(async () => {
			if (this.closed || this.paused) return;
			await this.options.cycle();
		});
		this.workActive = true;
		this.options.onStateChanged?.();
		const shared = run.finally(() => {
			this.workActive = false;
			this.options.onStateChanged?.();
		});
		this.cyclePromise = shared;
		this.tail = shared
			.catch((error: unknown) => {
				this.options.onError?.(error);
			})
			.finally(() => {
				if (this.cyclePromise === shared) this.cyclePromise = null;
			});
		return shared;
	}

	/** Saves local event intent in order without running network or apply effects while paused. */
	observe(event: PublicationEvent): Promise<void> {
		if (this.closed) return Promise.resolve();
		this.activeSince = Date.now();
		if (this.paused) {
			this.events.push(event);
			this.options.onStateChanged?.();
			return Promise.resolve();
		}
		this.schedulePolling();
		if (this.debounce !== null) this.options.host.clearTimeout(this.debounce);
		this.events.push(event);
		this.debounce = this.options.host.setTimeout(() => {
			this.debounce = null;
			this.options.onStateChanged?.();
			void this.drainEvents().catch((error: unknown) =>
				this.options.onError?.(error),
			);
		}, 2_000);
		this.options.onStateChanged?.();
		return Promise.resolve();
	}

	/** Fences scheduled work while retaining every not-yet-admitted local event. */
	pause(): void {
		if (this.closed || this.paused) return;
		this.paused = true;
		this.clearTimers();
		this.options.onStateChanged?.();
	}

	/** Waits for old serialized work, then replays saved intent before immediate recovery. */
	async resume(): Promise<void> {
		if (this.closed) return;
		this.paused = false;
		this.options.onStateChanged?.();
		await this.tail;
		const hasEvents = this.events.length > 0;
		await this.drainEvents();
		if (!hasEvents) await this.start();
	}

	/** Reschedules the host budget and triggers immediate recovery when the window becomes visible. */
	visibilityChanged(): Promise<void> {
		if (this.closed || this.paused) return Promise.resolve();
		this.schedulePolling();
		return this.options.host.isVisible?.() === false
			? Promise.resolve()
			: this.syncNow();
	}

	/** Waits until all work admitted before the call settles after close fences new work. */
	async waitForIdle(): Promise<void> {
		await this.tail;
	}

	/** Rebuilds through the caller's full reconciliation cycle. */
	rebuild(): Promise<void> {
		if (this.closed || this.paused) return Promise.resolve();
		const run = this.tail.then(async () => {
			if (this.closed || this.paused) return;
			this.workActive = true;
			this.options.onStateChanged?.();
			try {
				await (this.options.rebuild ?? this.options.cycle)();
			} finally {
				this.workActive = false;
				this.options.onStateChanged?.();
			}
		});
		this.tail = run.catch((error: unknown) => this.options.onError?.(error));
		return run;
	}

	/** Closes timer ownership immediately and lets already-started work settle. */
	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.clearTimers();
	}

	/** Routes retained events through the same queue as sync cycles. */
	private drainEvents(): Promise<void> {
		if (this.closed || this.paused || this.events.length === 0)
			return Promise.resolve();
		const events = this.events.splice(0);
		this.workActive = true;
		this.options.onStateChanged?.();
		const run = this.tail.then(async () => {
			let admitted = 0;
			let requeued = false;
			try {
				if (this.closed || this.paused) return;
				for (const event of events) {
					if (this.closed || this.paused) return;
					await this.options.onEvent?.(event);
					admitted += 1;
				}
				await this.options.cycle();
			} catch (error) {
				this.events = [...events.slice(admitted), ...this.events];
				requeued = true;
				this.options.onError?.(error);
			} finally {
				if ((this.closed || this.paused) && !requeued)
					this.events = [...events.slice(admitted), ...this.events];
				this.workActive = false;
				this.options.onStateChanged?.();
			}
		});
		this.tail = run.catch((error: unknown) => {
			this.options.onError?.(error);
		});
		return run;
	}

	/** Chooses one poll interval from visibility and recent foreground activity. */
	private schedulePolling(): void {
		if (this.closed || this.paused || this.options.host.isSuspended?.()) return;
		if (this.interval !== null) this.options.host.clearInterval(this.interval);
		const visible = this.options.host.isVisible?.() ?? true;
		const now = Date.now();
		const recentlyActive =
			visible && this.activeSince !== null && now - this.activeSince < 300_000;
		const delay = visible ? (recentlyActive ? 15_000 : 60_000) : 300_000;
		this.interval = this.options.host.setInterval(() => {
			this.schedulePolling();
			void this.syncNow().catch((error: unknown) =>
				this.options.onError?.(error),
			);
		}, delay);
	}

	/** Releases both scheduled callback handles once per close or pause transition. */
	private clearTimers(): void {
		if (this.interval !== null) this.options.host.clearInterval(this.interval);
		if (this.debounce !== null) this.options.host.clearTimeout(this.debounce);
		this.interval = null;
		this.debounce = null;
	}
}
