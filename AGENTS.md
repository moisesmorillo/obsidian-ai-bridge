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

Use `mise.toml` for:

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

Avoid duplicating task orchestration between `mise.toml` and language-native script files. `mise` should be the project task runner.

The README must document:

- `mise` as a required development dependency;
- installation;
- installation verification;
- `mise install`;
- the standard `mise run ...` workflow;
- the purpose of `mise.local.toml`.

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

### Deprecated APIs and warnings

Treat editor, compiler, linter, and dependency deprecation diagnostics as failures unless an explicit compatibility decision documents why a deprecated API must remain.

- New deprecated API usage is prohibited.
- Internal code must not use a deprecated compatibility API.
- CI must detect deprecated TypeScript API usage with type-aware static analysis.
- A green type check is not sufficient when an editor still reports a warning.

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

## Functions and responsibilities

A function must not have responsibilities beyond what its name promises.

If a function:

- parses input;
- validates input;
- applies business rules;
- performs persistence;
- formats transport responses;

it likely contains multiple responsibilities and should be decomposed.

Extract cohesive functions or utilities when doing so improves:

- readability;
- reuse;
- unit testing;
- naming;
- complexity;
- separation of concerns.

Do not extract trivial functions merely to reduce line count.

Prefer low cyclomatic complexity.

Functions, methods, classes, modules, and files should remain small enough to understand without mentally simulating many branches or unrelated states.

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

Reserve `.d.ts` for actual ambient declarations, module augmentation, external declarations, or global runtime typing. Do not use ambient declarations merely to avoid explicit imports.

## Constants and literals

Do not use magic numbers or magic strings when the literal has semantic meaning.

Prefer:

```ts
const MAX_POOL_SIZE = 10;
const MAX_NOTE_SIZE_BYTES = 1024 * 1024;
const AUTHENTICATION_TYPE_BEARER = "bearer";
```

Protocol values, limits, routes, media types, header names, statuses, retry values, timeouts, and other meaningful literals should normally be named.

For closed sets, use an idiomatic strongly typed representation such as an enum or an `as const` object plus union type.

Semantic literals must have one authoritative representation. Do not introduce disconnected copies of protocol codes, result discriminators, authentication states, headers, media types, or routes.

Do not extract purely syntactic or trivial literals when naming them adds no semantic value.

## Documentation and comments

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

Use the language-standard documentation format for named code constructs.

In TypeScript, use concise TSDoc for named:

- functions;
- methods;
- classes;
- interfaces;
- type aliases;
- enums;
- repositories;
- services;
- reusable domain abstractions.

Documentation should describe the contract, purpose, invariants, side effects, failure modes, or important semantics.

Do not create verbose documentation that simply repeats the symbol name or TypeScript signature.

Use TSDoc quality appropriate to the declaration. Document exported declarations and non-trivial internal declarations, including semantic constants, closed sets, schemas, interfaces, types, classes, constructors, and meaningful methods.

Use `@param`, `@returns`, `@throws`, `@example`, `@remarks`, and `@see` when they clarify a function or method contract. Do not add redundant JSDoc type annotations to TypeScript source. Automated documentation linting is a minimum guard; manual review must still assess whether the documentation explains behavior and invariants.

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

Handlers must remain thin.

Handlers depend on application services or use cases, never repository ports or infrastructure adapters directly. They must not pass repositories into business functions.

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

Do not use direct application-level:

- `console.log`;
- `console.warn`;
- `console.error`;
- `console.debug`.

Use a centralized structured logger or logging abstraction.

Logs should be machine-readable and enriched with useful structured context where applicable, for example:

- request ID;
- method;
- route;
- status;
- duration;
- operation;
- error code.

Never log:

- authentication tokens;
- secrets;
- credentials;
- vault content;
- sensitive request bodies.

Keep the logging abstraction portable and mockable.

Do not add a large logging dependency unless it provides clear value over a small project abstraction.

Prefer an established structured logging library compatible with the target runtime over a bespoke logger implementation. Logging adapters must use route templates rather than raw URLs when a URL could expose user-controlled identifiers.

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

## Biome and static validation

The project validation pipeline must cover all configured Biome diagnostics, including assist actions.

If `organizeImports` or another assist action is enabled, CI must detect violations.

Do not assume that separate formatter and linter invocations cover Biome assists.

Use an appropriate Biome `check`/`ci` workflow so editor diagnostics and CI remain aligned.

A repository should not be considered clean when the editor reports project-configured diagnostics that CI ignores.

Complement Biome with fast type-aware semantic linting when TypeScript or editor diagnostics cover rules Biome cannot enforce. Avoid duplicating checks already strongly enforced by Biome or TypeScript. Static analysis should enforce deprecated API use, unsafe typing, documentation completeness, console usage, and complexity where practical.

The canonical validation pipeline must have zero unexplained warnings. It must fail when a deprecated API is introduced.

## Decomposition and iteration

Functions must have one conceptual responsibility, not merely a small line count. File decomposition must follow cohesive concepts rather than arbitrary symbol counts.

Centralize duplicated policy, such as response headers, error mappings, normalization, and authentication rules, in one focused abstraction.

Avoid unconditional `while (true)` loops unless the condition cannot be expressed clearly and the reason is documented. Model continuation state so impossible states are unrepresentable where practical.

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
