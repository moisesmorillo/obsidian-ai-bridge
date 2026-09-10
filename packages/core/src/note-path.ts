const maximumDangerCheckPasses = 4;
const dangerousEncodedCharacterPattern = /%(?:2e|2f|5c|00)/i;

export type NotePath = string & {
  readonly __brand: "NotePath";
};

function isSafeDecodedPath(value: string): boolean {
  if (
    value.length === 0 ||
    value.includes("\0") ||
    value.includes("\\") ||
    value.startsWith("/") ||
    /^[A-Za-z]:/.test(value) ||
    !value.endsWith(".md")
  ) {
    return false;
  }

  const segments = value.split("/");
  return !segments.some(
    (segment) => segment.length === 0 || segment === "." || segment === "..",
  );
}

function containsDangerousEncoding(value: string): boolean {
  let candidate = value;

  for (let pass = 0; pass < maximumDangerCheckPasses; pass += 1) {
    if (
      dangerousEncodedCharacterPattern.test(candidate) ||
      candidate
        .split(/[\\/]/)
        .some((segment) => segment === "." || segment === "..")
    ) {
      return true;
    }

    let nextValue: string;
    try {
      nextValue = decodeURIComponent(candidate);
    } catch {
      return false;
    }

    if (nextValue === candidate) {
      return false;
    }

    candidate = nextValue;
  }

  return true;
}

export function normalizeNotePath(value: string): NotePath | undefined {
  if (value.length === 0 || value.includes("\0") || value.includes("\\")) {
    return undefined;
  }

  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(value);
  } catch {
    return undefined;
  }

  if (
    decodedPath.length === 0 ||
    containsDangerousEncoding(value) ||
    containsDangerousEncoding(decodedPath)
  ) {
    return undefined;
  }

  if (!isSafeDecodedPath(decodedPath)) {
    return undefined;
  }

  return decodedPath as NotePath;
}

export function isNormalizedNotePath(value: string): value is NotePath {
  return !containsDangerousEncoding(value) && isSafeDecodedPath(value);
}
