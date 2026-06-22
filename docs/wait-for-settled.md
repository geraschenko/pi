# `waitForSettled`: an extension signal for full session settlement

# SPEC

## Problem

The extension command context exposes `ctx.waitForIdle()` so an extension can "do
something once the agent is done." But its meaning is **one agent run**, not
"the agent is finished with everything it is going to do."

`ctx.waitForIdle()` is wired to `session.agent.waitForIdle()`
(`interactive-mode.ts`, `print-mode.ts`, `rpc-mode.ts`), which resolves when the
current `Agent` run reaches `agent_end` and its listeners settle
(`agent.ts:waitForIdle`). The **session**, however, drives additional work *after*
a run ends, inside `AgentSession._runAgentPrompt`'s loop:

- **Auto-retry of transient provider/transport errors.** When an assistant
  message comes back with `stopReason: "error"` and the error matches the
  retryable set (`_isRetryableError`: `overloaded`, `rate limit`/`429`, `5xx`,
  `service unavailable`, network/connection drops, `websocket closed`,
  `fetch failed`, premature stream endings, `timeout`, `terminated`, …), the
  session waits with **exponential backoff** (`_prepareRetry`:
  `await sleep(baseDelayMs * 2 ** (attempt - 1))`) and then calls
  `agent.continue()`. Throughout that multi-second backoff window the agent run
  has already ended, so `agent.waitForIdle()` has **already resolved** even
  though a retry is pending.
- **Auto-compaction continuations** and **messages queued by `agent_end`
  handlers**, both of which also re-drive via `agent.continue()` in the same
  loop.
- **Compaction with no active run.** During auto-compaction (whether the
  pre-prompt check in `prompt()` or the turn-triggered one in the post-run loop)
  and during manual `session.compact()`, there is no `activeRun`, so
  `agent.waitForIdle()` resolves immediately even though the session is actively
  rewriting its own history.

So an extension that does `await ctx.waitForIdle()` during a turn that hits a
flaky provider response fires **prematurely** — during the backoff gap, before
the retry runs — and any action it takes (e.g. reading "final" state, or
mutating agent state) races the session's continuation. The same premature fire
happens mid-compaction.

There is no signal an extension can await that means "the session is fully
settled — no run streaming, no retry pending, no compaction in progress, no
queued continuation outstanding."

## What we want

Add a new, **additive** extension signal `ctx.waitForSettled()` that resolves
only when no session driver is currently active — defined by a predicate over the
session's own observable state:

```
settled := _driverDepth === 0  // no agent-driving region in flight
        && !isStreaming         // no active agent run
        && !isCompacting        // no auto/manual compaction or branch summary running
        && !isRetrying          // not in a retry backoff sleep
        && !isBashRunning        // no bash command executing
```

If the session is already settled when called, it resolves immediately.

This covers everything that is **currently** doing session work: an agent run and
its post-run loop (retries/backoff, turn-triggered compaction, queued
continuations), the **pre-prompt** auto-compaction `prompt()` runs before a turn,
**manual** `session.compact()`, **branch summarization**, and a running **bash**
command. `_driverDepth` is a counter bracketing the two agent-driving regions
(`_runAgentPrompt` and the pre-prompt compaction block); the four `is*` getters
already exist on `AgentSession`. See Type design for why both the counter and the
flags are kept.

**Semantics: active drivers, not future work.** `waitForSettled()` resolves when
the drivers active *now* finish. It does not promise to span work queued *later*
in the same logical operation — in particular, a waiter registered while a
`prompt()` is running its *pre-prompt* compaction resolves when that compaction
finishes, which is before the prompt's subsequent agent turn begins (they are two
distinct drivers). The motivating self-navigation consumer is unaffected: it
registers its waiter while its own turn's `_runAgentPrompt` is already in flight
(`_driverDepth ≥ 1`), so its waiter can only resolve at a genuine settle.

`ctx.waitForIdle()`, `Agent.waitForIdle()`, and `AgentSession.abort()` are left
**exactly as they are**. This is purely an addition; nothing changes meaning.
(That `waitForIdle()` itself resolves mid-compaction is a separate latent issue,
explicitly out of scope here — see "Scope and non-goals".)

