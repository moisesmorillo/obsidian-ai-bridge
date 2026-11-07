/** Validate one lowercase UUID v4 used as a blob-GC run or delete-owner identity. */
export function isBlobGcRunId(value: string): boolean {
	return /^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/.test(
		value,
	);
}
