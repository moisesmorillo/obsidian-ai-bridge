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

## Evidence and next step

T1 evidence: commit `65d756f`; `git diff --check` and `mise run check` passed. Native RDD assessment unavailable because `gentle-ai` is not installed (`command not found`). T2 evidence: commit `c53dd20`; `git diff --check`, affected Markdown link resolution, stale-claim scan, and `mise run check` passed. Native RDD assessment remains unavailable (`gentle-ai` not installed). Current pre-T3 head: `cfadbcc`. Initial assessment: most review findings are valid; `hidden: true` is documented as a changelog-display setting and cannot be offered as an established release-suppression fix. The first correction was published and answered in PR #89. T3 evidence: commit `4899d86`; `mise run check`, `git diff --check`, relative Markdown target resolution, and stale-policy scan passed. Native RDD assessment unavailable (`gentle-ai` not installed). Next: publish T3, update the PR description, and answer review 5339112906. No sync code, deployment, or personal-vault change was made.

## Second review correction

Review `5339112906` verified the first corrections and identified remaining wording and placement issues. The owner explicitly selected automatic application for authorized MCP-origin changes in the future sync design; this does not authorize current M4 auto-apply or a live writer. T3 route: delegated direct because ADR, plan, roadmap, threat model, and operations need coordinated non-trivial edits. The reviewer requested removal of this `odd/` task record, but the user-provided ODD instruction requires it for substantial work; retain it as process evidence, not product authority. Release Please source supports a docs-only patch-release concern for the current `simple` strategy; release automation changes remain a separate decision. The second review also noted that the 400-line guidance came from an agent skill, not the repository production-code gate; correct the PR body rather than attributing that limit to AGENTS.md.