## Success criteria

1. **Deterministic regression test (CI gate).** With a mock `streamFn` that
   returns a retryable error once (error text containing `529`) and then succeeds,
   an extension awaiting `ctx.waitForSettled()` resolves **after** the retried
   success, while `ctx.waitForIdle()` awaited in the same scenario resolves
   **before** the retry completes. The contrast is asserted in one test.
2. **Waits through compaction and bash.** With a forced compaction (auto or
   manual), `waitForSettled()` resolves only after `isCompacting` clears, while
   `waitForIdle()` resolves during it; and a `waitForSettled()` does not resolve
   while a standalone bash command is running. Asserted in tests.
3. **No hang.** `waitForSettled()` resolves on every terminal outcome of a turn:
   success, retries exhausted, a terminal non-retryable error, abort, and a hard
   throw out of the run.
4. **No regressions.** The existing test suite (which uses
   `session.agent.waitForIdle()` directly) and all current `ctx.waitForIdle()`
   behavior are unaffected.
5. **Manual upstream demonstration.** A mitmproxy-based repro reproduces the
   premature-fire problem against a real provider endpoint, suitable for an
   upstream GitHub issue.

## Type design

### `AgentSession` (`packages/coding-agent/src/core/agent-session.ts`)

New state, a settled predicate, a resolver helper, the public method,
`_driverDepth` bookkeeping in the **two** agent-driving regions, and a resolver
call at each non-agent driver's exit. The four `is*` getters (`isStreaming`
`:773`, `isCompacting` `:836`, `isRetrying` `:2569`, `isBashRunning` `:2665`)
already exist and are unchanged.

```ts
class AgentSession {
  // NEW: number of in-flight agent-driving regions. There are exactly two such
  // regions — _runAgentPrompt and the pre-prompt compaction block in prompt()
  // (the only two places that call agent.prompt()/agent.continue()). Both are
  // bracketed below. A counter, not a boolean, so overlapping/nested regions
  // settle only when the last one unwinds.
  private _driverDepth = 0;
  // NEW: resolvers waiting for the session to settle.
  private _settleWaiters: Array<() => void> = [];

  // NEW: no session driver is currently active.
  //  - _driverDepth === 0 — no agent-driving region in flight. This alone implies
  //    !isStreaming and !isRetrying (all streaming/backoff happens inside one of
  //    the two bracketed regions); the flags are kept as defense-in-depth so a
  //    future un-bracketed agent.continue() can't silently break settlement, and
  //    as the cross-driver-race backstop (a non-agent driver — manual compact() /
  //    branch summary — finishing and calling the resolver at the synchronous
  //    instant a bracketed region sits between run-end and retry-setup).
  //  - isCompacting — any of the three compaction/branch-summary controllers is
  //    set (auto pre-prompt OR turn-triggered, manual compact(), branch summary);
  //    each is set before the work and cleared in a finally.
  //  - isRetrying — inside _prepareRetry's backoff sleep.
  //  - isBashRunning — a bash command (incl. standalone RPC bash) is executing.
  private get _isSettled(): boolean {
    return (
      this._driverDepth === 0 &&
      !this.isStreaming &&
      !this.isCompacting &&
      !this.isRetrying &&
      !this.isBashRunning
    );
  }

  // NEW: resolve all waiters iff settled. Idempotent; safe to call from any
  // driver's exit path. A no-op when anything is still running.
  private _maybeResolveSettled(): void {
    if (!this._isSettled) return;
    const waiters = this._settleWaiters;
    this._settleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  /**
   * Resolve when no session driver is currently active: no agent-driving region
   * in flight, not streaming, not compacting (auto/manual/branch-summary), not in
   * a retry backoff, no bash running. Resolves immediately if already settled.
   *
   * Unlike Agent.waitForIdle(), which resolves at the end of a single agent run
   * (and resolves immediately during compaction, when there is no active run),
   * this waits for the session to be idle across all of its drivers. It reflects
   * drivers active *now*; it does not span work queued later in the same prompt()
   * preflight (see "Semantics" in What we want).
   */
  waitForSettled(): Promise<void> {
    if (this._isSettled) return Promise.resolve();
    return new Promise((resolve) => {
      this._settleWaiters.push(resolve);
    });
  }

  // MODIFIED: existing method gains _driverDepth bookkeeping. The increment/
  // decrement bracket the entire loop (prompt + the retry/compaction/queued-
  // continuation `while`). The resolver is called in `finally` on every exit path
  // (success, retries exhausted, terminal error, abort, hard throw); the nested
  // try/finally ensures a throw from the existing flush cannot skip the
  // decrement-and-resolve.
  private async _runAgentPrompt(messages: AgentMessage | AgentMessage[]): Promise<void> {
    this._driverDepth++;
    try {
      await this.agent.prompt(messages);
      while (await this._handlePostAgentRun()) {
        await this.agent.continue();
      }
    } finally {
      try {
        this._flushPendingBashMessages(); // existing
      } finally {
        this._driverDepth--;
        this._maybeResolveSettled();
      }
    }
  }
}
```

