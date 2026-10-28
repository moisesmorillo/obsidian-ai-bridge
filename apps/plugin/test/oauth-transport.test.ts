import { beforeEach, describe, expect, it, vi } from "vitest";

const requestUrlMock = vi.hoisted(() => vi.fn());

vi.mock("../src/obsidian-api", () => ({ requestUrl: requestUrlMock }));

import { ObsidianOAuthTransport } from "../src/infrastructure/oauth-transport";

describe("ObsidianOAuthTransport", () => {
	beforeEach(() => requestUrlMock.mockReset());

	it("forwards requestUrl parameters and returns decoded response data", async () => {
		requestUrlMock.mockResolvedValue({
			status: 200,
			json: { access_token: "synthetic-access" },
		});
		const transport = new ObsidianOAuthTransport();
		await expect(
			transport.request("https://service.test/oauth/token", {
				method: "POST",
				contentType: "application/x-www-form-urlencoded",
				body: "grant_type=authorization_code",
			}),
		).resolves.toEqual({ access_token: "synthetic-access" });
		expect(requestUrlMock).toHaveBeenCalledWith({
			method: "POST",
			contentType: "application/x-www-form-urlencoded",
			body: "grant_type=authorization_code",
			url: "https://service.test/oauth/token",
			throw: false,
		});
	});

	it("hides host errors and non-success response bodies", async () => {
		const transport = new ObsidianOAuthTransport();
		requestUrlMock.mockResolvedValue({ status: 400, text: "provider secret" });
		await expect(
			transport.request("https://service.test/oauth/token"),
		).rejects.toThrow("OAuth request failed");
		requestUrlMock.mockRejectedValueOnce("host secret");
		await expect(
			transport.request("https://service.test/oauth/token"),
		).rejects.toThrow("OAuth request failed");
	});
});
