/** One-shot global key used only to fence sync during the approved plugin reload. */
export const OAB8_STARTUP_SYNC_FENCE = "__oab8DesktopStartupFence";

/** Consumes the guarded reload flag so no interception remains after startup. */
export function consumeStartupSyncFence(): boolean {
	const scope = globalThis as typeof globalThis & Record<string, unknown>;
	if (scope[OAB8_STARTUP_SYNC_FENCE] !== true) return false;
	Reflect.deleteProperty(scope, OAB8_STARTUP_SYNC_FENCE);
	return true;
}
