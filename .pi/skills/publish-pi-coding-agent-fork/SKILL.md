---
name: publish-pi-coding-agent-fork
description: Publish Anton's npm fork of packages/coding-agent as @geraschenko/pi-coding-agent after rebasing or making fork-only changes.
---

# Publish `@geraschenko/pi-coding-agent`

Use this for the coding-agent-only fork. Keep dependencies on upstream `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, and `@earendil-works/pi-tui` unless the fork actually needs changes from those packages too. If it does, stop and ask whether to publish more forked packages.

## Checklist

1. Verify `packages/coding-agent/package.json`:
   - `name`: `@geraschenko/pi-coding-agent`
   - `version`: new prerelease, e.g. `<upstream-version>-fork.N`
   - README still has the fork notice at the top.

2. Regenerate package metadata:

   ```sh
   npm run shrinkwrap:coding-agent
   ```

3. Build fresh workspace output before packaging. This avoids stale `dist/*.d.ts` errors from internal packages such as `Property 'queryTerminalBackgroundColor' is missing in type 'TUI'`:

   ```sh
   npm run build
   npm --prefix packages/coding-agent run prepublishOnly
   ```

4. Verify:

   ```sh
   npm run check
   npm pack --workspace packages/coding-agent --dry-run
   ```

   Inspect the file list for expected package contents and no local secrets.

5. Publish. Because `*-fork.N` is a semver prerelease, npm requires an explicit tag. Use `latest` so normal installs get this fork:

   ```sh
   npm publish --workspace packages/coding-agent --access public --tag latest
   ```

6. Wait a few minutes for registry propagation, then verify:

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

## Troubleshooting

- Missing declared type packages locally: run `npm install --ignore-scripts` and inspect any `package-lock.json` diff.
- `npm view`/`npm install` returns 404 right after publish: wait for registry propagation. If it persists, check access with `npm access get status @geraschenko/pi-coding-agent` and make it public with `npm access public @geraschenko/pi-coding-agent`.
- Root `npm run build` may regenerate `packages/ai/src/models.generated.ts` from current provider metadata. Revert it for a minimal coding-agent fork commit unless checks require it.

## Commit

Stage only files intentionally changed for the fork update, for example:

```sh
git add packages/coding-agent/package.json packages/coding-agent/npm-shrinkwrap.json packages/coding-agent/README.md .pi/skills/publish-pi-coding-agent-fork/SKILL.md
```

Include `package-lock.json` only if reviewed and intentional. Never use `git add .` or `git add -A`.
