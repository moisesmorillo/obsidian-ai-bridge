import {
  MUTATION_EFFECT_CERTAINTY,
  REMOTE_BRIDGE_FAILURE,
  type RemoteBridgeMutationResult,
  type RemoteBridgeResult,
  type RemoteRequestAdmission,
} from "@obsidian-ai-bridge/core";
import { MIRROR_HTTP_HEADER } from "@obsidian-ai-bridge/protocol";
import {
  decodeStrictUtf8,
  readBoundedResponseBytes,
} from "@obsidian-plugin/remote/bounded-response-reader";
import {
  REMOTE_FETCH_OPTIONS,
  REMOTE_REQUEST_DEADLINE_MILLISECONDS,
} from "@obsidian-plugin/remote/fetch-remote-bridge.constants";
import type {
  FetchRemoteBridgeDependencies,
  RemoteFetch,
} from "@obsidian-plugin/remote/fetch-remote-bridge.types";
import type { RemoteHttpMethod } from "@obsidian-plugin/remote/remote-response-policy";

type FetchRequestDispatcherDependencies = Pick<
  FetchRemoteBridgeDependencies,
  | "admission"
  | "cancellation"
  | "deadlineMilliseconds"
  | "fetch"
  | "origin"
  | "secretReference"
  | "secretStorage"
>;

interface RemoteHttpRequest {
  readonly method: RemoteHttpMethod;
  readonly path: string;
  readonly headers?: HeadersInit;
  readonly body?: BodyInit | null;
}

type RemoteBridgeFailureResult = Extract<
  RemoteBridgeResult<never>,
  { readonly kind: "failure" }
>;

type DispatchResult =
  | {
      readonly kind: "response";
      readonly response: Response;
      readonly signal: AbortSignal;
      readonly release: () => void;
    }
  | {
      readonly kind: "failure";
      readonly failure: RemoteBridgeFailureResult["failure"];
      readonly dispatched: boolean;
    };

/**
 * Owns Fetch admission, just-in-time authentication, deadlines, and settlement.
 *
 * Admission begins before secret retrieval and remains held until the Fetch promise,
 * response cancellation, and any interrupted body stream have all settled. The
 * dispatch boundary is crossed only after Fetch returns a promise; failures before
 * that point are safe to report as not dispatched. Abort is not treated as proof of
 * cancellation, so a timed-out Fetch keeps its permit until late settlement.
 */
export class FetchRequestDispatcher {
  private readonly fetch: RemoteFetch | null | undefined;
  private readonly deadlineMilliseconds: number;
  private readonly responseSettlements = new WeakMap<Response, Promise<void>>();

  /** @param dependencies - Validated endpoint, secret, admission, and Fetch seams. */
  constructor(
    private readonly dependencies: FetchRequestDispatcherDependencies,
  ) {
    this.fetch =
      dependencies.fetch === undefined ? globalThis.fetch : dependencies.fetch;
    this.deadlineMilliseconds =
      dependencies.deadlineMilliseconds ?? REMOTE_REQUEST_DEADLINE_MILLISECONDS;
  }

  /**
   * Executes one read request while retaining admission through body settlement.
   *
   * @param request - Fully classified method/path and operation-specific headers.
   * @param consume - Response decoder that may register bounded body settlement.
   * @returns Decoded result or sanitized pre-response transport failure.
   */
  async executeRead<Value>(
    request: RemoteHttpRequest,
    consume: (
      response: Response,
      signal: AbortSignal,
    ) => Promise<RemoteBridgeResult<Value>>,
  ): Promise<RemoteBridgeResult<Value>> {
    const dispatched = await this.dispatch(request);
    if (dispatched.kind === "failure") return failure(dispatched.failure);
    try {
      return await consume(dispatched.response, dispatched.signal);
    } finally {
      this.releaseAfterResponseSettlement(
        dispatched.response,
        dispatched.release,
      );
    }
  }

