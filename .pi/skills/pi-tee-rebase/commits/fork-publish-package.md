# Commit: Fork pi-coding-agent

Intent: publish only `packages/coding-agent` as Anton's npm fork `@geraschenko/pi-coding-agent`, while keeping dependencies on upstream `@earendil-works/*` packages.

## Expected conflict surface

- `.pi/skills/publish-pi-coding-agent-fork/`
- `packages/coding-agent/package.json`
- `packages/coding-agent/npm-shrinkwrap.json`
- `package-lock.json`
- `packages/coding-agent/README.md`
- `packages/coding-agent/src/core/settings-manager.ts`

## Package metadata resolution

When rebasing onto a newer upstream release, keep `packages/coding-agent/package.json` upstream-shaped:

- `name`: `@earendil-works/pi-coding-agent`
- `version`: `<current-upstream-version>`
- dependencies on `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, and `@earendil-works/pi-tui` at the current upstream version

Preserve the fork repository URL: `git+https://github.com/geraschenko/pi.git`.

Do not apply the `@geraschenko/pi-coding-agent` name or `<current-upstream-version>-fork.N` version to the workspace package. The publish skill rewrites only the staged tarball metadata. Do not switch dependencies to `@geraschenko/*` unless the fork actually needs changes from those packages too. If it does, stop and ask the user.

## Generated metadata conflicts

Do not hand-merge large generated metadata conflicts.

For `package-lock.json` and `packages/coding-agent/npm-shrinkwrap.json`, resolve enough to continue by taking upstream as the temporary base. Keep `packages/coding-agent/package.json` upstream-shaped, then regenerate after the rebase using:

```bash
.pi/skills/publish-pi-coding-agent-fork/verify-before-publish.sh
```

## README and settings manager

- Preserve the fork notice at the top of `packages/coding-agent/README.md`.
- Preserve fork-specific default settings only if they are still intentional and minimal.
- If upstream changed settings semantics in `settings-manager.ts`, stop and ask before making a non-obvious merge decision.