**The second agent-driving region: the pre-prompt compaction block in `prompt()`**
(`:1085`-`:1094`) must also be bracketed by `_driverDepth`, with the increment
placed *before* `_checkCompaction` so the whole region — the compaction itself
(including its `compaction_start` emit and the handoff gap before `continue()`)
and the continue loop — is covered. Without this, a waiter registered during
pre-prompt compaction could resolve in the all-flags-false instant after
compaction clears but before `continue()` starts, and a throw before the turn
would hang the waiter.

```ts
this._driverDepth++;
try {
  const lastAssistant = this._findLastAssistantMessage();
  if (lastAssistant && (await this._checkCompaction(lastAssistant, false))) {
    try {
      await this.agent.continue();
      while (await this._handlePostAgentRun()) {
        await this.agent.continue();
      }
    } finally {
      this._flushPendingBashMessages(); // existing — only when compaction ran
    }
  }
} finally {
  this._driverDepth--;
  this._maybeResolveSettled();
}
```

**Resolver calls at the non-agent drivers.** Auto-compaction and the retry
backoff always run inside a bracketed agent-driving region (`_driverDepth > 0`),
so they need no resolver call. The drivers that can run while `_driverDepth === 0`
add a `_maybeResolveSettled()` to their existing cleanup `finally`:

```ts
// in compact()        — finally that clears `_compactionAbortController` (~:1787)
// in the branch-summary path — finally that clears `_branchSummaryAbortController` (~:2917)
// in executeBash()    — finally that clears `_bashAbortController` (~:2623)
this._maybeResolveSettled();
```

**Ordering fix in `_runAutoCompaction`.** It currently emits `compaction_start`
*before* setting `_autoCompactionAbortController` (`:1941`→`:1942`). Set the
controller first, so `isCompacting` is true during `compaction_start` listeners.
(For the pre-prompt case this is also covered by the `_driverDepth` bracket above;
this reorder additionally protects the turn-triggered path and any direct
`isCompacting` reader.)

**Ordering + finally fix in `compact()`.** Today `compact()` does
`await this.abort()` *before* setting `_compactionAbortController`
(`:1660`→`:1661`), and clears the controller in a `try/finally` that does **not**
wrap the `abort()`. Two problems: (1) if a turn was in flight, `abort()` unwinds
the in-flight `_runAgentPrompt`, firing `_maybeResolveSettled()` in the window
after `abort()` resolves but before `isCompacting` becomes true — a premature
resolve; (2) if `abort()` throws, the controller is never set/cleared
consistently. Fix: **set `_compactionAbortController` (and emit `compaction_start`)
before `await this.abort()`, and move the `abort()` inside the `try` whose
`finally` clears the controller and calls `_maybeResolveSettled()`:**

```ts
this._disconnectFromAgent();
this._compactionAbortController = new AbortController();
this._emit({ type: "compaction_start", reason: "manual" });
try {
  await this.abort();
  // ... existing compaction body ...
} finally {
  this._compactionAbortController = undefined;
  this._maybeResolveSettled();
  // ... existing reconnect/cleanup, if any ...
}
```

