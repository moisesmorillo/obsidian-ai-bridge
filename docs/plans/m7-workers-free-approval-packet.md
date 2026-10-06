# Isolated Workers Free experiment: approval packet

**Not authorized or executed.** This is a proposed synthetic experiment, not a Free-tier support claim. No Cloudflare account, API, credential or deployment has been accessed. Current platform prices, limits, account headroom and availability of per-invocation CPU/heap observations are therefore **unverified preflight blockers**.

## Approval scope

Use an isolated test account on Workers Free, one private test Worker and one new empty disposable R2 bucket. No production Worker, bucket, binding, route, custom domain, credential registry, plugin or personal vault participates. Disable public unauthenticated invocation; reject unauthorized requests before R2 dispatch. Fix the exact source SHA, compiled fixture digest and synthetic recipe in the approval record.

Approve provisioning, credential use, one bounded profile at a time, evidence export and whole-test-bucket teardown separately. A local green result does not grant any of these permissions.

## Admission and stop budgets

| Resource | Proposed experiment ceiling | Required preflight |
| --- | --- | --- |
| Worker requests | 90,000/day, including setup, polling, retries, recovery, paging, probes and cleanup | Verify current Free daily limit, reset boundary and existing usage; retain at least 10% headroom |
| Physical R2 calls | Project ceiling: 400/request; the applicable provider Free ceiling may be lower | Verify all applicable Worker/binding subrequest and connection limits; any incompatible lower limit blocks this recipe. Reserve unknown-response worst case before dispatch; count setup/teardown separately |
| R2 Class A attempts | 150,000 total, including PUT, LIST, DELETE and unknown attempts conservatively classified as A | Verify operation classification, current price and remaining account allowance |
| R2 Class B attempts | 1,000,000 total, including all GET/control/read-back/recovery attempts | Verify current price and account allowance |
| Storage | 0.5 GiB logical stored data; 72 hours maximum test-resource lifetime | Include failed scans, witnesses/journals, claims, permanent manifests, immutable records and provider accounting overhead |
| Incremental cost | USD 2.00 **proposed**, not an approved spend or provider-enforced cap | Recompute with verified prices, billing units, rounding and tax; stop before the reserved next dispatch can exceed it |
| Isolate CPU | Accepted M7 target: 10 ms/request | Verify Free target and a trustworthy per-invocation observation channel; unavailable or sampled-only maxima block qualification |
| Isolate memory | Current platform ceiling is unverified | Verify the limit and observation/enforcement channel; Node RSS is not evidence |
| Scan duration | Existing 24-hour inventory expiry; never extended | Include seeding/pacing/recovery budget and abort incomplete/expired scans truthfully |

Provisional cost stress calculation uses **price caps**, not asserted current rates: Class A <= USD 5/million, Class B <= USD 1/million and storage <= USD 0.02/GiB-month. If current verified prices exceed any cap, this packet is not executable without recalculation. For 150,000 A + 1,000,000 B + 0.5 GiB held for 72 hours using a conservative 28-day month:

`0.15 * 5 + 1 * 1 + 0.5 * (72 / 672) * 0.02 = USD 1.751072`

This leaves approximately USD 0.248928 before rounding/tax/other chargeable operations. Do not assume monthly free allowance or an empty account. If the verified all-in worst case exceeds USD 2, stop before provisioning. Monitoring is not a hard provider billing cap; a client/server reservation mechanism and a private endpoint are mandatory.

The previous local 1,000-head recipe used 10,105 requests and 76,830 R2 attempts. Linear extrapolation to 10,000 heads gives 101,050 requests, already over this proposed daily request budget. This is a warning, not a measured 10,000-head result: **do not deploy that recipe unchanged**. Qualify a lower-polling request schedule locally and recompute with actual maximal/fault measurements, or keep remote admission blocked. Splitting a scan across a daily reset does not waive its 24-hour expiry.

## Credentials and resource identity

