/** Fail-closed experimental transport status; never a definite store-effect rejection. */
export const SYNC_LAB_UNAVAILABLE_STATUS = 503;
/** Stable explicit arming discriminator for remote experimental configuration; never production activation. */
export const SYNC_REMOTE_MODE = "synthetic-remote-only";
/** Remote experimental URLs require TLS; this never widens the default loopback contract. */
export const SYNC_REMOTE_URL_PROTOCOL = "https:";
/** Experimental remote transport ticket; grants admission only after authenticated server binding. */
export const SYNC_REMOTE_TICKET_HEADER = "X-AI-Bridge-Remote-Ticket";
/** Fixed participant-local single-use slots; shared across fresh isolates and never refunded. */
export const SYNC_REMOTE_TICKETS = 100;
/** Aggregate physical binding attempts per request, including claim, marker and read-back. */
export const SYNC_REMOTE_CALLS = 512;
/** Aggregate submitted PUT bytes per request, including uncertain/failed attempts, in bytes. */
export const SYNC_REMOTE_PUT_BYTES = 1024 * 1024;
/** Maximum enabled experiment lifetime, in milliseconds; not an extension of store TTLs. */
export const SYNC_REMOTE_LIFETIME_MS = 60 * 60 * 1000;
/** Validates a canonical HTTPS origin without credentials, ports, paths, query or fragment; no network resolution occurs.
 * @param value Non-secret candidate origin, never note content.
 * @returns Whether the exact string is a canonical HTTPS authority; no availability claim.
 */
export function isSyncRemoteEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === SYNC_REMOTE_URL_PROTOCOL &&
      url.hostname.includes(".") &&
      url.port === "" &&
      url.origin === value &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}
