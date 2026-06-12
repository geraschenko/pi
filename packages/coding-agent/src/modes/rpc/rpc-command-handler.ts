import type { ImageContent } from "@earendil-works/pi-ai";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import { prepareImageAttachment } from "../../utils/image-attachment.ts";
import type { RpcCommand, RpcResponse, RpcSessionState, RpcSlashCommand } from "./rpc-types.ts";

export interface RpcMessageWithImages {
	message: string;
	images: ImageContent[] | undefined;
}

/**
 * Run RPC-supplied images through the same sniff + resize pipeline as CLI file
 * arguments (`prepareImageAttachment`), so a session never contains an image
 * that did not pass it. The mime type is sniffed from the decoded bytes (the
 * client-supplied `mimeType` is advisory) and resizing honors the user's
 * auto-resize setting, exactly as file arguments do. Images that are not a
 * supported format or cannot be resized under the inline size limit are dropped
 * and replaced by an indexed text note appended to the message — surfacing the
 * failure in the dialogue instead of erroring.
 */
export async function processRpcImages(
	message: string,
	images: ImageContent[] | undefined,
	options: { autoResize: boolean },
): Promise<RpcMessageWithImages> {
	if (!images || images.length === 0) {
		return { message, images };
	}

	const processedImages: ImageContent[] = [];
	const notes: string[] = [];

	for (const [index, image] of images.entries()) {
		const bytes = Buffer.from(image.data, "base64");
		const prepared = await prepareImageAttachment(bytes, {
			autoResize: options.autoResize,
			label: `Image ${index + 1}`,
		});
		if (prepared.status === "ok") {
			if (prepared.note) {
				notes.push(prepared.note);
			}
			processedImages.push(prepared.image);
		} else {
			notes.push(prepared.note);
		}
	}

	if (notes.length > 0) {
		const noteBlock = notes.join("\n");
		message = message ? `${message}\n\n${noteBlock}` : noteBlock;
	}
	return { message, images: processedImages.length > 0 ? processedImages : undefined };
}

export function rpcSuccess<T extends RpcCommand["type"]>(
	id: string | undefined,
	command: T,
	data?: object | null,
): RpcResponse {
	if (data === undefined) {
		return { id, type: "response", command, success: true } as RpcResponse;
	}
	return { id, type: "response", command, success: true, data } as RpcResponse;
}

export function rpcError(id: string | undefined, command: string, message: string): RpcResponse {
	return { id, type: "response", command, success: false, error: message };
}

export interface ExecuteRpcCommandOptions {
	runtimeHost: AgentSessionRuntime;
	command: RpcCommand;
	output: (response: RpcResponse) => void;
}

