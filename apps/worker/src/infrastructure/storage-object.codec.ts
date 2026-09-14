import type { z } from "zod";

/**
 * Serializes one storage object only after its complete private schema accepts it.
 *
 * This keeps writers from creating representations that their corresponding
 * strict readers would reject, while returning no validation details or content.
 *
 * @param schema - Exact schema for the persisted representation.
 * @param candidate - Candidate containing only fields admitted by that format.
 * @returns Canonical compact JSON for the validated schema output.
 * @throws {Error} When the candidate violates its private storage schema.
 */
export function encodeValidatedStorageObject<Encoded>(
  schema: z.ZodType<Encoded>,
  candidate: Encoded,
): string {
  const result = schema.safeParse(candidate);
  if (!result.success) {
    throw new Error("Cannot encode an invalid private storage object");
  }

  return JSON.stringify(result.data);
}
