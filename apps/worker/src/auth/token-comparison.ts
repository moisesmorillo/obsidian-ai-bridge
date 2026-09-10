const TOKEN_DIGEST_ALGORITHM = "SHA-256";

/**
 * Compares byte arrays without exiting on their first differing byte.
 *
 * @param left - First digest to compare.
 * @param right - Second digest to compare.
 * @returns Whether both byte arrays have equal length and contents.
 */
function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  let difference = left.length ^ right.length;
  const longestLength = Math.max(left.length, right.length);

  for (let index = 0; index < longestLength; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }

  return difference === 0;
}

/**
 * Creates a fixed-length Web Crypto digest for token comparison.
 *
 * @param value - Token text to hash.
 * @returns The SHA-256 digest of the token.
 */
async function sha256(value: string): Promise<Uint8Array> {
  const bytes = new TextEncoder().encode(value);
  return new Uint8Array(
    await crypto.subtle.digest(TOKEN_DIGEST_ALGORITHM, bytes),
  );
}

/**
 * Compares credentials through fixed-length SHA-256 digests without early exits.
 *
 * @param providedToken - Credential supplied by the request.
 * @param expectedToken - Credential configured by the Worker.
 * @returns Whether the digests match.
 */
export async function hasMatchingToken(
  providedToken: string,
  expectedToken: string,
): Promise<boolean> {
  const [providedDigest, expectedDigest] = await Promise.all([
    sha256(providedToken),
    sha256(expectedToken),
  ]);

  return constantTimeEqual(providedDigest, expectedDigest);
}
