# ADR 0011 — M5 operational envelope and support policy

## Status

**Accepted; implemented and qualified by M5.** This Slice 1 record closes the eight
operational decisions used by the later M5 runbooks and final qualification. It changes
no runtime or API behavior. Corrective ADR 0013 advances the M4 state/runtime format
to v5; the subsequent [M5 final report](../qualification/m5-final.md) separately
qualifies the exact release, v5 migration/restart envelope, and desktop profile. M5
support remains limited to release v1.0.2 and the exact environment documented below.

## Context

M1–M4 provide hard safety bounds, conditional effects, content-free state, and manual
recovery APIs, but those implementation ceilings are not an operating-support
contract. In particular, the 50,000 tracked-path limit and 12 MiB state limit prevent
unbounded state; they do not prove that a real Obsidian writer is usable at those
limits. At this decision's acceptance, no real desktop/mobile host, iCloud trace,
deployed Worker, or production release had been qualified. Later corrective M4
evidence covers only one preservation-root/Keep-local scenario and does not qualify
this operating envelope.

Slice 1 therefore compared the smallest policies that could support one personal
bridge without treating one development laptop, a platform maximum, or an earlier
planning suggestion as a universal guarantee.

## Evidence

### Synthetic local qualification

A disposable in-memory harness called production boundaries at the time of measurement;
it was not committed and used no vault content, credentials, filesystem vault, network,
or deployment. The state/codec measurements were for the then-current strict v4 format;
they do not measure v5 migration, validation, or the v5 13 MiB ceiling. For each sample
it created eligible path metadata and a minimal content-
free live acknowledgement per path, then measured:

- `ObsidianLocalVault.list` plus `LocalInspectionService.list`, including eligibility
  evaluation and lexical sorting;
- `inspectBoundedMirrorInventory` with current 50-object pages;
- `isMirrorDeviceStateConsistent`;
- strict device-state v4 encode and decode; and
- strict v2 decode followed by v2→v3→v4 projection and v4 encode.

