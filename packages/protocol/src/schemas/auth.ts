import { z } from "zod";

/** Canonical HTTPS origin used as the OAuth issuer, resource, and service base. */
export const ServiceOriginSchema = z
	.string()
	.url()
	.refine((value) => {
		const parsed = new URL(value);
		return (
			parsed.protocol === "https:" &&
			parsed.origin === value &&
			parsed.pathname === "/" &&
			!parsed.search &&
			!parsed.hash
		);
	}, "service origin must be a canonical HTTPS origin");

/** HTTPS Cloudflare Access team origin used only for its fixed signing-key path. */
export const AccessTeamDomainSchema = ServiceOriginSchema;

/** Non-empty Access application audience expected in signed assertions. */
export const AccessAudienceSchema = z.string().min(1).max(255);

/** Owner subject identifier accepted by the authorization server. */
export const OwnerSubjectSchema = z
	.string()
	.min(1)
	.max(2048)
	.refine(
		(value) => !value.includes(":"),
		"owner subject cannot contain a colon",
	);

/** Optional local auth bindings. Missing values stay valid so the Worker can deny access. */
export const LocalAuthConfigurationSchema = z
	.object({
		SERVICE_ORIGIN: ServiceOriginSchema.optional(),
		ACCESS_TEAM_DOMAIN: AccessTeamDomainSchema.optional(),
		ACCESS_AUDIENCE: AccessAudienceSchema.optional(),
		OWNER_SUBJECT: OwnerSubjectSchema.optional(),
	})
	.strict();

/** Auth configuration validated at the adapter boundary. */
export type LocalAuthConfiguration = z.infer<
	typeof LocalAuthConfigurationSchema
>;
