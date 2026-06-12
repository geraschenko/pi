import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { assistantMsg, userMsg } from "../utilities.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("AgentSession.navigateTree streaming/compacting guard", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("throws while a response is streaming", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		const targetId = harness.sessionManager.appendMessage(userMsg("first"));
		harness.sessionManager.appendMessage(assistantMsg("reply"));
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;

		let releaseResponse!: () => void;
		const responseGate = new Promise<void>((resolve) => {
			releaseResponse = resolve;
		});
		let signalStreaming!: () => void;
		const streamingStarted = new Promise<void>((resolve) => {
			signalStreaming = resolve;
		});
		harness.setResponses([
			async () => {
				signalStreaming();
				await responseGate;
				return fauxAssistantMessage("done");
			},
		]);

		const promptPromise = harness.session.prompt("go");
		await streamingStarted;
		expect(harness.session.isStreaming).toBe(true);

		await expect(harness.session.navigateTree(targetId)).rejects.toThrow(
			"Cannot navigate the session tree while streaming or compacting",
		);

		releaseResponse();
		await promptPromise;
	});

	it("throws while compaction is running", async () => {
		let releaseCompaction!: () => void;
		const compactionGate = new Promise<void>((resolve) => {
			releaseCompaction = resolve;
		});
		let signalCompacting!: () => void;
		const compactionStarted = new Promise<void>((resolve) => {
			signalCompacting = resolve;
		});

		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						signalCompacting();
						await compactionGate;
						return {
							compaction: {
								summary: "summary",
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

		const targetId = harness.sessionManager.appendMessage(userMsg("first"));
		harness.sessionManager.appendMessage(assistantMsg("reply"));
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;

		const compactPromise = harness.session.compact();
		await compactionStarted;
		expect(harness.session.isCompacting).toBe(true);

		await expect(harness.session.navigateTree(targetId)).rejects.toThrow(
			"Cannot navigate the session tree while streaming or compacting",
		);

		releaseCompaction();
		await compactPromise;
	});
});
