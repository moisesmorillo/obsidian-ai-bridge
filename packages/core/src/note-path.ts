const maximumDangerCheckPasses = 4;
const dangerousEncodedCharacterPattern = /%(?:2e|2f|5c|00)/i;
const base64UrlPattern = /^[A-Za-z0-9_-]+$/;

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

function bytesToBinary(bytes: Uint8Array): string {
  let binary = "";

  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }

  return binary;
}

function binaryToBytes(binary: string): Uint8Array {
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function encodeNotePath(path: NotePath): string {
  return btoa(bytesToBinary(new TextEncoder().encode(path)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export function decodeNotePath(value: string): NotePath | undefined {
  if (!base64UrlPattern.test(value) || value.length % 4 === 1) {
    return undefined;
  }

  const base64Value = value.replaceAll("-", "+").replaceAll("_", "/");
  const paddedValue = base64Value.padEnd(
    base64Value.length + ((4 - (value.length % 4)) % 4),
    "=",
  );

  let decodedPath: string;
  try {
    decodedPath = new TextDecoder("utf-8", { fatal: true }).decode(
      binaryToBytes(atob(paddedValue)),
    );
  } catch {
    return undefined;
  }

  if (!isNormalizedNotePath(decodedPath)) {
    return undefined;
  }

  return encodeNotePath(decodedPath) === value ? decodedPath : undefined;
}
