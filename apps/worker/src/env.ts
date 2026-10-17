import type { Vault } from "@worker/infrastructure/durable-object/vault";

interface WorkerBindings {
	VAULTS: DurableObjectNamespace<Vault>;
}

export interface Env extends WorkerBindings {}

declare global {
	namespace Cloudflare {
		interface Env extends WorkerBindings {}
	}
}
