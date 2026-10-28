import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	AssistantMessageComponent,
	BashExecutionComponent,
	BranchSummaryMessageComponent,
	CompactionSummaryMessageComponent,
	CONFIG_DIR_NAME,
	createAgentSession,
	createCodemodeExtension,
	createMcpExtension,
	createToolSearchExtension,
	CustomMessageComponent,
	DefaultResourceLoader,
	defineTool,
	DynamicBorder,
	getAgentDir,
	getMarkdownTheme,
	getSelectListTheme,
	keyHint,
	ModelRuntime,
	parseFrontmatter,
	ProjectTrustStore,
	sessionEntryToContextMessages,
	SessionManager,
	SettingsManager,
	ToolExecutionComponent,
	truncateHead,
	UserMessageComponent,
	type AgentSession,
	type AgentSessionEvent,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
	type InlineExtension,
	type PromptTemplate,
	type ResourceDiagnostic,
	type SessionEntry,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { getSupportedThinkingLevels, type ToolCall, type ToolResultMessage } from "@earendil-works/pi-ai";
import {
	Container, CURSOR_MARKER, Editor, fuzzyFilter, Input, Markdown, parseColor, ScrollView, Spacer, Text, truncateToWidth,
	type Color, type Component, type Focusable, type TUI, type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	parameters as questionParameters,
	questionChoices,
	questionError,
	result as questionResult,
	type AskQuestionDetails,
	type AskQuestionParams,
} from "./ask-question.ts";

const NAMES = ["Joe", "Bob", "Sam", "Max", "Leo", "Ben", "Tom", "Dan", "Ray", "Jay"] as const;
type AgentName = (typeof NAMES)[number];
interface PendingQuestion {
	params: AskQuestionParams;
	resolve: (answer: ReturnType<typeof questionResult>) => void;
	signal?: AbortSignal;
	onAbort: () => void;
}

interface Child extends AgentViewModel {
	name: AgentName;
	thinking: ThinkingLevel;
	pending?: PendingQuestion;
	preflight?: Promise<"queued" | "handled" | "started">;
	runPromise?: Promise<void>;
	createdAt: number;
	runNumber: number;
	publishedRun: number;
	cancelRevision: number;
	abortRequested: boolean;
	destroyed: boolean;
	unsubscribe: () => void;
}

type ParentResult = { name: AgentName; profile?: string; model: string; thinking: ThinkingLevel; run: number; text: string };

type AgentProfile = { name: string; template?: string; instructions: string; source: "user" | "project" | "package" };
const PACKAGE_ROOT = fileURLToPath(new URL("../", import.meta.url));
const PROFILE_NAME = /^[a-z][a-z0-9-]*$/;
const MODEL_PICKER_TIMEOUT_MS = 30_000;
const MODEL_PICKER_BORDER = parseColor("#b58900");
type PickResult<T> = { kind: "selected"; value: T } | { kind: "timeout" } | undefined;

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function loadProfile(name: string, ctx: ExtensionContext): AgentProfile {
	if (!PROFILE_NAME.test(name)) throw new Error("Agent profile name must match [a-z][a-z0-9-]*");
	const projectPath = join(ctx.cwd, CONFIG_DIR_NAME, "agents", `${name}.md`);
	// Pi does not require a trust prompt for .pi/agents alone; require a saved decision.
	const projectExists = existsSync(projectPath);
	const project = projectExists && ctx.isProjectTrusted() && new ProjectTrustStore(getAgentDir()).get(ctx.cwd) === true;
	const userPath = join(getAgentDir(), "agents", `${name}.md`);
	const packagePath = join(PACKAGE_ROOT, "agents", `${name}.md`);
	const origin = project ? "project" : existsSync(userPath) ? "user" : "package";
	const path = origin === "project" ? projectPath : origin === "user" ? userPath : packagePath;
	let source: string;
	try { source = readFileSync(path, "utf8"); }
	catch (error) {
		if (projectExists && !project && !existsSync(userPath) && !existsSync(packagePath)) {
			throw new Error(`Project agent profile ${projectPath} requires saved project trust. Use /trust and restart Pi.`);
		}
		throw new Error(`Could not read agent profile ${path}: ${errorText(error)}`);
	}
	let frontmatter: Record<string, unknown>;
	let body: string;
	try { ({ frontmatter, body } = parseFrontmatter<Record<string, unknown>>(source)); }
	catch (error) { throw new Error(`Invalid agent profile ${path}: ${errorText(error)}`); }
	const template = frontmatter?.template;
	if (!frontmatter || typeof frontmatter !== "object" || Array.isArray(frontmatter) || frontmatter.name !== name ||
		typeof frontmatter.description !== "string" || !frontmatter.description.trim() ||
		(template !== undefined && (typeof template !== "string" || !PROFILE_NAME.test(template)))) {
		throw new Error(`Invalid agent profile ${path}: expected name: ${name}, description, and optional template`);
	}
	return { name, template: typeof template === "string" ? template : undefined, instructions: body, source: origin };
}

export function expandProfileTask(
	profile: AgentProfile, task: string, cwd: string, prompts: PromptTemplate[], diagnostics: ResourceDiagnostic[] = [],
): string {
	if (!profile.template) return task;
	const globalPath = join(getAgentDir(), "prompts", `${profile.template}.md`);
	const projectPath = join(cwd, CONFIG_DIR_NAME, "prompts", `${profile.template}.md`);
	const packagePath = join(PACKAGE_ROOT, "prompts", `${profile.template}.md`);
	const paths = profile.source === "project" ? [projectPath, globalPath, packagePath] : [globalPath, packagePath];
	let template: Pick<PromptTemplate, "filePath" | "content"> | undefined;
	for (const path of paths) {
		template = prompts.find((item) => item.name === profile.template && item.filePath === path);
		if (template) break;
		// Only recover enabled templates Pi actually loaded, then dropped by name deduplication.
		const collision = diagnostics.some((item) => item.collision?.resourceType === "prompt" &&
			item.collision.name === profile.template && item.collision.loserPath === path);
		if (collision) {
			template = { filePath: path, content: parseFrontmatter(readFileSync(path, "utf8")).body };
			break;
		}
	}
	if (!template) throw new Error(`Agent ${profile.name} requires a prompt template at ${paths.join(" or ")}`);
	if (!template.content.includes("$ARGUMENTS")) throw new Error(`Prompt template ${template.filePath} must contain $ARGUMENTS`);
	// Expand only the template, preserving quotes and newlines in the task verbatim.
	return template.content.replaceAll("$ARGUMENTS", () => task);
}