Safe because `session.abort()` (`:1430`) only aborts the retry and the agent run —
it does **not** abort the compaction controllers (`abortCompaction()` is a
separate method `abort()` doesn't call), so the freshly-set controller survives
the `abort()`. One intended behavior change: `abortCompaction()` called during the
`abort()` phase now cancels the just-started manual compaction instead of being a
no-op — which is the more correct behavior (the session has entered manual
compaction). (`_runAutoCompaction` has no such window: it sets its controller
before its work and never calls `abort()`.)

### Extension context (`packages/coding-agent/src/core/extensions/types.ts`)

`waitForSettled` is added to the **command** context (alongside `waitForIdle`),
not the base `ExtensionContext`:

```ts
export interface ExtensionCommandContext extends ExtensionContext {
  /** Wait for the agent to finish streaming (a single run). */
  waitForIdle(): Promise<void>;
  /** Wait until no session driver is active: not streaming, retrying, compacting, or running bash, and no agent-driving region in flight. */
  waitForSettled(): Promise<void>; // NEW
  // ...
}

export interface ExtensionCommandContextActions {
  waitForIdle: () => Promise<void>;
  waitForSettled: () => Promise<void>; // NEW
  // ...
}
```

### Extension runner plumbing (`packages/coding-agent/src/core/extensions/runner.ts`)

Mirror the existing `waitForIdleFn` wiring:

```ts
private waitForSettledFn: () => Promise<void> = async () => {}; // NEW field (default no-op)

bindCommandContext(actions?: ExtensionCommandContextActions): void {
  if (actions) {
    this.waitForIdleFn = actions.waitForIdle;
    this.waitForSettledFn = actions.waitForSettled; // NEW
    // ...
    return;
  }
  this.waitForIdleFn = async () => {};
  this.waitForSettledFn = async () => {}; // NEW reset
  // ...
}

// in createCommandContext():
context.waitForSettled = () => { // NEW, parallel to context.waitForIdle
  this.assertActive();
  return this.waitForSettledFn();
};
```

### Mode wirings (three sites)

Each mode that builds `ExtensionCommandContextActions` adds one property:

```ts
// interactive-mode.ts, print-mode.ts, rpc-mode.ts
waitForIdle: () => session.agent.waitForIdle(),   // unchanged
waitForSettled: () => session.waitForSettled(),    // NEW
```

## Edge cases

- **Already settled at call time** (`_isSettled`): resolves immediately.
- **Retries exhausted**: `_prepareRetry` returns false → `_handlePostAgentRun`
  returns false → the `while` loop exits → `_runAgentPrompt` `finally` →
  `_maybeResolveSettled` (now `_isSettled`) resolves waiters.
- **Terminal non-retryable error**: same path; the error message is the last
  assistant message, the loop exits, waiters resolve.
- **Pre-prompt auto-compaction** (`prompt()` before the turn): the whole block is
  bracketed by `_driverDepth`, so `_isSettled` is false throughout the compaction
  *and* the handoff gap before `continue()` *and* the continue loop. A waiter
  registered during it resolves at that block's `finally` (or, if the predicate is
  still busy then, at the next driver exit). Per the documented semantics, this is
  *before* the subsequent agent turn — the two are distinct drivers.
- **Manual `session.compact()` / branch summary / standalone bash**: `isCompacting`
  (resp. `isBashRunning`) true throughout; `_maybeResolveSettled()` at the
  controller's clearing `finally` resolves waiters when (and only when) nothing
  else is running.
- **Abort**: `agent.abort()` ends the run; the session loop unwinds and
  `_runAgentPrompt` returns → resolver runs. (`session.abort()` itself keeps using
  `agent.waitForIdle()`; out of scope to change.)
- **Hard throw out of `agent.prompt()`/`continue()`** (either region): the nested
  `finally` runs → decrement + resolver. No hang.
- **Overlapping/nested driver regions** (a non-blocking `void session.prompt()`
  arriving during a retry backoff gap, where `agent.prompt()` has resolved so
  `isStreaming` is briefly false but the region is still suspended in its post-run
  loop): `_driverDepth > 0` keeps `_isSettled` false until the last region unwinds,
  never mid-overlap.
