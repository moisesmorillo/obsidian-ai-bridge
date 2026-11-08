/** Format byte observations as decimal megabytes without implying storage capacity. */
export function formatBytes(bytes: number): string {
	if (bytes < 100_000) return "under 0.1 MB";
	return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/** Format counts compactly above one thousand while preserving smaller values. */
export function formatCount(count: number): string {
	if (count < 1_000) return String(count);
	const thousands = count / 1_000;
	return `${Number(thousands.toFixed(1))}k`;
}

/** Format an observed duration in milliseconds with its explicit unit. */
export function formatDuration(milliseconds: number): string {
	return `${milliseconds} ms`;
}

/** Show one valid instant as a single-line UTC date and time. */
export function formatUtcDateTime(value: string | number): string {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return "Unknown";
	return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** Show one valid instant as an HH:mm UTC time. */
export function formatUtcTime(
	value: string | number | null | undefined,
): string {
	if (value === null || value === undefined) return "Unknown";
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return "Unknown";
	return date.toISOString().slice(11, 16);
}
