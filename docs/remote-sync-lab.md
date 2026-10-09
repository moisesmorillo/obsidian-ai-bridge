# Remote synthetic sync lab — authorization recipe

**No Cloudflare operation has been authorized or performed.** Local implementation and simulated validation do not establish real R2/Workers Free behavior. G1–G6 remain OPEN. This is not a production rollout or backup.

## Resources and identity to approve

The operator must fill these fields explicitly before any account/API/session/credential access. They are intentionally not discovered from ambient login state.

| Field | Proposed value / approval requirement |
|---|---|
| Account | Owner-selected existing account or optional test account; explicit account ID supplied by owner |
| Session | Fresh dedicated Wrangler/API-token session, never ambient login or an existing production token; short-lived token stored outside tracked files |
| Plan | Workers Free; verify 100,000/day hard quota, 10 ms CPU, 128 MB/isolate and 1,000 internal subrequests before run |
| Worker | New `ai-bridge-m8-remote-synthetic-<experiment-suffix>`; deployment config outside tracked files derived only from `wrangler.remote.jsonc` |
| Bucket | New empty private Standard R2 `ai-bridge-m8-remote-synthetic-<experiment-suffix>`; no `r2.dev`, public access, domain or lifecycle |
| Hostname | `https://<worker-name>.<owner-supplied-workers-subdomain>.workers.dev`; exact origin becomes immutable lab config; no production custom domain/routes |
| Credentials | Three fresh registry participants with read/write only; raw bearers in disposable-vault native SecretStorage and temporary REST secret store; digest registry as test Worker secret |
| Duration | One hour enabled lifetime; complete test resource teardown within 24 hours. Re-enabling/extending needs new approval/config/experiment |
| Data | One synthetic `demo.md`, <=16 KiB, two new disposable vaults outside iCloud and personal data; fresh namespace and device IDs |

Do not call `wrangler whoami`, inspect login files, select an ambient token, or query any remote resource before approval. The exact account/subdomain/session cannot honestly be named until the owner provides it.

### Permissions

Approve only test Worker create/update/delete and secret installation, new R2 bucket create/list/delete and read-only test telemetry/account allowance. Worker accesses R2 solely through its binding; clients receive no S3/admin credential. Verify current API-token permission names and resource granularity during authorized preflight. If permissions cannot exclude production resources sufficiently, stop for owner review; do not silently require a second account or broaden credentials. Shared-account daily quota/billing contention must be explicitly accepted.

## Budget to approve

| Resource | Ceiling / reservation |
|---|---|
| Authorized recipe HTTP | <=300 POST attempts total across REST/A/B, including retry, rejection, replay and probes; <=300 OPTIONS conservatively; reserve 100 additional read-only setup/telemetry checks. Stop before next attempt at 700 total recipe requests |
| Accepted effects | 100 one-use tickets per participant, 300 total; no refunds/reuse, including lost/failed attempts |
| Per admitted invocation | <=512 attempted R2 calls and <=1 MiB submitted PUT bytes, including ticket and marker; no inventory/listing from public routes |
| Application aggregate | <=153,600 calls, <=300 MiB PUT bytes submitted; conservatively every attempt counts toward reservation |
| Denial flood fallback | Free account hard quota <=200,000 HTTP requests over <=1 hour across at most two UTC days; each authenticated claim rejection costs at most one additional PUT. <=353,600 application calls conservatively, independent of recipe compliance |
| Provisioning/teardown | Reserve separately <=160,000 R2/control attempts: <=153,600 possible object removals (`300 × 512` conservative unique-key bound), <=154 LIST pages at 1,000/page if verified, plus setup/verification margin. Stop/report rather than exceed reservation |
| Spend | Proposed incremental USD 10 ceiling including rounding/tax; requires authorized account allowance/price calculation, not a provider-enforced billing cap |

