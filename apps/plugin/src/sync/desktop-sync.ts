import { classifyEnrollmentPath } from "@plugin/sync/enrollment-scope";
import type { PublicationEvent } from "@plugin/sync/publication";

/** Excludes canonical path failures before they enter the retry queue. */
function isTerminallyExcluded(event: PublicationEvent): boolean {
	return (
		classifyEnrollmentPath(event.path, 0) === "excluded" ||
		(event.type === "rename" &&
			classifyEnrollmentPath(event.to, 0) === "excluded")
	);
}

/** Resolves whether observed bytes support one accepted plugin effect. */
export type PluginOriginProof = Promise<boolean>;

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
	/** Persists high-risk local intent before debounce or Pause can delay admission. */
	onCaptureEvent?(event: PublicationEvent): Promise<boolean>;
	/** Blocks cycle and event admission while captured intent awaits an owner decision. */
	isEffectBlocked?(): boolean;
	/** Admits explicit local event intent before the next full sync cycle. */
	onEvent?(event: PublicationEvent): Promise<void>;
	/** Owns platform timer and foreground-state capabilities. */
	host: DesktopSyncHost;
	/** Receives fixed-policy failures without forcing a successful cycle. */
	onError?(error: unknown): void;
	/** Refreshes presentation when local intent or lifecycle activity changes. */
	onStateChanged?(): void;
}

/** Owns one serialized sync loop and separates host suspension from user Pause. */
export class DesktopSyncController {
	private tail: Promise<void> = Promise.resolve();
	private events: PublicationEvent[] = [];
	private interval: number | null = null;
	private debounce: number | null = null;
	private closed = false;
	private paused = false;
	private suspended = false;
	private recoveryPromise: {
		revision: number;
		promise: Promise<void>;
	} | null = null;
	private drainPromise: Promise<void> | null = null;
	private started = false;
	private activeSince: number | null = null;
	private cyclePromise: Promise<void> | null = null;
	private workActive = false;
	private activityRevision = 0;
	private lifecycleRevision = 0;

	/** True while capture, cycle, debounce, or retained intent blocks settlement. Cadence-only proof does not block it. */
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

