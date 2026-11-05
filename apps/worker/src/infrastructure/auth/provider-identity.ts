/**
 * Derive the stable, service-scoped OAuth provider pseudonym for a configured owner.
 * This value is public identity metadata, not a secret or authorization credential.
 */
export async function deriveProviderUserId(
	ownerSubject: string,
	serviceOrigin: string,
): Promise<string> {
	const input = JSON.stringify([
		"obsidian-ai-bridge/provider-identity/v1",
		serviceOrigin,
		ownerSubject,
	]);
	const digest = new Uint8Array(
		await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input)),
	);
	const encoded = Array.from(digest, (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
	return `oab1_${encoded}`;
}
