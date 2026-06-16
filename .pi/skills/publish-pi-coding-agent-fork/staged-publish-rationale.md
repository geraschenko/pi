# Staged fork publish rationale

## Problem

This fork publishes `packages/coding-agent` to npm as `@geraschenko/pi-coding-agent`, but the monorepo is upstream-shaped and other workspace code imports the upstream package name `@earendil-works/pi-coding-agent`.

Renaming `packages/coding-agent/package.json` inside the repo to `@geraschenko/pi-coding-agent` makes npm stop satisfying `@earendil-works/pi-coding-agent` from the local workspace. Workspace packages such as `packages/orchestrator` then resolve `@earendil-works/pi-coding-agent` from the registry during package builds. We observed that this changed type graph can break `packages/orchestrator` under `tsgo` with errors where global `Response` loses standard fetch members (`ok`, `status`, `text()`, `json()`).

Changing orchestrator imports to the fork package name fixes the build, but it spreads fork-only naming through source that should stay easy to rebase and upstream-shaped.

## Accepted approach

Keep the repository workspace package upstream-shaped:

- `packages/coding-agent/package.json` remains `@earendil-works/pi-coding-agent` at the upstream version.
- Source imports keep using `@earendil-works/pi-coding-agent`.
- Other workspace package dependencies remain upstream-shaped.

Apply the fork name only to the packed publish artifact:

1. Build and check the workspace normally.
2. Run `npm pack --workspace packages/coding-agent` so npm selects exactly the files it would publish.
3. Unpack the tarball to a temporary staging directory.
4. Rewrite staged `package/package.json` to `@geraschenko/pi-coding-agent@<upstream-version>-fork.N`.
5. Rewrite staged `package/npm-shrinkwrap.json` root metadata to the same fork name/version.
6. Repack and publish that tarball.

This keeps local workspace resolution identical to upstream while still publishing the fork package under Anton's npm scope.

## Why not rename the workspace?

Renaming the workspace is mechanically simple but creates a fork-specific monorepo graph. Any package that still imports or depends on `@earendil-works/pi-coding-agent` no longer consumes local source and may pull the upstream npm package instead. That is surprising during rebase and makes full-workspace builds less representative.

## Why not TypeScript paths or npm overrides?

TypeScript `paths` can affect typechecking but does not rewrite emitted runtime imports. npm overrides/aliases are root-level dependency graph surgery and are easy to make non-representative of the package that will actually be published.

The staged tarball rewrite confines the fork identity to release packaging, which is the only place it is needed.