These remain historical v4 measurements. The final M5 qualification separately
measured the current v5 codec and v2→v3→v4→v5 migration/restart path; see the [M5
report](../qualification/m5-final.md#a6--bounded-operation).

The qualification ran three fresh Bun processes per sample on macOS 26.6.2, Apple M4
Pro, 48 GiB RAM, using the repository-pinned Bun 1.4.2. Values are medians; encoded
size is deterministic. Final RSS is a process observation, not operation-attributable
heap usage.

| Eligible notes | Local inventory | Remote inventory | State validation | v4 encode | v4 decode | v2→v4 + encode | v4 bytes | Final RSS range |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 | 1.34 ms | 0.66 ms / 20 pages | 1.04 ms | 7.86 ms | 3.26 ms | 6.52 ms | 282,338 | 63.9–65.7 MiB |
| 5,000 | 4.00 ms | 1.16 ms / 100 pages | 2.87 ms | 15.94 ms | 11.32 ms | 20.51 ms | 1,410,338 | 102.2–106.3 MiB |
| 10,000 | 8.67 ms | 1.72 ms / 200 pages | 3.23 ms | 23.82 ms | 17.74 ms | 38.60 ms | 2,820,338 | 138.1–144.3 MiB |

The inventory measurements exclude host filesystem, Obsidian, WebView, network, R2,
and note-body hashing/transfer latency. The state fixture represents ordinary settled
live paths, not a maximum-size combination of reviews, operations, receipts, or long
paths. These synthetic results did not establish support. The later M5 real-host
active-writer and current-v5 migration/restart measurements qualify only the exact
profile and scale in the [final report](../qualification/m5-final.md); they do not
establish mobile behavior, other-device startup latency, or a universal guarantee. No
generated data entered tests or artifacts, so canonical suite fixture volume and
runtime were unchanged.

### Repository and platform evidence

- The plugin scheduler permits two active jobs, finite retries, 50-object API pages,
  1,000-page explicit inventory passes, 1 MiB note bodies, at most 50,000 tracked
  paths, a 12 MiB historical v4 state bound, and the current 13 MiB v5 state bound.
  These are independent hard limits, not an operating-capacity guarantee.
- The current plugin and all production clients use v2. Repository search found v1
  route ownership only in the Worker compatibility surface; no current production
  client imports or calls authenticated v1 reads. Tests and documentation preserve
  v1 behavior but are not compatibility consumers.
- The manifest minimum is Obsidian 1.13.0, `isDesktopOnly: false`, and the bundle
  avoids Node/Electron APIs. The M5 qualified writer profile is Obsidian Desktop
  1.13.7 on macOS 26.6.2 / Apple M4 Pro. Broader mobile/native-secret/iCloud/
  WebView/background-iOS combinations remain unqualified.
- The v1.0.2 root/plugin/manifest/staged identities are synchronized and the tagged
  plugin build is reproducible under canonical tooling. The GitHub v1.0.2 release has
  no downloadable binary assets; the qualified artifact is source-built. Current device
  state v5 has no reverse migration; frozen v2/v3/v4 readers reject v5.
- Recovery APIs already provide 50-object metadata pages and one exact conditional
  seal or purge per request. Purge preserves a content-free marker and the accepted
  30-day semantics; there is no safe bulk-delete or scheduler requirement.
- Worker requests are already bounded per body/page/condition, while normal bootstrap
  may legitimately perform thousands of individually conditional operations. No
  deployed workload, abuse trace, or cost incident supports a precise application
  request rate.
- Cloudflare documents plan/account limits separately from application policy. Its
  [Workers Rate Limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
  supports only 10- or 60-second windows, is location-local, permissive, eventually
  consistent, and not accurate accounting. Its extra binding and failure policy would
  not establish a global destructive-operation quota.
- Cloudflare documents that [real-time logs are not stored](https://developers.cloudflare.com/workers/observability/logs/real-time-logs/),
  while optional [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)
  retain logs for three days on Free or seven days on Paid. Current committed Worker
  configuration does not enable that durable observability surface.

## Decision

### 1. Note-count envelope

Adopt **10,000 eligible notes** as the maximum qualified personal-mirror envelope.
M5 passed this ceiling only on the exact packaged/plugin host profile recorded in the
[final report](../qualification/m5-final.md): Obsidian Desktop 1.13.7 on macOS 26.6.2 /
Apple M4 Pro. Retained active-writer and v4→v5 migration/restart evidence covers
synthetic startup, persistence, transfer, and restart behavior. This is not universal
10,000-note support on other hosts, nor a latency or availability SLA.

The 50,000-path constant remains a corruption/resource safety ceiling. Counts above
10,000 are unsupported even when they fit that ceiling. Note count does not override
the 1 MiB per-note, current 13 MiB v5 state, collection, page, retry, or scheduler bounds (the frozen historical v4 bound was 12 MiB).

### 2–3. Rate limiting and operation quotas

Add **no Cloudflare Rate Limiting binding and no application read/write/delete
numeric quota in M5**. Consequently M5 adds no 429/retry-window contract. Existing
per-request/page/body/state bounds, two-job plugin scheduling, finite retries,
conditional revisions, independent `delete` permission, per-client revocation, and
the operator's Cloudflare account/plan limits form the smallest defensible personal-
bridge control set.

This is not a denial-of-service guarantee. Excessive authorized traffic remains an
accepted residual risk handled by credential revocation, pausing the writer, and
platform/account controls. `delete` remains stricter than ordinary reads through its
independent permission, designated-writer guard, exact predicates, recovery-first
tombstone, and conditional purge—not through an invented rate. Reopen this decision
only with deployed workload or incident/cost evidence and a precise principal, unit,
window, failure, retry, locality, and effect-certainty contract.

An isolate-local counter is rejected because eviction and distribution would make it
bypassable. Durable Objects, KV, D1, or another service are disproportionate and not
selected.

### 4. Platform and writer support

Keep `isDesktopOnly: false`: the plugin may load wherever Obsidian accepts the current
manifest and unsupported instances may use passive/local inspection behavior. The
**only M5-qualified designated-writer environment is Obsidian Desktop 1.13.7 on
macOS 26.6.2 / Apple M4 Pro**, as recorded in the final report. The manifest retains the
1.13.0 minimum and `isDesktopOnly: false`, but neither broadens this tested support
envelope. Intel macOS, Windows, Linux, other desktop versions, and all mobile writers
remain unsupported until separately qualified.

Mobile loading is not mobile writer support. iOS/Android designated-writer operation,
background freshness, mobile native-secret behavior, mobile WebView transport, and
mobile iCloud event ordering remain unsupported. Operators must not designate a
mobile installation as writer. This policy separates package loadability from the
narrower operating-support claim and requires no manifest change.

### 5. Recovery maintenance

Use the existing **bounded manual runbook**; add no plugin command, scheduled job, or
recovery automation. One operator step reads one 50-object metadata page and performs
at most one exact conditional seal repair or expired purge before re-reading evidence.
An empty visible page with a continuation is not completion. Continuing to another
page or entry is another explicit step.

Prepared/unsealed content remains readable and ineligible for purge until exact seal
proof exists. Sealed content keeps the existing 30-day deadline. Purge remains an
explicit CAS replacement with a retained marker, never blanket lifecycle expiration,
bulk deletion, or physical-erasure proof. This is slower but preserves the existing
effect-certainty and operator-review boundary without creating an always-on maintainer.

### 6. Release support

Support **only the latest M5-ready release, v1.0.2**; there are no parallel
maintenance lines or backports for this personal project. Its root/plugin/manifest/
staged identities and reproducible source-built artifact were checked; the GitHub
release has no binary assets. Compatibility instructions name the same exact version
and operating envelope. Operators must pause, preserve evidence, and upgrade forward
to the latest qualified release before requesting support.

Rollback is allowed only when that exact artifact has explicit compatibility evidence
for the currently persisted device-state, remote storage, API, and credential-registry
formats and cannot restore a revoked credential. Otherwise rollback is unsupported;
use the documented forward-upgrade, evidence preservation, handoff, or isolated-reset
path. A release candidate cannot be called supported unless the root release version,
source plugin manifest, staged manifest/artifact, release notes, and compatibility
instructions identify the same release and canonical checks qualify those exact
artifacts.

### 7. Logging retention

Retain application diagnostic logs for **zero days**: M5 will not enable Workers Logs,
Logpush, Tail Worker persistence, OTLP export, or another durable log store. Supported
operations may use Cloudflare real-time logs for live diagnosis, understanding that
sampling or a missed session can leave no record. Logs are diagnostics, not an audit
trail or recovery authority.

Only content-free structured application events may be emitted. Raw tokens or digests,
authorization headers, bodies, concrete or encoded note/recovery identifiers, storage
envelopes, revisions, hashes, receipts, and raw exceptions are forbidden even in
real-time output. Slice 3 adds canonical client ID only for authenticated requests plus
closed authentication/operation categories, status, and stable API error codes. It
adds no durable sink or audit authority. Platform/account metadata outside application
control remains inside the trusted Cloudflare operator boundary and is not a project
retention guarantee.

### 8. Complete v1 retirement

No current repository client requires v1 reads. Slice 4 removes every registered v1
route and its OpenAPI compatibility contract; retired v1 PUT/DELETE handlers were not
restored. Clients must use v2 before upgrading into this version. There is no dual
supported window, because no observed client needs one and latest-only support makes
an indefinite compatibility surface unnecessary.

Unknown API descendants remain authenticated. After removal, a valid registry bearer
receives sanitized `404 not_found` for v1 paths, while absent/invalid credentials
receive `401 unauthorized`; both outcomes precede service/storage dispatch. No v1
fallback or storage-format migration was added.

## Consequences

The decisions removed a limiter binding, quota state/failures, recovery automation,
mobile-writer work, durable log infrastructure, and multi-release maintenance from M5.
The final report closes the exact 10,000-note desktop qualification, synchronized
v1.0.2 artifact identity/reproducibility, latest-only forward-upgrade policy, and full
v1 retirement. Accepted residual risks are volumetric abuse within platform limits, no
historical application-log trail, manual recovery maintenance, unsupported mobile
writers, and no rollback unless an exact path is separately proven.

None of these decisions weakens authentication, independent delete permission,
conditional effects, 30-day recovery, retained tombstones/markers, one-writer
authority, reviewed reconciliation, or unknown-effect preservation.

## Alternatives

- **Claim 50,000 or universal 10,000-note support now:** rejected; the larger number is
  a safety ceiling and the synthetic run omits real host/network/storage behavior.
- **Use 5,000 as the target:** defensible but rejected because the bounded M5
  active-writer and v5 migration/restart evidence passes 10,000 on the exact profile;
  this does not extrapolate to other hosts.
- **Add Cloudflare Rate Limiting or exact per-operation quotas now:** rejected because
  no workload supports the numbers and the binding is permissive/location-local.
- **Set `isDesktopOnly: true`:** rejected because loadability is broader than writer
  support and no runtime dependency requires a desktop-only package flag.
- **Support every desktop platform or a mobile writer initially:** rejected until each
  real host is exercised; Apple-silicon macOS is the smallest maintainable target that
  matches the available local qualification environment.
- **Add a maintenance command or scheduler:** rejected; existing exact APIs and a
  page/operation-bounded runbook satisfy the personal operating model with less
  authority and complexity.
- **Support several recent releases:** rejected as an unsupported maintainer burden.
- **Retain logs for three or seven days:** rejected because it requires enabling a
  durable platform surface and adds privacy/cost without an audit requirement.
- **Keep v1 reads until an external client requests removal:** rejected; repository
  evidence shows no consumer and indefinite compatibility conflicts with a bounded,
  latest-only support contract.

## Evidence / related documents

- [M5 milestone specification](../milestones/m5-operational-and-security-readiness.md)
- [Consolidated threat model](../threat-model.md)
- [Roadmap](../roadmap.md)
- [Current-state evidence](../current-state.md)
- [Plugin qualification boundary](../plugin-development.md)
- [Worker API](../api.md)
- [Operator guide](../operations.md)
- [ADR 0004 — recovery semantics](0004-recoverable-mirror-deletions.md)
- [ADR 0009 — historical state v4 and hard bounds](0009-m4-history-runtime-and-device-state-v4.md)
- [ADR 0013 — current state v5 listener-gap correction](0013-listener-ready-effect-authority-and-observation-gap-recovery.md)
- [ADR 0010 — scoped credentials and permissions](0010-scoped-client-credentials-and-permissions.md)
