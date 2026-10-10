# Remote synthetic lab F — Desktop and R2 result

**Result: passed for the bounded synthetic path; the lab was removed.** The
separate remote Worker and plugin from merged #116 and #117 were exercised from
source `59087897ab2e931c28f0a53684ffbb70649f50fe` on 2026-10-10. Two
disposable Obsidian Desktop vaults exchanged one `demo-f.md` through a temporary
Workers Free/R2 lab. No personal vault, production Worker/bucket, mobile host or
iCloud cutover participated.

| Observation | Result | Source-bound local evidence |
| --- | --- | --- |
| A created; B pulled | B's bytes matched SHA-256 `3db34a81b6b14486eb9d6d8b34800be57346a4b4ffe8945bff006c9aa9d52ce8` and revision `c7713118-0e5c-4024-be6e-a1be50133f22`; exact content and checkpoint confirmed | `B-pull-B.json`, `continue-A-02.json` |
| B edited; A pulled | A's bytes matched SHA-256 `a8980087a116137eb516677fa9ba5a4d7775c8ca5e6c4f0034eeef75c3d0d20f` and revision `7e6647c3-a8ce-4519-b33d-4790746c22b9`; exact content and checkpoint confirmed | `continue-B-update-01.json`, `A-pull-A.json` |
| Old-parent mutation | Parent `c7713118-0e5c-4024-be6e-a1be50133f22` was refused as stale; current revision remained `7e6647c3-a8ce-4519-b33d-4790746c22b9` | `stale-cas-report.json` |
| Stop and teardown | The stopped gate returned `503 demo_unavailable` before arming; the later server stop was verified. Worker absence and empty/deleted private bucket were verified after removing 72 synthetic objects | `stopped-propagation-report.json`, `stop-report.json`, `teardown-report.json` |
| Bounded use | 488 of 700 reserved recipe HTTP requests; 66 POST and 47 OPTIONS counted | `teardown-report.json` |

The named JSON reports are retained locally under
`/tmp/m8-remote-session-20261010f/`; this document carries only sanitized
results, not credentials, headers or note bodies. The F plugin, its native test
secrets and temporary resource configuration were removed from the disposable
vaults after the server stopped. Earlier disposable vault notes and ledgers were
preserved. The repository and production release configuration were unchanged.

Several serial `Sync now` passes were needed for each mutation to settle through
the durable R2 journal. `pending` was never counted as success: both receiving
clients had an exact revision/hash and no remaining work before the pass claim.
This demonstrates real Desktop plus remote R2 behavior for one synthetic Markdown
path under manual commands. It does not establish automatic scheduling, crash or
mobile behavior, the 24-hour expiry gate, full Workers Free CPU/resource envelope,
general account economics, or any G1–G6 production/real-data gate. Those remain
open under the [activation report](m7-delivery-and-activation-gate.md).