- **Cross-driver microtask race**: a manual `compact()`/branch summary/bash
  finishing and calling `_maybeResolveSettled()` at the instant a bracketed region
  sits in the all-flags-false gap between run-end and retry-setup — `_driverDepth >
  0` keeps it unsettled.
- **`compact()`'s abort→compact transition**: handled by setting the compaction
  controller before `await this.abort()` and wrapping the abort in the clearing
  `try/finally` (see "Ordering + finally fix in `compact()`").
- **Calling `waitForSettled()` from any handler whose completion the active run
  awaits**: returns a pending promise (the active region's `_driverDepth > 0`); it
  must not be `await`ed inline by such a handler (that would deadlock the turn). Today
  this is the command handler that blocks `prompt()`; the same hazard applies to
  any future context that exposes `waitForSettled` to handlers the run awaits
  (e.g. `agent_end`/`turn_end`), which must detach before awaiting it. See the
  handoff doc for the detached-continuation pattern. This is a usage contract,
  not enforced by the API.

## Scope and non-goals

**`waitForSettled` covers all currently-active session drivers**, not just the
`_runAgentPrompt` turn: streaming runs, retry backoff, every compaction path
(pre-prompt auto, turn-triggered auto, manual `compact()`, branch summary), and a
running bash command are included via the
`_driverDepth`/`isStreaming`/`isCompacting`/`isRetrying`/`isBashRunning`
predicate. This is the behavior the motivating self-navigation consumer needs: the
detached continuation must not navigate while the session is rewriting its own
history. (It reflects *active* drivers, not future work later in the same
`prompt()` preflight — see "Semantics" under What we want.)

- **`waitForIdle` is NOT changed**, even though it too resolves mid-compaction
  (during compaction there is no `activeRun`, so `agent.waitForIdle()` returns
  immediately). Redefining `waitForIdle` would be a behavior change to an existing
  pi-core API with its own callers and tests, against the additive/upstreamable
  goal of this spec. Extensions that need to wait through compaction use
  `waitForSettled`. The mid-compaction behavior of `waitForIdle` is noted as a
  **separate latent issue** for a possible follow-up, deliberately out of scope.
- **No change to `navigate_tree`** (RPC, command, or `AgentSession.navigateTree`).
  This spec is solely the `waitForSettled` primitive.
- **No self-navigation logic in core.** The `/self-navigate` extension that
  consumes `waitForSettled` is specified separately (handoff doc in the pictl
  repo) and built on top of this primitive.
- **No redefinition of `waitForIdle`.** Existing per-run semantics are preserved;
  `waitForSettled` is strictly additive.
- **No continuation-prompt or deferral parameters added to any RPC or to
  `navigateTree`.**

---

# IMPLEMENTATION IDEAS

## Why `_driverDepth` bracketing both agent regions, plus the flags

There are exactly **two** places that drive the agent (call `agent.prompt()` /
`agent.continue()`): `_runAgentPrompt`, and the pre-prompt auto-compaction block
in `prompt()` (`:1085`-`:1094`). Both are bracketed by `_driverDepth`. The reason
to bracket the *region* rather than rely on flags alone: a flag-only predicate has
*momentary* all-flags-false instants inside a region — e.g. between an agent run
ending (`isStreaming` false) and `_prepareRetry` setting `_retryAbortController`,
or between the pre-prompt compaction clearing `isCompacting` and the following
`agent.continue()` setting `isStreaming`. In those instants a concurrent
non-agent driver (manual `compact()`/branch summary/bash) finishing and calling
`_maybeResolveSettled()` would see the predicate true and resolve prematurely; and
a waiter registered during pre-prompt compaction could hang if the block threw
before the turn. `_driverDepth > 0` spans the whole region with no gaps, closing
both. It also makes overlapping/nested regions settle only when the last unwinds.

The `is*` flags are kept in the predicate as well, for two reasons:

- **Non-agent drivers.** Manual `compact()`, branch summary, and standalone bash
  do not run the agent and are not bracketed by `_driverDepth`; `isCompacting`
  (`:836`) / `isBashRunning` (`:2665`) cover them. Each controller is set before
  its work and cleared in a `finally`, so the flag is true for the whole
  operation. (`isRetrying` (`:2569`) and `isStreaming` (`:773`) are implied by
  `_driverDepth > 0` today, but…)
- **Defense in depth.** …keeping `!isStreaming`/`!isRetrying` means a future
  un-bracketed `agent.continue()` call site can't silently make the session report
  settled while streaming. The invariant "all streaming/retrying happens inside a
  `_driverDepth`-bracketed region" is asserted by these terms rather than assumed.

Overlapping regions ARE reachable: `_runAgentPrompt`'s two call sites (`prompt()`
and `sendCustomMessage(triggerTurn)`) gate on `!isStreaming`, which is false during
a retry backoff (the run has ended), so a non-blocking `void session.prompt()`
arriving then re-enters `_runAgentPrompt` while the first is still suspended.
Queued steers/follow-ups do *not* cause this — they drain inside the `Agent` loop
(`agent-loop.ts` outer `while`) as part of the same run.

