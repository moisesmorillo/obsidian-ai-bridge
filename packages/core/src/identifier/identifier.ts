import { IDENTIFIER_PATTERN } from "@core/identifier/identifier.constants";
import type { Identifier } from "@core/identifier/identifier.types";

/**
 * Creates a normalized identifier when the value satisfies the public format.
 *
 * @param value - Human- or transport-provided identifier candidate.
 * @returns The trimmed lowercase identifier, or `undefined` when its format is invalid.
 */
export function createIdentifier(value: string): Identifier | undefined {
  const normalizedValue = value.trim().toLowerCase();

  if (!IDENTIFIER_PATTERN.test(normalizedValue)) {
    return undefined;
  }

  return normalizedValue as Identifier;
}
