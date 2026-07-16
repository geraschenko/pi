/**
 * Client-side fold for maintaining `RpcSessionState` from the RPC socket
 * broadcast stream, plus the server-side state builder it must stay in sync
 * with.
 *
 * Contract: seed from the `session_changed` event delivered after the hello
 * record (or from a `get_state` response), then fold every subsequent
 * broadcast event. All event payloads carry absolute values, so re-applying
 * an event already reflected in the seed is harmless — a `get_state` response
 * can be ~one microtask stale relative to events already on the wire.
 *
 * `messageCount` is NOT foldable: several code paths change the message list
 * without a broadcast event, so under folding it reflects the most recent
 * seed only. Clients needing a fresh count must re-poll `get_state`.
 */

import { modelsAreEqual } from "@earendil-works/pi-ai";
import type { AgentSession } from "../../core/agent-session.ts";
import type { RpcSessionState, RpcSocketBroadcastEvent } from "./rpc-types.ts";

/** Build the current `RpcSessionState` from a live session. Single source of
 * truth shared by the `get_state` handler and `session_changed` broadcasts. */
export function buildRpcSessionState(session: AgentSession): RpcSessionState {
	return {
		model: session.model,
		thinkingLevel: session.thinkingLevel,
		isStreaming: session.isStreaming,
		isCompacting: session.isCompacting,
		steeringMode: session.steeringMode,
		followUpMode: session.followUpMode,
		sessionFile: session.sessionFile,
		sessionId: session.sessionId,
		sessionName: session.sessionName,
		autoCompactionEnabled: session.autoCompactionEnabled,
		messageCount: session.messages.length,
		pendingMessageCount: session.pendingMessageCount,
	};
}

/**
 * Pure transition function: returns the session state after applying one
 * broadcast event. Returns `state` by reference when the event changes no
 * field. `isStreaming` clears on `agent_settled`, not `agent_end` — the
 * latter fires mid-run when the turn will be retried.
 */
export function nextSessionState(state: RpcSessionState, event: RpcSocketBroadcastEvent): RpcSessionState {
	switch (event.type) {
		case "agent_start":
			return state.isStreaming ? state : { ...state, isStreaming: true };
		case "agent_settled":
			return state.isStreaming ? { ...state, isStreaming: false } : state;
		case "model_changed":
			return modelsAreEqual(state.model, event.model) ? state : { ...state, model: event.model };
		case "thinking_level_changed":
			return state.thinkingLevel === event.level ? state : { ...state, thinkingLevel: event.level };
		case "session_info_changed":
			return state.sessionName === event.name ? state : { ...state, sessionName: event.name };
		case "session_changed":
			return event.state;
		case "queue_update": {
			const pendingMessageCount = event.steering.length + event.followUp.length;
			return state.pendingMessageCount === pendingMessageCount ? state : { ...state, pendingMessageCount };
		}
		case "compaction_start":
			return state.isCompacting ? state : { ...state, isCompacting: true };
		case "compaction_end":
			return state.isCompacting ? { ...state, isCompacting: false } : state;
		case "steering_mode_changed":
			return state.steeringMode === event.mode ? state : { ...state, steeringMode: event.mode };
		case "follow_up_mode_changed":
			return state.followUpMode === event.mode ? state : { ...state, followUpMode: event.mode };
		case "auto_compaction_changed":
			return state.autoCompactionEnabled === event.enabled
				? state
				: { ...state, autoCompactionEnabled: event.enabled };
		default:
			return state;
	}
}
