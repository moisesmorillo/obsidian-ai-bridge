---
id: OAB-56
title: Run a security audit of the whole repository
status: In Progress
assignee:
  - '@pi'
created_date: '2026-11-10T03:43:00Z'
updated_date: '2026-11-11T02:09:00Z'
labels: []
dependencies: []
priority: high
ordinal: 96000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The owner asked for a full security audit after the Vaultwire 1.0 release. Use the Cloudflare security audit skill and the Trail of Bits (tob) skills that the owner named. The skills are not installed in ~/.claude or ~/.pi on 2026-11-09. Find and install them first, or ask the owner for the source. Scope: apps/worker, apps/plugin, packages/protocol, tooling, .github/workflows and the OpenTofu link to cloudflare-infra. The audit is read-only. Fixes go in separate tasks.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The Cloudflare security audit skill runs on the whole repository and its report lists each finding with file, line and severity
- [ ] #2 The Trail of Bits skills run on the whole repository and their findings use the same format
- [ ] #3 Each confirmed finding has its own Backlog task with severity, or a written reason why it is a false positive
- [ ] #4 The audit changes no code, no Cloudflare resource and no secret
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Install and inspect the named audit skills. 2. Map trust boundaries and build the coverage ledger. 3. Hunt, validate, and independently verify candidates. 4. Write external reports. 5. Create one fix task and submit one plan for owner approval. 6. After approval, implement, validate, review, and open the pull request.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Owner brief: audit the full repository at 66ff86a. Keep all audit artifacts outside the repository in ~/workspace/moisesmorillo/vaultwire-security-audit/. Create one task for all confirmed fixes, not one task per finding. Keep OAB-57 and its files unchanged. Owner change: keep global skills and commit project skills for Pi and Claude Code in a separate commit on the fix branch. No production writes, Cloudflare changes, real device, or real vault access.

Owner decision: bounded local fixture tests may run without the complete audit-skill OS sandbox. Use dummy data, an empty test environment, time limits, and no production calls. Run repository checks after plan approval. Skill sources: cloudflare/security-audit-skill (security-audit), cloudflare/skills (workers-best-practices, durable-objects), trailofbits/skills (sharp-edges, supply-chain-risk-auditor, entry-point-analyzer, variant-analysis). Supervisor corrected static-analysis: install semgrep and sarif-parsing from its plugin. insecure-defaults has no SKILL.md and remains unavailable.

Installed globally and in project scope for Pi and Claude Code: security-audit from cloudflare/security-audit-skill. workers-best-practices and durable-objects from cloudflare/skills. entry-point-analyzer, sharp-edges, supply-chain-risk-auditor, variant-analysis, semgrep, and sarif-parsing from trailofbits/skills. insecure-defaults is unavailable because it is a command plugin with no SKILL.md. entry-point-analyzer excludes non-smart-contract code. The owner approved the exact nine-source Semgrep run-all scan with OSS. Semgrep 1.185.0 completed eight scans and returned 64 merged alerts. p/yaml failed with exit 7. Elttam and Apiiro reported partial rule compilation. Alert triage and independent validation remain open.

Independent validation confirms one low-severity finding: apps/plugin/enrollment-case-folding. OAB-63 is the single task for all confirmed fixes. Public OAuth registration capacity and tag-triggered publication remain needs_validation because decisive deployment facts are absent. The backup-retention claim is rejected because the source defines an external lifecycle rule, not an unauthorized path. All 64 Semgrep alerts are rejected after source triage. Final coverage critic found no more source gaps. Both schema validators pass. Independent retained-record review passes after a parent-side fixture rerun and bounded artifact retention. External reports remain in ~/workspace/moisesmorillo/vaultwire-security-audit/. Coverage limits include one blocked vendor unit, the failed YAML ruleset, partial third-party rule compilation, omitted TS test targets, OSS-only analysis, no advisory scan, and no real host effects. No product fix or plan approval exists yet.
<!-- SECTION:NOTES:END -->
