/**
 * Run modes for the coding agent.
 */

export { InteractiveMode, type InteractiveModeOptions } from "./interactive/interactive-mode.ts";
export type { JsonAgentSessionEvent } from "./json-event.ts";
export { type PrintModeOptions, runPrintMode } from "./print-mode.ts";
export { type ModelInfo, RpcClient, type RpcClientOptions, type RpcEventListener } from "./rpc/rpc-client.ts";
export { runRpcMode } from "./rpc/rpc-mode.ts";
export {
	type RpcSocketServerHandle,
	resolveAndValidateRpcSocketPath,
	runRpcSocketServer,
} from "./rpc/rpc-socket-mode.ts";
export { buildRpcSessionState, nextSessionState } from "./rpc/rpc-state-fold.ts";
export type {
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
	RpcSessionState,
	RpcSocketBroadcastEvent,
} from "./rpc/rpc-types.ts";
