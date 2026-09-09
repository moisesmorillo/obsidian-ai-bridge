# Contributing

Thank you for helping improve `obsidian-ai-bridge`. The project is experimental, so focused changes and clear rationale are especially valuable.

## Development setup

Install [mise](https://mise.jdx.dev/), then install the repository's pinned Bun version:

```bash
mise install
bun install --frozen-lockfile
```

Use Bun for package installation, scripts, and workspace commands. Do not add npm, Yarn, or pnpm lockfiles.

## Branches and pull requests

- Create a focused branch from the default branch.
- Keep pull requests small and explain the reason for the change.
- Update architecture or other documentation when a change affects an established boundary.
- Do not include secrets, real vault content, or generated local artifacts.

## Testing and validation

Add behavioral Vitest coverage for behavior changes. Before opening a pull request, run:

```bash
bun run check
```

This runs formatting checks, linting, type checking, tests, and builds. Individual commands are also available in `package.json`.

## Coding style

Use explicit, idiomatic TypeScript and modern web APIs where practical. Prefer small functions, precise names, strong types, and package boundaries over clever abstractions. Use comments for non-obvious constraints and TSDoc when public API documentation provides real value.

## Commits

Write concise imperative commit messages, for example:

```text
Add protocol envelope types
```

Keep unrelated changes in separate commits when practical.

## Issues

Search existing issues before opening a new one. Include a clear description, reproduction details for bugs, expected behavior, and relevant environment information. Never include sensitive vault content or credentials.

## Security reports

Do not report vulnerabilities in public issues. Follow the private reporting process in [SECURITY.md](SECURITY.md).
