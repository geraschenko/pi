import { afterEach, describe, expect, it } from "vitest";
import { assistantMsg, userMsg } from "../utilities.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("AgentSession.navigateTree tree_navigated event", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("emits tree_navigated with old and new leaf ids", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.sessionManager.appendMessage(userMsg("first"));
		const targetId = harness.sessionManager.appendMessage(assistantMsg("reply"));
		const oldLeafId = harness.sessionManager.appendMessage(userMsg("second"));

		await harness.session.navigateTree(targetId);

		const events = harness.eventsOfType("tree_navigated");
		expect(events).toEqual([{ type: "tree_navigated", oldLeafId, newLeafId: targetId, summaryEntry: undefined }]);
	});

	it("emits synchronously before navigateTree resolves", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.sessionManager.appendMessage(userMsg("first"));
		const targetId = harness.sessionManager.appendMessage(assistantMsg("reply"));
		harness.sessionManager.appendMessage(userMsg("second"));

		let leafIdAtEmit: string | null | undefined;
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type === "tree_navigated") {
				leafIdAtEmit = harness.sessionManager.getLeafId();
			}
		});

		const navigatePromise = harness.session.navigateTree(targetId);
		await navigatePromise;
		unsubscribe();

		// The listener observed the post-navigation leaf, i.e. the emit happened
		// after agent state was rebuilt and before the promise resolved.
		expect(leafIdAtEmit).toBe(targetId);
	});

	it("rewinds to the parent for user message targets", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.sessionManager.appendMessage(userMsg("first"));
		const parentId = harness.sessionManager.appendMessage(assistantMsg("reply"));
		const targetId = harness.sessionManager.appendMessage(userMsg("second"));
		const oldLeafId = harness.sessionManager.appendMessage(assistantMsg("answer"));

		const result = await harness.session.navigateTree(targetId);

		expect(result.editorText).toBe("second");
		const events = harness.eventsOfType("tree_navigated");
		expect(events).toEqual([{ type: "tree_navigated", oldLeafId, newLeafId: parentId, summaryEntry: undefined }]);
	});

	it("does not emit on no-op navigation to the current leaf", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.sessionManager.appendMessage(userMsg("first"));
		const leafId = harness.sessionManager.appendMessage(assistantMsg("reply"));

		await harness.session.navigateTree(leafId);

		expect(harness.eventsOfType("tree_navigated")).toEqual([]);
	});

	it("does not emit when an extension cancels navigation", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_before_tree", () => ({ cancel: true }));
				},
			],
		});
		harnesses.push(harness);

		const targetId = harness.sessionManager.appendMessage(userMsg("first"));
		harness.sessionManager.appendMessage(assistantMsg("reply"));

		const result = await harness.session.navigateTree(targetId, { summarize: false });

		expect(result).toEqual({ cancelled: true });
		expect(harness.eventsOfType("tree_navigated")).toEqual([]);
	});

	it("includes the branch summary entry when summarizing", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_before_tree", () => ({
						summary: { summary: "branch summary from extension" },
					}));
				},
			],
		});
		harnesses.push(harness);

		harness.sessionManager.appendMessage(userMsg("first"));
		const targetId = harness.sessionManager.appendMessage(assistantMsg("reply"));
		const oldLeafId = harness.sessionManager.appendMessage(userMsg("second"));

		await harness.session.navigateTree(targetId, { summarize: true });

		const events = harness.eventsOfType("tree_navigated");
		expect(events).toHaveLength(1);
		const event = events[0];
		expect(event.oldLeafId).toBe(oldLeafId);
		expect(event.summaryEntry?.type).toBe("branch_summary");
		expect(event.summaryEntry?.summary).toBe("branch summary from extension");
		expect(event.summaryEntry?.fromHook).toBe(true);
		expect(event.newLeafId).toBe(harness.sessionManager.getLeafId());
		expect(event.newLeafId).toBe(event.summaryEntry?.id);
	});
});
