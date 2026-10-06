import demo from "@worker/demo/index";
import type { R2ConditionalBucketPort } from "@worker/infrastructure/r2.types";

interface Environment {
  readonly DEMO_BUCKET: R2ConditionalBucketPort;
  readonly DEMO_CONFIGURATION: string;
  readonly DEMO_CREDENTIAL_REGISTRY: string;
}
let epoch = 2_000_000_000_000;
let seeded = false;

export default {
  async fetch(request: Request, environment: Environment): Promise<Response> {
    epoch += 5000;
    Date.now = () => epoch;
    if (!seeded) {
      await environment.DEMO_BUCKET.put(
        "vault/m8-legacy-sentinel.md",
        "unchanged-v2",
        {
          onlyIf: new Headers({ "If-None-Match": "*" }),
          customMetadata: { format: "synthetic-legacy" },
          httpMetadata: { contentType: "text/plain" },
        },
      );
      seeded = true;
    }
    let calls = 0;
    const bucket: R2ConditionalBucketPort = {
      get: async (key) => {
        calls += 1;
        return environment.DEMO_BUCKET.get(key);
      },
      put: async (key, bytes, options) => {
        calls += 1;
        return environment.DEMO_BUCKET.put(key, bytes, options);
      },
      list: async (options) => {
        calls += 1;
        return environment.DEMO_BUCKET.list(options);
      },
    };
    const response = await demo.fetch(request, {
      ...environment,
      DEMO_BUCKET: bucket,
    });
    const sentinel = await environment.DEMO_BUCKET.get(
      "vault/m8-legacy-sentinel.md",
    );
    const headers = new Headers(response.headers);
    headers.set("Test-Store-Calls", String(calls));
    headers.set(
      "Test-Legacy",
      sentinel === null
        ? "missing"
        : new TextDecoder().decode(await sentinel.arrayBuffer()),
    );
    return new Response(response.body, { status: response.status, headers });
  },
};
