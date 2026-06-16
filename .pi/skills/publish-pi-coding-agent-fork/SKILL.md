---
name: publish-pi-coding-agent-fork
description: Publish Anton's npm fork of packages/coding-agent as @geraschenko/pi-coding-agent after rebasing or making fork-only changes.
---

# Publish `@geraschenko/pi-coding-agent`

Use this for the coding-agent-only fork. Keep dependencies on upstream `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, and `@earendil-works/pi-tui` unless the fork actually needs changes from those packages too. If it does, stop and ask whether to publish more forked packages.

## Before publishing

1. Verify `packages/coding-agent/package.json`:
   - `name`: `@geraschenko/pi-coding-agent`
   - `version`: a new prerelease for the current upstream version, e.g. `<upstream-version>-fork.N`
   - upstream dependencies remain on the current `@earendil-works/*` versions
   - repository URL points at `https://github.com/geraschenko/pi.git`

2. Verify `packages/coding-agent/README.md` still has the fork notice at the top.

3. Run the verification script:

   ```sh
   .pi/skills/publish-pi-coding-agent-fork/verify-before-publish.sh
   ```

   The script hydrates dependencies, regenerates shrinkwrap metadata, builds, runs checks, performs `npm pack --dry-run`, and prints the publish command.

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

When rebasing the fork commit onto a newer upstream release, keep upstream package contents and dependency versions, then reapply only the fork metadata in `packages/coding-agent/package.json`:

- `name`: `@geraschenko/pi-coding-agent`
- `version`: `<current-upstream-version>-fork.N`

Resolve generated metadata files (`package-lock.json`, `packages/coding-agent/npm-shrinkwrap.json`) by regenerating them instead of hand-editing large conflicts. It is usually safest to take upstream as the temporary conflict resolution, update `package.json`, then run the verification script.

## Commit

Stage only files intentionally changed for the fork update, for example:

```sh
git add packages/coding-agent/package.json packages/coding-agent/npm-shrinkwrap.json packages/coding-agent/README.md .pi/skills/publish-pi-coding-agent-fork/SKILL.md .pi/skills/publish-pi-coding-agent-fork/verify-before-publish.sh
```

Include `package-lock.json` only if reviewed and intentional. Never use `git add .` or `git add -A`.