async function pick<T>(
	ctx: ExtensionContext, title: string, items: T[], label: (item: T) => string, signal?: AbortSignal,
	options: { timeoutLabel?: string; borderColor?: Color } = {},
): Promise<PickResult<T>> {
	if (signal?.aborted) return undefined;
	let cleanup = () => {};
	try {
		return await ctx.ui.custom<PickResult<T>>((tui, theme, keys, done) => {
			const search = new Input({ prompt: " > ", placeholder: `Search ${title.toLowerCase()}` });
			let selected = 0;
			let finished = false;
			let automatic = options.timeoutLabel !== undefined;
			let timeout: ReturnType<typeof setTimeout> | undefined;
			let countdown: ReturnType<typeof setInterval> | undefined;
			const deadline = Date.now() + MODEL_PICKER_TIMEOUT_MS;
			const matches = () => fuzzyFilter(items, search.getValue(), label);
			const border = (s: string) => options.borderColor ? theme.style(s, { fg: options.borderColor }) : theme.fg("accent", s);
			const stopCountdown = () => {
				automatic = false;
				clearTimeout(timeout);
				clearInterval(countdown);
			};
			cleanup = () => {
				stopCountdown();
				signal?.removeEventListener("abort", onAbort);
			};
			const finish = (result: PickResult<T>) => {
				if (finished) return;
				finished = true;
				cleanup();
				done(result);
			};
			const onAbort = () => finish(undefined);
			if (automatic) {
				timeout = setTimeout(() => finish(signal?.aborted ? undefined : { kind: "timeout" }), MODEL_PICKER_TIMEOUT_MS);
				countdown = setInterval(() => tui.requestRender(), 1000);
			}
			signal?.addEventListener("abort", onAbort, { once: true });
			if (signal?.aborted) onAbort();
			return {
				get focused() { return search.focused; },
				set focused(value: boolean) { search.focused = value; },
				render(width: number): string[] {
					const list = matches();
					selected = Math.max(0, Math.min(selected, list.length - 1));
					const start = Math.max(0, Math.min(selected - 3, list.length - 8));
					const lines = [
						...new DynamicBorder(border).render(width),
						...new Text(theme.fg("accent", theme.bold(`Select ${title}`)), 1, 0).render(width),
						...search.render(width),
					];
					for (const [index, item] of list.slice(start, start + 8).entries()) {
						lines.push(...new Text(theme.fg(index + start === selected ? "accent" : "text", `${index + start === selected ? ">" : " "} ${label(item)}`), 1, 0).render(width).slice(0, 1));
					}
					if (!list.length) lines.push(...new Text(theme.fg("muted", "No matches"), 1, 0).render(width));
					if (options.timeoutLabel !== undefined) {
						const notice = automatic
							? `Default in ${Math.max(0, Math.ceil((deadline - Date.now()) / 1000))}s: ${options.timeoutLabel} · Any key keeps selection manual`
							: "Automatic default disabled; selection is now manual.";
						lines.push(...new Text(theme.fg("muted", notice), 1, 0).render(width));
					}
					lines.push(...new Text(theme.fg("dim", "Type to filter · ↑↓ select · Enter confirm · Esc cancel"), 1, 0).render(width));
					lines.push(...new DynamicBorder(border).render(width));
					return lines.map((line) => truncateToWidth(line, width, ""));
				},
				handleInput(data: string): void {
					if (finished) return;
					stopCountdown();
					const list = matches();
					if (keys.matches(data, "tui.select.cancel")) finish(undefined);
					else if (keys.matches(data, "tui.select.up")) selected = Math.max(0, selected - 1);
					else if (keys.matches(data, "tui.select.down")) selected = Math.min(list.length - 1, selected + 1);
					else if (keys.matches(data, "tui.select.confirm")) {
						if (list[selected]) finish({ kind: "selected", value: list[selected] });
					} else { search.handleInput(data); selected = 0; }
					if (!finished) tui.requestRender();
				},
				invalidate() { search.invalidate(); },
				dispose() { finish(undefined); },
			};
		}, { overlay: true });
	} finally { cleanup(); }
}

export function childExtensionFactories(pi: ExtensionAPI): InlineExtension[] {
	const tools = pi.getAllTools();
	const factories: InlineExtension[] = [];
	for (const [name, tool, factory] of [
		["codemode", "codemode", createCodemodeExtension],
		["tool-search", "tool_search", createToolSearchExtension],
	] as const) {
		if (tools.some((item) => item.name === tool)) factories.push({ name, factory: factory(), builtin: true, replaceable: true });
	}
	// Do not resurrect MCP when the parent disabled it (including CLI --no-mcp).
	if (pi.getCommands().some((item) => item.source === "extension" && item.name === "mcp")) {
		factories.push({ name: "mcp", factory: createMcpExtension(), builtin: true, replaceable: true });
	}
	return factories;
}

export async function selectDelegationSettings(ctx: ExtensionContext, thinking: ThinkingLevel, signal?: AbortSignal) {
	const currentProvider = ctx.model?.provider;
	const currentModelId = ctx.model?.id;
	const isCurrent = (model: NonNullable<ExtensionContext["model"]>) => model.provider === currentProvider && model.id === currentModelId;
	const models = ctx.modelRegistry.getAvailable();
	// The registry exposes virtual catalog entries, but not their router registrations.
	const unsupported = (model: NonNullable<ExtensionContext["model"]>) => model.api === "pi-virtual";
	if (ctx.model && unsupported(ctx.model)) {
		throw new Error(`Virtual model ${currentProvider}/${currentModelId} is unsupported for delegation; select a physical caller model first`);
	}
	const available = models.filter((model) => !unsupported(model)).sort((a, b) =>
		Number(isCurrent(b)) - Number(isCurrent(a)) || `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`),
	);
	if (!available.length) throw new Error("No authenticated models available for delegation; a physical model is required (virtual models are unsupported)");
	const inheritedLabel = currentProvider && currentModelId ? `${currentProvider}/${currentModelId}` : "caller model (unavailable)";
	const picked = await pick(ctx, "model", available, (item) => `${item.provider}/${item.id}`, signal, {
		timeoutLabel: `${inheritedLabel} / ${thinking}`, borderColor: MODEL_PICKER_BORDER,
	});
	if (!picked || signal?.aborted) return undefined;
	if (picked.kind === "timeout") {
		const model = available.find(isCurrent);
		if (!model) throw new Error(`Caller model unavailable for delegation: ${inheritedLabel}`);
		if (!getSupportedThinkingLevels(model).includes(thinking)) throw new Error(`Model does not support thinking level ${thinking}`);
		return { model, thinking };
	}
	const model = picked.value;
	const levels = getSupportedThinkingLevels(model).sort((a, b) => Number(b === thinking) - Number(a === thinking));
	const level = await pick(ctx, "thinking level", levels, (value) => value, signal);
	return level?.kind === "selected" && !signal?.aborted ? { model, thinking: level.value } : undefined;
}

export type AgentStatus = "running" | "waiting" | "done" | "failed" | "aborted";
type ToolOutput = Parameters<ToolExecutionComponent["updateResult"]>[0];
type Question = { params: AskQuestionParams };
type Phase = "choices" | "custom" | "comment";
interface ToolProgress {
	args?: Record<string, unknown>;
	started?: boolean;
	result?: ToolOutput;
	complete?: boolean;
}

export interface AgentViewState {
	draft: string;
	question?: { request: Question; selected: number; phase: Phase; custom: string; comments: Map<number, string> };
	tools: Map<string, ToolProgress>;
	expanded: boolean;
	hideThinking: boolean;
	scrollTop: number;
	following: boolean;
	activity?: string;
	diagnostic?: string;
}

