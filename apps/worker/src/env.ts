import type { Vault } from "@worker/infrastructure/durable-object/vault";

/** Native Worker capabilities shared by deployment typing and the Workers test environment. */
interface WorkerBindings {
	VAULTS: DurableObjectNamespace<Vault>;
	R2_BUCKET: R2Bucket;
	OAUTH_KV?: KVNamespace;
	SERVICE_ORIGIN?: string;
	ACCESS_TEAM_DOMAIN?: string;
	ACCESS_AUDIENCE?: string;
	OWNER_SUBJECT?: string;
}

/** Explicit environment contract consumed by the Vault adapter, not a runtime validation schema. */
export interface Env extends WorkerBindings {}

declare global {
	namespace Cloudflare {
		/** Gives native test bindings the same capabilities as the production Worker environment. */
		interface Env extends WorkerBindings {}
	}
}
