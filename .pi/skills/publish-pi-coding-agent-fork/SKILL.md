---
name: publish-pi-coding-agent-fork
description: Publish Anton's npm fork of packages/coding-agent as @geraschenko/pi-coding-agent after rebasing or making fork-only changes.
---

# Publish `@geraschenko/pi-coding-agent`

Use this for the coding-agent-only fork. Keep the repository workspace upstream-shaped and publish the fork name only by rewriting the packed artifact. See `staged-publish-rationale.md` for why this avoids breaking workspace builds.

Keep dependencies on upstream `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, and `@earendil-works/pi-tui` unless the fork actually needs changes from those packages too. If it does, stop and ask whether to publish more forked packages.

## Before publishing

1. Verify `packages/coding-agent/package.json` stays upstream-shaped:
   - `name`: `@earendil-works/pi-coding-agent`
   - `version`: the current upstream version, e.g. `0.80.6`
   - upstream dependencies remain on the current `@earendil-works/*` versions

   Do not rename the workspace package to `@geraschenko/pi-coding-agent`. The verification script rewrites only the staged tarball metadata.

2. Verify `packages/coding-agent/README.md` still has the fork notice at the top.

3. Run the verification script:

   ```sh
   .pi/skills/publish-pi-coding-agent-fork/verify-before-publish.sh
   ```

   The script hydrates dependencies, regenerates shrinkwrap metadata, builds, restores the released AI model-catalog snapshot before checking, packs `packages/coding-agent`, rewrites the staged tarball to `@geraschenko/pi-coding-agent@<upstream-version>-fork.0` (or another numeric fork revision from `$FORK_VERSION`), runs `npm publish --dry-run` on that tarball, and prints the tag and publish commands. Set `FORK_VERSION=2` to produce `<upstream-version>-fork.2` and tag `v<upstream-version>-fork.2`.

4. Inspect the dry-run package file list for expected package contents and no local secrets.

5. If npm publish fails with `E401`, run `npm login` and verify `npm whoami`. If it fails with `E404`, verify the package name is exactly `@geraschenko/pi-coding-agent` and that the logged-in npm user has publish rights.

6. After publishing, verify:

   ```sh
   npm view @geraschenko/pi-coding-agent version dist-tags bin
   ```

7. Smoke test outside the repo:

   ```sh
   rm -rf /tmp/pi-fork-smoke
   mkdir -p /tmp/pi-fork-smoke
   cd /tmp/pi-fork-smoke
   npm init -y
   npm install @geraschenko/pi-coding-agent@latest
   npx pi --help
   ```

## Rebase conflict guidance

When rebasing the fork commit onto a newer upstream release, keep upstream package contents and dependency versions. Keep `packages/coding-agent/package.json` upstream-shaped:

- `name`: `@earendil-works/pi-coding-agent`
- `version`: `<current-upstream-version>`
- dependencies: current upstream `@earendil-works/*` versions

Preserve the Geraschenko repository URL and the fork notice in `packages/coding-agent/README.md`. Do not apply the fork package name or fork version to the workspace package; the verification script produces the fork-named, fork-versioned tarball.

Resolve generated metadata files (`package-lock.json`, `packages/coding-agent/npm-shrinkwrap.json`) by regenerating them instead of hand-editing large conflicts.

## Commit

Stage only files intentionally changed for the fork update, for example:

```sh
git add packages/coding-agent/README.md .pi/skills/publish-pi-coding-agent-fork/SKILL.md .pi/skills/publish-pi-coding-agent-fork/verify-before-publish.sh .pi/skills/publish-pi-coding-agent-fork/pack-forked-coding-agent.ts .pi/skills/publish-pi-coding-agent-fork/staged-publish-rationale.md
```

Include `package-lock.json` only if reviewed and intentional. Never use `git add .` or `git add -A`.