export interface AgentViewModel {
	name: string;
	profile?: string;
	task: string;
	model: string;
	thinking: string;
	status: AgentStatus;
	session: AgentSession;
	pending?: Question;
	view: AgentViewState;
}

export interface AgentViewActions {
	send(text: string): Promise<"queued" | "handled" | "started">;
	answer(details: Omit<AskQuestionDetails, "question" | "options">): void;
	abort(): Promise<void>;
	subscribe(listener: () => void): () => void;
}

type PickerAgent = Pick<AgentViewModel, "name" | "profile" | "task" | "model" | "thinking" | "status"> & { createdAt: number };

export function createAgentPicker<T extends PickerAgent>(
	listAgents: () => T[], remove: (agent: T) => Promise<void>, subscribe: AgentViewActions["subscribe"],
	tui: TUI, theme: Theme, keys: KeybindingsManager, done: (agent: T | undefined) => void,
): Component & Focusable & { dispose(): void } {
	const search = new Input({ prompt: " > ", placeholder: "Search agents" });
	let selected: string | undefined;
	let confirmDelete: T | undefined;
	let deleting = false;
	let disposed = false;
	let error: string | undefined;
	const redraw = () => { if (!disposed) tui.requestRender(); };
	const unsubscribe = subscribe(redraw);
	const order = { waiting: 0, running: 1, done: 2, failed: 3, aborted: 3 };
	function matches(): T[] {
		const agents = listAgents().sort((a, b) => order[a.status] - order[b.status] || a.createdAt - b.createdAt);
		return [0, 1, 2, 3].flatMap((group) => fuzzyFilter(agents.filter((agent) => order[agent.status] === group), search.getValue(),
			(agent) => `${agent.name} ${agent.profile ?? ""} ${agent.task} ${agent.model} ${agent.thinking} ${agent.status}`));
	}
	function selection(list: T[]): number {
		const index = Math.max(0, list.findIndex((agent) => agent.name === selected));
		selected = list[index]?.name;
		return index;
	}
	return {
		get focused() { return search.focused; },
		set focused(value) { search.focused = value; },
		render(width) {
			const list = matches();
			const index = selection(list);
			const rows = Math.max(1, tui.terminal.rows);
			if (rows === 1) return search.render(width).slice(0, 1).map((text) => truncateToWidth(text, width, ""));
			const compact = rows < 7;
			const count = Math.max(0, Math.min(8, Math.floor((rows - (compact ? 2 : 5)) / (compact ? 1 : 2))));
			const start = Math.max(0, Math.min(index - Math.floor(count / 2), list.length - count));
			const lines = compact ? search.render(width) : [theme.fg("accent", "─".repeat(width)), theme.fg("accent", theme.bold("Agents")), ...search.render(width)];
			for (const [offset, agent] of list.slice(start, start + count).entries()) {
				const active = offset + start === index;
				const icon = { waiting: "?", running: "●", done: "✓", failed: "✗", aborted: "×" }[agent.status];
				lines.push(theme.fg(active ? "accent" : "text", `${active ? "→" : " "} ${icon} ${agent.name}${agent.profile ? ` · ${agent.profile}` : ""} · ${agent.status} · ${agent.model} · ${agent.thinking}`));
				if (!compact) lines.push(theme.fg("muted", `    ${agent.task.replace(/[\r\n\t]/g, " ")}`));
			}
			if (!list.length && count) lines.push(theme.fg("muted", "No matches"));
			const help = error ?? (deleting ? "Deleting…" : confirmDelete
				? `Delete ${confirmDelete.name} and its conversation? ${keyHint("tui.select.confirm", "confirm")} · ${keyHint("tui.select.cancel", "cancel")}`
				: `${keyHint("tui.select.confirm", "open")} · ${keyHint("app.session.delete", "delete")} · ${keyHint("tui.select.cancel", "back")}`);
			lines.push(theme.fg(error ? "error" : "dim", help));
			if (!compact) lines.push(theme.fg("accent", "─".repeat(width)));
			return lines.slice(0, rows).map((text) => truncateToWidth(text, width, "…"));
		},
		handleInput(data) {
			if (deleting || disposed) return;
			error = undefined;
			if (confirmDelete) {
				const agent = confirmDelete;
				confirmDelete = undefined;
				if (keys.matches(data, "tui.select.confirm")) {
					deleting = true;
					void remove(agent).catch((cause: unknown) => { error = `Delete failed: ${cause instanceof Error ? cause.message : String(cause)}`; })
						.finally(() => { deleting = false; redraw(); });
				}
			} else {
				const list = matches();
				const index = selection(list);
				if (keys.matches(data, "tui.select.cancel")) done(undefined);
				else if (keys.matches(data, "tui.select.up")) selected = list[Math.max(0, index - 1)]?.name;
				else if (keys.matches(data, "tui.select.down")) selected = list[Math.min(list.length - 1, index + 1)]?.name;
				else if (keys.matches(data, "app.session.delete")) confirmDelete = list[index];
				else if (keys.matches(data, "tui.select.confirm")) { if (list[index]) done(list[index]); }
				else { search.handleInput(data); selected = undefined; }
			}
			redraw();
		},
		invalidate() { search.invalidate(); },
		dispose() { disposed = true; unsubscribe(); },
	};
}

export function createAgentViewState(hideThinking: boolean): AgentViewState {
	return { draft: "", tools: new Map(), expanded: false, hideThinking, scrollTop: 0, following: true };
}

export function updateAgentView(state: AgentViewState, event: AgentSessionEvent): void {
	switch (event.type) {
		case "tool_execution_start":
			if (!event.parentToolCallId) state.tools.set(event.toolCallId, { args: event.args, started: true });
			break;
		case "tool_execution_update":
		case "tool_execution_end": {
			if (event.parentToolCallId) break;
			const complete = event.type === "tool_execution_end";
			state.tools.set(event.toolCallId, {
				...state.tools.get(event.toolCallId),
				started: true, complete,
				result: complete
					? { ...event.result, isError: event.isError, durationMs: event.durationMs }
					: { ...event.partialResult, isError: false },
			});
			break;
		}
		case "compaction_start": state.activity = "Compacting context…"; break;
		case "compaction_end":
			state.activity = undefined;
			if (event.errorMessage) state.diagnostic = `Compaction failed: ${event.errorMessage}`;
			break;
		case "auto_retry_start":
			state.activity = `Retry ${event.attempt}/${event.maxAttempts}: ${event.errorMessage}`;
			break;
		case "auto_retry_end": state.activity = undefined; break;
		case "agent_settled":
			state.activity = undefined;
			for (const [id, tool] of state.tools) {
				if (!tool.complete) state.tools.set(id, {
					...tool, complete: true,
					result: { content: [{ type: "text", text: event.aborted ? "Operation aborted" : "Tool ended without a result" }], isError: true },
				});
			}
			break;
	}
}