	/** Installs polling on first start and requests immediate recovery. */
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
		if (
			this.closed ||
			this.paused ||
			this.isSuspended() ||
			this.isEffectBlocked()
		)
			return Promise.resolve();
		if (this.events.length > 0) {
			if (this.debounce !== null) this.options.host.clearTimeout(this.debounce);
			this.debounce = null;
			return this.drainEvents();
		}
		if (this.cyclePromise) return this.cyclePromise;
		const run = this.tail.then(async () => {
			if (
				this.closed ||
				this.paused ||
				this.isSuspended() ||
				this.isEffectBlocked()
			)
				return;
			await this.options.cycle();
		});
		this.workActive = true;
		this.options.onStateChanged?.();
		let shared: Promise<void>;
		shared = run.finally(() => {
			this.workActive = false;
			if (this.cyclePromise === shared) this.cyclePromise = null;
			this.options.onStateChanged?.();
		});
		this.cyclePromise = shared;
		this.tail = shared.catch((error: unknown) => {
			this.options.onError?.(error);
		});
		return shared;
	}

	/**
	 * Captures, retains, and schedules an event before asynchronous origin proof can finish.
	 * Proof may revise only this event's activity timestamp in the same lifecycle.
	 */
	async observe(
		event: PublicationEvent,
		originProof?: PluginOriginProof,
	): Promise<void> {
		if (this.closed) return;
		this.workActive = true;
		this.options.onStateChanged?.();
		let captured = false;
		try {
			captured = (await this.options.onCaptureEvent?.(event)) ?? false;
		} catch (error) {
			this.events.push(event);
			this.workActive = false;
			this.options.onStateChanged?.();
			this.options.onError?.(error);
			return;
		}
		if (captured || this.closed || isTerminallyExcluded(event)) {
			this.workActive = false;
			this.options.onStateChanged?.();
			return;
		}

		const previousActivity = this.activeSince;
		this.activeSince = Date.now();
		const activityRevision = ++this.activityRevision;
		const lifecycleRevision = this.lifecycleRevision;
		if (this.paused || this.isSuspended()) {
			this.events.push(event);
		} else {
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
		}
		this.workActive = false;
		this.options.onStateChanged?.();
		if (originProof)
			this.reviseActivityFromProof(
				originProof,
				previousActivity,
				activityRevision,
				lifecycleRevision,
			);
	}

	/** Fences scheduled work while retaining every not-yet-admitted local event. */
	pause(): void {
		if (this.closed || this.paused) return;
		this.paused = true;
		this.lifecycleRevision += 1;
		this.clearTimers();
		this.options.onStateChanged?.();
	}

	/** Clears user Pause, then recovers only after admitted work settles and lifecycle fences remain current. */
	async resume(): Promise<void> {
		if (this.closed) return;
		if (this.paused) {
			this.paused = false;
			this.lifecycleRevision += 1;
			this.options.onStateChanged?.();
		}
		if (this.isSuspended()) return;
		await this.recoverAfterLifecycleChange();
	}

	/** Clears timers while host-suspended and recovers queued work when the host resumes. */
	visibilityChanged(): Promise<void> {
		if (this.closed) return Promise.resolve();
		if (this.options.host.isSuspended?.()) {
			this.suspend();
			return Promise.resolve();
		}
		if (this.suspended) {
			this.suspended = false;
			this.lifecycleRevision += 1;
			this.options.onStateChanged?.();
			return this.paused
				? Promise.resolve()
				: this.recoverAfterLifecycleChange();
		}
		if (this.paused) return Promise.resolve();
		this.schedulePolling();
		return this.options.host.isVisible?.() === false
			? Promise.resolve()
			: this.syncNow();
	}

	/** Waits until all work admitted before the call settles after close fences new work. */
	async waitForIdle(): Promise<void> {
		await this.tail;
	}

	/** Closes timer ownership immediately and lets already-started work settle. */
	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.lifecycleRevision += 1;
		this.clearTimers();
	}

	/** Routes retained events through the same queue as sync cycles. */
	private drainEvents(): Promise<void> {
		if (
			this.closed ||
			this.paused ||
			this.isSuspended() ||
			this.events.length === 0 ||
			this.isEffectBlocked()
		)
			return Promise.resolve();
		if (this.drainPromise) return this.drainPromise;
		this.workActive = true;
		this.options.onStateChanged?.();
		const run = this.tail.then(async () => {
			let cycleNeeded = true;
			try {
				while (true) {
					while (this.events.length > 0 && this.debounce === null) {
						if (
							this.closed ||
							this.paused ||
							this.isSuspended() ||
							this.isEffectBlocked()
						)
							return;
						const event = this.events[0];
						if (!event) return;
						const captured =
							(await this.options.onCaptureEvent?.(event)) ?? false;
						if (this.closed || this.paused || this.isSuspended()) return;
						if (!captured && !isTerminallyExcluded(event))
							await this.options.onEvent?.(event);
						this.events.shift();
					}
					if (
						this.closed ||
						this.paused ||
						this.isSuspended() ||
						this.isEffectBlocked()
					)
						return;
					if (!cycleNeeded) return;
					await this.options.cycle();
					cycleNeeded = false;
					if (this.events.length === 0 || this.debounce !== null) return;
					cycleNeeded = true;
				}
			} catch (error) {
				this.options.onError?.(error);
			} finally {
				this.workActive = false;
				this.options.onStateChanged?.();
			}
		});
		let sharedDrain: Promise<void>;
		sharedDrain = run.finally(() => {
			if (this.drainPromise === sharedDrain) this.drainPromise = null;
		});
		this.drainPromise = sharedDrain;
		this.tail = sharedDrain.catch((error: unknown) => {
			this.options.onError?.(error);
		});
		return sharedDrain;
	}

	/** Chooses one poll interval from visibility and recent foreground activity. */
	private schedulePolling(): void {
		if (this.closed || this.paused || this.isSuspended()) {
			if (this.suspended) this.clearTimers();
			return;
		}
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

	/** Revises cadence only when a proof still belongs to the latest local event and lifecycle. */
	private reviseActivityFromProof(
		proof: PluginOriginProof,
		previousActivity: number | null,
		activityRevision: number,
		lifecycleRevision: number,
	): void {
		void proof
			.then((isPlugin) => {
				if (
					!isPlugin ||
					this.closed ||
					this.paused ||
					this.activityRevision !== activityRevision ||
					this.lifecycleRevision !== lifecycleRevision
				)
					return;
				this.activeSince = previousActivity;
				this.activityRevision += 1;
				this.schedulePolling();
				this.options.onStateChanged?.();
			})
			.catch(() => undefined);
	}

	/** Fences timer and effect admission when the host reports automatic suspension. */
	private isSuspended(): boolean {
		if (this.options.host.isSuspended?.()) {
			this.suspend();
			return true;
		}
		return this.suspended;
	}

	/** Advances the lifecycle fence once and clears owned timers on suspension. */
	private suspend(): void {
		if (this.closed || this.suspended) return;
		this.suspended = true;
		this.lifecycleRevision += 1;
		this.clearTimers();
		this.options.onStateChanged?.();
	}

	/** Waits for admitted work, then recovers only if Pause, close, or suspension did not win. */
	private recoverAfterLifecycleChange(): Promise<void> {
		if (this.closed || this.paused || this.isSuspended())
			return Promise.resolve();
		const revision = this.lifecycleRevision;
		if (this.recoveryPromise?.revision === revision)
			return this.recoveryPromise.promise;
		const recovery = (async () => {
			await this.tail;
			if (
				this.closed ||
				this.paused ||
				this.isSuspended() ||
				this.lifecycleRevision !== revision
			)
				return;
			this.started = true;
			this.schedulePolling();
			const hasEvents = this.events.length > 0;
			await this.drainEvents();
			if (!hasEvents) await this.syncNow();
		})();
		let sharedRecovery: Promise<void>;
		sharedRecovery = recovery.finally(() => {
			if (this.recoveryPromise?.promise === sharedRecovery)
				this.recoveryPromise = null;
		});
		this.recoveryPromise = { revision, promise: sharedRecovery };
		return sharedRecovery;
	}

	/** Reads the shared capture fence before event and cycle admission. */
	private isEffectBlocked(): boolean {
		return this.options.isEffectBlocked?.() ?? false;
	}

	/** Releases both scheduled callback handles once per close or pause transition. */
	private clearTimers(): void {
		if (this.interval !== null) this.options.host.clearInterval(this.interval);
		if (this.debounce !== null) this.options.host.clearTimeout(this.debounce);
		this.interval = null;
		this.debounce = null;
	}
}