At documented Standard prices, conservatively charge all <=513,600 attempts as Class A AND Class B, without free-tier credit. Rounded to one million of each: USD4.50 + USD0.36. Reserve <=300 MiB submitted bodies plus bounded private metadata for <=24h; reserve one full GB-month at USD0.015 rather than assuming proportional billing (verify provider accounting during preflight). Subtotal USD4.875; remaining USD5.125 covers verified tax/other incremental costs. Verify billing-unit effects, existing usage and paid features; if the all-in reservation exceeds USD10, do not provision. Unknown PUTs remain charged reservations. Monitoring is not a global hard billing stop.

The provider hard request limit is account-wide. This fallback is invalid on Paid/unlimited tier, with a changed Free limit, with a longer window or if admission keys are reset. Recalculate and seek approval instead. Unauthorized flood can exhaust account quota; this lab does not promise production isolation at account-quota level or availability. It never authorizes spending through another account/plan.

Public primary sources consulted during design: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [R2 limits](https://developers.cloudflare.com/r2/platform/limits/), [R2 prices](https://developers.cloudflare.com/r2/pricing/) (2026-10-09 session). Account headroom, actual telemetry and remote binding semantics remain unknown. Heap/RSS from local Node and request wall time are not remote isolate evidence.

## Authorized execution sequence (NOT executed)

1. Verify supplied account/session identity and exact permission scope, tier/headroom/cost. No automatic production-resource discovery. Pin source SHA, build hashes and synthetic recipe. If CPU/heap observations are unavailable, label the limitation; do not claim G4 acceptance.
2. Create the approved empty private bucket and standalone Worker only. Verify the binding matches that bucket, no production config/routes/imports and no public R2 endpoint. Initial Worker stays stopped/unconfigured.
3. Generate registry/config outside Git. Configure exact HTTPS hostname, fresh experiment/vault/participants, start/end and `enabled:true`. Install secrets using the approved dedicated session. Never put raw secrets in command arguments, reports or logs.
4. Prove missing/invalid bearer, foreign identity, expired/stopped config and disallowed path cannot dispatch store effects. Account for probes and claims. REST seed first; missing marker is not an empty-vault ACK.
5. Install only remote experimental artifact into positively verified new disposable A/B. Supply fresh native references/config; no reuse of local M8 ledgers or production plugin. Save a note in A; explicit sync A/B proves exact A→B bytes/revision; edit B and prove B→A.
6. REST edit with exact parent, then clean B pull. Re-submit stale parent and verify preservation/refusal. Reload only B's disposable window, verify persisted base/config/ticket and continue. Respect original retry floors; no busy-loop/current-head overwrite.
7. Concurrent local B and REST edits preserve exact local and remote bytes with one visible excluded copy; repeat/reload leaves ACK/checkpoint fenced and `attention`. Pending is not success. Stop on unexpected identity/key/content, budget violation, lost certainty, CPU/memory error or defect.
8. Export sanitized source-bound report and counters (include OPTIONS/rejections/claim attempts and unknown reservations). Report actual real R2/host/telemetry limits, never infer G1–G6 closure.

## Stop, rollback and teardown

- Immediate local stop: disable remote plugin and REST runner. Do not clear prepared effects or ledgers; retain versions/conflict copies.
- Server stop: set `enabled:false` or remove remote configuration/registry secret using approved session; remove hostname/Worker if an emergency stop is required. No claim that a config change aborts already dispatched effects. TTL independently refuses subsequent admission.
- Rollback removes remote-only composition/artifact. Do not redirect its state to loopback or the production Worker; local M8 remains available under its original namespace/credentials.
- Export evidence, reconcile object/call counts, then delete only the approved disposable bucket contents/bucket and Worker, test secrets and temporary config. Teardown is not an application delete/retention feature.
- Verify absence, revoke the dedicated token/session, erase temporary raw secret stores/native lab entries after preservation. If cleanup exceeds its reservation or fails, stop and report exact residual resources for separately authorized remediation. Never broaden credentials.

## Local validation

Use `mise install`, `mise run test`, `mise run remote:build`, `mise run remote:plugin:build` and `mise run check`. Build tasks bundle locally only; there is deliberately no deploy task. Local integration uses synthetic URLs and deterministic/local native storage, not Cloudflare access. Validation evidence is recorded with the functional deliveries.
