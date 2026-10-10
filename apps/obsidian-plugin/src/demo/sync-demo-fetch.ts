import {
  createContentSha256,
  SYNC_DEMO_CLIENT_LIMITS,
  type SyncDemoClientBinding,
  type SyncDemoRemote,
  type SyncNotePath,
  type SyncRevision,
  type SyncStoreFailure,
} from "@obsidian-ai-bridge/core";
import {
  decodeSyncCursor,
  HTTP_METHOD,
  HTTP_STATUS_CODE,
  isSyncRemoteEndpoint,
  MAX_SYNC_DEMO_FEED_EVENTS,
  MAX_SYNC_DEMO_REQUEST_BYTES,
  MAX_SYNC_NOTE_PATH_BYTES,
  MIRROR_HTTP_HEADER,
  MIRROR_MEDIA_TYPE,
  SYNC_DEMO_BINDING_HEADER,
  SYNC_DEMO_LOOPBACK_HOSTS,
  SYNC_DEMO_OPERATION,
  SYNC_DEMO_ROUTE,
  SYNC_DEMO_TRANSPORT_ERROR,
  SYNC_DEMO_URL_PROTOCOL,
  SYNC_LAB_UNAVAILABLE_STATUS,
  SYNC_REMOTE_TICKET_HEADER,
  syncDemoRequestSchema,
  syncDemoResponseSchema,
  syncDemoTransportFailureSchema,
  syncRemoteTicketSchema,
} from "@obsidian-ai-bridge/protocol";
import type { z } from "zod";

/** Closed validated wire result; weak external JSON is confined to immediate schema decoding. */
type WireResult = z.output<typeof syncDemoResponseSchema>;
/** Closed validated experimental command, distinct from the core mutation's server-bound identities. */
type WireRequest = z.output<typeof syncDemoRequestSchema>;
/** Whole secret/dispatch/body deadline in milliseconds; neither abort nor timeout asserts rollback. */
const REQUEST_DEADLINE_MS = 10_000;
/** Standard rate-limit floor header, interpreted only for HTTP 429 in the remote experiment. */
const RETRY_AFTER_HEADER = "Retry-After";
/** Parses standard delta-seconds or HTTP-date Retry-After as a safe Unix-millisecond floor.
 * @param value Untrusted remote header value.
 * @param now Current time in the transport's clock domain.
 * @returns Future safe floor or null for absent, invalid or non-future values.
 */
function retryAfterFloor(value: string | null, now: number): number | null {
  if (value === null) return null;
  const floor = /^[0-9]{1,10}$/.test(value)
    ? now + Number(value) * 1000
    : Date.parse(value);
  return Number.isSafeInteger(floor) && floor > now ? floor : null;
}
/** Canonical Worker JSON allowance per event excluding its bounded ASCII path; covers UUIDs, sequence, timestamp and field syntax. */
const FEED_EVENT_METADATA_BYTES = 512;
/** Canonical cursor/page framing allowance in encoded bytes, including all 64 fixed-width lane positions. */
const FEED_PAGE_FRAMING_BYTES = 4096;
/** Finite encoded response budget admitting both maximally escaped live bodies and full maximum-path feed pages. */
const MAX_RESPONSE_BYTES = Math.max(
  MAX_SYNC_DEMO_REQUEST_BYTES,
  MAX_SYNC_DEMO_FEED_EVENTS *
    (MAX_SYNC_NOTE_PATH_BYTES + FEED_EVENT_METADATA_BYTES) +
    FEED_PAGE_FRAMING_BYTES,
);

/** Converts contextual wire failures to core certainty without accepting incomplete code/context conjunctions.
 * @param result Strict schema-validated error variant, not arbitrary JSON.
 * @returns Core failure retaining contextual retry/operation certainty.
 */