  /**
   * Executes one mutation while preserving certainty at the exact dispatch boundary.
   *
   * @param request - Fully classified method/path and operation-specific headers/body.
   * @param consume - Response decoder that owns post-response effect classification.
   * @returns Confirmed result or failure with conservative dispatch certainty.
   */
  async executeMutation<Value>(
    request: RemoteHttpRequest,
    consume: (
      response: Response,
      signal: AbortSignal,
    ) => Promise<RemoteBridgeMutationResult<Value>>,
  ): Promise<RemoteBridgeMutationResult<Value>> {
    const dispatched = await this.dispatch(request);
    if (dispatched.kind === "failure") {
      return {
        kind: "failure",
        failure: dispatched.failure,
        effect: dispatched.dispatched
          ? MUTATION_EFFECT_CERTAINTY.unknown
          : MUTATION_EFFECT_CERTAINTY.notDispatched,
      };
    }
    try {
      return await consume(dispatched.response, dispatched.signal);
    } finally {
      this.releaseAfterResponseSettlement(
        dispatched.response,
        dispatched.release,
      );
    }
  }

  /**
   * Reads and strictly decodes one bounded response body under the request deadline.
   *
   * @param response - Fetch response whose body belongs to the active admission permit.
   * @param maximumBytes - Inclusive operation-specific response limit in bytes.
   * @param signal - Full-operation deadline signal.
   * @returns Strict UTF-8 text or a sanitized body/settlement failure.
   */
  async readText(
    response: Response,
    maximumBytes: number,
    signal: AbortSignal,
  ): Promise<RemoteBridgeResult<string>> {
    const result = await readBoundedResponseBytes(
      response,
      maximumBytes,
      signal,
    );
    if (result.kind === "ok") {
      const text = decodeStrictUtf8(result.bytes);
      return text === undefined
        ? failure(REMOTE_BRIDGE_FAILURE.malformedResponse)
        : success(text);
    }
    if ("settlement" in result) {
      this.responseSettlements.set(response, result.settlement);
    }
    if (result.kind === "aborted") {
      return failure(REMOTE_BRIDGE_FAILURE.timedOut);
    }
    if (result.kind === "stream-error") {
      return failure(REMOTE_BRIDGE_FAILURE.networkUnavailable);
    }
    return failure(REMOTE_BRIDGE_FAILURE.malformedResponse);
  }

  /** @returns Whether the host provides every capability required by the Fetch adapter. */
  isRuntimeSupported(): boolean {
    return (
      this.fetch !== undefined &&
      this.fetch !== null &&
      typeof this.dependencies.secretStorage.getSecret === "function" &&
      typeof AbortController !== "undefined" &&
      typeof Headers !== "undefined" &&
      typeof URL !== "undefined" &&
      typeof TextDecoder !== "undefined" &&
      typeof TextEncoder !== "undefined" &&
      typeof btoa === "function"
    );
  }

