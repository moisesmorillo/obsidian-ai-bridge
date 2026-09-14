# Contributing

Thank you for helping improve `obsidian-ai-bridge`. The project is experimental, so focused changes and clear rationale are especially valuable.

## Development setup

Install [mise](https://mise.jdx.dev/installing-mise.html), verify it with `mise --version`, then install the repository's pinned Bun version and dependencies:

```bash
mise install
mise run install
```

Use `mise run ...` for project tasks. Bun remains the package manager; do not add npm, Yarn, or pnpm lockfiles.

## Choosing work

Read [AGENTS.md](AGENTS.md), [architecture](docs/architecture.md), the
[canonical roadmap](docs/roadmap.md) and the specification linked by its `NEXT`
milestone, then inspect the relevant source/tests. Keep feature PRs within that
milestone; unresolved architecture-affecting decisions need a documented proposal
before implementation. Follow the roadmap's completion/transition protocol and
[ADR convention](docs/decisions/README.md) for durable decisions.

## Branches and pull requests

- Create a focused branch from the default branch.
- Keep pull requests small and explain the reason for the change.
- Title every pull request with a Conventional Commit using one of: `feat`, `fix`, `docs`, `refactor`, `test`, `build`, `ci`, `chore`, `perf`, or `revert`. Scopes are optional but encouraged, for example `feat(plugin): add mirror state persistence`.
- `main` receives squash merges only, using the PR title as the resulting commit subject. Update the title if the delivered change's semantic type changes; avoid vague titles such as `update`, `changes`, or milestone names.
- Mark a genuine breaking change with `!` in the Conventional Commit title (for example, `feat(api)!: retire v1 mutations`). A `BREAKING CHANGE:` footer in the PR body is also preserved in the squash commit.
- Update architecture or other documentation when a change affects an established boundary.
- Do not include secrets, real vault content, or generated local artifacts.

## Releases

Release Please runs only after commits land on `main`. It reads the Conventional
squash commit subject and PR body, tracks this single product from
`.release-please-manifest.json` at `0.1.0`, updates the root `package.json`
version, and opens a release PR rather than directly tagging a release. The
configured default strategy produces `0.1.0 →
0.1.1` for `fix` and `0.1.x → 0.2.0` for `feat`; a genuine breaking change at a
pre-1.0 version produces the default major bump (`0.1.x → 1.0.0`).

Release Please authenticates with a dedicated GitHub App that is installed only for
this repository. At runtime, the workflow creates a short-lived installation token
from the repository secrets `RELEASE_PLEASE_APP_ID` and
`RELEASE_PLEASE_APP_PRIVATE_KEY`, then passes it directly to Release Please. Do not
expose or commit the private key; long-lived personal PATs are not used. Release PRs
created with the App token trigger this repository's required PR workflows.

## Testing and validation

Add behavioral Vitest coverage for behavior changes. Tests live in dedicated `tests/` trees outside production `src/` trees. Use `tests/unit/` for isolated behavior and `tests/integration/` for tests that intentionally compose multiple application layers; do not label those tests E2E unless they exercise real external system boundaries.

Use these focused validation tasks:

```bash
mise run test
mise run coverage
mise run check
```

`test` is the fast normal suite, `coverage` runs the suite with coverage enforcement, and `check` is the complete quality gate. Use `mise run format`, `mise run typecheck`, or `mise run build` for other focused work. Put shared non-sensitive configuration in `.mise.toml`; put local tokens and machine-specific overrides in ignored `mise.local.toml`. The repository does not use `.env` files.

A passing check/CI is necessary, not sufficient. Complete the active spec's
acceptance checklist and the manual semantic/security review in AGENTS.md after
automated validation. Preserve coverage thresholds, verify editor diagnostics,
and include evidence and any explicitly justified deferrals in the PR. Builds
are non-deploying; deployment is not a validation step.

## Coding style

Use explicit, idiomatic TypeScript and modern web APIs where practical. Prefer small functions, precise names, strong types, and package boundaries over clever abstractions. Use comments for non-obvious constraints. Follow the stricter TSDoc policy in [AGENTS.md](AGENTS.md): every exported/public declaration needs useful TSDoc, and non-trivial internal declarations must also be documented.

## Commits

Use Conventional Commit messages for branch commits when practical, for example:

```text
feat(protocol): add mirror envelope types
```

The PR title is the required release input; intermediate branch commits are not a
merge gate and should not require rewriting shared history solely for wording.
Keep unrelated changes in separate commits when practical.

## Issues

Search existing issues before opening a new one. Include a clear description, reproduction details for bugs, expected behavior, and relevant environment information. Never include sensitive vault content or credentials.

## Security reports

Do not report vulnerabilities in public issues. Follow the private reporting process in [SECURITY.md](SECURITY.md).
