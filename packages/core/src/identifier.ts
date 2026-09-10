const IDENTIFIER_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** A normalized, URL-safe identifier. */
export type Identifier = string & { readonly __brand: "Identifier" };

/** Creates a normalized identifier when the value satisfies the public format. */
export function createIdentifier(value: string): Identifier | undefined {
  const normalizedValue = value.trim().toLowerCase();

  if (!IDENTIFIER_PATTERN.test(normalizedValue)) {
    return undefined;
  }

  return normalizedValue as Identifier;
}
