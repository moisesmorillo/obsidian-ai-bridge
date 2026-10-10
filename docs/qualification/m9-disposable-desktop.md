# M9 disposable Desktop automatic sync

Date: 2026-10-10. This was a bounded synthetic experiment in real Obsidian
Desktop 1.14.4 with two positively verified disposable vaults, `vault-A` and
`vault-B`, and a temporary private Cloudflare Worker/R2 bucket. Both vaults
admitted only `demo.md`. The release plugin, production Worker and bucket,
personal vault, and iCloud were untouched. The test did not use `Sync now` to
deliver the edits below.

## Observed flows

| Flow | Observation |
| --- | --- |
| REST → A/B | A REST create committed after 10 bounded attempts; the 31-byte note appeared automatically on both hosts with matching SHA-256 prefix `29744b5`. |
| A → B | A's 56-byte edit committed at remote revision prefix `f3a2e6c8` and arrived automatically on B with matching SHA-256 prefix `c7549f`. |
| B → A | B's 82-byte edit committed at remote revision prefix `07fd4f21` and arrived automatically on A with matching SHA-256 prefix `40beb`. |
| Targeted reload | `View → Force Reload` on A retained the note and the automatic opt-in; settings still offered `Disable automatic sync`. This did not restart the main Obsidian process. |
| Concurrent edit | B's automatic opt-in was disabled before a 100-byte local edit (SHA-256 prefix `8ecc225`). A concurrent REST update from revision prefix `07fd4f21` committed after nine bounded attempts. When B's opt-in was re-enabled, it showed attention, preserved the local branch, and created exactly one conflict copy matching the remote content (SHA-256 prefix `3ce0a7`). It did not overwrite the local edit. |

The recorded hashes and revision IDs above are prefixes, not complete values or
independent proof of every checkpoint. Before teardown, the experiment's R2
listing contained 109 admission objects (A 50, B 37, REST 22) and 19 sync-store
objects. Admission objects are not a complete HTTP request count. REST used
tickets 1–10 for the seed, 21–23 for current reads, and 24–32 for the
concurrent edit. No CPU latency, cost, quota headroom, or full-process restart
result is claimed for this Desktop run.
The earlier [isolated host-instance report](m9-automatic-host-instance.md)
contains source-bound cursor, checkpoint and request-count assertions under an
accelerated test clock; those measurements do not transfer to this live run.
The final documentation gate passed `mise run check`: 2,305 fast tests, 53
storage tests and 17 plugin smoke tests (one existing skip), with 95.01%
statement coverage. The isolated artifact smoke run recorded 184 requests
(A 92, B 64, REST 28); this is a separate harness measurement, not the
Desktop request count. Worker builds in this gate were dry runs only.

## Shutdown and limits

Automatic opt-in was disabled on both vaults. The temporary Worker was deleted
and its absence confirmed by Cloudflare error `10007`. All 128 objects under
the experiment's exact R2 prefix were removed, the temporary bucket was
deleted, and the remaining bucket list contained only the existing production
bucket. Temporary raw bearer, registry and configuration files were removed.
Native Keychain references remain in the disposable vaults, but the deleted
Worker no longer accepts those credentials. No production data was deleted.

This establishes the bounded disposable Desktop behavior described above. It
does not qualify mobile, background operation, general vault sync, real data,
or production activation. The separate G1–G6 gates remain open.
