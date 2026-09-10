# Instructions for AI coding agents

## General principles

- Read the relevant repository documentation before modifying code.
- Prefer simple, explicit, idiomatic, modern code.
- Use the latest stable ecosystem tooling unless compatibility requires otherwise.
- Avoid unnecessary dependencies and abstractions.
- Do not expand scope without a clear technical reason.
- Make small, logically separated changes.
- Preserve architectural and package boundaries.
- Keep documentation synchronized with architectural, API, tooling, and behavior changes.
- Never commit credentials, tokens, secrets, or machine-specific configuration.
- Optimize for maintainability, readability, testability, portability, and low operational complexity.

## Repository execution protocol

Before feature work:

1. Read `README.md`, `AGENTS.md`, `docs/architecture.md`, and `docs/roadmap.md`.
2. Identify the single milestone marked `NEXT` and read its linked specification
   under `docs/milestones/`, then inspect the relevant source and tests.
3. Implement only that milestone. If its specification is not implementation-ready,
   create/refine it before writing production code. Document material product or
   architectural ambiguity and seek clarification rather than guessing.
4. Preserve completed milestone invariants. Repository state beats conversation
   assumptions; current code beats stale documentation. Record discrepancies and
   correct docs, but never silently reinterpret a completed decision. Use
   `docs/decisions/README.md` for consequential architectural changes.
5. Keep tests, coverage, documentation and architecture notes synchronized during
   implementation. Follow the canonical installation/validation tasks below and
   perform semantic review after automated checks pass; green CI alone is not done.
6. On completion, update the milestone spec/status and evidence, `docs/roadmap.md`,
   affected current-state/architecture/API docs, ADRs and operational instructions.
   Only then mark the following eligible milestone `NEXT` and update active-spec
   links. Refine its detailed spec before production implementation; do not start
   later-milestone code in the completion PR. Transitions are canonical when merged.

The roadmap owns execution order and unresolved decisions. Do not infer deployed
resources, credentials or vault installations from configuration, or deploy merely
to validate work. If no next milestone remains, propose a roadmap update rather
than inventing product scope.

## Tooling and development environment

`mise` is the canonical entry point for project tooling and tasks.

Use:

```bash
mise install
mise run check
mise run test
mise run build
mise run dev
```

Do not document or rely on direct `bun run ...`, `vitest ...`, `biome ...`, or similar commands as the primary project interface when a corresponding `mise` task exists.

### mise responsibilities

Use `.mise.toml` for:

- runtime and tool versions;
- project tasks;
- non-sensitive environment variables;
- development tools that do not belong in the language dependency graph.

Use `mise.local.toml` for:

- secrets;
- credentials;
- machine-specific environment values;
- local overrides.

`mise.local.toml` must never be committed.

Language-native dependency files such as `package.json` remain responsible for actual application and development dependencies.

Avoid duplicating task orchestration between `.mise.toml` and language-native script files. `mise` should be the project task runner.

The README must document:

- `mise` as a required development dependency;
- installation;
- installation verification;
- `mise install`;
- the standard `mise run ...` workflow;
- the purpose of `mise.local.toml`.

## Quality gate

A green CI pipeline is necessary but not sufficient.

Modified code must have zero unexplained:

- compiler diagnostics;
- linter diagnostics;
- editor diagnostics;
- deprecation warnings;
- configured assist diagnostics.

APIs marked `@deprecated` must not be used unless an explicit compatibility requirement documents why the deprecated API is unavoidable. Internal code must not depend on a deprecated compatibility API.

Whenever tooling can reliably enforce an engineering rule, prefer automated enforcement in `mise run check` over relying exclusively on agent instructions.

Framework types must be parameterized when their defaults introduce weak typing such as implicit `any`.

## TypeScript

Use strict TypeScript.

### Strong typing

Do not use weak typing as an escape hatch.

Avoid:

- `any`;
- `unknown`;
- weak generic records;
- unchecked casts;
- broad types that avoid modeling the actual domain.

Prefer:

- explicit domain types;
- discriminated unions;
- constrained generics;
- branded types where useful;
- strongly typed DTOs and contracts;
- exhaustive handling of closed sets.