function failure(
  result: Extract<WireResult, { kind: "error" }>,
): SyncStoreFailure {
  const retryAfterEpochMs =
    "retryAfterEpochMs" in result ? result.retryAfterEpochMs : undefined;
  const operationId = "operationId" in result ? result.operationId : undefined;
  const retry = retryAfterEpochMs === undefined ? {} : { retryAfterEpochMs };
  switch (result.code) {
    case "storage_throttled":
      return retryAfterEpochMs === undefined
        ? { kind: "error", code: "storage_unavailable" }
        : { kind: "error", code: result.code, retryAfterEpochMs };
    case "operation_pending":
      return operationId === undefined
        ? { kind: "error", code: "effect_unknown" }
        : { kind: "error", code: result.code, operationId, ...retry };
    case "mutation_not_admitted":
      return operationId === undefined
        ? { kind: "error", code: "effect_unknown" }
        : { kind: "error", code: result.code, operationId };
    case "effect_unknown":
      return operationId === undefined
        ? { kind: "error", code: result.code, ...retry }
        : { kind: "error", code: result.code, operationId, ...retry };
    case "storage_unavailable":
      return { kind: "error", code: "storage_unavailable" };
    default:
      return { kind: "error", code: result.code };
  }
}

/** Explicit remote artifact capability; no setting can enable it in the default loopback transport. */
interface RemoteFetchAdmission {
  /** Immutable original HTTPS origin, compared before native secret retrieval or dispatch. */
  readonly endpoint: string;
  /** Persists a fresh single-use ticket before dispatch; null fences Fetch without refunding prior work. */
  readonly ticket: () => string | null;
}
/** Finite loopback-default Fetch capability, intentionally absent from release main.ts and M3 composition. */
export class SyncDemoFetchRemote implements SyncDemoRemote {
  /** Original canonical route; remote capability pins exact HTTPS authority, while defaults remain loopback-only. */
  private readonly endpoint: string;
  /** Dispatch admissions in this explicit pass; failures never refund a consumed count. */
  private requests = 0;
  /** Secret/request/body settlement exclusion survives timeout and pass-budget reset. */
  private busy = false;
  /** Remote stopped/expired/auth-refused responses permanently fence automatic retries for this owner. */
  private terminal = false;
  /** Highest typed or HTTP rate-limit floor observed by this transport, in Unix milliseconds. */
  private retryAfterEpochMs = 0;
  /** Admits loopback by default or one explicit original HTTPS capability; only dispatch-time native secret lookup exposes a bearer to non-redirecting Fetch. */
  constructor(
    endpoint: string,
    private readonly binding: SyncDemoClientBinding,
    private readonly bearer: () => Promise<string | null>,
    private readonly fetcher: typeof fetch = fetch,
    private readonly deadlineMs = REQUEST_DEADLINE_MS,
    private readonly remote?: RemoteFetchAdmission,
    private readonly now: () => number = Date.now,
  ) {
    const url = new URL(endpoint);
    if (
      (remote
        ? endpoint !== remote.endpoint || !isSyncRemoteEndpoint(endpoint)
        : url.protocol !== SYNC_DEMO_URL_PROTOCOL ||
          !SYNC_DEMO_LOOPBACK_HOSTS.some((host) => host === url.hostname)) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      !Number.isSafeInteger(deadlineMs) ||
      deadlineMs <= 0 ||
      deadlineMs > REQUEST_DEADLINE_MS
    )
      throw new TypeError("Invalid synthetic loopback endpoint.");
    this.endpoint = new URL(SYNC_DEMO_ROUTE, url).href;
  }
  /** Reports unsettled secret/request/body ownership, including work surviving the scheduled deadline; never grants cancellation certainty.
   * @returns Whether late transport settlement still owns the single dispatch permit.
   */
  isBusy(): boolean {
    return this.busy;
  }
  /** Reports a remote admission refusal that a timer must never retry.
   * @returns Whether this transport observed a terminal remote refusal.
   */
  isTerminal(): boolean {
    return this.terminal;
  }
  /** Returns the observed floor before which no further remote ticket may be consumed.
   * @returns Highest server floor in Unix milliseconds, or zero when none is known.
   */
  retryFloorEpochMs(): number {
    return this.retryAfterEpochMs;
  }
  /** Resets finite admission for a serialized invocation; a late unsettled request still owns its permit. */
  beginPass(): void {
    this.requests = 0;
  }
  /** Maps only head-shaped responses; wrong-operation JSON never becomes absence/current evidence.
   * @param path Explicit admitted path to observe.
   * @returns Exact head evidence or sanitized unavailability/refusal.
   */
  async current(path: SyncNotePath): ReturnType<SyncDemoRemote["current"]> {
    if (!this.binding.paths.includes(path))
      return { kind: "error", code: "invalid_input" };
    const result = await this.request({
      operation: SYNC_DEMO_OPERATION.current,
      path,
    });
    if (result?.kind === "error") return failure(result);
    if (result?.kind === "never_seen") return result;
    if (result?.kind !== "live" && result?.kind !== "tombstone")
      return { kind: "error", code: "storage_unavailable" };
    const contentSha256 = createContentSha256(result.contentSha256);
    return contentSha256 === undefined
      ? { kind: "error", code: "storage_unavailable" }
      : { ...result, contentSha256 };
  }
  /** Maps only the requested immutable identity in the admitted vault/path scope; coordinator verifies body/hash/head linkage.
   * @param revision Original immutable identity, never a storage generation.
   * @returns Strict requested version, explicit absence or conservative failure.
   */
  async version(revision: SyncRevision): ReturnType<SyncDemoRemote["version"]> {
    const result = await this.request({
      operation: SYNC_DEMO_OPERATION.version,
      revision,
    });
    if (result?.kind === "error") return failure(result);
    if (result?.kind === "absent") return result;
    if (
      result?.kind !== "present" ||
      result.version.revision !== revision ||
      result.version.vaultId !== this.binding.vaultId ||
      !this.binding.paths.includes(result.version.path)
    )
      return { kind: "error", code: "storage_unavailable" };
    const contentSha256 = createContentSha256(result.version.contentSha256);
    return contentSha256 === undefined
      ? { kind: "error", code: "storage_unavailable" }
      : { kind: "present", version: { ...result.version, contentSha256 } };
  }
  /** Sends the original tuple with denial-only identity expectations; the authenticated server still selects vault/origin, and lost responses retain uncertainty.
   * @param request Original IDs, parent and transient bytes with exact configured binding.
   * @returns Matching committed response or typed uncertainty/refusal; HTTP 200 alone never acknowledges.
   */
  async mutate(
    request: Parameters<SyncDemoRemote["mutate"]>[0],
  ): ReturnType<SyncDemoRemote["mutate"]> {
    if (
      request.vaultId !== this.binding.vaultId ||
      request.origin !== this.binding.deviceId ||
      !this.binding.paths.includes(request.path)
    )
      return { kind: "error", code: "invalid_input" };
    const {
      vaultId: _vaultId,
      origin: _origin,
      contentSha256: _hash,
      mediaType: _mediaType,
      ...mutation
    } = request;
    const result = await this.request({
      operation: SYNC_DEMO_OPERATION.mutate,
      mutation,
    });
    if (result?.kind === "error") return failure(result);
    if (
      result?.kind === "committed" &&
      result.operationId === request.operationId &&
      result.revision === request.revision
    )
      return result;
    return {
      kind: "error",
      code: "effect_unknown",
      operationId: request.operationId,
    };
  }
  /** Verifies original/next vault-bound cursors and monotonic lane vectors; invalid/expired cursors stay failures, not repaired checkpoints.
   * @param cursor Original canonical checkpoint for this vault.
   * @returns A bounded monotonic page or failure without cursor repair.
   */
  async changes(cursor: string): ReturnType<SyncDemoRemote["changes"]> {
    const prior = decodeSyncCursor(cursor, this.binding.vaultId);
    if (prior === undefined) return { kind: "error", code: "invalid_cursor" };
    const result = await this.request({
      operation: SYNC_DEMO_OPERATION.changes,
      cursor,
    });
    if (result?.kind === "error") return failure(result);
    if (result?.kind !== "page")
      return { kind: "error", code: "storage_unavailable" };
    const next = decodeSyncCursor(result.nextCursor, this.binding.vaultId);
    if (
      next === undefined ||
      next.laneSequences.some(
        (sequence, lane) => sequence < (prior.laneSequences[lane] ?? sequence),
      ) ||
      result.events.some(
        (event) =>
          event.sequence <=
            (prior.laneSequences[event.lane] ?? event.sequence) ||
          event.sequence > (next.laneSequences[event.lane] ?? "") ||
          (event.kind === "changed" &&
            !this.binding.paths.includes(event.path)),
      )
    )
      return { kind: "error", code: "invalid_cursor" };
    return result;
  }
  /** Owns one count/late-request permit and an inclusive deadline; transport failure never asserts definite mutation failure.
   * @param input Closed operation-specific command before schema admission.
   * @returns Strict response or null when evidence/budget/deadline cannot be established.
   */
  private async request(input: WireRequest): Promise<WireResult | null> {
    if (
      this.terminal ||
      this.now() < this.retryAfterEpochMs ||
      this.busy ||
      this.requests >= SYNC_DEMO_CLIENT_LIMITS.requests
    )
      return null;
    const admitted = syncDemoRequestSchema.safeParse(input);
    if (!admitted.success) return null;
    this.requests += 1;
    this.busy = true;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const dispatched = this.dispatch(admitted.data, controller.signal)
      .catch(() => null)
      .finally(() => {
        this.busy = false;
      });
    const deadline = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(null);
      }, this.deadlineMs);
    });
    try {
      return await Promise.race([dispatched, deadline]);
    } finally {
      clearTimeout(timer);
    }
  }
  /** Decodes bounded fatal-UTF-8 JSON from HTTP 200 or the strict known HTTP 400 binding refusal, never success from an error status.
   * @param input Admitted wire command containing only the original request fields.
   * @param signal Inclusive dispatch/body deadline cancellation, never rollback evidence.
   * @returns Bounded schema-decoded JSON or null, without exposing raw transport failures.
   */
  private async dispatch(
    input: WireRequest,
    signal: AbortSignal,
  ): Promise<WireResult | null> {
    const bearer = await this.bearer();
    if (bearer === null || signal.aborted) return null;
    const ticket = this.remote?.ticket();
    if (this.remote && !syncRemoteTicketSchema.safeParse(ticket).success)
      return null;
    if (signal.aborted) return null;
    const response = await this.fetcher(this.endpoint, {
      method: HTTP_METHOD.post,
      headers: {
        [MIRROR_HTTP_HEADER.authorization]: `Bearer ${bearer}`,
        [MIRROR_HTTP_HEADER.contentType]: MIRROR_MEDIA_TYPE.json,
        [SYNC_DEMO_BINDING_HEADER.vaultId]: this.binding.vaultId,
        [SYNC_DEMO_BINDING_HEADER.origin]: this.binding.deviceId,
        ...(ticket == null ? {} : { [SYNC_REMOTE_TICKET_HEADER]: ticket }),
      },
      body: JSON.stringify(input),
      redirect: "error",
      cache: "no-store",
      signal,
    });
    if (
      this.remote &&
      [
        HTTP_STATUS_CODE.unauthorized,
        HTTP_STATUS_CODE.forbidden,
        SYNC_LAB_UNAVAILABLE_STATUS,
      ].includes(response.status)
    )
      this.terminal = true;
    if (this.remote && response.status === HTTP_STATUS_CODE.rateLimited) {
      const floor = retryAfterFloor(
        response.headers.get(RETRY_AFTER_HEADER),
        this.now(),
      );
      if (floor !== null)
        this.retryAfterEpochMs = Math.max(this.retryAfterEpochMs, floor);
    }
    if (
      (response.status !== HTTP_STATUS_CODE.ok &&
        response.status !== HTTP_STATUS_CODE.badRequest) ||
      response.headers
        .get(MIRROR_HTTP_HEADER.contentType)
        ?.split(";")[0]
        ?.trim()
        .toLowerCase() !== MIRROR_MEDIA_TYPE.json ||
      response.body === null
    ) {
      void response.body?.cancel().catch(() => {});
      return null;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let bytes = 0;
    let text = "";
    let done = false;
    try {
      while (!done) {
        const chunk = await reader.read();
        done = chunk.done;
        if (chunk.value !== undefined) {
          bytes += chunk.value.byteLength;
          if (bytes > MAX_RESPONSE_BYTES || signal.aborted) return null;
          text += decoder.decode(chunk.value, { stream: true });
        }
      }
      text += decoder.decode();
      if (response.status === HTTP_STATUS_CODE.badRequest) {
        const refusal = syncDemoTransportFailureSchema.safeParse(
          JSON.parse(text),
        );
        return refusal.success &&
          refusal.data.code === SYNC_DEMO_TRANSPORT_ERROR.bindingMismatch
          ? { kind: "error", code: "invalid_input" }
          : null;
      }
      const result = syncDemoResponseSchema.safeParse(JSON.parse(text));
      if (!result.success) return null;
      if (
        result.data.kind === "error" &&
        "retryAfterEpochMs" in result.data &&
        result.data.retryAfterEpochMs !== undefined
      )
        this.retryAfterEpochMs = Math.max(
          this.retryAfterEpochMs,
          result.data.retryAfterEpochMs,
        );
      return result.data;
    } finally {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}