class Transcript implements Component {
	private messages = new Map<string, { message: AgentMessage; component: Component }>();
	private entries = new WeakMap<SessionEntry, AgentMessage[]>();
	private tools = new Map<string, {
		component: ToolExecutionComponent; args: unknown; started: boolean; complete: boolean; result?: ToolOutput; partial?: boolean; durationMs?: number;
	}>();
	private streaming?: AssistantMessageComponent;

	constructor(private agent: AgentViewModel, private tui: TUI, private theme: Theme) {}

	invalidate(): void {
		this.messages.clear();
		this.entries = new WeakMap();
		this.tools.clear();
		this.streaming = undefined;
	}

	private message(message: AgentMessage): Component | undefined {
		const { session, view } = this.agent;
		const pad = session.settingsManager.getOutputPad();
		switch (message.role) {
			case "user": {
				const text = typeof message.content === "string" ? message.content
					: message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
				const images = typeof message.content === "string" ? 0 : message.content.filter((part) => part.type === "image").length;
				return new UserMessageComponent(text + (images ? `\n[${images} image attachment(s)]` : ""), getMarkdownTheme(), pad, session.extensionRunner.getMarkdownTransformers());
			}
			case "assistant": return new AssistantMessageComponent(message, view.hideThinking, getMarkdownTheme(), "Thinking…", pad, session.extensionRunner.getMarkdownTransformers());
			case "custom": return message.display ? new CustomMessageComponent(message, session.extensionRunner.getMessageRenderer(message.customType), getMarkdownTheme(), pad) : undefined;
			case "compactionSummary": return new CompactionSummaryMessageComponent(message, getMarkdownTheme(), pad);
			case "branchSummary": return new BranchSummaryMessageComponent(message, getMarkdownTheme(), pad);
			case "bashExecution": {
				const component = new BashExecutionComponent(message.command, this.tui, message.excludeFromContext, pad);
				component.appendOutput(message.output);
				component.setComplete(message.exitCode, message.cancelled, undefined, message.fullOutputPath);
				return component;
			}
			default: return undefined;
		}
	}

	private tool(call: ToolCall, complete: boolean): ToolExecutionComponent {
		let cached = this.tools.get(call.id);
		if (!cached) {
			const { session } = this.agent;
			const renderers = session.extensionRunner.resolveToolRenderers(call.name, () => session.getToolDefinition(call.name));
			const component = new ToolExecutionComponent(call.name, call.id, call.arguments,
				{ showImages: false, outputPad: session.settingsManager.getOutputPad() }, renderers ?? {}, this.tui, session.sessionManager.getCwd());
			component.setExpanded(this.agent.view.expanded);
			cached = { component, args: call.arguments, started: false, complete: false };
			this.tools.set(call.id, cached);
		} else if (!complete || cached.args !== call.arguments) {
			cached.component.updateArgs(call.arguments);
			cached.args = call.arguments;
		}
		if (complete && !cached.complete) { cached.component.setArgsComplete(); cached.complete = true; }
		return cached.component;
	}

	render(width: number): string[] {
		const { session, view } = this.agent;
		const components: Component[] = [];
		const seenTools = new Set<string>();
		const results = new Map<string, ToolResultMessage>();
		for (const entry of session.sessionManager.getBranch()) {
			let messages = this.entries.get(entry);
			if (!messages) { messages = sessionEntryToContextMessages(entry); this.entries.set(entry, messages); }
			for (const [index, message] of messages.entries()) {
				if (message.role === "toolResult") {
					results.set(message.toolCallId, message);
					if (!seenTools.has(message.toolCallId)) {
						seenTools.add(message.toolCallId);
						components.push(this.tool({ type: "toolCall", id: message.toolCallId, name: message.toolName, arguments: {} }, true));
					}
					continue;
				}
				const key = `${entry.id}:${index}`;
				let cached = this.messages.get(key);
				if (!cached || cached.message !== message) {
					const component = this.message(message);
					if (!component) continue;
					if (component instanceof CompactionSummaryMessageComponent || component instanceof BranchSummaryMessageComponent || component instanceof BashExecutionComponent) component.setExpanded(view.expanded);
					cached = { message, component };
					this.messages.set(key, cached);
				}
				components.push(cached.component);
				if (message.role === "assistant") {
					for (const part of message.content) if (part.type === "toolCall") {
						seenTools.add(part.id);
						components.push(this.tool(part, true));
					}
				}
			}
		}
		const streaming = session.state.streamingMessage;
		if (streaming?.role === "assistant") {
			this.streaming ??= new AssistantMessageComponent(undefined, view.hideThinking, getMarkdownTheme(), "Thinking…", session.settingsManager.getOutputPad(), session.extensionRunner.getMarkdownTransformers());
			this.streaming.updateContent(streaming, true);
			components.push(this.streaming);
			for (const part of streaming.content) if (part.type === "toolCall") {
				seenTools.add(part.id);
				components.push(this.tool(part, false));
			}
		}
		for (const [id, cached] of this.tools) {
			const progress = view.tools.get(id);
			if (progress?.started && !cached.started) { cached.component.markExecutionStarted(); cached.started = true; }
			const final = results.get(id);
			const result = final ?? progress?.result;
			const durationMs = progress?.complete ? progress.result?.durationMs : undefined;
			const partial = !final && !progress?.complete;
			if (result && (cached.result !== result || cached.partial !== partial || cached.durationMs !== durationMs)) {
				cached.component.updateResult(durationMs === undefined ? result : { ...result, durationMs }, partial);
				cached.result = result;
				cached.partial = partial;
				cached.durationMs = durationMs;
			}
		}
		const lines = components.flatMap((component) => component.render(width));
		if (view.diagnostic) lines.push(...new Text(this.theme.fg("error", view.diagnostic), 1, 1).render(width));
		if (!lines.length) lines.push(...new Text(this.theme.fg("muted", this.agent.status === "running" ? "Waiting for child output…" : `Child ${this.agent.status}.`), 1, 0).render(width));
		return lines;
	}
}