If an external library forces weakly typed input at a boundary, isolate it inside the adapter, validate it immediately, and convert it into a strong application type before it can propagate.

Do not use `as SomeType` merely to silence the compiler.

### Framework types

Do not rely on framework generic defaults when they introduce `any` or otherwise weaken application types.

For Hono and other typed frameworks, define and use explicit bindings, variables, context, middleware, handler, and application types. Framework services must be injected through typed context variables or another explicit composition boundary.

### Imports

Do not use relative imports for project modules.

Avoid:

```ts
import { value } from "./module";
import { value } from "../../module";
```

Never use absolute filesystem imports.

Use aliases declared at the appropriate shared `tsconfig` level.

Aliases must work consistently with:

- TypeScript;
- Bun;
- Vitest;
- Wrangler;
- the Obsidian plugin bundler.

Cross-package dependencies must still respect workspace package boundaries. Do not use aliases to reach into another package's private internals.

Use `import type` for type-only dependencies.

### Modern language features

Prefer modern, idiomatic language APIs over lower-level legacy constructs.

Prefer operations such as:

- `map`;
- `filter`;
- `find`;
- `some`;
- `every`;
- `forEach` where control flow allows it;
- `for...of` when `await`, `break`, or `continue` are required;
- `for...in` only when iterating object keys is actually intended.

Avoid C-style indexed loops when a clearer modern construct exists.

Do not prefer a modern construct when it makes the code less readable or less correct.

## Control flow

Prefer guard clauses and early returns.

Avoid `else` when the alternative can naturally become the default flow.

Prefer:

```ts
if (!isValid(value)) {
  return invalidResult();
}

return process(value);
```

over:

```ts
if (isValid(value)) {
  return process(value);
} else {
  return invalidResult();
}
```

Keep the happy path minimally indented.

Avoid unnecessary nesting.

Do not apply this mechanically when an `else` genuinely improves clarity.

Prefer declarative control flow over long imperative conditional chains.
Use exhaustive `switch` or equivalent typed pattern matching for closed
discriminated unions. Simple readable `if` statements are preferred over
unnecessary abstractions; do not remove conditionals merely to satisfy a
functional-programming style preference.

### Fallible pipelines

For multi-step fallible pipelines, prefer explicit typed result states over
implicit fallthrough, sentinel values, or loosely related booleans when doing so
improves clarity and exhaustiveness.

### Loops and termination

Avoid unconditional loops such as:

```ts
while (true) {
  // ...
}
```

when the actual termination condition can be modeled explicitly.

Prefer:

- condition-driven loops;
- iterators;
- async iterators;
- typed pagination state;
- generators;

when they make termination and invariants clearer.

An unconditional loop is acceptable only when it genuinely produces the clearest implementation and its termination invariant is explicit and safe.

## Responsibility boundaries

Single Responsibility Principle refers to conceptual responsibility, not function length. A short function can still have too many responsibilities.

Parsing syntax, validating input, applying domain policy, authenticating credentials, performing persistence, transforming data, and formatting transport responses are distinct responsibilities unless there is a compelling reason to combine them.

A function must not have responsibilities beyond what its name promises. Extract cohesive functions or modules when doing so improves:

- readability;
- reuse;
- unit testing;
- naming;
- complexity;
- separation of concerns.

Do not extract trivial functions merely to reduce line count. Prefer low cyclomatic complexity. Functions, methods, classes, modules, and files should remain small enough to understand without mentally simulating many branches or unrelated states.

Handlers and controllers depend on application services or use cases. They must not depend directly on repository implementations and should normally not depend directly on repository ports.

Application services depend on repository ports. Infrastructure adapters implement repository ports. Framework-specific objects must remain at transport or infrastructure boundaries.

## Duplication

Avoid duplicated policy, not merely duplicated lines.

Shared behavior such as:

- common response headers;
- media-type normalization;
- error mappings;
- authentication schemes;
- limits;
- route semantics;
- serialization rules;

must have one cohesive source of truth.

