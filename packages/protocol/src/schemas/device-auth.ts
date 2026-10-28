import { z } from "zod";

/** OAuth discovery metadata accepted only when every endpoint uses the configured service origin. */
export const DeviceDiscoverySchema = z
	.object({
		issuer: z.string().url(),
		registration_endpoint: z.string().url(),
		authorization_endpoint: z.string().url(),
		token_endpoint: z.string().url(),
		response_types_supported: z.array(z.string()),
		grant_types_supported: z.array(z.string()).optional(),
		code_challenge_methods_supported: z.array(z.string()),
		scopes_supported: z.array(z.string()).optional(),
	})
	.passthrough();

/** OAuth public-client registration accepted before browser consent. */
export const DeviceRegistrationResponseSchema = z
	.object({ client_id: z.string().min(1).max(2048) })
	.passthrough();

/** OAuth authorization-code and refresh response fields consumed by the session controller. */
export const DeviceTokenResponseSchema = z
	.object({
		access_token: z.string().min(1),
		token_type: z.string().min(1),
		expires_in: z.number().int().positive().safe(),
		refresh_token: z.string().min(1),
		scope: z.string().optional(),
	})
	.passthrough();

/** One validated token set stored atomically under a device-scoped local key. */
export const DeviceCredentialSchema = z
	.object({
		client_id: z.string().min(1).max(2048),
		access_token: z.string().min(1),
		refresh_token: z.string().min(1),
		token_type: z.literal("Bearer"),
		expires_at: z.number().int().positive().safe(),
		scope: z.array(z.enum(["vault:read", "vault:write", "vault:delete"])),
	})
	.strict();

/** Inferred validated token record. Secrets must remain outside the device journal and synced settings. */
export type DeviceCredential = z.infer<typeof DeviceCredentialSchema>;
/** Inferred OAuth service discovery DTO before endpoint-origin checks. */
export type DeviceDiscovery = z.infer<typeof DeviceDiscoverySchema>;
/** Inferred public-client registration response. */
export type DeviceRegistrationResponse = z.infer<
	typeof DeviceRegistrationResponseSchema
>;
/** Inferred OAuth token response before credential record construction. */
export type DeviceTokenResponse = z.infer<typeof DeviceTokenResponseSchema>;
