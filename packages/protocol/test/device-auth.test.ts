import { describe, expect, it } from "vitest";
import {
	DEVICE_CALLBACK_URI,
	DeviceCredentialSchema,
	DeviceDiscoverySchema,
	DeviceTokenResponseSchema,
} from "../src/schemas/device-auth";

describe("device enrollment protocol schemas", () => {
	it("rejects malformed token responses before credential persistence", () => {
		expect(
			DeviceTokenResponseSchema.safeParse({
				access_token: "access",
				refresh_token: "refresh",
				token_type: "Bearer",
				expires_in: "3600",
			}).success,
		).toBe(false);
	});

	it("requires canonical issuing origin on credentials", () => {
		const valid = {
			service_origin: "https://service.test",
			client_id: "client",
			access_token: "access",
			refresh_token: "refresh",
			token_type: "Bearer",
			expires_at: 1_800_000_000_000,
			scope: ["vault:read", "vault:write", "vault:delete"],
		};
		expect(DeviceCredentialSchema.safeParse(valid).success).toBe(true);
		const { service_origin: _serviceOrigin, ...legacy } = valid;
		expect(DeviceCredentialSchema.safeParse(legacy).success).toBe(false);
		expect(
			DeviceCredentialSchema.safeParse({
				...valid,
				service_origin: "http://service.test",
			}).success,
		).toBe(false);
		expect(
			DeviceCredentialSchema.safeParse({
				...valid,
				service_origin: "https://service.test/path",
			}).success,
		).toBe(false);
	});

	it("accepts only complete credentials with supported scopes", () => {
		const valid = {
			service_origin: "https://service.test",
			client_id: "client",
			access_token: "access",
			refresh_token: "refresh",
			token_type: "Bearer",
			expires_at: 1_800_000_000_000,
			scope: ["vault:read", "vault:write", "vault:delete"],
		};
		expect(DeviceCredentialSchema.safeParse(valid).success).toBe(true);
		expect(
			DeviceCredentialSchema.safeParse({ ...valid, extra: "not accepted" })
				.success,
		).toBe(false);
	});

	it("validates required OAuth discovery fields", () => {
		expect(
			DeviceDiscoverySchema.safeParse({
				issuer: "https://service.test",
				registration_endpoint: "https://service.test/register",
				authorization_endpoint: "https://service.test/authorize",
				token_endpoint: "https://service.test/token",
				response_types_supported: ["code"],
				code_challenge_methods_supported: ["S256"],
			}).success,
		).toBe(true);
		expect(DEVICE_CALLBACK_URI).toBe("obsidian://ai-bridge/callback");
		expect(
			DeviceDiscoverySchema.safeParse({ issuer: "https://service.test" })
				.success,
		).toBe(false);
	});
});
