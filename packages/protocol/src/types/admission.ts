import type {
	AdmissionCompletionSchema,
	AdmissionFailureSchema,
	AdmissionFinishResultSchema,
	AdmissionResultSchema,
	AuthorizationContextSchema,
	DescriptorPreparationSchema,
	OperationDescriptorSchema,
	OperationIntentSchema,
	OperationPreparationSchema,
	OperationTicketSchema,
	RequestAdmissionLeaseSchema,
	RequestAdmissionResultSchema,
	VaultScopeSchema,
} from "@protocol/schemas/admission";
import type { z } from "zod";

/** One canonical vault scope used during admission. */
export type VaultScope = z.infer<typeof VaultScopeSchema>;
/** Normalized client and grant identity with unique scopes. */
export type AuthorizationContext = z.infer<typeof AuthorizationContextSchema>;
/** Validated operation metadata for pre-body checks. */
export type OperationDescriptor = z.infer<typeof OperationDescriptorSchema>;
/** Descriptor metadata with a declared payload hash and size. */
export type OperationIntent = z.infer<typeof OperationIntentSchema>;
/** Canonical envelope for descriptor reservation. */
export type DescriptorPreparation = z.infer<typeof DescriptorPreparationSchema>;
/** Canonical envelope for full operation authorization. */
export type OperationPreparation = z.infer<typeof OperationPreparationSchema>;
/** Lease returned after request capacity reservation. */
export type RequestAdmissionLease = z.infer<typeof RequestAdmissionLeaseSchema>;
/** Result of a request capacity reservation. */
export type RequestAdmissionResult = z.infer<
	typeof RequestAdmissionResultSchema
>;
/** Single-use ticket returned after full authorization. */
export type OperationTicket = z.infer<typeof OperationTicketSchema>;
/** Internal failure detail for an admission denial. */
export type AdmissionFailure = z.infer<typeof AdmissionFailureSchema>;
/** Result of full operation authorization. */
export type AdmissionResult = z.infer<typeof AdmissionResultSchema>;
/** State used to settle or retain a ticket. */
export type AdmissionCompletion = z.infer<typeof AdmissionCompletionSchema>;
/** Result of finishing an admitted operation. */
export type AdmissionFinishResult = z.infer<typeof AdmissionFinishResultSchema>;
