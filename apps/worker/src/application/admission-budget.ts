/** Shared admission ceiling for MCP requests and REST body operations, in bytes. */
export const ADMISSION_SHARED_BYTE_LIMIT = 64_000_000;
/** Separate admission ceiling for four REST authoritative read responses, in bytes. */
export const REST_READ_BYTE_LIMIT = 18_000_000;
/** Maximum REST read reservation, in bytes. */
export const REST_READ_BYTE_ALLOWANCE = 4_500_000;
/** Ordinary REST body reservation, in bytes. */
export const REST_BODY_BYTE_ALLOWANCE = 8_000_000;
/** REST heading append reservation, in bytes. */
export const REST_HEADING_APPEND_BYTE_ALLOWANCE = 32_000_000;
/** Maximum MCP envelope wire size, in bytes. */
export const MCP_ENVELOPE_BYTE_LIMIT = 6_100_000;
/** Maximum active MCP admission reservations. */
export const MCP_ADMISSION_COUNT_LIMIT = 8;
/** Local refusal delay, in seconds, when no physical release time is known. */
export const LOCAL_ADMISSION_RETRY_SECONDS = 2;
/** Maximum MCP admission wait, in milliseconds. */
export const MCP_ADMISSION_WAIT_MS = 2_000;
/** Maximum queued MCP requests per isolate. */
export const MCP_ADMISSION_QUEUE_LIMIT = 30;

/** Byte pool charged for one request's owned application work. */
export type AdmissionByteClass = "rest_body" | "mcp" | "rest_read";

/** Idempotent ownership handle with no reference to request payload data. */
export interface AdmissionByteReservation {
	/** Reserved byte count, in decimal bytes. */
	readonly bytes: number;
	/** Release these reserved bytes once. */
	release(): void;
}

/** State held for one live reservation. */
interface ReservationState {
	readonly byteClass: AdmissionByteClass;
	readonly bytes: number;
}

/** One queued MCP admission with one bounded timer and abort listener. */
interface McpWaiter {
	readonly bytes: number;
	readonly expiresAt: number;
	readonly signal: AbortSignal;
	readonly resolve: (result: McpAdmissionResult) => void;
	timer: ReturnType<typeof setTimeout>;
	abort: () => void;
	settled: boolean;
}

/** Result of bounded MCP admission before body demand. */
export type McpAdmissionResult =
	| { kind: "admitted"; reservation: AdmissionByteReservation }
	| { kind: "refused"; retryAfterSeconds: number };

const reservations = new Map<number, ReservationState>();
const mcpReservations = new Set<number>();
const mcpWaiters: McpWaiter[] = [];
let nextReservationId = 0;
let sharedBytes = 0;
let restReadBytes = 0;

/** Return the byte ceiling for one admission pool. */
function limitFor(byteClass: AdmissionByteClass): number {
	return byteClass === "rest_read"
		? REST_READ_BYTE_LIMIT
		: ADMISSION_SHARED_BYTE_LIMIT;
}

/** Current bytes owned by one pool. */
function usageFor(byteClass: AdmissionByteClass): number {
	return byteClass === "rest_read" ? restReadBytes : sharedBytes;
}

/** Change the byte count owned by one pool. */
function changeUsage(byteClass: AdmissionByteClass, delta: number): void {
	if (byteClass === "rest_read") restReadBytes += delta;
	else sharedBytes += delta;
}

/** Reserve weighted capacity before allocating or demanding the related body. */
export function tryReserveAdmissionBytes(
	byteClass: AdmissionByteClass,
	bytes: number,
): AdmissionByteReservation | undefined {
	if (!Number.isSafeInteger(bytes) || bytes <= 0) return undefined;
	if (byteClass === "rest_read" && bytes > REST_READ_BYTE_ALLOWANCE)
		return undefined;
	if (usageFor(byteClass) + bytes > limitFor(byteClass)) return undefined;
	return createReservation(byteClass, bytes);
}

/** Compute the conservative MCP byte reservation from checked wire bytes. */
export function mcpAdmissionBytes(checkedWireBytes: number): number {
	if (
		!Number.isSafeInteger(checkedWireBytes) ||
		checkedWireBytes < 0 ||
		checkedWireBytes > MCP_ENVELOPE_BYTE_LIMIT
	)
		throw new RangeError("MCP byte bound is outside the checked wire limit");
	if (checkedWireBytes === MCP_ENVELOPE_BYTE_LIMIT)
		return ADMISSION_SHARED_BYTE_LIMIT;
	return (
		4_000_000 + 8 * checkedWireBytes + 128 * Math.min(checkedWireBytes, 65_536)
	);
}