Operator supplies the account identity and confirms it contains no production resources available to the test credential. Request only verified permissions needed for test Worker deployment, creation/deletion of the disposable bucket, test-secret installation and the selected read-only telemetry channel. Permission names and resource-level scoping must be verified before token issuance; do not assume the API can constrain edits to one Worker name.

Use a short-lived account-scoped token and a separate random test invocation secret. Keep both in untracked local configuration or an approved secret store, never in commands, reports, traces, source, PRs or logs. Do not inspect ambient Cloudflare credentials or use an existing authenticated session. A restricted account is required if the platform cannot enforce sufficiently narrow resource permissions.

Before the first binding call, verify the newly created bucket is empty and the Worker references exactly that bucket. A dedicated configuration must have no imports/fallbacks to the production Wrangler configuration or production resource identifiers. Bind only disposable synthetic resources.

## Measurement and run sequence

1. Archive dated primary-source limits/prices and operator-provided account headroom. Confirm CPU and memory observation is genuinely available on Free, with operation/recipe correlation, precision and sampling disclosed. Aggregated p95, request wall time and injected 20-ms local allowance do not substitute for CPU maxima.
2. Recalculate aggregate reservations using completed local maximal and fault profiles. Include every rejected/unknown attempt, control read, replay, finalization, full evidence traversal and cleanup. Check bounded workload assumptions: scans/day, retries, retained history and manifest growth.
3. Deploy only the approved standalone private test fixture, after its authorization boundary has independent code/test review. The local fixture is not directly deployable as a public authenticated endpoint. Disable production routes and enrollment. Confirm authentication refusal causes zero binding calls.
4. Run 0/1 heads first; abort on any unexpected call, namespace, CPU/memory error, unresolved accounting or cost-reservation violation. Retain failures as evidence.
5. Run the separately admitted 1,000/5,000/10,000 recipes serially in fresh inventory identities. Record every request, physical operation count, exact root/count, legal body/key sizes and full traversal. Instrument actual start, continuation, finalization, recovery, paging and cleanup paths.
6. Execute separately bounded faults/races and expiry/cleanup probes. Injected failures remain labelled; do not equate an injected lost reply with a provider fault or later absence with earlier confirmed deletion.
7. Export sanitized source-bound reports and raw synthetic evidence to the approved local location. Redact credentials/account identifiers; retain failed and slow samples.

**Blocking telemetry question:** determine the actual Free-tier mechanism for complete per-invocation CPU observations and trustworthy isolate memory evidence. Do not promise Workers Logs, Tail, Logpush or a paid capability until its fields, availability and sampling have been verified. Missing telemetry keeps G4 and activation blocked after private M7 delivery; switching tiers is not an acceptable shortcut. See [ADR 0020 and the consolidated gates](../qualification/m7-delivery-and-activation-gate.md).

## Cleanup and reconciliation

Exercise application scratch cleanup first: preserve manifest tombstones, exact owned-slot CAS, peer/sentinel bytes and uncertainty. Reconcile final object/key/byte counts, all attempted Class A/B operations and unresolved-request reservations. Export evidence before deleting resources.

Then remove only the explicitly approved disposable Worker/bucket and associated test secret/routes. Whole-bucket deletion is **test-resource teardown**, not a new application retention policy. Verify resource absence and record teardown attempts, failures, residual storage and billing window. Revoke the token and erase local secret material. If cleanup fails, report the exact remaining resource and bounded manual remediation; never broaden credentials or delete a production resource.

## Primary sources to verify after approval

- Workers limits: https://developers.cloudflare.com/workers/platform/limits/
- Workers pricing: https://developers.cloudflare.com/workers/platform/pricing/
- R2 limits: https://developers.cloudflare.com/r2/platform/limits/
- R2 pricing: https://developers.cloudflare.com/r2/pricing/
- Workers observability: https://developers.cloudflare.com/workers/observability/

Retrieval date: **not retrieved in this execution**, honoring the no-Cloudflare-access boundary. This plan cannot yet receive a feasibility-ready verdict because its admission depends on the unresolved live limits, prices, headroom and telemetry above.