export function createAgentView(
	agent: AgentViewModel, actions: AgentViewActions, tui: TUI, theme: Theme, keys: KeybindingsManager, done: () => void,
): Component & Focusable & { dispose(): void } {
	const state = agent.view;
	const transcript = new Transcript(agent, tui, theme);
	const viewport = new ScrollView(transcript, { follow: "end", overscroll: "contain" });
	const questionBody = new Container();
	const questionViewport = new ScrollView(questionBody, { overscroll: "contain" });
	const editor = new Editor(tui, { borderColor: (text) => theme.fg("borderMuted", text), selectList: getSelectListTheme() }, { paddingX: 1 });
	// Submit ourselves: Editor normally clears its buffer before onSubmit is called.
	editor.disableSubmit = true;
	let loading = false;
	let activeQuestion: Question | undefined;
	let activePhase: Phase = "choices";
	let focused = false;
	let sending = false;
	let disposed = false;
	let pasting = false;
	let pasteTail = "";
	let notice: string | undefined;
	let restoreScroll = true;
	let questionKey: string | undefined;
	let editorTop = 0;
	let editorStart = 0;
	let editorBorder = true;
	const redraw = () => { if (!disposed) tui.requestRender(); };
	const unsubscribe = actions.subscribe(redraw);
	const line = (text: string, width: number) => truncateToWidth(text.replace(/[\r\n\t]/g, " "), width, "…");

	function loadDraft(text: string): void {
		loading = true;
		editor.setText(text);
		loading = false;
	}
	function syncQuestion(): void {
		if (pasting) return;
		if (state.question?.request !== agent.pending) {
			state.question = agent.pending ? { request: agent.pending, selected: 0, phase: "choices", custom: "", comments: new Map() } : undefined;
			questionKey = undefined;
		}
		const question = state.question;
		const phase = question?.phase ?? "choices";
		if (activeQuestion !== agent.pending || activePhase !== phase) {
			activeQuestion = agent.pending;
			activePhase = phase;
			loadDraft(!question ? state.draft : phase === "custom" ? question.custom : phase === "comment" ? question.comments.get(question.selected) ?? "" : "");
		}
		editor.focused = focused && (!question || phase !== "choices");
	}
	editor.onChange = () => {
		if (loading) return;
		const text = editor.getExpandedText();
		const question = state.question;
		if (!question) state.draft = text;
		else if (question.phase === "custom") question.custom = text;
		else if (question.phase === "comment") question.comments.set(question.selected, text);
	};
	loadDraft(state.draft);
	syncQuestion();

	async function submit(): Promise<void> {
		const question = state.question;
		const original = editor.getExpandedText();
		const text = original.trim();
		if (sending || (!text && question?.phase !== "comment")) return;
		notice = undefined;
		if (question) {
			if (question.phase === "custom") actions.answer({ answer: text, wasCustom: true });
			else if (question.phase === "comment") actions.answer({ answer: question.request.params.options[question.selected]!.label, selectedIndex: question.selected + 1, comment: text || undefined });
			syncQuestion();
		} else {
			sending = true;
			try {
				const result = await actions.send(text);
				if (state.draft === original) {
					state.draft = "";
					if (!agent.pending) loadDraft("");
				}
				editor.addToHistory(text);
				notice = result === "queued" ? "Guidance accepted." : result === "handled" ? "Message handled by child extension." : undefined;
			} catch (error) { notice = `Send failed: ${error instanceof Error ? error.message : String(error)}`; }
			finally { sending = false; }
		}
		redraw();
	}

	function renderEditor(width: number, budget: number): string[] {
		const lines = editor.render(width);
		const body = lines.slice(1, -1);
		editorBorder = budget >= 3;
		const height = Math.max(1, budget - (editorBorder ? 2 : 0));
		const cursor = Math.max(0, body.findIndex((text) => text.includes(CURSOR_MARKER)));
		editorStart = Math.max(0, Math.min(cursor - Math.floor(height / 2), body.length - height));
		const visible = body.slice(editorStart, editorStart + height);
		return editorBorder ? [lines[0]!, ...visible, lines.at(-1)!] : visible;
	}
	function saveScroll(): void { state.scrollTop = viewport.scrollTop; state.following = viewport.isFollowingEnd; }
	function scroll(lines: number): void {
		if (agent.pending) questionViewport.scrollBy(lines);
		else { viewport.scrollBy(lines); saveScroll(); }
	}

	return {
		get focused() { return focused; },
		set focused(value) { focused = value; syncQuestion(); },
		render(width): string[] {
			syncQuestion();
			const rows = Math.max(1, tui.terminal.rows);
			const question = state.question;
			const composing = !question || question.phase !== "choices";
			const choices = question && questionChoices(question.request.params.options);
			if (rows < 5) {
				editorTop = 0;
				return (composing ? renderEditor(width, rows) : [line(choices![question!.selected]!.label, width), line(keyHint("tui.select.confirm", "answer") + " · " + keyHint("app.interrupt", "back"), width)]).slice(0, rows);
			}
			const color = agent.status === "failed" ? "error" : agent.status === "waiting" ? "warning" : agent.status === "done" ? "success" : "accent";
			const header = [line(theme.bold(`Parent › ${agent.name}${agent.profile ? ` · ${agent.profile}` : ""}`) + "  " + theme.fg(color, agent.status), width)];
			if (rows >= 12) header.push(line(theme.fg("muted", `${agent.model} · ${agent.thinking}`), width));
			const help = [line(theme.fg("dim", (question?.phase === "choices" ? keyHint("tui.select.confirm", "answer") + " · " + keyHint("tui.input.tab", "details") : keyHint("tui.input.submit", "send")) + " · " + keyHint("app.interrupt", "back") + " · " + keyHint("app.clear", "abort")), width)];
			if (rows >= 12) help.push(line(theme.fg("dim", keyHint("tui.select.pageUp", "up") + "/" + keyHint("tui.select.pageDown", "down") + " · " + keyHint("tui.altScreen.bottom", "live") + (composing ? " · " + keyHint("tui.input.newLine", "newline") : "")), width));
			if (rows >= 20) help.push(line(theme.fg("dim", keyHint("app.tools.expand", "tools") + " · " + keyHint("app.thinking.toggle", "thinking")), width));
			const queue = agent.session.getSteeringMessages().length + agent.session.getFollowUpMessages().length;
			const failure = notice?.startsWith("Send failed:") || notice?.startsWith("Abort failed:");
			const activity = failure ? notice : state.activity ?? (queue ? `${queue} queued message(s)` : !state.following && !question ? "Reading history · jump to live to follow new output" : notice);
			const status = activity && rows >= 7 ? [line(theme.fg(failure ? "error" : "muted", activity), width)] : [];
			const footer: string[] = [];
			if (composing) {
				const label = question ? question.phase === "custom" ? "Your answer" : `Details for ${question.request.params.options[question.selected]!.label}` : sending ? "Sending…" : `Message ${agent.name}${agent.status === "running" ? " · steer current run" : ""}`;
				footer.push(line(theme.fg("accent", label), width));
				const budget = Math.max(1, Math.min(7, rows - header.length - help.length - status.length - 2));
				footer.push(...renderEditor(width, budget));
			} else {
				const count = Math.min(choices!.length, Math.max(1, Math.min(5, Math.floor(rows / 4))));
				const start = Math.max(0, Math.min(question!.selected - Math.floor(count / 2), choices!.length - count));
				footer.push(line(theme.fg("muted", `Choose an answer (${question!.selected + 1}/${choices!.length})`), width));
				for (let index = start; index < start + count; index++) footer.push(line(theme.fg(index === question!.selected ? "accent" : "text", `${index === question!.selected ? "→" : " "} ${choices![index]!.label}`), width));
			}
			const height = Math.max(0, rows - header.length - footer.length - help.length - status.length);
			let body: string[];
			if (question) {
				const key = `${question.selected}:${question.phase}`;
				if (questionKey !== key) {
					questionKey = key;
					questionBody.clear();
					questionBody.addChild(new Markdown(question.request.params.question, 1, 0, getMarkdownTheme()));
					questionBody.addChild(new Spacer(1));
					questionBody.addChild(new Text(theme.bold(choices![question.selected]!.label), 1, 0));
					const description = choices![question.selected]!.description;
					if (description) questionBody.addChild(new Text(description, 1, 0));
					questionViewport.scrollToStart();
				}
				const lines = questionBody.render(width);
				questionViewport.updateLayout(lines.length, height, redraw);
				body = lines.slice(questionViewport.scrollTop, questionViewport.scrollTop + height);
			} else {
				const lines = transcript.render(width);
				viewport.updateLayout(lines.length, height, redraw);
				if (restoreScroll) {
					restoreScroll = false;
					if (!state.following) viewport.scrollTo(state.scrollTop, { disableFollow: true });
				}
				saveScroll();
				body = lines.slice(viewport.scrollTop, viewport.scrollTop + height);
			}
			editorTop = header.length + height + status.length + 1;
			return [...header, ...body, ...Array(Math.max(0, height - body.length)).fill(""), ...status, ...footer, ...help].map((text) => truncateToWidth(text, width, ""));
		},
		handleInput(data): void {
			if (disposed) return;
			syncQuestion();
			if (pasting || data.includes("\x1b[200~")) {
				const chunk = pasteTail + data;
				pasting = !chunk.includes("\x1b[201~");
				pasteTail = pasting ? chunk.slice(-5) : "";
				if (!state.question || state.question.phase !== "choices") editor.handleInput(data);
				redraw();
				return;
			}
			const question = state.question;
			if (keys.matches(data, "app.clear")) {
				void actions.abort().catch((error: unknown) => { notice = `Abort failed: ${error instanceof Error ? error.message : String(error)}`; redraw(); });
			} else if (keys.matches(data, "app.interrupt")) {
				if (question && question.phase !== "choices") { question.phase = "choices"; syncQuestion(); }
				else done();
			} else if (keys.matches(data, "tui.select.pageUp")) scroll(-Math.max(1, (question ? questionViewport : viewport).viewportHeight));
			else if (keys.matches(data, "tui.select.pageDown")) scroll(Math.max(1, (question ? questionViewport : viewport).viewportHeight));
			else if (keys.matches(data, "tui.altScreen.top")) { (question ? questionViewport : viewport).scrollToStart(); if (!question) saveScroll(); }
			else if (keys.matches(data, "tui.altScreen.bottom")) { (question ? questionViewport : viewport).scrollToEnd(); if (!question) saveScroll(); }
			else if (keys.matches(data, "app.tools.expand")) { state.expanded = !state.expanded; transcript.invalidate(); }
			else if (keys.matches(data, "app.thinking.toggle")) { state.hideThinking = !state.hideThinking; transcript.invalidate(); }
			else if (question && question.phase === "choices") {
				const max = question.request.params.options.length;
				if (keys.matches(data, "tui.select.up")) question.selected = (question.selected + max) % (max + 1);
				else if (keys.matches(data, "tui.select.down")) question.selected = (question.selected + 1) % (max + 1);
				else if (keys.matches(data, "tui.select.confirm") || keys.matches(data, "tui.input.tab")) {
					if (question.selected === max) question.phase = "custom";
					else if (keys.matches(data, "tui.input.tab")) question.phase = "comment";
					else actions.answer({ answer: question.request.params.options[question.selected]!.label, selectedIndex: question.selected + 1 });
				}
			} else if (keys.matches(data, "tui.input.submit") && !keys.matches(data, "tui.input.newLine")) void submit();
			else editor.handleInput(data);
			redraw();
		},
		handleMouse(event: TuiMouseEvent) {
			if (disposed) return undefined;
			if (event.type === "wheel") { scroll(event.wheelDelta ?? 0); redraw(); return { handled: true }; }
			if ((!state.question || state.question.phase !== "choices") && event.y >= editorTop) {
				return editor.handleMouse({ ...event, y: event.y - editorTop + editorStart + (editorBorder ? 0 : 1) });
			}
			return undefined;
		},
		invalidate() { transcript.invalidate(); questionKey = undefined; editor.invalidate(); },
		dispose() { disposed = true; unsubscribe(); },
	};
}