## Waiter resolution must not be skippable

Resolution lives in the `finally` of each driver region (both agent regions, plus
`compact()`, branch summary, and `executeBash`). A throw from the existing
`_flushPendingBashMessages()` must not prevent the decrement-and-resolve — hence
the nested `try`/`finally` in the Type design. The decrement must run exactly once
per region invocation.

## Concurrency note (adjacent, not in scope)

During retry backoff, `isStreaming` is false and there is no `activeRun`, so a new
top-level prompt can currently start and race the pending retry. That is a
pre-existing concern independent of this change. `waitForSettled` does not try to
fix it; the predicate + counter ensure the settle signal degrades gracefully if
it happens (settle fires only when all in-flight work unwinds).

## Regression test (deterministic, no network)

Drive retry with a mock `streamFn` rather than a live provider:

- Configure the session/agent with a `streamFn` that, on first call, yields an
  assistant message with `stopReason: "error"` and `errorMessage` containing
  `529` (matches `_isRetryableError`), and on the second call yields a normal
  successful completion. Ensure retry settings are enabled with a small
  `baseDelayMs` so the test is fast but the backoff window is real.
- Register a probe command (or call the session directly) that, while the turn is
  in flight, records the order of: (1) `ctx.waitForIdle()` resolving and (2)
  `ctx.waitForSettled()` resolving, relative to the second (successful) stream
  completing.
- Assert: `waitForIdle` resolves before the retried success; `waitForSettled`
  resolves after it. Also assert `waitForSettled` resolves (does not hang) in a
  retries-exhausted variant (mock errors every time, `maxRetries` small).
- **Overlapping-regions variant (validates `_driverDepth` is load-bearing, not a
  boolean).** With the same retry-once mock, call `waitForSettled()` to obtain a
  pending promise, then during the backoff window start a *second* top-level
  prompt (`void session.prompt(...)`, which passes the `!isStreaming` guard
  because the first run has resolved). Assert the `waitForSettled` promise resolves
  only after **both** regions have unwound — not when whichever finishes earlier
  completes. A boolean fails this; the counter passes it.
  `agent-session-concurrent.test.ts` already exercises backoff-window re-entry.
- **Compaction variants (validate `isCompacting` + the `_driverDepth` bracket).**
  - Manual `session.compact()` while a run is in flight: assert `waitForSettled()`
    does **not** resolve in the abort→compact transition and resolves only after
    compaction completes, while `waitForIdle()` resolves during it.
  - Pre-prompt auto-compaction (force with a low threshold): a waiter registered
    from a `compaction_start` listener does not resolve mid-compaction; and a
    waiter does not resolve in the compaction-clear → `continue()` handoff.
  `agent-session-compaction.test.ts` has the harness for forcing compaction.
- **Bash variant (validates `!isBashRunning`).** With a standalone
  `session.executeBash(...)` in flight, assert `waitForSettled()` stays pending
  until the bash command completes.

Look at `agent-session-compaction.test.ts` and `agent-session-concurrent.test.ts`
for the existing mock-streamFn / harness setup to copy.

## mitmproxy demonstration (manual artifact for the upstream issue)

Purpose: show the premature-fire problem against a real endpoint in the GitHub
issue. Not a CI gate.

- A mitmproxy addon that, for the first N requests to the provider endpoint,
  short-circuits with HTTP `529` (and/or `overloaded_error` body), then passes
  subsequent requests through untouched.