Extract shared abstractions when they represent the same concept. Do not introduce generic helpers solely to reduce textual duplication.

## File organization

Do not overload implementation files with unrelated declarations and definitions.

Separate concerns into dedicated modules where useful, for example:

```text
auth/
  auth.ts
  auth.constants.ts
  auth.types.ts
  auth.errors.ts
  auth.test.ts
```

Use dedicated modules for:

- constants;
- types;
- interfaces;
- errors;
- enums or closed value sets;
- schemas;
- repositories;
- services;
- handlers.

Do not interpret this as requiring one file per symbol. Group closely related definitions by concern.

Prefer `*.types.ts` or other explicit TypeScript modules for domain and application types.
Files named `*.types.ts` MUST contain type-level declarations only. Runtime constants
and enum-like runtime values belong in `*.constants.ts` unless co-location is
technically required and documented.

Reserve `.d.ts` for actual ambient declarations, module augmentation, external declarations, or global runtime typing. Do not use ambient declarations merely to avoid explicit imports.

## Semantic source of truth

Domain, application, and protocol states must have one authoritative typed definition.

Do not scatter repeated raw strings for concepts such as:

```text
authenticated
unauthenticated
invalid
not_found
ok
pending
```

through business and transport code.

Prefer a strongly typed constant object, enum, discriminated union, or schema as the source of truth, and derive related types from it when practical.

HTTP header names, media types, protocol values, application result kinds, externally visible state values, limits, routes, statuses, retry values, and timeouts are semantic values, not arbitrary strings or numbers. Name them and keep one authoritative representation.

For example:

```ts
const MAX_POOL_SIZE = 10;
const MAX_NOTE_SIZE_BYTES = 1024 * 1024;
const AUTHENTICATION_TYPE_BEARER = "bearer";
```

Do not create meaningless constants for syntax-only or trivial literals.

## Documentation quality

Code should explain itself through:

- naming;
- decomposition;
- types;
- architecture.

Avoid explanatory inline comments that narrate what the code is doing.

Do not write comments such as:

```ts
// Check if token is valid
if (!isValidToken(token)) {
  // Return unauthorized
  return unauthorized();
}
```

Historical reasoning belongs primarily in:

- commit messages;
- pull request descriptions;
- ADRs;
- architecture documentation.

Inline comments are appropriate when they explain a non-obvious `why`, invariant, compatibility issue, security constraint, or external behavior that cannot reasonably be expressed in code.

### Documentation comments

TypeScript code uses TSDoc-style documentation comments. Documentation is part of the code contract, not decoration.

All exported/public declarations MUST have useful TSDoc.
Non-trivial internal declarations MUST also be documented. Documentation quality
matters more than merely having a comment block.

Meaningful named declarations should have useful documentation, including:

- functions;
- methods;
- classes;
- constructors where relevant;
- interfaces;
- interface members with non-obvious semantics;
- type aliases;
- enums and enum-like closed sets;
- schemas;
- repositories and ports;
- services and use cases;
- semantic constants;
- important configuration and definition objects.

Document exported declarations and non-trivial internal declarations. Documentation must explain purpose, contract, invariants, behavior, side effects, failure modes, units, security constraints, or usage.

Function and method documentation should use the appropriate TSDoc constructs when useful:

- `@param` to explain parameter semantics and constraints;
- `@returns` to explain result semantics;
- `@throws` to document expected failure types and conditions;
- `@example` for non-obvious or reusable APIs;
- `@remarks` for important invariants or deeper behavior;
- `@see` for relevant related contracts.

Do not repeat TypeScript type annotations inside documentation merely to duplicate the signature. Avoid low-value comments such as:

```ts
/** Handles a request. */
```

when the function contract contains meaningful semantics that should be documented.

Semantic constants and closed sets must document what they represent and whether they are protocol-stable or internally configurable.

## Errors

Do not represent application or domain errors as arbitrary strings.

Errors must have an explicit type.

Prefer:

- typed error classes when runtime identity or behavior is required;
- discriminated unions for result-oriented flows;
- strongly typed error codes for protocol contracts.

Avoid stringly typed control flow such as:

