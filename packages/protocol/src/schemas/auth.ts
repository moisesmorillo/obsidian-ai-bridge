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

/** One provider client identity scoped to the configured owner and selected vault. */
export const ClientIdSchema = z.string().min(1).max(2048);

/** Opaque consent identifier stored in provider-controlled grant properties. */
export const ConsentIdSchema = z.string().uuid();

/** Monotonic fencing number for one client within its vault registry. */
export const ClientGenerationSchema = z.number().int().nonnegative().safe();

/** Cursor used to read a finite owner-console page. */
export const ClientPageCursorSchema = z.string().min(1).max(4096);

/** Starts owner consent for one provider client at its current generation. */
export const BeginClientConsentRequestSchema = z
	.object({ owner_subject: OwnerSubjectSchema, client_id: ClientIdSchema })
	.strict();

/** Consent fence stored before the provider issues an authorization code. */
export const BeginClientConsentResultSchema = z
	.object({ generation: ClientGenerationSchema, consent_id: ConsentIdSchema })
	.strict();

/** Provider callback proof that one grant belongs to an approved consent. */
export const RegisterClientGrantRequestSchema = z
	.object({
		owner_subject: OwnerSubjectSchema,
		client_id: ClientIdSchema,
		grant_id: z.string().min(1).max(255),
		generation: ClientGenerationSchema,
		consent_id: ConsentIdSchema,
	})
	.strict();

/** Result of checking and recording an OAuth provider grant before token issue. */
export const RegisterClientGrantResultSchema = z
	.object({ accepted: z.boolean() })
	.strict();

/** Owner-visible grant data without provider secrets or authorization content. */
export const OwnerGrantSchema = z
	.object({
		grant_id: z.string().min(1).max(255),
		created_at: z.number().int().nonnegative().safe(),
		cleanup_pending: z.boolean(),
	})
	.strict();

/** One client and its bounded page of known durable grant records. */
export const OwnerClientSchema = z
	.object({
		client_id: ClientIdSchema,
		name: z.string().max(80),
		generation: ClientGenerationSchema,
		created_at: z.number().int().nonnegative().safe(),
		last_seen_at: z.number().int().nonnegative().safe().nullable(),
		grant_count: z.number().int().nonnegative().safe(),
		grants: z.array(OwnerGrantSchema).max(32),
		grants_cursor: ClientPageCursorSchema.nullable(),
	})
	.strict();

/** A paged owner listing. The next cursor never implies provider KV completeness. */
export const ListClientsResultSchema = z
	.object({
		clients: z.array(OwnerClientSchema).max(32),
		next_cursor: ClientPageCursorSchema.nullable(),
	})
	.strict();

/** Request to list one finite page of clients and their known grant records. */
export const ListClientsRequestSchema = z
	.object({
		owner_subject: OwnerSubjectSchema,
		cursor: ClientPageCursorSchema.optional(),
		grant_cursor: ClientPageCursorSchema.optional(),
	})
	.strict();

/** One finite page of grants owned by a client. */
export const ListClientGrantsResultSchema = z
	.object({
		grants: z.array(OwnerGrantSchema).max(32),
		next_cursor: ClientPageCursorSchema.nullable(),
	})
	.strict();

/** Owner request to list a finite page of one client's durable grants. */
export const ListClientGrantsRequestSchema = z
	.object({
		owner_subject: OwnerSubjectSchema,
		client_id: ClientIdSchema,
		cursor: ClientPageCursorSchema.optional(),
	})
	.strict();

/** Owner request to change the display name for an existing provider client. */
export const RenameClientRequestSchema = z
	.object({
		owner_subject: OwnerSubjectSchema,
		client_id: ClientIdSchema,
		name: z.string().trim().min(1).max(80),
	})
	.strict();

/** Client revocation result; cleanup remains pending until provider KV confirms it. */
export const RevokeClientResultSchema = z
	.object({
		generation: ClientGenerationSchema,
		cleanup_pending: z.boolean(),
		grants: z.array(z.string().min(1).max(255)).max(16),
	})
	.strict();

/** Request to close a client generation before bounded provider cleanup. */
export const RevokeClientRequestSchema = z
	.object({ owner_subject: OwnerSubjectSchema, client_id: ClientIdSchema })
	.strict();

/** Browser-bound single-use owner state used by page mutations. */
export const OwnerCsrfStateRequestSchema = z
	.object({
		owner_subject: OwnerSubjectSchema,
		browser_id: z.string().uuid(),
		state: z.string().uuid(),
		expires_at: z.number().int().positive().safe(),
	})
	.strict();

/** Result of consuming one unexpired browser-bound owner state. */
export const OwnerCsrfConsumeRequestSchema = z
	.object({
		owner_subject: OwnerSubjectSchema,
		browser_id: z.string().uuid(),
		state: z.string().uuid(),
		now: z.number().int().nonnegative().safe(),
	})
	.strict();

/** Derived input for the provider's consent and registry boundaries. */
export type BeginClientConsentRequest = z.infer<
	typeof BeginClientConsentRequestSchema
>;
/** Derived result containing the consent fence used by token callbacks. */
export type BeginClientConsentResult = z.infer<
	typeof BeginClientConsentResultSchema
>;
/** Derived provider grant callback input. */
export type RegisterClientGrantRequest = z.infer<
	typeof RegisterClientGrantRequestSchema
>;
/** Derived bounded client listing result. */
export type ListClientsResult = z.infer<typeof ListClientsResultSchema>;
/** Derived bounded grant listing result. */
export type ListClientGrantsResult = z.infer<
	typeof ListClientGrantsResultSchema
>;
