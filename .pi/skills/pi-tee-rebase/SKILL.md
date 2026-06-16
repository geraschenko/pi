---
name: pi-tee-rebase
description: Rebase Anton's fork branch onto the latest upstream release tag, resolving known fork commits including RPC tree commands, rpc-socket mode, waitForSettled, and npm fork packaging.
---

# Rebase Anton's pi fork

Use this skill when rebasing Anton's `main` fork branch onto the latest released upstream tag.

The branch currently carries a small stack of fork commits on top of upstream:

1. `feat(coding-agent): add get_entries and get_tree RPC commands`
2. `Implementation of --rpc-socket (pi-tee)`
3. `Add navigate_tree rpc command`
4. `Process images sent through rpc mode the same as interactive mode`
5. `REVIEW LATER: implement waitForSettled`
6. `Fork pi-coding-agent`

Commit hashes change after each rebase. Use commit subjects, conflict files, and intent rather than old hashes.

## Fixed facts

- Current repo path: `/home/anton/git/earendil-works/pi`
- Rebase normally starts from the fork `main` branch. Fetch upstream first, then rebase onto the latest released upstream tag rather than `upstream/main`:

  ```bash
  git fetch upstream --tags
  latest_release_tag=$(git tag --list 'v*' --sort=-v:refname | head -1)
  git rebase "$latest_release_tag"
  ```

- The implementation should stay narrow and easy to rebase.
- After conflicts are resolved, checks pass, and resolved files are staged, run `git rebase --continue` and keep resolving until the rebase completes.
- Ignore unrelated untracked local files unless the user asks about them.
- If resolving conflicts requires remotely non-obvious design decisions, stop and ask the user before editing.

## Important upstream conventions

Upstream uses:

- package names such as `@earendil-works/pi-ai`
- relative TypeScript imports ending in `.ts`, not `.js`

When resolving conflicts, do not resurrect older fork-side imports such as:

- `@mariozechner/...`
- relative imports ending in `.js`

Preserve upstream's newer surrounding architecture unless the fork feature specifically needs a hook.

## Conflict workflow

Always start with:

```bash
cd /home/anton/git/earendil-works/pi
git status --short
git diff --name-only --diff-filter=U
rg -n '^(<<<<<<<|=======|>>>>>>>|\|\|\|\|\|\|\|)' . -g '!packages/coding-agent/test/fixtures/*.jsonl'
```

Then:

1. Identify the current commit subject from `git status` or `git rebase --show-current-patch --stat`.
2. Read the matching guidance file under `commits/`:
   - `commits/rpc-tree-commands.md`
   - `commits/rpc-socket-mode.md`
   - `commits/rpc-navigate-tree.md`
   - `commits/rpc-image-inputs.md`
   - `commits/wait-for-settled.md`
   - `commits/fork-publish-package.md`
3. Read each conflicted file enough to understand upstream context before editing.
4. Prefer upstream structure and add the smallest fork hook needed.
5. Resolve conflict markers with precise edits.
6. Update `.pi/skills/pi-tee-rebase/docs/rebase_report.md` with one section per commit that had conflicts. This report is for user review and should not be committed.
7. Run:

   ```bash
   rg -n '^(<<<<<<<|=======|>>>>>>>|\|\|\|\|\|\|\|)' . -g '!packages/coding-agent/test/fixtures/*.jsonl'
   git diff --name-only --diff-filter=U
   ```

8. Run checks:

   ```bash
   npm run check
   ```

9. If checks pass, stage only the resolved conflicted files:

   ```bash
   git add <resolved-files>
   ```

10. Run `git rebase --continue` and repeat this workflow until the rebase completes.

## End-of-rebase validation

After the rebase is complete, run the validation in `validate.md`, including the rpc-socket smoke test.

## Reporting format

When done with a conflict, report concisely:

- current commit subject
- conflicted files found
- how each conflict was resolved
- whether `npm run check` passed
- whether files were staged
- whether `.pi/skills/pi-tee-rebase/docs/rebase_report.md` was updated
- whether `git rebase --continue` was run and what happened next