```ts
if (error === "unauthorized") {
  ...
}
```

Error definitions should normally live outside business-logic implementation files.

HTTP error representation belongs to the transport layer and must not leak into the domain.

## Architecture

Use pragmatic Clean Architecture / Ports and Adapters.

Architecture must provide real separation without ceremonial layers.

For API code, the normal responsibility flow is:

```text
transport / handlers
        ↓
application services / use cases
        ↓
domain
        ↓
repository ports
        ↓
infrastructure adapters
```

### Transport / handlers

Responsible for:

- HTTP;
- Hono context;
- request parsing;
- response formatting;
- headers;
- transport-level validation;
- status codes.

Handlers must remain thin and must not pass repositories into business functions.

### Application services / use cases

Responsible for:

- orchestration;
- application rules;
- business workflows.

Application services must not depend on Hono, Cloudflare request objects, Obsidian APIs, or persistence implementations.

### Domain / core

Responsible for:

- domain models;
- invariants;
- domain rules;
- repository contracts;
- platform-independent behavior.

### Repositories / ports

Define contracts for external state and services.

Business logic must depend on repository interfaces, not infrastructure implementations.

### Infrastructure adapters

Responsible for integrations such as:

- Cloudflare R2;
- Obsidian;
- filesystem;
- external APIs;
- future storage implementations.

Changing R2 to another backend should not require rewriting business rules.

Do not create layers such as Controller → Manager → Service → UseCase → Repository unless each layer has a distinct responsibility.

## Existing package boundaries

The intended package responsibilities are:

```text
apps/worker
Cloudflare Worker HTTP/API adapter and infrastructure integration.

apps/obsidian-plugin
Obsidian client integration and local vault adapter.

packages/core
Platform-independent domain and application logic.

packages/protocol
Shared protocol contracts, schemas, API types, and serialization definitions.
```

Dependencies should generally flow inward.

`packages/core` must not depend on:

- Cloudflare APIs;
- Obsidian APIs;
- Hono;
- HTTP concerns;
- filesystem implementations;
- infrastructure adapters.

## HTTP APIs

For TypeScript APIs running on Cloudflare Workers, Hono is the required HTTP framework unless an explicit architectural decision documents why it cannot be used.

Hono must remain confined to the transport layer.

Do not put business rules directly inside Hono route callbacks.

API contracts must be documented with OpenAPI.

Expose interactive API documentation using Scalar.

Keep OpenAPI documentation synchronized with implementation.

Prefer deriving validation and API documentation from shared strongly typed schemas where practical instead of maintaining duplicate manual contracts.

## Logging and observability

Application logging must use an established structured logging library compatible with the target runtime. For TypeScript Edge and Cloudflare applications, prefer a runtime-portable structured logger.

Do not use direct application-level:

- `console.log`;
- `console.warn`;
- `console.error`;
- `console.debug`.

Do not build a project-specific logging framework when a mature lightweight library provides the required behavior. Project-specific code may provide a thin integration or adapter when necessary for:

- dependency injection;
- context enrichment;
- privacy;
- redaction;
- testing.

Logs must be machine-readable and enriched with useful structured context where applicable, for example:

- request ID;
- method;
- registered route template;
- status;
- duration;
- operation;
- error code.

Never log secrets, credentials, raw authorization headers, vault content, request bodies, or other sensitive user data.

Prefer registered route templates over concrete request URLs when route parameters can contain sensitive information.

## Testing

Use Vitest.

### Unit testing

Unit tests are mandatory for behavior-bearing code.

External and platform dependencies must be isolated using mocks, fakes, stubs, or deterministic test doubles.

Examples include:

- Cloudflare R2;
- Obsidian APIs;
- network requests;
- filesystem access;
- clocks when behavior depends on time;
- logging sinks;
- other external services.

Tests should be:

- deterministic;
- isolated;
- fast;
- behavior-focused.

Do not weaken assertions merely to make tests pass.

Do not couple unit tests unnecessarily to private implementation details.

### TDD

Prefer Test-Driven Development for new behavior:

1. write the failing unit test;
2. implement the minimum behavior;
3. refactor while keeping the test green.

