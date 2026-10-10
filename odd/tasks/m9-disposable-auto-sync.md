# M9 disposable automatic Markdown sync

Objective: automatically reconcile explicitly admitted synthetic Markdown paths between disposable Obsidian Desktop vaults and the isolated remote synthetic Worker, preserving the existing durable exact-base behavior.

Problem: the merged M8 plugin requires repeated `Sync now` commands. Its owner records host events but does not schedule passes, and the core client stops at the first pending path. The immutable binding currently prevents a safe live toggle.

Authorized scope: implement M9 from `docs/milestones/m9-disposable-auto-markdown-sync.md`, including focused tests, a disposable-host demonstration, documentation and a ready-to-review PR. No production Worker or release plugin activation, personal vault, Cloudflare operation, iCloud cutover, mobile claim, delete or rename sync.

Constraints: exact approved endpoint and participant binding, one-use tickets, 16 KiB/path limits, durable prepared effects, fail-closed persistence, bounded retry and explicit opt-in. Preserve G1–G6 as open gates. Keep the manual command working.

Route: delegated direct. Mapping needed more than four files; implementation touches multiple non-trivial files. Parent owns scope and acceptance; writers receive bounded work units. TDD: preferred RED/GREEN/REFACTOR for new behavior per repo `AGENTS.md` (not an absolute switch); runner `mise run test` / focused Vitest, full gate `mise run check`. RDD: on globally (`gentle-ai review mode status`); assess each committed work unit against branch point or last reviewed boundary.

Delivery: single-pr, because scheduler, core fairness and host evidence form one coherent M9 behavior; follow existing PR size gate and request an exception only if needed. Forecast about 700–1,000 authored changed lines excluding generated artifacts; 400 lines per task is advisory only. Branch `feat/m9-disposable-auto-sync` from `origin/main` `972bb080f468725561a94ba5c482ec608a652acc` (#120). Track authored changed lines and commits below.

Tasks:
- [ ] M9.1. Implement strict, separate opt-in for the remote experimental plugin and owner-scoped bounded timer/event schedule. Live disable must not rewrite the immutable binding. Fence late callbacks across reload/unload/config or credential changes; stop on expiry, ticket/persistence uncertainty; coalesce events and back off under pending/unavailable. Keep manual `Sync now`. Route: delegated writer. Checks: observed RED then GREEN focused tests, artifact smoke, typecheck, safety review. Evidence: pending.
- [ ] M9.2. Make one pending/attention path unable to starve other admitted paths while preserving cursor/ACK authority and durable original operation tuples. Route: delegated writer. Checks: focused core tests for independent progress, stale CAS, loss/attention and unchanged false-absence policy; full gate. Evidence: pending.
- [ ] M9.3. Run an isolated disposable Desktop or clearly labeled host-instance demonstration: automatic A→B, B→A, REST→device, targeted reload, conflict preservation and bounded retry/cancellation. Record exact bytes/hash/revision/checkpoint and request counts; update M9/current-state docs only after observed proof. Route: delegated writer if multiple non-trivial files. Checks: `mise run check`, independent semantic/security review, no release/production changes. Evidence: pending.

Progress: mapped merged main and created feature branch; no source edits or commits yet. Mirror this document to Engram before M9.1 implementation.

Next step: delegate M9.1 with this locator and the exact TDD/check configuration.