export default function subagents(pi: ExtensionAPI): void {
	const agents = new Map<AgentName, Child>();
	const reserved = new Set<AgentName>();
	const pendingResults: ParentResult[] = [];
	const listeners = new Set<(agent?: Child) => void>();
	let statusText: string | undefined;
	let parent: ExtensionContext | undefined;
	let alive = true;
	let selectionAbort = new AbortController();

	function changed(agent?: Child): void {
		if (!alive) return;
		if (parent?.mode === "tui") {
			const children = [...agents.values()];
			const waiting = children.filter((child) => child.status === "waiting").map((child) => child.name);
			const counts = (["running", "done", "failed", "aborted"] as const).map((status) => {
				const count = children.filter((child) => child.status === status).length;
				return count ? `${count} ${status}` : undefined;
			}).filter(Boolean);
			if (waiting.length) counts.unshift(`${waiting.join(", ")} needs input`);
			const text = agents.size ? `agents: ${counts.join(" · ")}` : undefined;
			if (text !== statusText) { parent.ui.setStatus("subagents", text); statusText = text; }
		}
		for (const listener of listeners) listener(agent);
	}

	function subscribe(listener: () => void, agent?: Child): () => void {
		const callback = (child?: Child) => { if (!agent || !child || child === agent) listener(); };
		listeners.add(callback);
		return () => { listeners.delete(callback); };
	}

	function flush(): void {
		if (!alive || !parent) return;
		for (const item of pendingResults.splice(0)) {
			pi.sendMessage({
				customType: "subagent-result",
				content: `[${item.name}${item.profile ? ` · ${item.profile}` : ""} · ${item.model} · ${item.thinking} · run ${item.run}]\n\n${item.text}`,
				display: true,
				details: { name: item.name, ...(item.profile ? { profile: item.profile } : {}), model: item.model, thinking: item.thinking, run: item.run },
			}, { triggerTurn: true });
		}
	}

	function publish(agent: Child, text: string): void {
		if (!alive || agent.destroyed || agent.publishedRun >= agent.runNumber) return;
		agent.publishedRun = agent.runNumber;
		const shortened = truncateHead(text, { maxBytes: 50_000, maxLines: 2000 });
		pendingResults.push({
			name: agent.name, profile: agent.profile, model: agent.model, thinking: agent.thinking, run: agent.runNumber,
			text: shortened.content + (shortened.truncated ? "\n[Result truncated; full conversation available in /agent]" : ""),
		});
		flush();
	}

	function settleQuestion(agent: Child, details: AskQuestionDetails): void {
		const pending = agent.pending;
		if (!pending) return;
		agent.pending = undefined;
		pending.signal?.removeEventListener("abort", pending.onAbort);
		if (agent.status === "waiting") agent.status = "running";
		pending.resolve(questionResult(details));
		changed(agent);
	}

	function answerQuestion(agent: Child, answer: Omit<AskQuestionDetails, "question" | "options">): void {
		const params = agent.pending?.params;
		if (!params) return;
		settleQuestion(agent, {
			question: params.question,
			options: params.options.map((option) => option.label),
			...answer,
		});
	}

	function finishRun(agent: Child): void {
		if (agent.destroyed || agent.publishedRun >= agent.runNumber) return;
		const messages = agent.session.messages;
		const lastUser = messages.findLastIndex((message) => message.role === "user");
		const reply = messages.slice(lastUser + 1).findLast((message) => message.role === "assistant");
		if (agent.abortRequested || reply?.stopReason === "aborted") {
			agent.status = "aborted";
			agent.view.diagnostic = "Child run aborted.";
			publish(agent, agent.view.diagnostic);
		} else if (!reply || reply.stopReason === "error" || reply.stopReason === "length") {
			agent.status = "failed";
			agent.view.diagnostic = `Child run failed: ${reply?.errorMessage ?? reply?.stopReason ?? "no assistant response"}`;
			publish(agent, agent.view.diagnostic);
		} else {
			const text = reply.content.filter((part) => part.type === "text").map((part) => part.text).join("\n").trim();
			agent.status = "done";
			publish(agent, text || "Child run ended without a final text answer. See /agent for details.");
		}
		changed(agent);
	}

	function startRun(agent: Child, text: string): Promise<"queued" | "handled" | "started"> {
		const begin = () => {
			agent.status = "running";
			agent.view.diagnostic = undefined;
			agent.view.activity = undefined;
			changed(agent);
			return ++agent.runNumber;
		};
		const busy = agent.session.isStreaming;
		let runNumber: number | undefined;
		if (!busy) {
			agent.abortRequested = false;
			runNumber = begin();
		}
		let disposition: "queued" | "handled" | "started" | undefined;
		let accept!: (value: "queued" | "handled" | "started") => void;
		let reject!: (error: unknown) => void;
		const preflight = new Promise<"queued" | "handled" | "started">((resolve, fail) => { accept = resolve; reject = fail; });
		agent.preflight = preflight;
		const run = agent.session.prompt(text, {
			expandPromptTemplates: false, streamingBehavior: "steer",
			preflightResult(result) {
				disposition = result;
				if (result === "started") {
					runNumber ??= begin();
					agent.runPromise = tracked;
					// abort() may have run before input/auth finished and before Pi owned a run.
					if (agent.abortRequested || agent.destroyed) void agent.session.abort();
				}
				accept(result);
			},
		});
		const tracked = run.then(() => {
			if (runNumber === undefined || agent.runNumber !== runNumber) return;
			if (disposition === "handled") {
				agent.status = "done";
				publish(agent, "Message handled by child extension.");
				changed(agent);
			} else if (agent.publishedRun < runNumber) finishRun(agent);
		}).catch((error: unknown) => {
			reject(error);
			if (runNumber === undefined || agent.destroyed || agent.runNumber !== runNumber || agent.publishedRun >= runNumber) return;
			agent.status = agent.abortRequested ? "aborted" : "failed";
			agent.view.diagnostic = agent.abortRequested ? "Child run aborted." : `Child run failed: ${errorText(error)}`;
			publish(agent, agent.view.diagnostic);
			changed(agent);
		}).finally(() => {
			if (agent.preflight === preflight) agent.preflight = undefined;
			if (agent.runPromise === tracked) agent.runPromise = undefined;
		});
		if (!busy) agent.runPromise = tracked;
		return preflight;
	}

	async function send(agent: Child, text: string): Promise<"queued" | "handled" | "started"> {
		const revision = agent.cancelRevision;
		for (;;) {
			const preflight = agent.preflight;
			await preflight;
			if (agent.destroyed) throw new Error("Agent deleted");
			if (!alive) throw new Error("Session shut down");
			if (agent.cancelRevision !== revision) throw new Error("Message cancelled");
			if (agent.status === "waiting") throw new Error("Answer the pending question first");
			if (agent.preflight && agent.preflight !== preflight) continue;
			// Pi clears isStreaming before awaiting settlement hooks. Its prompt()
			// would resolve early and defer the submission while those hooks run.
			const previousRun = agent.runPromise;
			if (!agent.session.isStreaming && previousRun) {
				await previousRun;
				continue;
			}
			return startRun(agent, text);
		}
	}

	async function abort(agent: Child): Promise<void> {
		if (agent.destroyed) return;
		agent.cancelRevision++;
		if (agent.status !== "running" && agent.status !== "waiting") return;
		agent.abortRequested = true;
		answerQuestion(agent, { answer: null, error: "Question aborted" });
		await agent.session.abort();
		await agent.preflight?.catch(() => {});
		await agent.runPromise;
		if (agent.publishedRun < agent.runNumber) finishRun(agent);
		changed(agent);
	}

	async function destroy(agent: Child): Promise<void> {
		if (agent.destroyed) return;
		agent.destroyed = true;
		answerQuestion(agent, { answer: null, error: "Agent deleted" });
		try {
			await agent.session.abort();
			await agent.preflight?.catch(() => {});
			await agent.runPromise;
			await agent.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		} finally {
			agent.unsubscribe();
			agent.session.dispose();
			agents.delete(agent.name);
			reserved.delete(agent.name);
			changed(agent);
		}
	}

	pi.on("session_start", (_event, ctx) => {
		parent = ctx;
		alive = true;
		selectionAbort = new AbortController();
		changed();
	});
	pi.on("session_shutdown", async (_event, ctx) => {
		alive = false;
		selectionAbort.abort();
		ctx.ui.setStatus("subagents", undefined);
		statusText = undefined;
		parent = undefined;
		pendingResults.length = 0;
		await Promise.allSettled([...agents.values()].map(destroy));
		listeners.clear();
	});

	pi.registerTool({
		name: "delegate",
		label: "Delegate",
		description: "Start a concurrent in-process child agent. Set agent to planner to use a planning profile. Project profiles in .pi/agents require saved project trust and take precedence over user profiles. Profiles may specify a prompt template. A fuzzy TUI model picker defaults to the caller's model and thinking level after 30 untouched seconds. Any key disables that default; explicit model selection opens a manual thinking picker. Results appear in the parent when the child finishes; use /agent to talk to it.",
		promptSnippet: "Start a concurrent child agent; set agent to planner for planning. An untouched model picker inherits the caller's model and thinking level after 30 seconds",
		parameters: Type.Object({
			task: Type.String({ minLength: 1, description: "Task for the child agent" }),
			agent: Type.Optional(Type.String({ description: "User or trusted project agent profile name, such as planner" })),
		}),
		async execute(_id, params, signal, _update, ctx) {
			if (ctx.mode !== "tui") throw new Error("delegate requires an interactive Pi TUI in v1");
			signal = signal ? AbortSignal.any([signal, selectionAbort.signal]) : selectionAbort.signal;
			if (!alive || signal.aborted) throw new Error("Delegation cancelled");
			const task = params.task.trim();
			if (!task) throw new Error("Provide a task for the child agent");
			const profile = params.agent === undefined ? undefined : loadProfile(params.agent, ctx);
			const selected = await selectDelegationSettings(ctx, ctx.thinkingLevel ?? pi.getThinkingLevel(), signal);
			if (!selected) return { content: [{ type: "text", text: "Delegation cancelled; no child started." }], details: undefined };
			const { model, thinking } = selected;
			if (!alive || signal?.aborted) throw new Error("Delegation cancelled");
			const provider = model.provider;
			const modelId = model.id;
			const name = NAMES.find((candidate) => !reserved.has(candidate));
			if (!name) throw new Error("All ten child sessions are occupied; delete one with /agent");
			reserved.add(name);
			let session: AgentSession | undefined;
			try {
				const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
				if (!auth.ok) throw new Error(auth.error);
				const runtime = await ModelRuntime.create();
				// A child has its own SDK runtime. Copy providers registered dynamically by the parent.
				for (const id of ctx.modelRegistry.getRegisteredProviderIds()) {
					const native = ctx.modelRegistry.getRegisteredNativeProvider(id);
					const config = ctx.modelRegistry.getRegisteredProviderConfig(id);
					if (native) runtime.registerNativeProvider(native);
					if (config) runtime.registerProvider(id, config);
				}
				// OAuth credentials must remain refreshable in the child's runtime.
				if (auth.apiKey && !ctx.modelRegistry.isUsingOAuth(model)) {
					await runtime.setRuntimeApiKey(provider, auth.apiKey);
				}
				let childModel = runtime.getModel(provider, modelId);
				if (!childModel) {
					const refresh = await runtime.refresh({ providers: [provider], allowNetwork: true, force: true, signal });
					if (refresh.aborted || signal?.aborted) throw new Error("Delegation cancelled");
					childModel = runtime.getModel(provider, modelId);
				}
				if (!childModel) throw new Error(`Model unavailable in child runtime: ${provider}/${modelId}`);
				const settings = SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted: ctx.isProjectTrusted() });
				const loader = new DefaultResourceLoader({
					cwd: ctx.cwd, agentDir: getAgentDir(), settingsManager: settings,
					extensionFactories: childExtensionFactories(pi),
					appendSystemPromptOverride: profile?.instructions ? (base) => [...base, profile.instructions] : undefined,
				});
				await loader.reload();
				const prompts = loader.getPrompts();
				const prompt = profile ? expandProfileTask(profile, task, ctx.cwd, prompts.prompts, prompts.diagnostics) : task;

				let child!: Child;
				const ask = defineTool({
					name: "ask_question",
					label: "Ask Question",
					description: "Ask the user one question with meaningful options or a custom answer. Wait for their answer in /agent.",
					promptSnippet: "Ask the user one question and wait for their answer in /agent",
					promptGuidelines: [
						"Use ask_question when clarification is needed; the user answers through /agent. Do not wait for a new user message.",
						"Ask one focused question with meaningful options, putting the recommended option first.",
					],
					executionMode: "sequential",
					parameters: questionParameters,
					execute(_callId, input, questionSignal) {
						const question = input.question.trim();
						const options = input.options.map((option) => ({ label: option.label.trim(), description: option.description?.trim() }));
						const error = questionError(question, options);
						const details = { question, options: options.map((option) => option.label), answer: null };
						if (error || child.destroyed || questionSignal?.aborted) {
							return Promise.resolve(questionResult({ ...details, error: error ?? "Question aborted" }));
						}
						if (child.pending) return Promise.resolve(questionResult({ ...details, error: "Question already pending" }));
						return new Promise<ReturnType<typeof questionResult>>((resolve) => {
							const onAbort = () => answerQuestion(child, { answer: null, error: "Question aborted" });
							child.pending = { params: { question, options }, resolve, signal: questionSignal, onAbort };
							child.status = "waiting";
							questionSignal?.addEventListener("abort", onAbort, { once: true });
							if (questionSignal?.aborted) onAbort();
							else {
								ctx.ui.notify(`${name} is waiting for an answer. Open /agent ${name}.`, "info");
								changed(child);
							}
						});
					},
				});
				const created = await createAgentSession({
					cwd: ctx.cwd, model: childModel, thinkingLevel: thinking, modelRuntime: runtime,
					settingsManager: settings, resourceLoader: loader,
					sessionManager: SessionManager.inMemory(ctx.cwd),
					tools: pi.getActiveTools().filter((tool) => tool !== "delegate"),
					excludeTools: ["delegate"], customTools: [ask],
				});
				session = created.session;
				await session.bindExtensions({ mode: "print" });
				session.setThinkingLevel(thinking);
				if (session.thinkingLevel !== thinking) throw new Error(`Model does not support thinking level ${thinking}`);
				if (!alive || signal?.aborted) throw new Error("Delegation cancelled");
				child = {
					name, profile: profile?.name, task, model: `${provider}/${modelId}`, thinking,
					session, status: "running", createdAt: Date.now(), runNumber: 0, publishedRun: 0,
					view: createAgentViewState(session.settingsManager.getHideThinkingBlock()),
					cancelRevision: 0, abortRequested: false, destroyed: false, unsubscribe: () => {},
				};
				child.unsubscribe = session.subscribe((event) => {
					updateAgentView(child.view, event);
					if (event.type === "agent_settled") finishRun(child);
					else changed(child);
				});
				agents.set(name, child);
				changed(child);
				void startRun(child, prompt).catch(() => {});
				return { content: [{ type: "text", text: `Started ${name}${profile ? ` (${profile.name})` : ""}: ${child.model} / ${child.thinking}. Use /agent ${name} to view or answer questions.` }], details: { name, ...(profile ? { profile: profile.name } : {}) } };
			} catch (error) {
				try {
					if (session) {
						try {
							await session.abort();
							await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
						} finally { session.dispose(); }
					}
				} finally { reserved.delete(name); }
				throw error;
			}
		},
	});

	pi.registerCommand("agent", {
		description: "Pick, enter, or delete a retained child agent; /agent Joe opens Joe directly",
		getArgumentCompletions: (prefix) => NAMES.filter((name) => agents.has(name) && name.toLowerCase().startsWith(prefix.toLowerCase())).map((name) => ({ value: name, label: name })),
		async handler(args, ctx) {
			if (ctx.mode !== "tui") { ctx.ui.notify("/agent needs the interactive TUI", "error"); return; }
			if (!agents.size) { ctx.ui.notify("No child agents. Use delegate first.", "info"); return; }
			let name = [...agents.keys()].find((candidate) => candidate.toLowerCase() === args.trim().toLowerCase());
			if (args.trim() && !name) { ctx.ui.notify(`No agent named ${args.trim()}`, "error"); return; }
			if (!name) {
				const selected = await ctx.ui.custom<Child | undefined>((tui, theme, keys, done) =>
					createAgentPicker(() => [...agents.values()], destroy, (listener) => subscribe(listener), tui, theme, keys, done),
				{ overlay: true, overlayOptions: { maxHeight: "100%" } });
				name = selected?.name;
			}
			const agent = name && agents.get(name);
			if (!agent) return;
			await ctx.ui.custom<void>((tui, theme, keys, done) => createAgentView(agent, {
				send: (text) => send(agent, text),
				answer: (details) => answerQuestion(agent, details),
				abort: () => abort(agent),
				subscribe: (listener) => subscribe(listener, agent),
			}, tui, theme, keys, () => done()),
			{ overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", anchor: "top-left" } });
		},
	});
}
