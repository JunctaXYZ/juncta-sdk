# Changesets

Each user visible change adds a file here with `pnpm exec changeset`, naming the bump (patch, minor or major) and a line for the changelog. `pnpm exec changeset version` turns them into a version bump and `CHANGELOG.md` entries.

`changeset version` bumps `version` in `package.json` but not the `VERSION` constant in `src/index.ts`. Set the constant to the new version in the same commit; `test/version.test.ts` fails until they match.

The package is marked private, so `changeset publish` does nothing. Publishing is a separate, approved step.