- A tiny demo extension registering a command (e.g. `/probe`) that starts a turn
  (so it hits the 529 and enters backoff) and then `await ctx.waitForIdle()` and
  separately `await ctx.waitForSettled()`, logging when each resolves.
- Expected: with the real backoff, `waitForIdle` logs during the 529 backoff
  (before the real answer), `waitForSettled` logs after the successful retry.
- Capture the run for the issue write-up.

---

# WORK LOG

**Instructions**: Update this section during each work session. Add new tasks, mark completed ones with [x], document decisions and problems encountered.

## Tasks

- [x] `AgentSession`: add `_driverDepth`, `_settleWaiters`, `_isSettled` getter (`_driverDepth===0 && !isStreaming && !isCompacting && !isRetrying && !isBashRunning`), `_maybeResolveSettled()`, `waitForSettled()`.
- [x] Bracket **both** agent-driving regions with `_driverDepth` + nested-`finally` resolver: `_runAgentPrompt`, and the pre-prompt compaction block in `prompt()` (increment before `_checkCompaction`).
- [x] Add `_maybeResolveSettled()` to the cleanup `finally`s of `compact()`, branch summary, and `executeBash`.
- [x] `compact()`: set `_compactionAbortController` before `await this.abort()` and move the `abort()` inside the controller-clearing `try/finally`.
- [x] `_runAutoCompaction`: set `_autoCompactionAbortController` before emitting `compaction_start`.
- [x] `extensions/types.ts`: add `waitForSettled` to `ExtensionCommandContext` and `ExtensionCommandContextActions`.
- [x] `extensions/runner.ts`: add `waitForSettledFn` field, bind it in `bindCommandContext` (set + reset), wire `context.waitForSettled` in `createCommandContext`.
- [x] Mode wirings: add `waitForSettled: () => session.waitForSettled()` in `interactive-mode.ts`, `print-mode.ts`, `rpc-mode.ts`. Compile fallout fixed in two test fixtures (`extensions-runner.test.ts`, `regressions/2860-replaced-session-context.test.ts`).
- [x] Deterministic regression tests: 529-once contrast (`waitForIdle` before, `waitForSettled` after); retries-exhausted no-hang; terminal non-retryable no-hang; `_driverDepth`-load-bearing (all `is*` flags idle at backoff yet still unsettled — replaces the original "overlapping regions" idea, see below); standalone-bash blocks settlement (`test/agent-session-settled.test.ts`). Compaction: no-settle-during-manual-compact (waitForIdle wins the race); no-settle-in-abort→compact transition with an in-flight run; pre-prompt auto-compaction no-premature-resolve + no-hang (`test/suite/agent-session-settled-compaction.test.ts`). 8 tests, all passing.
- [x] Run the full existing suite; confirm no regressions. Full run: 11 pre-existing failures only (openrouter-attribution, first-time-setup, rpc-unknown-command-id, stdout-cleanliness, tree-navigation-guard) — identical count on a clean tree with this change stashed. The 7 suites adjacent to this change (settled, retry, concurrent, compaction characterization, extensions-runner, 2860) all pass: 69 tests. `tsgo --noEmit` and `biome check` clean.
- [ ] mitmproxy demo addon + tiny probe extension; capture output for the upstream issue. (Manual artifact, not a CI gate — deferred; the deterministic 529-once test already proves the contrast.)
- [x] Docs: `ctx.waitForSettled` vs `ctx.waitForIdle` section added to `packages/coding-agent/docs/extensions.md`, including the detach-before-await usage contract.

## Decisions

- **Additive, not a redefinition.** `ctx.waitForIdle` / `Agent.waitForIdle` keep
  per-run semantics; `waitForSettled` is the new full-settlement signal. Cleaner
  upstream story (no behavior change to an existing API) and zero test churn.
  `waitForIdle` resolving mid-compaction is a known separate latent issue, left
  out of scope.