/** Wait for count and weighted byte capacity without demanding the queued request body. */
export function acquireMcpAdmission(
	bytes: number,
	signal: AbortSignal,
): Promise<McpAdmissionResult> {
	if (
		!Number.isSafeInteger(bytes) ||
		bytes <= 0 ||
		bytes > ADMISSION_SHARED_BYTE_LIMIT
	)
		return Promise.resolve({
			kind: "refused",
			retryAfterSeconds: LOCAL_ADMISSION_RETRY_SECONDS,
		});
	if (signal.aborted)
		return Promise.resolve({
			kind: "refused",
			retryAfterSeconds: LOCAL_ADMISSION_RETRY_SECONDS,
		});
	wakeMcpWaiters();
	if (canAdmitMcp(bytes))
		return Promise.resolve({
			kind: "admitted",
			reservation: createMcpReservation(bytes),
		});
	if (mcpWaiters.length >= MCP_ADMISSION_QUEUE_LIMIT)
		return Promise.resolve({
			kind: "refused",
			retryAfterSeconds: LOCAL_ADMISSION_RETRY_SECONDS,
		});
	return new Promise((resolve) => {
		/** Remove a refused waiter, then reconsider the remaining queue. */
		const refuse = () => {
			settleWaiter(waiter, false);
			wakeMcpWaiters();
		};
		const waiter: McpWaiter = {
			bytes,
			expiresAt: Date.now() + MCP_ADMISSION_WAIT_MS,
			signal,
			resolve,
			timer: setTimeout(refuse, MCP_ADMISSION_WAIT_MS),
			abort: refuse,
			settled: false,
		};
		signal.addEventListener("abort", waiter.abort, { once: true });
		mcpWaiters.push(waiter);
		wakeMcpWaiters();
	});
}

/** Check MCP count and shared byte capacity together. */
function canAdmitMcp(bytes: number): boolean {
	return (
		mcpReservations.size < MCP_ADMISSION_COUNT_LIMIT &&
		sharedBytes + bytes <= ADMISSION_SHARED_BYTE_LIMIT
	);
}

/** Create MCP-owned bytes whose release also wakes eligible queued requests. */
function createMcpReservation(bytes: number): AdmissionByteReservation {
	const reservation = createReservation("mcp", bytes, false);
	const id = nextReservationId;
	mcpReservations.add(id);
	return {
		bytes,
		/** Release this MCP envelope and wake eligible waiters. */
		release() {
			if (!mcpReservations.has(id)) return;
			mcpReservations.delete(id);
			reservation.release();
			wakeMcpWaiters();
		},
	};
}

/** Create an idempotent reservation without scheduler ownership. */
function createReservation(
	byteClass: AdmissionByteClass,
	bytes: number,
	wakeWaiters = true,
): AdmissionByteReservation {
	const id = ++nextReservationId;
	let released = false;
	changeUsage(byteClass, bytes);
	reservations.set(id, { byteClass, bytes });
	return {
		bytes,
		/** Release this reservation once and wake eligible MCP waiters. */
		release() {
			if (released) return;
			released = true;
			const reservation = reservations.get(id);
			if (!reservation) return;
			reservations.delete(id);
			changeUsage(reservation.byteClass, -reservation.bytes);
			if (wakeWaiters) wakeMcpWaiters();
		},
	};
}

/** Remove one waiter and return either its reservation or a bounded refusal. */
function settleWaiter(waiter: McpWaiter, admitted: boolean): void {
	if (waiter.settled) return;
	waiter.settled = true;
	clearTimeout(waiter.timer);
	waiter.signal.removeEventListener("abort", waiter.abort);
	const index = mcpWaiters.indexOf(waiter);
	if (index >= 0) mcpWaiters.splice(index, 1);
	waiter.resolve(
		admitted
			? { kind: "admitted", reservation: createMcpReservation(waiter.bytes) }
			: { kind: "refused", retryAfterSeconds: LOCAL_ADMISSION_RETRY_SECONDS },
	);
}

/** Admit eligible waiters in queue order without allowing a large waiter to block smaller work. */
function wakeMcpWaiters(): void {
	for (let index = 0; index < mcpWaiters.length; ) {
		const waiter = mcpWaiters[index];
		if (!waiter) return;
		if (waiter.settled) {
			mcpWaiters.splice(index, 1);
			continue;
		}
		if (waiter.signal.aborted || Date.now() >= waiter.expiresAt) {
			settleWaiter(waiter, false);
			continue;
		}
		if (!canAdmitMcp(waiter.bytes)) {
			index += 1;
			continue;
		}
		settleWaiter(waiter, true);
	}
}

/** Return current reservation totals for invariant tests without retaining payload data. */
export function admissionByteSnapshot(): {
	shared_bytes: number;
	rest_read_bytes: number;
	active_reservations: number;
	queued_mcp_requests: number;
} {
	return {
		shared_bytes: sharedBytes,
		rest_read_bytes: restReadBytes,
		active_reservations: reservations.size,
		queued_mcp_requests: mcpWaiters.length,
	};
}
