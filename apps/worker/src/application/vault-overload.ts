import type { FileFailure } from "@vaultwire/protocol";
import { FileOperationDenied } from "@worker/application/files";

/**
 * Retry delay, in seconds, sent with a refusal caused by an overloaded Vault Durable Object.
 * Cloudflare says an overloaded object must not be retried at once, so clients wait at least this
 * long and their own exponential backoff applies on top.
 */
export const VAULT_OVERLOAD_RETRY_SECONDS = 5;

/**
 * A Vault RPC the platform refused because the Durable Object queue was overloaded.
 * It carries the canonical `admission_limited` failure, so every caller that maps known failures
 * returns `429 admission_limited` with `Retry-After` instead of an internal error. The caller cannot
 * know whether the refused call reached the object, so every caller keeps the durable admission
 * uncertain (see {@link knownFailureCompletion}) and every mutation retry stays conditional.
 */
export class VaultOverloaded extends FileOperationDenied {
	/** The fixed retryable refusal, narrowed so callers can read its retry delay. */
	declare readonly failure: Extract<FileFailure, { kind: "admission_limited" }>;
	/** Build the fixed retryable refusal. */
	constructor() {
		super({
			kind: "admission_limited",
			retry_after_seconds: VAULT_OVERLOAD_RETRY_SECONDS,
		});
	}
}

/**
 * True when a Durable Object stub error reports overload. The runtime marks these errors with
 * `overloaded === true` (for example "Durable Object is overloaded. Requests queued for too long.").
 */
export function isVaultOverload(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		(error as { overloaded?: unknown }).overloaded === true
	);
}

/**
 * Wrap every method of a Vault gateway so an overloaded Durable Object rejects with
 * {@link VaultOverloaded}. Other results and errors pass through unchanged. Non-function properties
 * pass through as they are. The wrapper adds no retry.
 */
export function refuseVaultOverload<T extends object>(gateway: T): T {
	return new Proxy(gateway, {
		/** Return a rejection-mapping wrapper for each method and plain values otherwise. */
		get(target, property) {
			const value = Reflect.get(target, property, target);
			if (typeof value !== "function") return value;
			return async (...args: unknown[]) => {
				try {
					return await Reflect.apply(value, target, args);
				} catch (error) {
					if (isVaultOverload(error)) throw new VaultOverloaded();
					throw error;
				}
			};
		},
	});
}

/**
 * Admission completion for a failure whose canonical response is known. Known policy failures
 * settle their admission. An overload refusal stays uncertain: the platform does not promise that
 * the refused call never reached the object, so the admission keeps its original deadline.
 */
export function knownFailureCompletion(
	error: unknown,
): "settled" | "uncertain" {
	return error instanceof VaultOverloaded ? "uncertain" : "settled";
}

/**
 * Map an unexpected error at a catch-all boundary: an overloaded Vault keeps its retryable
 * `admission_limited` failure, and every other error stays an internal error.
 */
export function unexpectedFailure(
	error: unknown,
): VaultOverloaded["failure"] | { kind: "internal_error" } {
	return error instanceof VaultOverloaded
		? error.failure
		: { kind: "internal_error" };
}
