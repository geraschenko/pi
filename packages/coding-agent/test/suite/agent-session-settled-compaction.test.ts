/**
 * Settlement (waitForSettled) tests for the compaction drivers.
 *
 * waitForSettled() must stay pending throughout any compaction (manual, auto, or
 * pre-prompt) and resolve only once isCompacting clears and nothing else is
 * running — whereas agent.waitForIdle() resolves during compaction (no active
 * run). These tests also pin the compact() ordering fix: a manual compact() that
 * aborts an in-flight run must not let the aborted run's cleanup resolve settle
 * in the abort→compact transition.
 */

import { type AssistantMessage, type FauxResponseFactory, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

/** A faux assistant message reporting `totalTokens` of usage, attributed to the harness model. */
function assistantWithUsage(harness: Harness, text: string, totalTokens: number): AssistantMessage {
	const model = harness.getModel();
	return {
		...fauxAssistantMessage(text),
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: totalTokens,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

describe("AgentSession waitForSettled — compaction", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("does not settle during manual compaction, while waitForIdle resolves during it", async () => {
		let raceWinner: string | undefined;
		let settledPromise: Promise<void> | undefined;
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						// We are mid-compaction here: isCompacting is true. waitForIdle
						// should win the race (no active run), waitForSettled must not.
						const idle = harness.session.agent.waitForIdle().then(() => "idle");
						settledPromise = harness.session.waitForSettled();
						raceWinner = await Promise.race([idle, settledPromise.then(() => "settled")]);
						return {
							compaction: {
								summary: "compacted",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
								details: {},
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);

		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		await harness.session.prompt("first");
		await harness.session.prompt("second");

		await harness.session.compact();
		await settledPromise; // resolves only after compaction completes (no hang)

		expect(raceWinner).toBe("idle");
		expect(harness.session.isCompacting).toBe(false);
	});

	it("does not settle in the abort→compact transition when compacting an in-flight run", async () => {
		const harness = await createHarness({ settings: { compaction: { keepRecentTokens: 1 } } });
		harnesses.push(harness);

		// Build a little history to compact.
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		await harness.session.prompt("first");
		await harness.session.prompt("second");

		// An in-flight run that only ends when aborted, and a gated compaction-summary
		// request so we can observe the abort→compact transition deterministically.
		const runStarted = deferred();
		const summaryStarted = deferred();
		const releaseSummary = deferred();

		const blockingRun: FauxResponseFactory = (_context, options) => {
			runStarted.resolve();
			return new Promise<AssistantMessage>((resolve) => {
				options?.signal?.addEventListener(
					"abort",
					() => resolve(fauxAssistantMessage("", { stopReason: "aborted" })),
					{ once: true },
				);
			});
		};
		const gatedSummary: FauxResponseFactory = async () => {
			summaryStarted.resolve();
			await releaseSummary.promise;
			return fauxAssistantMessage("compacted summary");
		};
		harness.setResponses([blockingRun, gatedSummary]);

		const runPromise = harness.session.prompt("third").catch(() => {});
		await runStarted.promise;
		expect(harness.session.isStreaming).toBe(true);

		let settledResolved = false;
		const settledPromise = harness.session.waitForSettled().then(() => {
			settledResolved = true;
		});

		// compact() aborts the in-flight run, then starts the (gated) summary request.
		const compactPromise = harness.session.compact();
		await summaryStarted.promise; // abort has happened; compaction is now in flight
		await runPromise; // the aborted run's _runAgentPrompt finally has fully unwound
		await Promise.resolve();
		await Promise.resolve();

		// The aborted run's cleanup must NOT have resolved settle: isCompacting was set
		// before abort(), so the predicate stays busy across the whole transition.
		expect(harness.session.isCompacting).toBe(true);
		expect(settledResolved).toBe(false);

		releaseSummary.resolve();
		await compactPromise;
		await settledPromise;
		expect(settledResolved).toBe(true);
	});

	it("does not settle during pre-prompt auto-compaction and does not hang", async () => {
		let raceWinner: string | undefined;
		let settledPromise: Promise<void> | undefined;
		const harness = await createHarness({
			// Tiny context window so a moderate usage report trips the overflow/threshold
			// compaction check on the pre-prompt pass.
			models: [{ id: "faux-1", contextWindow: 100, maxTokens: 50 }],
			settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 0 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						const idle = harness.session.agent.waitForIdle().then(() => "idle");
						settledPromise = harness.session.waitForSettled();
						raceWinner = await Promise.race([idle, settledPromise.then(() => "settled")]);
						return {
							compaction: {
								summary: "pre-prompt compacted",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
								details: {},
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);

		// Seed a history whose last assistant message reports usage over the window, so
		// prompt()'s pre-prompt _checkCompaction triggers auto-compaction before the turn.
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "earlier question" }],
			timestamp: Date.now() - 1000,
		});
		harness.sessionManager.appendMessage(assistantWithUsage(harness, "earlier answer", 10_000));
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;

		// Response for the actual turn that runs after pre-prompt compaction.
		harness.setResponses([fauxAssistantMessage("answer after compaction")]);

		await harness.session.prompt("next question");
		await settledPromise; // resolves after the whole prompt() (compaction + turn): no hang

		expect(raceWinner).toBe("idle");
		expect(harness.eventsOfType("compaction_start").length).toBeGreaterThan(0);
		expect(harness.session.isCompacting).toBe(false);
	});
});
