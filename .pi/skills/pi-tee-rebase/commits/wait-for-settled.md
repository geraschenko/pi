# Commit: REVIEW LATER: implement waitForSettled

Intent: experimental fork-side support for waiting until the agent/session is settled. This commit is explicitly marked for later review, so treat conflicts conservatively.

## Expected conflict surface

- Agent/session runtime code
- RPC command/type files if `waitForSettled` is exposed over RPC
- Interactive or print mode lifecycle code if they observe settled state
- Tests for idle/settled behavior

## Resolution guidance

- Prefer upstream lifecycle semantics.
- Preserve this commit only as a narrow hook unless the user decides to redesign it.
- Do not expand the concept of settled state during conflict resolution.
- Ensure `waitForSettled` cannot hang indefinitely on normal completed turns.
- Ensure abort/shutdown paths are not blocked by waiting for settled state.

Because this commit is marked `REVIEW LATER`, stop and ask the user for any conflict that is more than mechanical API adaptation.
