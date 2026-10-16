# Changesets

Each user visible change adds a file here with `pnpm exec changeset`, naming the bump (patch, minor or major) and a line for the changelog. `pnpm exec changeset version` turns them into a version bump and `CHANGELOG.md` entries.

The package is marked private, so `changeset publish` does nothing. Publishing is a separate, approved step.
