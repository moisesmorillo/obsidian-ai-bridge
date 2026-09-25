# M6 final qualification — authorized stateless MCP adapter

**Disposition:** M6 implementation and qualification are complete on the single
completion branch. The PR is intended to remain unmerged; its roadmap transition
becomes canonical only after merge. No milestone is marked NEXT, and no M7 is defined.

**Branch:** `feat/m6-mcp-adapter`

**Base:** `main` at `e6b3f75205d1da62dae623145ed933a414a5b4fe`

**PR title:** `feat(mcp): add authorized MCP adapter`

## Scope and decisions

The Worker exposes stateless Streamable HTTP at `POST /mcp` using the official
`@modelcontextprotocol/server` 2.0.0 SDK and protocol revision `2026-07-28`. Eight
narrow tools expose bounded note/recovery listing, metadata inspection, conditional
note writes, recoverable deletion, and existing recovery maintenance. Two explicit
resource templates return one authorized note or eligible recovery body as literal
untrusted Markdown. MCP does not expose arbitrary dispatch, search/inference,
reconciliation, or local-vault mutation.

Every request reuses the M5 digest-only credential registry, bearer authentication,
and typed principal. Exact independent `read`, `write`, and `delete` permissions are
checked before application services resolve. One shared core conditional-write policy
serves HTTP and MCP; current-generation CAS, recovery-first tombstones, recovery seal,
retention, and purge eligibility remain owned by existing services. No MCP code reaches
R2 directly or persists transport state.

The M5 bearer is an **application-level authentication overlay**, not MCP OAuth. The
implementation does not issue/audience-bind OAuth tokens, publish Protected Resource
Metadata, or claim full MCP authorization-profile conformance. OAuth-discovery-only
clients are unsupported; a preconfigured bearer header is required. The official
Inspector CLI was not installed, so qualification used the allowed alternative: the
official TypeScript MCP Client 2.0.0. No product-client, Inspector UI, or deployed
service compatibility is claimed.

Transport policy is stateless POST-only; GET/DELETE, earlier initialize-era protocol,
sessions, HTTP+SSE, and cross-origin browser requests are rejected. Present origins
must exactly match the request origin. Actual request bytes are bounded to 6,307,840,
responses to 8 MiB, and streamed chunks to 16,384; responses are `no-store`. Errors
remain typed and sanitized, preserving mutation effect uncertainty without exposing
raw exceptions, storage metadata, receipts, hashes, credentials, or unrequested note
content.

The initial production estimate was approximately 700 net lines. The maintainer
explicitly authorized one coherent M6 exception up to 12 production TypeScript files
and 2,000 net new production lines. The final change is **10 production TypeScript
files and 1,636 net new lines**, within that bound. It is limited to the shared
conditional-write seam, official MCP adapter/transport, existing Worker assembly and
logging integration, and required regression tests/documentation; it adds no unrelated
cleanup or later-milestone scope.

## Official-client and safety qualification

Integration tests use official `Client` and `StreamableHTTPClientTransport` from
`@modelcontextprotocol/client` 2.0.0, pinned to protocol version `2026-07-28`. The
transport's injected Fetch sends requests to the composed Hono Worker application at
`https://example.test/mcp`; it does not open a network socket. Test fixtures use
synthetic bearer tokens whose digests are loaded into the existing registry, an
in-memory mirror bucket, deterministic services, and a test-only logger. No live R2,
Cloudflare account, production Worker, personal vault, or deployment is accessed.

The official client exercises discovery, tool and resource-template listing, explicit
resource reads, conditional mutations, recovery flows, independent permissions,
credential lifecycle, and sanitized results. Focused raw Worker requests cover
unsupported methods and legacy protocol traffic, cross-origin/malformed origins,
malformed JSON/content type/content length, streamed body failures and size bounds,
no-store behavior, and absence of service resolution on denials. Hostile Markdown is
returned only by explicit resource reads and does not alter discovery, policy, effects,
or diagnostics. Tests also verify unknown mutation effect certainty and tombstone
sealing-stage information without raw exception/storage leakage.

A regression test was added for a valid note beginning with U+FEFF: the default UTF-8
decoder treated the leading BOM as a signature and stripped it, causing the shared
content validator to refuse otherwise valid exact text. The core validator now uses
`ignoreBOM: true`, preserving the literal character while continuing to reject
unpaired UTF-16 surrogates and enforce the exact UTF-8 byte bound. Both core-service
and official-MCP-client tests verify exact round-trip preservation.

## Validation evidence

- `mise install`: all 44 declared tools were already installed. `mise run install`
  completed with no dependency changes.
- Focused conditional-write and official-client run:
  `mise run test -- apps/worker/tests/integration/current-generation-conditional-write.test.ts apps/worker/tests/integration/mcp.test.ts` — **2 files, 17 tests passed** after the BOM fix. The two new BOM regressions failed before the fix and passed afterward.
- Final canonical `mise run check`: **passed**. It includes Biome/assists, type-aware
  Oxlint, TypeScript, V8 coverage and thresholds, Worker storage qualification, Worker
  dry-run build, plugin build/smoke, release identity, and TSDoc presence.
- Canonical test totals: **83 source test files / 1,402 tests**, **1 Worker storage
  file / 8 tests**, and **1 generated-plugin smoke file / 12 tests**.
- Source coverage: statements **95.01% (8,836/9,300)**, branches **90.71%
  (7,087/7,812)**, functions **98.33% (1,947/1,980)**, and lines **96.96%
  (8,414/8,677)**. Configured thresholds passed.
- TSDoc presence: **0 violations across 208 production files**. `git diff --check`
  passed. A local link/anchor check passed for all **10 changed Markdown files**;
  the final roadmap marks M6 complete, has no NEXT milestone, and defines no M7.
- Worker build used Wrangler `deploy --dry-run`; it did not deploy. Storage and client
  tests used only local fakes/in-memory state.

## Semantic review and finding closure

The final manual review covered the changed transport, schemas, permission matrix,
conditional-write seam, recovery effect reporting, resource content boundary, logs,
package direction, TSDoc, documentation consistency, and repository constraints.

Two actionable findings were fixed and regression-tested:

1. The `seal_recovery` and `purge_recovery` output schemas did not admit the sanitized
   failure envelope emitted by those handlers. Their contracts now accept either the
   safe recovery result or typed failure; integration assertions verify that every
   exposed tool advertises the stable failure shape.
2. The UTF-8 round trip stripped a leading BOM and rejected valid exact note text.
   Decoder BOM handling now preserves U+FEFF, with core and official-client tests for
   exact text retention.

The stale-precondition message was also made conditional-neutral: it does not imply
that a supplied revision existed or that an update was attempted. Re-review found no
open actionable findings (**APPROVE**).

## Residual limits and non-claims

M6 does not qualify MCP Inspector/UI behavior, ChatGPT/Claude or another product
client, OAuth/Protected Resource Metadata interoperability, a production deployment,
production R2 behavior, or personal-vault operation. The existing bearer model is not
OAuth and is not audience-bound. The M5 software-support envelope is unchanged; M6
adds no Obsidian host support claim, security certification, availability/SLA promise,
complete-backup guarantee, or physical-erasure claim. No production resource was
deployed and this PR must not be merged by the implementation agent.
