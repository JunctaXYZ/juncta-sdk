# @juncta/sdk

TypeScript SDK for Juncta. It will give integrators and market makers quotes, routes, transaction building, relay submission and a WebSocket client.

## Status

Not yet published. This repository is the package skeleton: it builds, tests and checks a package that exports one value, `VERSION`. Features arrive in later releases.

The `@juncta/sdk` name on npm has older 0.1.x releases from an earlier codebase. This code replaces them, and its first release will be 0.2.0 or later. Until then, do not install the 0.1.x releases for new work.

## Install

Once published:

```sh
pnpm add @juncta/sdk
```

```ts
import { VERSION } from '@juncta/sdk';
```

The package is ESM only, with type declarations, and supports Node 24.11 or later within Node 24, and bundlers.

## Development

You need Node 24.21.0 (`.nvmrc`) and corepack, which ships with Node 24. Corepack installs the pnpm version in `package.json` and checks it against the hash pinned there.

```sh
corepack enable pnpm
pnpm install --frozen-lockfile
pnpm test
```

| Command                     | What it does                                                            |
| --------------------------- | ----------------------------------------------------------------------- |
| `pnpm build`                | Compiles `src/` into `dist/` with declarations and source maps          |
| `pnpm typecheck`            | Type checks sources, tests and config                                   |
| `pnpm lint`                 | eslint with type information, zero warnings allowed                     |
| `pnpm format:check`         | prettier check                                                          |
| `pnpm coverage`             | Tests with coverage; fails under the committed `coverage-baseline.json` |
| `pnpm publint`, `pnpm attw` | Check the packed package's `exports` and types (run `pnpm build` first) |
| `pnpm docs`                 | API reference as markdown in `docs/api/`; any warning fails it          |

`scripts/gate.sh` is the full local gate and runs every check CI runs, including gitleaks, osv-scanner, semgrep (through Docker), actionlint, zizmor and the script self-tests. It also needs gitleaks 8.30.1, actionlint 1.7.12 (both installed with checksums by `scripts/install-ci-tools.sh`), zizmor 1.30.1, osv-scanner 2.6.0, shellcheck 0.11.0, perl and Docker. `scripts/precommit.sh` runs the fast subset.

The coverage floor is 85 percent of lines and branches, or the baseline in `coverage-baseline.json` if that is higher. The gate refuses a baseline lower than the one on the base branch, so raise it when coverage rises and never lower it.

Release notes use changesets (`pnpm exec changeset`). Nothing publishes from this repository yet.

## License

Apache-2.0. See [LICENSE](LICENSE).
