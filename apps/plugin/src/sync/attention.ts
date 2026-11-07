import type { DeviceState } from "@obsidian-ai-bridge/protocol";

/** One validated journal attention item used to match a dismissal to exact evidence. */
export type DeviceAttention = DeviceState["attention"][number];

/** Returns an unambiguous key for one path, reason, and optional operation identity. */
export function getAttentionKey(item: DeviceAttention): string {
	return JSON.stringify([item.path, item.reason, item.operation?.key ?? null]);
}

/** Identifies only the three informational reasons that owners may dismiss in bulk. */
export function isInformationalAttention(item: DeviceAttention): boolean {
	return (
		item.reason === "Local binary bytes were preserved as a conflict copy" ||
		item.reason === "Local file changed after publication was queued" ||
		item.reason === "Local text met newer remote content"
	);
}