TDD may be skipped when it introduces disproportionate complexity or provides little practical value.

### E2E

End-to-end tests are not the default strategy.

Do not introduce E2E tests unless a concrete risk cannot reasonably be covered by unit or focused integration tests.

Prefer unit coverage first.

### Test layout

Production `src/` trees should contain production source only.

For this repository, tests live in dedicated `tests/` trees outside `src/`.

Use `tests/unit/` for isolated behavioral tests and `tests/integration/` for
tests that intentionally compose multiple application layers.

Do not label integration tests as E2E unless they exercise real external system
boundaries.

Follow an established repository test-layout convention consistently. When
defining a new convention, prefer a dedicated test tree when it improves
navigation and makes test scope explicit.

### Coverage

Behavioral test coverage must be measured.

Coverage is a regression signal, not proof of test quality.

Track lines, statements, functions, and branches.

Coverage configuration must include relevant production source even when a file
is not imported by any test.

Thresholds should prevent regression from an established baseline rather than
incentivize meaningless tests.

## Static analysis

Biome remains responsible for formatting, supported lint rules, and assists. The validation pipeline must cover every configured Biome diagnostic, including actions such as `organizeImports`.

Do not assume separate formatter and linter invocations cover Biome assists. Use an appropriate Biome `check` or `ci` workflow so editor diagnostics and CI remain aligned.

Use complementary type-aware static analysis when TypeScript or Biome cannot enforce an important rule. Avoid duplicating checks already strongly enforced by Biome or TypeScript.

The validation pipeline must fail on deprecated API usage. Static analysis should also enforce unsafe typing, documentation completeness, direct console usage, and complexity where practical.

Semantic linting must be part of:

```bash
mise run lint
```

and the canonical:

```bash
mise run check
```

Prefer modern, fast TypeScript-aware tooling over introducing a legacy ESLint stack solely for one rule.

Documentation linting should be automated where practical, but automated presence checks never replace manual documentation-quality review.

## GitHub Actions

Workflow and job names must communicate their real purpose.

Avoid generic names such as:

```text
Validate repository
```

Prefer names such as:

```text
Quality checks
Test and build
Code quality
```

Use the latest stable major-version tag for GitHub Actions.

Prefer:

```yaml
uses: actions/checkout@v7
```

Do not pin Action usage to patch or minor versions such as:

```yaml
uses: some/action@v4.3.0
```

Do not use `@latest`.

Verify the current stable major before introducing or updating an Action.

CI should invoke the same `mise` tasks used locally rather than reimplementing project validation commands directly in YAML.

## Security and data safety

Security and data safety take priority over convenience.

Never introduce silent data-loss behavior.

Future sync conflicts must never be silently resolved by overwriting data.

Validate all untrusted input at system boundaries.

Treat vault paths, HTTP input, remote content, persisted metadata, and plugin input as untrusted.

Never leak implementation details, stack traces, credentials, tokens, or sensitive content through API responses or logs.

Security-sensitive responsibilities should be decomposed into small, independently testable units.

## Review requirement

Before declaring a refactor complete, perform a manual semantic review after automated validation succeeds.

The review must inspect:

- responsibility boundaries;
- weak or implicit typing;
- deprecated APIs;
- documentation quality;
- semantic magic literals;
- duplicated policy;
- architecture direction;
- unnecessary dependencies;
- unbounded control flow;
- security-sensitive behavior;
- editor warnings.

Do not treat passing tests as evidence that the architecture or code quality is correct.

A corrective review is not complete until every explicitly listed review finding is
either fixed or explicitly documented in the PR as intentionally deferred with a
technical justification.

## Completion criteria

Before considering a task complete:

```bash
mise install
mise run check
```

The canonical check must cover, as applicable:

- formatting;
- Biome diagnostics and assists;
- linting;
- type checking;
- unit tests;
- build.

Additionally:

- editor diagnostics introduced by repository configuration must be clean;
- relevant documentation must be updated;
- no secrets or local configuration may be committed;
- behavior changes must have unit tests;
- architecture boundaries must remain intact.
