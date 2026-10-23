import { z } from "zod";

/** Printable ASCII Vault identity, 1–255 bytes, returned only for a retired Vault redirect. */
export const VaultIdSchema = z
	.string()
	.min(1)
	.max(255)
	.regex(/^[!-~]+$/);
