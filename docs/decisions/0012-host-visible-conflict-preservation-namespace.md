# ADR 0012 — Host-visible conflict-preservation namespace

## Status

**Accepted and implemented by the corrective M4 production change.** This record
supersedes only the preservation-root location in [ADR 0006](0006-conflict-preservation-and-local-mutation.md)
and [ADR 0009](0009-m4-history-runtime-and-device-state-v4.md). Their authority,
ordering, create-only, collision, step identity, and effect-certainty decisions remain
in force.

## Context

M4 selected `.ai-bridge-conflicts` because the generic dot-segment rule excluded it
from mirroring. Isolated qualification on macOS 26.6.2 build 25G83, native arm64 Apple
M4 Pro, and Obsidian desktop 1.13.7 found that `Vault.createFolder` physically creates
a dot-prefixed folder while `Vault.getAbstractFileByPath` does not expose it through
the Vault index. The writer therefore cannot prove its folder/file postcondition. It
correctly stops at unknown/evidence-required before the conditional remote mutation,
but reviewed Keep local is unusable on the qualified host.

A replacement must be visible through official Vault APIs and explicitly ineligible
for mirroring. Historical receipts cannot be rewritten or treated as proof of an
unindexed physical effect.

## Decision

New operations use the exact vault-relative reserved root:

```text
ai-bridge-conflicts/<operation-uuid>/<side>.md
ai-bridge-conflicts/<parent-operation-uuid>/<step-uuid>/<side>.md
```

An isolated official-API probe created the root, operation and step folders, created a
Markdown file, retrieved every node through `Vault.getAbstractFileByPath`, reread the
exact 32 UTF-8 bytes, and produced SHA-256
`5dc99b3cd6f31525efd4c828e549900992fb8b35374850b368a9f1aee6b3b60d`.
The same probe reproduced null lookups for `.ai-bridge-conflicts`. `AI Bridge Conflicts`
also passed, but the lowercase hyphenated name is selected as the simpler deterministic
namespace. The root remains disjoint from the observed `.obsidian` configuration
directory.

One core namespace owner defines both `ai-bridge-conflicts` and the historical
`.ai-bridge-conflicts` root with exact root-or-descendant boundary checks. Shared local
eligibility, saved-file events, bootstrap enumeration, and review-candidate admission
consume this policy. Prefix-sharing names such as `ai-bridge-conflicts-notes` are not
reserved.

Frozen v3/v4 receipt validation accepts an exact operation- or step-scoped path under
either root. Path generation and every new host effect use only the current root. A
pending/evidence-required legacy receipt does not match the current generated recovery
path, so it remains blocked and is neither redispatched nor rewritten. Verified legacy
receipts retain their historical evidence identity. No automatic move, copy, repair,
raw filesystem lookup, or physical-dot-folder inference is added.

## Consequences

The new archive is visible in the vault UI/index but cannot enter mirror inventory or
runtime event admission. Operators still own artifact cleanup, and a collision at the
reserved current root remains a fail-closed refusal. Both namespaces remain excluded
forever so historical physical leftovers cannot propagate to R2.

Existing operation/step determinism, create-only behavior, exact reread/hash proof,
preservation-before-replacement ordering, and the absence of local delete/move/rename
authority are unchanged.

## Alternatives

Keeping the dot root with a raw filesystem fallback was rejected because it would add
an unreviewed capability and still would not create official Vault-index evidence.
`AI Bridge Conflicts` passed the probe but adds no benefit over the simpler selected
name. A configurable root was rejected because one deterministic reserved namespace is
sufficient and avoids another path-policy owner and migration surface.

## Evidence / related documents

See [corrective host qualification](../qualification/m4-host-visible-preservation.md),
[M4 specification](../milestones/m4-remote-to-local-reconciliation-and-conflict-resolution.md),
[operator guidance](../operations.md), and focused core/plugin/artifact tests.
