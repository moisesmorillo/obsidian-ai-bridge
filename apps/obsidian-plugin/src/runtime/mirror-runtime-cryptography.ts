import {
  type ContentSha256,
  createContentSha256,
  createMirrorOperationId,
  type MirrorOperationId,
  type MirrorSynchronizerRuntime,
} from "@obsidian-ai-bridge/core";

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
    const digest = await this.cryptography.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(content),
    );
    const encoded = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    const hash = createContentSha256(encoded);
    if (hash === undefined) throw new Error("Invalid SHA-256 provider output.");
    return hash;
  }

  /** @inheritdoc */
  createOperationId(): MirrorOperationId {
    const operationId = createMirrorOperationId(this.cryptography.randomUUID());
    if (operationId === undefined) {
      throw new Error("Invalid random UUID provider output.");
    }
    return operationId;
  }
}