export async function executeRpcCommand(options: ExecuteRpcCommandOptions): Promise<RpcResponse | undefined> {
	const { runtimeHost, command, output } = options;
	const session = runtimeHost.session;
	const id = command.id;

	switch (command.type) {
		case "prompt": {
			const { message, images } = await processRpcImages(command.message, command.images, {
				autoResize: session.settingsManager.getImageAutoResize(),
			});
			let preflightSucceeded = false;
			void session
				.prompt(message, {
					images,
					streamingBehavior: command.streamingBehavior,
					source: "rpc",
					preflightResult: (didSucceed) => {
						if (didSucceed) {
							preflightSucceeded = true;
							output(rpcSuccess(id, "prompt"));
						}
					},
				})
				.catch((error: unknown) => {
					if (!preflightSucceeded) {
						output(rpcError(id, "prompt", error instanceof Error ? error.message : String(error)));
					}
				});
			return undefined;
		}

		case "steer": {
			const { message, images } = await processRpcImages(command.message, command.images, {
				autoResize: session.settingsManager.getImageAutoResize(),
			});
			await session.steer(message, images);
			return rpcSuccess(id, "steer");
		}

		case "follow_up": {
			const { message, images } = await processRpcImages(command.message, command.images, {
				autoResize: session.settingsManager.getImageAutoResize(),
			});
			await session.followUp(message, images);
			return rpcSuccess(id, "follow_up");
		}

		case "abort": {
			await session.abort();
			return rpcSuccess(id, "abort");
		}

		case "new_session": {
			const newSessionOptions = command.parentSession ? { parentSession: command.parentSession } : undefined;
			const result = await runtimeHost.newSession(newSessionOptions);
			return rpcSuccess(id, "new_session", result);
		}

		case "get_state": {
			const state: RpcSessionState = {
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
			return rpcSuccess(id, "get_state", state);
		}

		case "set_model": {
			const models = await session.modelRegistry.getAvailable();
			const model = models.find((m) => m.provider === command.provider && m.id === command.modelId);
			if (!model) {
				return rpcError(id, "set_model", `Model not found: ${command.provider}/${command.modelId}`);
			}
			await session.setModel(model);
			return rpcSuccess(id, "set_model", model);
		}

		case "cycle_model": {
			const result = await session.cycleModel();
			if (!result) {
				return rpcSuccess(id, "cycle_model", null);
			}
			return rpcSuccess(id, "cycle_model", result);
		}

		case "get_available_models": {
			const models = await session.modelRegistry.getAvailable();
			return rpcSuccess(id, "get_available_models", { models });
		}

		case "set_thinking_level": {
			session.setThinkingLevel(command.level);
			return rpcSuccess(id, "set_thinking_level");
		}

		case "cycle_thinking_level": {
			const level = session.cycleThinkingLevel();
			if (!level) {
				return rpcSuccess(id, "cycle_thinking_level", null);
			}
			return rpcSuccess(id, "cycle_thinking_level", { level });
		}

		case "set_steering_mode": {
			session.setSteeringMode(command.mode);
			return rpcSuccess(id, "set_steering_mode");
		}

		case "set_follow_up_mode": {
			session.setFollowUpMode(command.mode);
			return rpcSuccess(id, "set_follow_up_mode");
		}

		case "compact": {
			const result = await session.compact(command.customInstructions);
			return rpcSuccess(id, "compact", result);
		}

		case "set_auto_compaction": {
			session.setAutoCompactionEnabled(command.enabled);
			return rpcSuccess(id, "set_auto_compaction");
		}

		case "set_auto_retry": {
			session.setAutoRetryEnabled(command.enabled);
			return rpcSuccess(id, "set_auto_retry");
		}

		case "abort_retry": {
			session.abortRetry();
			return rpcSuccess(id, "abort_retry");
		}

		case "bash": {
			const result = await session.executeBash(command.command, undefined, {
				excludeFromContext: command.excludeFromContext,
			});
			return rpcSuccess(id, "bash", result);
		}

		case "abort_bash": {
			session.abortBash();
			return rpcSuccess(id, "abort_bash");
		}

		case "get_session_stats": {
			const stats = session.getSessionStats();
			return rpcSuccess(id, "get_session_stats", stats);
		}

		case "export_html": {
			const path = await session.exportToHtml(command.outputPath);
			return rpcSuccess(id, "export_html", { path });
		}

		case "switch_session": {
			const result = await runtimeHost.switchSession(command.sessionPath);
			return rpcSuccess(id, "switch_session", result);
		}

		case "fork": {
			const result = await runtimeHost.fork(command.entryId);
			return rpcSuccess(id, "fork", { text: result.selectedText ?? "", cancelled: result.cancelled });
		}

		case "clone": {
			const leafId = session.sessionManager.getLeafId();
			if (!leafId) {
				return rpcError(id, "clone", "Cannot clone session: no current entry selected");
			}
			const result = await runtimeHost.fork(leafId, { position: "at" });
			return rpcSuccess(id, "clone", { cancelled: result.cancelled });
		}

		case "get_fork_messages": {
			const messages = session.getUserMessagesForForking();
			return rpcSuccess(id, "get_fork_messages", { messages });
		}

		case "get_entries": {
			const sessionManager = session.sessionManager;
			let entries = sessionManager.getEntries();
			if (command.since !== undefined) {
				const sinceIndex = entries.findIndex((e) => e.id === command.since);
				if (sinceIndex === -1) {
					return rpcError(id, "get_entries", `Entry not found: ${command.since}`);
				}
				entries = entries.slice(sinceIndex + 1);
			}
			return rpcSuccess(id, "get_entries", { entries, leafId: sessionManager.getLeafId() });
		}

		case "get_tree": {
			const sessionManager = session.sessionManager;
			return rpcSuccess(id, "get_tree", { tree: sessionManager.getTree(), leafId: sessionManager.getLeafId() });
		}

		case "navigate_tree": {
			const result = await session.navigateTree(command.targetId, {
				summarize: command.summarize,
				customInstructions: command.customInstructions,
				replaceInstructions: command.replaceInstructions,
				label: command.label,
			});
			return rpcSuccess(id, "navigate_tree", result);
		}

		case "get_last_assistant_text": {
			const text = session.getLastAssistantText();
			return rpcSuccess(id, "get_last_assistant_text", { text });
		}

		case "set_session_name": {
			const name = command.name.trim();
			if (!name) {
				return rpcError(id, "set_session_name", "Session name cannot be empty");
			}
			session.setSessionName(name);
			return rpcSuccess(id, "set_session_name");
		}

		case "get_messages": {
			return rpcSuccess(id, "get_messages", { messages: session.messages });
		}

		case "get_commands": {
			const commands: RpcSlashCommand[] = [];

			for (const registeredCommand of session.extensionRunner.getRegisteredCommands()) {
				commands.push({
					name: registeredCommand.invocationName,
					description: registeredCommand.description,
					source: "extension",
					sourceInfo: registeredCommand.sourceInfo,
				});
			}

			for (const template of session.promptTemplates) {
				commands.push({
					name: template.name,
					description: template.description,
					source: "prompt",
					sourceInfo: template.sourceInfo,
				});
			}

			for (const skill of session.resourceLoader.getSkills().skills) {
				commands.push({
					name: `skill:${skill.name}`,
					description: skill.description,
					source: "skill",
					sourceInfo: skill.sourceInfo,
				});
			}

			return rpcSuccess(id, "get_commands", { commands });
		}

		default: {
			const unknownCommand = command as { type: string };
			return rpcError(undefined, unknownCommand.type, `Unknown command: ${unknownCommand.type}`);
		}
	}
}
