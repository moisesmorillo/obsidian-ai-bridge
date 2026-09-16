import {
  type ContentSha256,
  createContentSha256,
  createMirrorOperationId,
  type MirrorOperationId,
  type MirrorSynchronizerRuntime,
} from "@obsidian-ai-bridge/core";

/** Sanitized local runtime failure; the provider exception is never retained. */
export class MirrorRuntimeCryptographyError extends Error {
  override readonly name = "MirrorRuntimeCryptographyError";

  /** Creates a provider-independent capability failure. */
  constructor() {
    super("Required runtime cryptography is unavailable.");
  }
}

/**
 * @param cryptography - Untrusted host Web Crypto surface.
 * @returns Whether every synchronous Slice 7 cryptographic capability exists.
 */
export function hasMirrorRuntimeCryptography(
  cryptography: Crypto | undefined,
): cryptography is Crypto {
  try {
    return (
      cryptography !== undefined &&
      typeof cryptography.randomUUID === "function" &&
      cryptography.subtle !== undefined &&
      typeof cryptography.subtle.digest === "function"
    );
  } catch {
    return false;
  }
}

/**
 * Performs an explicit empty-input digest probe without retaining user content.
 * @param cryptography - Host Web Crypto provider.
 * @returns Whether SHA-256 digest execution succeeds with the expected width.
 */
export async function probeMirrorRuntimeCryptography(
  cryptography: Crypto,
): Promise<boolean> {
  if (!hasMirrorRuntimeCryptography(cryptography)) return false;
  try {
    const digest = await cryptography.subtle.digest(
      "SHA-256",
      new Uint8Array(),
    );
    return digest.byteLength === 32;
  } catch {
    return false;
  }
}

/**
 * Standards-Web-Crypto implementation of core digest and operation identity seams.
 * It retains neither note text nor digest input after each invocation settles.
 */
export class BrowserMirrorSynchronizerRuntime
  implements MirrorSynchronizerRuntime
{
  /** @param cryptography - Supported host Web Crypto implementation. */
  constructor(private readonly cryptography: Crypto = globalThis.crypto) {}

  /** @inheritdoc */
  nowMilliseconds(): number {
    return performance.now();
  }

  /** @inheritdoc */
  async hashContent(content: string): Promise<ContentSha256> {
    try {
      const digest = await this.cryptography.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(content),
      );
      const encoded = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
      const hash = createContentSha256(encoded);
      if (hash === undefined) throw new MirrorRuntimeCryptographyError();
      return hash;
    } catch {
      throw new MirrorRuntimeCryptographyError();
    }
  }

  /** @inheritdoc */
  createOperationId(): MirrorOperationId {
    try {
      const operationId = createMirrorOperationId(
        this.cryptography.randomUUID(),
      );
      if (operationId === undefined) throw new MirrorRuntimeCryptographyError();
      return operationId;
    } catch {
      throw new MirrorRuntimeCryptographyError();
    }
  }
}
