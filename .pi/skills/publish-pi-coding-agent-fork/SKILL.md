---
name: publish-pi-coding-agent-fork
description: Publish Anton's npm fork of packages/coding-agent only, under @geraschenko/pi-coding-agent, while keeping upstream @earendil-works dependencies. Use after rebasing the fork or preparing a fork update for npm.
---

# Publish the pi-coding-agent fork

This skill is for maintaining a forked npm package for `packages/coding-agent` only. The fork package name is:

```text
@geraschenko/pi-coding-agent
```

The fork intentionally keeps upstream package dependencies unless the forked changes require changes in other packages:

```text
@earendil-works/pi-ai
@earendil-works/pi-agent-core
@earendil-works/pi-tui
```

If the rebased fork depends on changes in `packages/ai`, `packages/agent`, or `packages/tui`, stop and ask whether to publish forked versions of those too.

## Package metadata

After rebasing, verify `packages/coding-agent/package.json` has the fork name and a fork version, e.g.:

```json
{
  "name": "@geraschenko/pi-coding-agent",
  "version": "0.79.6-fork.0"
}
```

Use a new version for each npm publish. Suggested pattern:

```text
<upstream-version>-fork.0
<upstream-version>-fork.1
```

If upstream moved from `0.79.6` to `0.80.0`, use `0.80.0-fork.0` for the first fork publish based on that upstream version.

## README fork notice

Make sure `packages/coding-agent/README.md` starts with a clear notice that this is an unofficial fork and most users probably want upstream:

```md
> [!IMPORTANT]
> This package is an unofficial fork of [`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent).
> Most users should install the original package instead:
>
> ```sh
> npm install -g @earendil-works/pi-coding-agent
> ```
>
> This fork exists only to provide changes needed by downstream projects that depend on `@geraschenko/pi-coding-agent`.
```

## Regenerate shrinkwrap

Changing package name/version makes the coding-agent shrinkwrap stale. Run from the repo root:

```sh
npm run shrinkwrap:coding-agent
```

Inspect the diff:

```sh
git diff packages/coding-agent/package.json packages/coding-agent/npm-shrinkwrap.json
```

Expected shrinkwrap diffs are package name/version metadata and dependency metadata caused by the version change. Unexpected dependency version churn should be reviewed before committing.

## Hydrate dependencies

If TypeScript reports missing declaration packages that are already listed in `package.json`, hydrate the repo:

```sh
npm install --ignore-scripts
```

Inspect any lockfile diff:

```sh
git diff package-lock.json
```

If committing a lockfile change, pre-commit may require:

```sh
PI_ALLOW_LOCKFILE_CHANGE=1 git commit
```

Only use that after reviewing the lockfile diff.

## Build gotcha: stale workspace dist types

`packages/coding-agent` imports `@earendil-works/pi-tui`, `@earendil-works/pi-ai`, and `@earendil-works/pi-agent-core` through their package entrypoints. Those entrypoints use `dist/*.d.ts`. After a rebase, source may be newer than stale `dist`, causing errors during `npm --prefix packages/coding-agent run prepublishOnly`, such as:

```text
Property 'queryTerminalBackgroundColor' is missing in type 'TUI'
```

This means dependency package `dist` output is stale. Build workspace dependencies first, or run the root build:

```sh
npm run build
```

For a narrower build before publishing only coding-agent:

```sh
npm --prefix packages/tui run build
npm --prefix packages/ai run build
npm --prefix packages/agent run build
npm --prefix packages/coding-agent run prepublishOnly
```

## Verification before publish

From the repo root:

```sh
npm run check
npm pack --workspace packages/coding-agent --dry-run
```

Inspect the dry-run file list. It should include `dist`, `docs`, `examples`, `containerization.md`, `CHANGELOG.md`, and `npm-shrinkwrap.json`, and it should not include local secrets or unrelated files.

## Publish

Publish only the coding-agent workspace. Fork versions like `0.79.6-fork.0` are prerelease versions, so npm requires an explicit dist-tag:

```sh
npm publish --workspace packages/coding-agent --access public --tag latest
```

Users can install the fork with:

```sh
npm install -g @geraschenko/pi-coding-agent
```

or, if using the `fork` tag:

```sh
npm install -g @geraschenko/pi-coding-agent@fork
```

## Post-publish smoke test

Test outside the repo so workspace links cannot hide packaging problems:

```sh
mkdir -p /tmp/pi-fork-smoke
cd /tmp/pi-fork-smoke
npm init -y
npm install @geraschenko/pi-coding-agent@<version>
npx pi --help
```

If the CLI bin conflicts with another installed package, use a clean temp directory or a disposable environment.

## Commit guidance

Stage only files changed for this fork publish, for example:

```sh
git add packages/coding-agent/package.json packages/coding-agent/npm-shrinkwrap.json packages/coding-agent/README.md package-lock.json
```

Never use `git add .` or `git add -A` in this repo. Use the repo's normal commit message style unless the user asks otherwise.
