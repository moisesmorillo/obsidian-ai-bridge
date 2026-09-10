# Contributing

Thank you for helping improve `obsidian-ai-bridge`. The project is experimental, so focused changes and clear rationale are especially valuable.

## Development setup

Install [mise](https://mise.jdx.dev/installing-mise.html), verify it with `mise --version`, then install the repository's pinned Bun version and dependencies:

```bash
mise install
mise run install
```

Use `mise run ...` for project tasks. Bun remains the package manager; do not add npm, Yarn, or pnpm lockfiles.

## Branches and pull requests

- Create a focused branch from the default branch.
- Keep pull requests small and explain the reason for the change.
- Update architecture or other documentation when a change affects an established boundary.
- Do not include secrets, real vault content, or generated local artifacts.

## Testing and validation

Add behavioral Vitest coverage for behavior changes. Before opening a pull request, run:

```bash
mise run check
```

This runs Biome formatting checks, linting, configured assists, type checking, unit tests, and builds. Use `mise run format`, `mise run typecheck`, `mise run test`, or `mise run build` for focused work. Put shared non-sensitive configuration in `.mise.toml`; put local tokens and machine-specific overrides in ignored `mise.local.toml`. The repository does not use `.env` files.

## Coding style

Use explicit, idiomatic TypeScript and modern web APIs where practical. Prefer small functions, precise names, strong types, and package boundaries over clever abstractions. Use comments for non-obvious constraints. Follow the stricter TSDoc policy in [AGENTS.md](AGENTS.md): every exported/public declaration needs useful TSDoc, and non-trivial internal declarations must also be documented.

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
