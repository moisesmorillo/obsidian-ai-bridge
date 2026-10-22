import {
	encodeJsonChunks,
	jsonReadSource,
	ownedReadResponse,
} from "@worker/transport/read-response";
import { describe, expect, it, vi } from "vitest";

/** Verify search output retains shared response ownership through EOF. */
describe("search response ownership", () => {
	it("keeps the slot after the data chunk until the consumer requests EOF", async () => {
		const release = vi.fn();
		const finish = vi.fn(async () => ({ ok: true as const }));
		const response = ownedReadResponse(
			jsonReadSource(encodeJsonChunks({ results: [] })),
			{ finish },
			release,
		);
		const reader = response.body?.getReader();
		expect(reader).toBeDefined();
		let json = "";
		while (!json.endsWith("}")) {
			const data = await reader?.read();
			expect(data?.done).toBe(false);
			json += new TextDecoder().decode(data?.value);
		}
		expect(json).toBe('{"results":[]}');
		expect(release).not.toHaveBeenCalled();
		await reader?.read();
		expect(finish).toHaveBeenCalledWith("settled");
		expect(release).toHaveBeenCalledTimes(1);
	});
});
