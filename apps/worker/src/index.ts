import type { HistoryVaultGateway } from "@worker/application/history";
import type { TextVaultGateway } from "@worker/application/text-files";
import type { Env } from "@worker/env";
import { createWorker } from "@worker/transport/worker";

/** Deny all production identities until an approved authentication adapter exists. */
async function resolveIdentity(_request: Request) {
	return null;
}

/** Select the vault named by the request host after identity validation. */
function resolveVault(
	env: Env,
	request: Request,
): TextVaultGateway & HistoryVaultGateway {
	const stub = env.VAULTS.get(env.VAULTS.idFromName(new URL(request.url).host));
	return {
		getCurrentEpoch: async (...args: Parameters<typeof stub.getCurrentEpoch>) =>
			await stub.getCurrentEpoch(...args),
		beginMutation: async (...args: Parameters<typeof stub.beginMutation>) =>
			await stub.beginMutation(...args),
		authorize: async (...args: Parameters<typeof stub.authorize>) =>
			await stub.authorize(...args),
		commitText: async (...args: Parameters<typeof stub.commitText>) =>
			await stub.commitText(...args),
		commitBlob: async (...args: Parameters<typeof stub.commitBlob>) =>
			await stub.commitBlob(...args),
		readBlobMetadata: async (
			...args: Parameters<typeof stub.readBlobMetadata>
		) => await stub.readBlobMetadata(...args),
		finishAdmission: async (...args: Parameters<typeof stub.finishAdmission>) =>
			await stub.finishAdmission(...args),
		readText: async (...args: Parameters<typeof stub.readText>) =>
			await stub.readText(...args),
		beginRenameSource: async (
			...args: Parameters<typeof stub.beginRenameSource>
		) => await stub.beginRenameSource(...args),
		authorizeRenameSource: async (
			...args: Parameters<typeof stub.authorizeRenameSource>
		) => await stub.authorizeRenameSource(...args),
		commitFileCommand: async (
			...args: Parameters<typeof stub.commitFileCommand>
		) => await stub.commitFileCommand(...args),
		readHistory: async (...args: Parameters<typeof stub.readHistory>) =>
			await stub.readHistory(...args),
	};
}

const worker = createWorker(resolveIdentity, resolveVault);

export { Vault } from "@worker/infrastructure/durable-object/vault";
export default worker;
