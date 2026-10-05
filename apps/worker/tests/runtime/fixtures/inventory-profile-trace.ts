import { appendFileSync, readFileSync } from "node:fs";
import {
  profileMetricsSchema,
  profileRequestSchema,
} from "@worker-tests/runtime/fixtures/inventory-profile.contract";
import { z } from "zod";

/** Content-free synthetic dispatch intent is written before any native effect can occur. */
const dispatchSchema = z
  .object({
    kind: z.literal("dispatch"),
    id: z.uuid(),
    request: profileRequestSchema,
    startedAtMs: z.number().int().nonnegative(),
  })
  .strict();
/** Observed native acknowledgement records exact request-local counters, never inferred missing calls. */
const replySchema = z
  .object({
    kind: z.literal("reply"),
    id: z.uuid(),
    action: z.enum(["seed", "start", "continue", "page"]),
    startedAtMs: z.number().int().nonnegative(),
    finishedAtMs: z.number().int().nonnegative(),
    status: z.number().int(),
    metrics: profileMetricsSchema,
    result: z.string(),
    hostRssBytes: z.number().int().nonnegative(),
  })
  .strict();
/** Ordered private trace retains dispatch intent separately from observed acknowledgement. */
const traceSchema = z.discriminatedUnion("kind", [dispatchSchema, replySchema]);
/** Appends one validated intent/acknowledgement; atomic checkpoints cannot erase prior measured attempts.
 * @param path Locked local trace path.
 * @param entry Content-free synthetic operation or observed request-local counters.
 */
export function appendProfileTrace(
  path: string,
  entry: z.input<typeof traceSchema>,
): void {
  appendFileSync(path, `${JSON.stringify(traceSchema.parse(entry))}\n`);
}
/** Classifies every intent/reply pair; missing replies remain unresolved, not zero calls.
 * @param path Retained trace already bound to its exact persistence pair.
 * @returns Observed counters and unresolved intent count; corrupt or duplicate acknowledgements throw.
 */
export function readProfileTrace(path: string) {
  const pending = new Map<string, z.infer<typeof dispatchSchema>>();
  const ids = new Set<string>();
  const replies: z.infer<typeof replySchema>[] = [];
  const lines = readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
  for (const line of lines) {
    const entry = traceSchema.parse(JSON.parse(line));
    if (entry.kind === "dispatch") {
      if (ids.has(entry.id)) throw new RangeError("Duplicate dispatch intent.");
      ids.add(entry.id);
      pending.set(entry.id, entry);
      continue;
    }
    const intent = pending.get(entry.id);
    if (
      intent === undefined ||
      entry.action !== intent.request.action ||
      entry.startedAtMs !== intent.startedAtMs ||
      entry.finishedAtMs < entry.startedAtMs
    )
      throw new RangeError("Unbound trace acknowledgement.");
    replies.push(entry);
    pending.delete(entry.id);
  }
  return {
    requests: ids.size,
    replies,
    unresolvedRequests: pending.size,
    accountingComplete: pending.size === 0,
  };
}
