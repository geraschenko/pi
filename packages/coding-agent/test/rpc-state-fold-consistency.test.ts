/**
 * Server-side consistency test: folding the session's own emitted event
 * stream from an initial `buildRpcSessionState` seed must reproduce
 * `buildRpcSessionState` at every quiescent point — for every field except
 * `messageCount`, which is excluded from the foldable contract. This pins
 * the emitted events and the fold together: a new state field or a new
 * silent mutation path breaks this test.
 *
 * Uses a mock stream (no LLM calls), so it proves event/fold bookkeeping,
 * not model behavior.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, type AssistantMessageEvent, EventStream, getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { buildRpcSessionState, nextSessionState } from "../src/modes/rpc/rpc-state-fold.ts";
import type { RpcSessionState } from "../src/modes/rpc/rpc-types.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "./utilities.ts";

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

function createAssistantMessage(text: string): AssistantMessage {
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
	};
}

function withoutMessageCount(state: RpcSessionState): Omit<RpcSessionState, "messageCount"> {
	const { messageCount: _messageCount, ...rest } = state;
	return rest;
}

describe("RPC state fold consistency", () => {
	let session: AgentSession;
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-fold-consistency-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		session?.dispose();
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	});

	async function createSession(extensionFactories: Parameters<typeof createTestExtensionsResult>[0] = []) {
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: "Test",
				tools: [],
			},
			streamFn: () => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					const message = createAssistantMessage("Mock response");
					stream.push({ type: "start", partial: createAssistantMessage("") });
					stream.push({ type: "done", reason: "stop", message });
				});
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = await createModelRegistry(authStorage, tempDir);
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
		const extensionsResult = await createTestExtensionsResult(extensionFactories);

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRuntime: getModelRuntime(modelRegistry),
			resourceLoader: createTestResourceLoader({ extensionsResult }),
		});
		return session;
	}

	it("folding the emitted stream reproduces buildRpcSessionState", async () => {
		await createSession();

		let folded = buildRpcSessionState(session);
		session.subscribe((event) => {
			folded = nextSessionState(folded, event);
		});

		const expectConsistent = () => {
			expect(withoutMessageCount(folded)).toEqual(withoutMessageCount(buildRpcSessionState(session)));
		};

		expectConsistent();

		// Streaming turn (agent_start / agent_settled)
		await session.prompt("First message");
		expectConsistent();

		// Steering while streaming (queue_update)
		const secondPrompt = session.prompt("Second message");
		await new Promise((resolve) => setTimeout(resolve, 10));
		session.steer("A steering message");
		expectConsistent();
		await secondPrompt;
		await session.agent.waitForIdle();
		expectConsistent();

		// Thinking level
		session.setThinkingLevel("high");
		expectConsistent();

		// Queue modes and auto-compaction
		session.setSteeringMode("all");
		expectConsistent();
		session.setFollowUpMode("all");
		expectConsistent();
		session.setAutoCompactionEnabled(false);
		expectConsistent();

		// Model change
		const opus = getModel("anthropic", "claude-opus-4-6")!;
		await session.setModel(opus);
		expectConsistent();

		// Session rename
		session.setSessionName("renamed session");
		expectConsistent();

		// Manual compaction (compaction_start / compaction_end)
		await session.compact().catch(() => {});
		expectConsistent();

		// Tree navigation with branch summarization (branch-summary compaction events)
		const firstUserEntry = session.sessionManager
			.getEntries()
			.find((entry) => entry.type === "message" && entry.message.role === "user");
		expect(firstUserEntry).toBeDefined();
		await session.navigateTree(firstUserEntry!.id, { summarize: true });
		expectConsistent();
	});

	it("emits branch-summary compaction events during summarizing tree navigation", async () => {
		await createSession();

		const compactionEvents: Array<{ type: string; reason: string }> = [];
		session.subscribe((event) => {
			if (event.type === "compaction_start" || event.type === "compaction_end") {
				compactionEvents.push({ type: event.type, reason: event.reason });
			}
		});

		await session.prompt("First message");
		await session.prompt("Second message");

		const firstUserEntry = session.sessionManager
			.getEntries()
			.find((entry) => entry.type === "message" && entry.message.role === "user");
		await session.navigateTree(firstUserEntry!.id, { summarize: true });

		expect(compactionEvents).toEqual([
			{ type: "compaction_start", reason: "branch-summary" },
			{ type: "compaction_end", reason: "branch-summary" },
		]);
	});

	it("extensions observe mode and auto-compaction changes", async () => {
		const received: Array<{ type: string; value: unknown }> = [];
		await createSession([
			(pi) => {
				pi.on("steering_mode_changed", async (event) => {
					received.push({ type: event.type, value: event.mode });
				});
				pi.on("follow_up_mode_changed", async (event) => {
					received.push({ type: event.type, value: event.mode });
				});
				pi.on("auto_compaction_changed", async (event) => {
					received.push({ type: event.type, value: event.enabled });
				});
			},
		]);

		session.setSteeringMode("all");
		session.setFollowUpMode("all");
		session.setAutoCompactionEnabled(false);

		// Extension emits are fire-and-forget; give handlers a tick to run.
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(received).toEqual([
			{ type: "steering_mode_changed", value: "all" },
			{ type: "follow_up_mode_changed", value: "all" },
			{ type: "auto_compaction_changed", value: false },
		]);
	});
});
