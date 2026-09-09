const identifierPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type Identifier = string & {
  readonly __brand: "Identifier";
};

export function createIdentifier(value: string): Identifier | undefined {
  const normalizedValue = value.trim().toLowerCase();

  if (!identifierPattern.test(normalizedValue)) {
    return undefined;
  }

  return normalizedValue as Identifier;
}