- **Settled is a predicate: counter (both agent regions) + flags.** `_isSettled :=
  _driverDepth === 0 && !isStreaming && !isCompacting && !isRetrying &&
  !isBashRunning`. `_driverDepth` brackets the **two** agent-driving regions
  (`_runAgentPrompt` and the pre-prompt compaction block) — bracketing the region,
  not relying on flags alone, because a flag-only predicate has momentary
  all-flags-false instants inside a region (run-end→retry-setup;
  compaction-clear→`continue()`) that a concurrent resolver call could resolve
  through, and a pre-prompt-compaction waiter could hang on a throw. The flags
  cover the non-agent drivers (`isCompacting`, `isBashRunning`) and serve as
  defense-in-depth against a future un-bracketed `agent.continue()`.
- **Semantics: active drivers, not future preflight work.** A waiter registered
  during a prompt's pre-prompt compaction resolves when that compaction finishes,
  before the prompt's subsequent turn (two distinct drivers). Documented;
  immaterial to the self-nav consumer, whose waiter is registered while its own
  turn is in flight.
- **Resolver at every driver exit.** `_maybeResolveSettled()` (no-op unless
  `_isSettled`) is called from the `finally` of: both agent regions, `compact()`,
  branch summary, and `executeBash`. Auto-compaction and retry need no call — they
  run inside an agent-driving region.
- **Two in-scope changes to existing code**, both required for correctness, not
  scope creep: (1) `compact()` sets its controller before `await this.abort()` and
  wraps the abort in the controller-clearing `try/finally` (else premature resolve
  in the abort→compact window, or a stranded controller on abort throw); (2)
  `_runAutoCompaction` sets its controller before emitting `compaction_start`.
  Both safe (`session.abort()` doesn't touch compaction controllers). One intended
  behavior change: `abortCompaction()` during `compact()`'s abort phase now cancels
  the starting compaction instead of being a no-op — more correct.
- **`waitForSettled` lives on the command context** (where `waitForIdle` already
  is), not the base `ExtensionContext`.
- **Reviewed twice (fresh-context reviewer).** Round 2 found: pre-prompt
  compaction is a second agent-driving region with all-flags-false gaps (→ bracket
  it); `_runAutoCompaction` `compaction_start` ordering; `compact()` abort must be
  inside the clearing `finally`; `isBashRunning` omission (→ add it). All adopted.

### Implementation session

Implemented per the Type design with no deviations to the production code. All
five `AgentSession` edits, the extension-context/runner/mode plumbing, and the
two test-fixture fallout fixes are in place and match the spec snippets. tsgo and
biome are clean; the eight new settlement tests pass; the full suite shows only
pre-existing failures.

One **test-design** change from the spec's test list, worth recording:

- **"Overlapping regions" via two concurrent `session.prompt()` is not testable
  as written, because real double-prompt overlap is a pre-existing broken path.**
  Starting a second top-level `prompt()` during the first prompt's retry backoff
  (which the `!isStreaming` guard permits) makes two `_runAgentPrompt` regions
  drive the *same* `Agent` concurrently, and the Agent throws `Cannot continue
  from message role: assistant` — its message state can't be driven by two regions
  at once. This is exactly the "Concurrency note (adjacent, not in scope)" hazard:
  the overlap itself is broken regardless of `waitForSettled`. So that scenario
  can't be used to assert "settle waits for both regions."

  Instead, the counter's load-bearing role is proven directly and deterministically
  by the **`_driverDepth`-load-bearing** test: at the `auto_retry_start` instant,
  all four `is*` flags read idle (the failed run has ended → `!isStreaming`; the
  retry controller is set *after* the emit → `!isRetrying`), yet `waitForSettled()`
  correctly stays pending and resolves only after the retried run completes. A
  flag-only predicate would resolve there; only `_driverDepth > 0` holds it. This
  is a stronger, race-free demonstration that the counter (not a flag-only
  predicate) is required — which was the original intent of the overlapping test.

- The **abort→compact** correctness of the `compact()` reorder is pinned by a
  dedicated test using a faux response that ends only on abort plus a gated
  compaction-summary request: with an in-flight run, after `compact()` aborts it,
  `settledResolved` is asserted `false` while `isCompacting` is `true` (the
  aborted run's `finally` fired `_maybeResolveSettled()` but found `isCompacting`
  already set — no premature resolve), then resolves once the summary is released.
