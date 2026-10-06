# M7 maximum-encoded synthetic heads

**Qualification in progress; no scale or CPU approval is implied.** The original baseline's 720-byte paths produced 1,184-byte heads, not the 2,048-byte head ceiling. A separate test-only dataset exercises exact legal full-ceiling bodies without padding or changing production limits.

## Dataset and limits

| Property | Maximum-encoded dataset | Accepted ceiling |
| --- | --- | --- |
| Raw path | 720 UTF-8 bytes, four 170-byte segments and indexed Markdown filename | 720 bytes |
| Canonical head key | 1,023 bytes | R2 target: 1,024 bytes |
| Head body | Exactly 2,048 canonical JSON bytes | 2,048 bytes |
| Kind | Alternating live/tombstone heads | Both existing strict record variants |
| Declared content size | 1,048,576 bytes | Existing content-body maximum |
| Persisted summary | 1,038 bytes live; 1,043 bytes tombstone | 1,536 bytes |
| 10,000 unique head bodies | 20,480,000 bytes | 20,971,520 bytes (20 MiB) |
| 10,000 alternating summaries | 10,405,000 bytes | Conservative cap allocation: 15,360,000 bytes |

The live fixture replaces 171 ASCII path characters with U+0001 and three with quotes; tombstones replace 170 and three respectively. JSON encodes each U+0001 as six bytes and each quote as two, while UTF-8 path length remains unchanged. The existing path and record schemas accept these relative synthetic metadata paths. They are never created as actual vault files. Summaries contain canonical base64url path keys, so raw-path JSON escaping does not inflate persisted summary size.

These are strict metadata fixtures, **not** proof of stored content/version provenance: the digest, parent and declared content size are synthetic, and no 1-MiB note body or immutable version is seeded. Inventory qualification must not be advertised as mutation/content conformance.

## Reproduction

```bash
M7_PROFILE_HEADS=5000 \
M7_PROFILE_FIXTURE=maximum_encoded \
M7_PROFILE_OUTPUT="$PWD/.pi/inventory-profiles/<fresh-exclusive-directory>" \
mise run worker:inventory-profile
```

Use 10,000 only for the separately recorded maximum-scale run. Each call uses the existing private SyncStore, one method per real workerd request and real-time cooldowns. The test-only 20-ms admission estimate is **not** isolate CPU measurement or Workers Free qualification.

Dataset identity is persisted and checked on reopen. Different populations/datasets or source recipes refuse before state mutation. Baseline head bytes remain unchanged, but edited harness sources change the recipe hash: old sealed pairs must be reopened with their original source, not silently adopted by the new harness.

## Evidence status

- RED `b4b46e680`: two full-ceiling assertions observed 1,184 instead of 2,048 bytes; baseline assertion passed.
- GREEN `b388dd070`: 3 focused unit tests and the native two-head full-traversal/reopen test passed.
- Scheduling RED `b01269cb2` and GREEN `bf8ba2dd6`: 9 focused unit/14 native tests passed. A persisted observed-LIST hint selects continuation calls instead of redundant `start` reads; it grants no state/effect/completion authority and preserves validated retry floors.
- Canonical `b203dfc21`: `mise install && mise run check && git diff --check` passed with 2,085 source tests, 28 native tests and 12 smoke tests; coverage and thresholds unchanged (95% statements, 91.46% branches, 98.65% functions, 96.81% lines). The new acknowledged-chunk recovery test verifies full completion from a fresh isolate with exactly one total LIST.
- Manual semantic review after green: author review, not independent approval; no actionable finding in this bounded test-only change.
- 5,000/10,000 maximum-encoded execution and sealed reopen: pending.
- Original-recipe 10,000-head baseline: running separately in its unchanged source worktree; it cannot close the maximum-encoded gate.
- Isolate CPU/memory and remote/account/billing admission: pending; Node resource observations cannot substitute.

M7 remains **NEXT**, synchronization remains inactive, and no Cloudflare resource is accessed by this local dataset.
