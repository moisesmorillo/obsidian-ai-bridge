import { requestUrl } from "@plugin/obsidian-api";
import type { RequestUrlParam } from "obsidian";

/** Safe response boundary that never returns a host error or response body in exceptions. */
export interface OAuthTransport {
	/** Requests one endpoint through the host API and returns untrusted decoded data. */
	request(
		url: string,
		options?: Omit<RequestUrlParam, "url">,
	): Promise<unknown>;
}

/** Uses Obsidian's network API and maps all transport failures to non-sensitive errors. */
export class ObsidianOAuthTransport implements OAuthTransport {
	/** Replaces host exceptions and response bodies with one safe failure message. */
	async request(
		url: string,
		options: Omit<RequestUrlParam, "url"> = {},
	): Promise<unknown> {
		try {
			const response = await requestUrl({ ...options, url, throw: false });
			if (response.status < 200 || response.status >= 300)
				throw new Error("OAuth request failed");
			return response.json as unknown;
		} catch {
			throw new Error("OAuth request failed");
		}
	}
}
