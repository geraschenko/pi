import { afterEach, describe, expect, it } from "vitest";
import type { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import { executeRpcCommand } from "../../src/modes/rpc/rpc-command-handler.ts";
import type { RpcResponse } from "../../src/modes/rpc/rpc-types.ts";
import { assistantMsg, userMsg } from "../utilities.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("RPC navigate_tree command", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	async function dispatch(harness: Harness, command: Parameters<typeof executeRpcCommand>[0]["command"]) {
		const outputs: RpcResponse[] = [];
		const response = await executeRpcCommand({
			runtimeHost: { session: harness.session } as AgentSessionRuntime,
			command,
			output: (record) => {
				outputs.push(record);
			},
		});
		return { response, outputs };
	}

	it("navigates and returns the NavigateTreeResult", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.sessionManager.appendMessage(userMsg("first"));
		const targetId = harness.sessionManager.appendMessage(assistantMsg("reply"));
		harness.sessionManager.appendMessage(userMsg("second"));

		const { response } = await dispatch(harness, { id: "1", type: "navigate_tree", targetId });

		expect(response).toEqual({
			id: "1",
			type: "response",
			command: "navigate_tree",
			success: true,
			data: { editorText: undefined, cancelled: false, summaryEntry: undefined },
		});
		expect(harness.sessionManager.getLeafId()).toBe(targetId);
		expect(harness.eventsOfType("tree_navigated")).toHaveLength(1);
	});

	it("returns editorText when navigating to a user message", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		const targetId = harness.sessionManager.appendMessage(userMsg("first"));
		harness.sessionManager.appendMessage(assistantMsg("reply"));

		const { response } = await dispatch(harness, { id: "2", type: "navigate_tree", targetId });

		expect(response).toMatchObject({
			command: "navigate_tree",
			success: true,
			data: { editorText: "first", cancelled: false },
		});
	});

	it("propagates navigateTree errors to the transport", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.sessionManager.appendMessage(userMsg("first"));
		harness.sessionManager.appendMessage(assistantMsg("reply"));

		await expect(dispatch(harness, { id: "3", type: "navigate_tree", targetId: "missing" })).rejects.toThrow(
			"Entry missing not found",
		);
	});
});
