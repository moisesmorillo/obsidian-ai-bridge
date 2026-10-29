import { requestUrl } from "@plugin/obsidian-api";
import type { RequestUrlParam } from "obsidian";

/** Response metadata needed for pinned reads without decoding or normalizing content bytes. */
export interface OAuthTransportResponse {
	/** HTTP result status, including protocol error responses. */
	status: number;
	/** Response headers keyed by lowercase field name. */
	headers: Record<string, string>;
	/** Exact response text as returned by Obsidian requestUrl. */
	text: string;
}

/** Safe response boundary that never returns a host error or response body in exceptions. */
export interface OAuthTransport {
	/** Requests one endpoint through the host API and returns untrusted decoded data. */
	request(
		url: string,
		options?: Omit<RequestUrlParam, "url">,
	): Promise<unknown>;
	/** Preserves status, response headers, and exact text for authenticated file reads. */
	requestResponse?(
		url: string,
		options?: Omit<RequestUrlParam, "url">,
	): Promise<OAuthTransportResponse>;
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

	/** Returns safe response metadata while keeping raw bodies out of thrown errors. */
	async requestResponse(
		url: string,
		options: Omit<RequestUrlParam, "url"> = {},
	): Promise<OAuthTransportResponse> {
		try {
			const response = await requestUrl({ ...options, url, throw: false });
			return {
				status: response.status,
				headers: Object.fromEntries(
					Object.entries(response.headers).map(([name, value]) => [
						name.toLowerCase(),
						value,
					]),
				),
				text: response.text,
			};
		} catch {
			throw new Error("OAuth request failed");
		}
	}
}
