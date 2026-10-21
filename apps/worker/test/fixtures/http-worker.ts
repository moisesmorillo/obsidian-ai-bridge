import type { AuthorizationContext } from "@obsidian-ai-bridge/protocol";
import type { HistoryVaultGateway } from "@worker/application/history";
import type { ReadVaultGateway } from "@worker/application/reads";
import type { TextVaultGateway } from "@worker/application/text-files";
import type { Env } from "@worker/env";
import { R2BlobStore } from "@worker/infrastructure/r2/blobs";
import { createWorker } from "@worker/transport/worker";

/** Fixed test-only identity with all implemented file scopes. */
const TEST_IDENTITY: AuthorizationContext = {
	client_id: "http-test-client",
	grant_id: "http-test-grant",
	scopes: ["vault:read", "vault:write", "vault:delete"],
};

/** Fixed test-only write identity used to verify operation-specific access checks. */
const WRITE_IDENTITY: AuthorizationContext = {
	client_id: "http-write-client",
	grant_id: "http-write-grant",
	scopes: ["vault:write"],
};

/** Fixed test-only read identity used to verify missing operation scope. */
const READ_IDENTITY: AuthorizationContext = {
	client_id: "http-read-client",
	grant_id: "http-read-grant",
	scopes: ["vault:read"],
};

/** Fixed test-only revoked identity used to verify current grant policy. */
const REVOKED_IDENTITY: AuthorizationContext = {
	client_id: "http-revoked-client",
	grant_id: "http-revoked-grant",
	scopes: ["vault:read", "vault:write", "vault:delete"],
};

/** Match one test-only post-RPC failure requested by the current test. */
function shouldFailAfter(request: Request, operation: string): boolean {
	return request.headers.get("X-Test-Fail-RPC") === operation;
}

/** Inject test identities and select the real Durable Object binding only in this test entry. */
const worker = createWorker(
	async (request) => {
		switch (request.headers.get("X-Test-Identity")) {
			case "write":
				return WRITE_IDENTITY;
			case "read":
				return READ_IDENTITY;
			case "revoked":
				return REVOKED_IDENTITY;
			default:
				return TEST_IDENTITY;
		}
	},
	(
		env: Env,
		request: Request,
	): TextVaultGateway & HistoryVaultGateway & ReadVaultGateway => {
		const stub = env.VAULTS.get(
			env.VAULTS.idFromName(new URL(request.url).host),
		);
		return {
			getCurrentEpoch: async (
				...args: Parameters<typeof stub.getCurrentEpoch>
			) => {
				const result = await stub.getCurrentEpoch(...args);
				if (shouldFailAfter(request, "getCurrentEpoch"))
					throw new Error("Simulated RPC response loss");
				return result;
			},
			beginMutation: async (...args) => {
				const result = await stub.beginMutation(...args);
				if (shouldFailAfter(request, "beginMutation"))
					throw new Error("Simulated RPC response loss");
				return result;
			},
			authorize: async (context, intent, admissionId?: string) => {
				const result = await stub.authorize(context, intent, admissionId);
				if (shouldFailAfter(request, "authorize"))
					throw new Error("Simulated RPC response loss");
				return result;
			},
			/** Simulate a lost RPC response after a successful durable commit. */
			commitText: async (...args) => {
				const result = await stub.commitText(...args);
				if (
					(shouldFailAfter(request, "commitText") ||
						request.headers.get("X-Test-Lose-Commit-Response") === "true") &&
					result.ok
				)
					throw new Error("Simulated committed response loss");
				return result;
			},
			authorizeBlob: async (...args) => await stub.authorizeBlob(...args),
			/** Lose only a confirmed blob result so exact receipt retries exercise the HTTP boundary. */
			commitBlob: async (...args) => {
				const result = await stub.commitBlob(...args);
				if (
					(shouldFailAfter(request, "commitBlob") ||
						request.headers.get("X-Test-Lose-Commit-Response") === "true") &&
					result.ok
				)
					throw new Error("Simulated committed response loss");
				return result;
			},
			readBlobMetadata: async (...args) => await stub.readBlobMetadata(...args),
			finishAdmission: async (...args) => {
				const result = await stub.finishAdmission(...args);
				if (shouldFailAfter(request, "finishAdmission"))
					throw new Error("Simulated RPC response loss");
				return result;
			},
			readText: async (...args) => {
				const result = await stub.readText(...args);
				if (shouldFailAfter(request, "readText"))
					throw new Error("Simulated RPC response loss");
				return result;
			},
			beginRenameSource: async (...args) =>
				await stub.beginRenameSource(...args),
			authorizeRenameSource: async (...args) =>
				await stub.authorizeRenameSource(...args),
			commitFileCommand: async (...args) => {
				const result = await stub.commitFileCommand(...args);
				if (
					(shouldFailAfter(request, "commitFileCommand") ||
						request.headers.get("X-Test-Lose-Commit-Response") === "true") &&
					result.ok
				)
					throw new Error("Simulated committed response loss");
				return result;
			},
			readHistory: async (...args) => await stub.readHistory(...args),
			readVault: async (...args) => {
				const result = await stub.readVault(...args);
				if (shouldFailAfter(request, "readVault"))
					throw new Error("Simulated RPC response loss");
				return result;
			},
			readHistoryUpper: async (...args) => {
				const result = await stub.readHistoryUpper(...args);
				if (shouldFailAfter(request, "readHistoryUpper"))
					throw new Error("Simulated RPC response loss");
				return result;
			},
			readBatch: async (...args) => {
				const result = await stub.readBatch(...args);
				if (shouldFailAfter(request, "readBatch"))
					throw new Error("Simulated RPC response loss");
				return result;
			},
		};
	},
	(env) => new R2BlobStore(env.R2_BUCKET),
);

export { Vault } from "@worker/infrastructure/durable-object/vault";
export default worker;
