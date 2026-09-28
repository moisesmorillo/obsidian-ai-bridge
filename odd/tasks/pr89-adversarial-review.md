# PR 89 adversarial review corrections

## Objective and authorization

Incorporate verified adversarial review findings into the proposed bidirectional sync ADR and rollout plan, correct directly affected documentation, and respond to rebuttable review claims. The user authorized this correction on 2026-09-28 and then selected automatic local application for authorized MCP-origin revisions during the second review. This is documentation design work only: no sync implementation, deployment, production credential, or personal-vault change.

## Problem and constraints

PR #89's proposed contract under-specifies client write authorization, storage/revision migration, path collisions, deletion and rename behavior, mobile inventory cost, and MCP-origin policy. Preserve M1-M6 as implemented, keep the future direction proposed with no M7/NEXT, and do not claim live qualification. Do not accept an unverified Release Please configuration fix. Existing PR diff is 416 authored lines before corrections; ADR, plan, and roadmap form one cohesive design proposal, so note the review-size exception before delivery.

## Route and verification

Substantial documentation correction with two meaningful steps. Route: delegated direct. Mapping trigger: understanding requires ADR, plan, roadmap, auth code, storage code, release config and workflows. Writer trigger: ADR and plan both need non-trivial edits. Preparation trigger: mapping delegated before write. TDD: not applicable to documentation-only change; no configured test runner for prose. Functional check: focused document consistency, links, `mise run check` if available, and manual semantic review. Engram mirror `odd/pr89-adversarial-review/tasks` pending: no Engram tool is available in this runtime. Delivery strategy: single-PR continuation as requested; size exception needs explicit note because coherent proposal exceeds 400 authored lines.

## Tasks

- [x] T1 — Clarify ADR/protocol and rollout requirements: OAuth write/delete and refresh migration; existing revision/receipt and object namespace transition; path equivalence and external deletion; MCP origin policy; mandatory incremental feed/mobile bounds; rename crash semantics. Check affected source contracts and design consistency. Commit a reviewable documentation unit.
- [x] T2 — Correct roadmap, threat model, stale/self-referential wording, and release-process explanation. Keep historical state distinct from proposed direction. Verify docs, applicable quality checks, and release behavior claim. Commit a reviewable documentation unit.
- [x] T3 — Close the MCP-origin product decision as automatic local application under exact acknowledged-base/precondition checks, with preservation and review for conflicts or unknown effects; resolve second-review wording, rename placement, and release-guidance location. Recheck docs and PR. Commit a reviewable documentation unit.
- [x] T4 — Resolve third-review never-seen remote creates and safe incoming tombstones; clarify durable absence evidence, current deployment prose, and the roadmap NEXT gate. Verify against official Obsidian API declarations, affected docs, and canonical checks. Commit a reviewable documentation unit.

## Evidence and next step

- T1: `65d756f`; `mise run check` and `git diff --check` passed.
- T2: `c53dd20`; canonical checks, affected links, and stale-claim scan passed.
- T3: `4899d86`; canonical checks, affected links, and policy scan passed.
- T4: `e934588`; canonical checks, affected links, and stale-claim scan passed. The installed Obsidian API declaration confirms `FileManager.trashFile` follows the user trash preference.
- Native RDD assessment was unavailable throughout because `gentle-ai` is not installed (`command not found`). The Engram mirror remains pending because this runtime exposes no Engram tool.

Current implementation head: `e934588`. Next: publish the branch and answer third review `5339383010`. No sync code, deployment, or personal-vault change was made.

## Second review correction

Review `5339112906` verified the first corrections and identified remaining wording and placement issues. The owner explicitly selected automatic application for authorized MCP-origin changes in the future sync design; this does not authorize current M4 auto-apply or a live writer. T3 route: delegated direct because ADR, plan, roadmap, threat model, and operations need coordinated non-trivial edits. The reviewer requested removal of this `odd/` task record, but the user-provided ODD instruction requires it for substantial work; retain it as process evidence, not product authority. Release Please source supports a docs-only patch-release concern for the current `simple` strategy; release automation changes remain a separate decision. The second review also noted that the 400-line guidance came from an agent skill, not the repository production-code gate; correct the PR body rather than attributing that limit to AGENTS.md.

## Third review correction

Review `5339383010` found that acknowledged absence does not cover a brand-new remote path. The future protocol must allow a never-seen remote create only after a fresh local absence/collision check and no pending local intent; a pre-existing local file goes to review. The installed Obsidian declarations show `FileManager.trashFile` follows the user trash preference, while `Vault.trash` takes an explicit system/local flag and `Vault.delete` is permanent. Incoming auto-delete must preserve remote recovery, use the user-preferred trash path where qualified, and fail closed on uncertain local effect. The owner request to review the updated PR continues the authorized review-correction work. T4 route: delegated direct; multiple design docs and current-state docs need coordinated changes.

