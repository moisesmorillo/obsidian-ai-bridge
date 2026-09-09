# Instructions for AI coding agents

## General

- Read relevant documentation before modifying code.
- Prefer simple, explicit, idiomatic TypeScript.
- Prefer modern web APIs over platform-specific APIs where practical.
- Use the latest stable ecosystem tooling.
- Avoid unnecessary dependencies.
- Do not expand scope without justification.
- Preserve package boundaries.
- Keep documentation synchronized with architectural changes.
- Make small, logically separated changes.
- Never commit secrets or credentials.

## Code quality

- Favor self-documenting code over explanatory comments.
- Do not add comments that merely restate what the code already says.
- Use precise names and small abstractions.
- Use TSDoc for public APIs or contracts when documentation provides actual value.
- Comments should explain `why`, not `what`.
- Keep functions focused and reasonably small.
- Avoid clever code when straightforward code is easier to maintain.
- Prefer immutable data where practical.
- Prefer explicit types at architectural boundaries.

## Architecture

Keep business logic outside transport and framework adapters.

Intended package responsibilities:

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

Dependencies should generally flow inward:

```text
apps/*
   ↓
packages/protocol
packages/core
```

`packages/core` must not depend on:

- Cloudflare APIs
- Obsidian APIs
- HTTP frameworks
- filesystem implementations

## Testing

- Use Vitest.
- Add tests for behavior changes.
- Prefer behavioral tests over implementation-detail tests.
- Critical sync logic should eventually be testable without Cloudflare or Obsidian.
- Run tests before considering work complete.
- Never weaken tests merely to make a build pass.

## Validation

Before completing a task, run the relevant:

```bash
bun run format
bun run lint
bun run typecheck
bun run test
bun run build
```

If the repository later provides a combined validation command, prefer that.

## Security and data safety

- Security and data safety have priority over convenience.
- Never introduce silent data-loss behavior.
- Future sync conflicts must never be silently resolved by overwriting data.
- Validate all untrusted input at system boundaries.
- Treat vault paths and remote content as untrusted input.
- Never log authentication tokens or vault content by default.
