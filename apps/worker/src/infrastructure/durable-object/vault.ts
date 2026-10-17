import { DurableObject } from "cloudflare:workers";
import type { Env } from "@worker/env";
import {
	generateEpoch,
	initializeVaultStorage,
} from "@worker/infrastructure/sqlite/schema";

/** SQLite-backed authority for one isolated vault id. */
export class Vault extends DurableObject<Env> {
	/**
	 * Creates fresh storage or validates existing storage synchronously in one transaction.
	 * Incompatible state throws without repair or identity replacement. Construction does not expose mutation operations.
	 */
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		initializeVaultStorage(
			ctx.storage,
			() =>
				generateEpoch((bytes) => {
					bytes.set(crypto.getRandomValues(new Uint8Array(16)));
					return bytes;
				}),
			Date.now,
		);
	}
}