  /**
   * Dispatches one admitted Fetch and returns a permit-bound response.
   *
   * @param request - Complete HTTP request using a policy-owned method and route.
   * @returns Response ownership or a failure marked by whether Fetch returned a promise.
   */
  private async dispatch(request: RemoteHttpRequest): Promise<DispatchResult> {
    if (!this.isRuntimeSupported()) {
      return {
        kind: "failure",
        failure: REMOTE_BRIDGE_FAILURE.unsupportedRuntime,
        dispatched: false,
      };
    }
    let permit: Awaited<ReturnType<RemoteRequestAdmission["admit"]>>;
    try {
      permit = await this.dependencies.admission.admit();
    } catch {
      return {
        kind: "failure",
        failure: REMOTE_BRIDGE_FAILURE.admissionDenied,
        dispatched: false,
      };
    }
    if (permit === undefined) {
      return {
        kind: "failure",
        failure: REMOTE_BRIDGE_FAILURE.admissionDenied,
        dispatched: false,
      };
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unregisterCancellation: (() => void) | undefined;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      if (timer !== undefined) clearTimeout(timer);
      unregisterCancellation?.();
      permit.release();
    };
    const fetch = this.fetch;
    if (fetch === undefined || fetch === null) {
      release();
      return {
        kind: "failure",
        failure: REMOTE_BRIDGE_FAILURE.unsupportedRuntime,
        dispatched: false,
      };
    }
    let bearer: string | null;
    try {
      bearer =
        this.dependencies.secretStorage.getSecret?.(
          this.dependencies.secretReference,
        ) ?? null;
    } catch {
      release();
      return {
        kind: "failure",
        failure: REMOTE_BRIDGE_FAILURE.missingSecret,
        dispatched: false,
      };
    }
    if (bearer === null || bearer.length === 0) {
      release();
      return {
        kind: "failure",
        failure: REMOTE_BRIDGE_FAILURE.missingSecret,
        dispatched: false,
      };
    }
    let url: URL;
    try {
      url = new URL(request.path, this.dependencies.origin);
    } catch {
      release();
      return {
        kind: "failure",
        failure: REMOTE_BRIDGE_FAILURE.invalidConfiguration,
        dispatched: false,
      };
    }
    const controller = new AbortController();
    unregisterCancellation =
      this.dependencies.cancellation?.register(controller);
    if (controller.signal.aborted) {
      release();
      return {
        kind: "failure",
        failure: REMOTE_BRIDGE_FAILURE.admissionDenied,
        dispatched: false,
      };
    }
    timer = setTimeout(() => controller.abort(), this.deadlineMilliseconds);
    let fetchResult: Response | undefined;
    let dispatched = false;
    try {
      const headers = new Headers(request.headers);
      headers.set(MIRROR_HTTP_HEADER.authorization, `Bearer ${bearer}`);
      const promise = fetch(url, {
        ...REMOTE_FETCH_OPTIONS,
        method: request.method,
        headers,
        ...(request.body === undefined ? {} : { body: request.body }),
        signal: controller.signal,
      });
      dispatched = true;
      const raced = await raceFetchWithAbort(promise, controller.signal);
      if (raced.kind === "aborted") {
        releaseAfterLateFetchSettlement(promise, release);
        return {
          kind: "failure",
          failure: REMOTE_BRIDGE_FAILURE.timedOut,
          dispatched: true,
        };
      }
      fetchResult = raced.response;
      return {
        kind: "response",
        response: fetchResult,
        signal: controller.signal,
        release,
      };
    } catch {
      return {
        kind: "failure",
        failure: dispatched
          ? controller.signal.aborted
            ? REMOTE_BRIDGE_FAILURE.timedOut
            : REMOTE_BRIDGE_FAILURE.networkUnavailable
          : REMOTE_BRIDGE_FAILURE.invalidConfiguration,
        dispatched,
      };
    } finally {
      if (
        fetchResult === undefined &&
        (!controller.signal.aborted || !dispatched)
      ) {
        release();
      }
    }
  }

  /** Retains admission until response cancellation and body work actually settle. */
  private releaseAfterResponseSettlement(
    response: Response,
    release: () => void,
  ): void {
    const bodySettlement = this.responseSettlements.get(response);
    this.responseSettlements.delete(response);
    const settlements = [cancelResponse(response)];
    if (bodySettlement !== undefined) settlements.push(bodySettlement);
    void Promise.all(settlements)
      .finally(release)
      .catch(() => undefined);
  }
}

function success<Value>(value: Value): RemoteBridgeResult<Value> {
  return { kind: "success", value };
}

function failure(
  failureKind: RemoteBridgeFailureResult["failure"],
): RemoteBridgeFailureResult {
  return { kind: "failure", failure: failureKind };
}

/**
 * Races Fetch settlement against the request deadline without claiming cancellation.
 *
 * @param promise - Original Fetch promise retained for late settlement.
 * @param signal - Deadline signal for the complete operation.
 * @returns The first response or deadline observation.
 */
async function raceFetchWithAbort(
  promise: Promise<Response>,
  signal: AbortSignal,
): Promise<
  | { readonly kind: "response"; readonly response: Response }
  | { readonly kind: "aborted" }
> {
  if (signal.aborted) return { kind: "aborted" };
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve({ kind: "aborted" });
    signal.addEventListener("abort", onAbort, { once: true });
    void promise
      .then((response) => resolve({ kind: "response", response }), reject)
      .finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/**
 * Best-effort cancels a response body before releasing request admission.
 *
 * @param response - Response whose unread body may retain transport resources.
 */
async function cancelResponse(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    return;
  }
}

/**
 * Releases a timed-out request only after the original Fetch and late body settle.
 *
 * @param promise - Original Fetch promise that outlived the deadline.
 * @param release - Idempotent admission release callback.
 */
function releaseAfterLateFetchSettlement(
  promise: Promise<Response>,
  release: () => void,
): void {
  void promise
    .then(cancelResponse, () => undefined)
    .finally(release)
    .catch(() => undefined);
}
