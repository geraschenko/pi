/**
 * Tests for AgentSession.waitForSettled() — the full-session settlement signal.
 *
 * waitForSettled() resolves only when no session driver is active: no agent run
 * streaming, no retry backoff pending, no compaction running, no bash running,
 * and no agent-driving region in flight (_driverDepth === 0). This contrasts with
 * agent.waitForIdle(), which resolves at the end of a single run — and so fires
 * prematurely during a retry backoff or mid-compaction.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, type AssistantMessageEvent, EventStream } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestResourceLoader } from "./utilities.ts";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function createAssistantMessage(text: string, overrides?: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
		...overrides,
	};
}

describe("AgentSession waitForSettled", () => {
	let session: AgentSession;
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-settled-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (session) {
			session.dispose();
		}
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	});

	/**
	 * Build a session whose stream is produced by `streamFn`. The streamFn closes
	 * over `sessionRef` so a test can register settlement waiters from inside a run.
	 */
	function createSession(
		streamFn: (sessionRef: { current: AgentSession }) => () => MockAssistantStream,
		options?: { maxRetries?: number },
	): AgentSession {
		const sessionRef = { current: undefined as unknown as AgentSession };
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "Test", tools: [] },
			streamFn: streamFn(sessionRef),
		});

		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = ModelRegistry.create(authStorage, tempDir);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		settingsManager.applyOverrides({
			retry: { enabled: true, maxRetries: options?.maxRetries ?? 3, baseDelayMs: 1 },
		});

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			resourceLoader: createTestResourceLoader(),
		});
		sessionRef.current = session;
		return session;
	}

	it("resolves after a retried success, while waitForIdle resolves before it", async () => {
		const order: string[] = [];
		let callCount = 0;
		createSession(() => () => {
			callCount++;
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callCount === 1) {
					const msg = createAssistantMessage("", {
						stopReason: "error",
						errorMessage: "overloaded_error (HTTP 529)",
					});
					stream.push({ type: "start", partial: msg });
					stream.push({ type: "error", reason: "error", error: msg });
				} else {
					order.push("retry-success");
					const msg = createAssistantMessage("Recovered");
					stream.push({ type: "start", partial: msg });
					stream.push({ type: "done", reason: "stop", message: msg });
				}
			});
			return stream;
		});

		// Register both waiters during the retry backoff window: the first run has
		// ended (isStreaming false) but the session is still driving the turn
		// (_driverDepth >= 1, isRetrying about to be true).
		let idlePromise: Promise<void> | undefined;
		let settledPromise: Promise<void> | undefined;
		session.subscribe((event) => {
			if (event.type === "auto_retry_start" && !settledPromise) {
				idlePromise = session.agent.waitForIdle().then(() => {
					order.push("idle");
				});
				settledPromise = session.waitForSettled().then(() => {
					order.push("settled");
				});
			}
		});

		await session.prompt("Test");
		await Promise.all([idlePromise, settledPromise]);

		expect(callCount).toBe(2);
		expect(order).toEqual(["idle", "retry-success", "settled"]);
	});

	it("resolves (does not hang) when retries are exhausted", async () => {
		let callCount = 0;
		createSession(
			() => () => {
				callCount++;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					const msg = createAssistantMessage("", {
						stopReason: "error",
						errorMessage: "overloaded_error",
					});
					stream.push({ type: "start", partial: msg });
					stream.push({ type: "error", reason: "error", error: msg });
				});
				return stream;
			},
			{ maxRetries: 2 },
		);

		let settledPromise: Promise<void> | undefined;
		session.subscribe((event) => {
			if (event.type === "auto_retry_start" && !settledPromise) {
				settledPromise = session.waitForSettled();
			}
		});

		await session.prompt("Test");
		await settledPromise; // would hang the test if never resolved

		expect(callCount).toBe(3); // initial + 2 retries
		expect(session.isRetrying).toBe(false);
	});

	it("resolves (does not hang) on a terminal non-retryable error", async () => {
		let settledResolved = false;
		let settledPromise: Promise<void> | undefined;
		createSession((sessionRef) => () => {
			const stream = new MockAssistantStream();
			// Streaming now: _driverDepth >= 1, isStreaming true.
			if (!settledPromise) {
				settledPromise = sessionRef.current.waitForSettled().then(() => {
					settledResolved = true;
				});
			}
			queueMicrotask(() => {
				const msg = createAssistantMessage("", {
					stopReason: "error",
					errorMessage: "invalid_request_error: bad input",
				});
				stream.push({ type: "start", partial: msg });
				stream.push({ type: "error", reason: "error", error: msg });
			});
			return stream;
		});

		await session.prompt("Test");
		await settledPromise;

		expect(settledResolved).toBe(true);
		expect(session.isStreaming).toBe(false);
	});

	it("stays unsettled during retry backoff even though all is* flags read idle (_driverDepth is load-bearing)", async () => {
		// At the auto_retry_start instant the failed run has ended (isStreaming
		// false) and the retry controller is not yet set (isRetrying false), so ALL
		// four is* flags read idle. A flag-only predicate would report settled here
		// and resolve waiters prematurely. The settle signal must stay pending —
		// held only by _driverDepth > 0 — until the retried run completes.
		const order: string[] = [];
		let callCount = 0;
		let flagsAtBackoff: Record<string, boolean> | undefined;
		createSession(() => () => {
			callCount++;
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callCount === 1) {
					const msg = createAssistantMessage("", {
						stopReason: "error",
						errorMessage: "overloaded_error",
					});
					stream.push({ type: "start", partial: msg });
					stream.push({ type: "error", reason: "error", error: msg });
				} else {
					order.push("retry-success");
					const msg = createAssistantMessage("ok");
					stream.push({ type: "start", partial: msg });
					stream.push({ type: "done", reason: "stop", message: msg });
				}
			});
			return stream;
		});

		let settledPromise: Promise<void> | undefined;
		session.subscribe((event) => {
			if (event.type === "auto_retry_start" && !settledPromise) {
				flagsAtBackoff = {
					isStreaming: session.isStreaming,
					isCompacting: session.isCompacting,
					isRetrying: session.isRetrying,
					isBashRunning: session.isBashRunning,
				};
				settledPromise = session.waitForSettled().then(() => {
					order.push("settled");
				});
			}
		});

		await session.prompt("Test");
		await settledPromise;

		// All four flags were idle at the registration instant...
		expect(flagsAtBackoff).toEqual({
			isStreaming: false,
			isCompacting: false,
			isRetrying: false,
			isBashRunning: false,
		});
		// ...yet the waiter resolved only after the retried run completed.
		expect(order).toEqual(["retry-success", "settled"]);
	});

	it("does not settle while a standalone bash command is running", async () => {
		createSession(() => () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				const msg = createAssistantMessage("done");
				stream.push({ type: "start", partial: msg });
				stream.push({ type: "done", reason: "stop", message: msg });
			});
			return stream;
		});

		const bashPromise = session.executeBash("printf settled-test");
		// _bashAbortController is set synchronously at the top of executeBash.
		expect(session.isBashRunning).toBe(true);

		let settledResolved = false;
		const settledPromise = session.waitForSettled().then(() => {
			settledResolved = true;
		});

		// Flush microtasks; the real subprocess cannot complete this fast.
		await Promise.resolve();
		expect(settledResolved).toBe(false);

		await bashPromise;
		await settledPromise;
		expect(settledResolved).toBe(true);
	});
});
