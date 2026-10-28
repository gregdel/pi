import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters as plain } from "node:util";

const here = dirname(fileURLToPath(import.meta.url));
const packageFile = process.env.PI_PACKAGE_DIR
	? join(process.env.PI_PACKAGE_DIR, "package.json") : import.meta.url;
const require = createRequire(packageFile);
const { createJiti } = require("jiti");
const resolver = createJiti(packageFile, { fsCache: false });
const jiti = createJiti(import.meta.url, {
	fsCache: false, moduleCache: false,
	alias: Object.fromEntries([
		"@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox",
	].map((name) => [name, fileURLToPath(resolver.esmResolve(
		name === "@earendil-works/pi-ai" ? `${name}/compat` : name,
	))])),
});
const runtime = dirname(fileURLToPath(resolver.esmResolve("@earendil-works/pi-coding-agent")));
const { AssistantMessageComponent, SessionManager, SettingsManager, getMarkdownTheme, initTheme } =
	await jiti.import("@earendil-works/pi-coding-agent");
const { KeybindingsManager } = await jiti.import(join(runtime, "core/keybindings.js"));
const { theme } = await jiti.import(join(runtime, "modes/interactive/theme/theme.js"));
const { CURSOR_MARKER, getKeybindings, setKeybindings, Text, TuiAltScreen, visibleWidth } = await jiti.import("@earendil-works/pi-tui");
const tuiRuntime = dirname(fileURLToPath(resolver.esmResolve("@earendil-works/pi-tui")));
const { TuiMainScreen } = await jiti.import(join(tuiRuntime, "tui-main-screen.js"));
const { createAgentViewState, updateAgentView, createAgentView } = await jiti.import(join(here, "../extensions/subagents.ts"));
initTheme("dark"); // No watcher, user settings, credentials, or model runtime.

const key = {
	enter: "\r", escape: "\x1b", down: "\x1b[B", up: "\x1b[A", tab: "\t",
	pageUp: "\x1b[5~", pageDown: "\x1b[6~", top: "\x1b[1;5H", bottom: "\x1b[1;5F",
	tools: "\x0f", thinking: "\x14", newline: "\n",
};
const flush = () => new Promise(setImmediate);
const paste = (text) => `\x1b[200~${text}\x1b[201~`;
const textContent = (text) => [{ type: "text", text }];
const assistant = (content, extra = {}) => ({
	role: "assistant", content: typeof content === "string" ? textContent(content) : content,
	api: "openai-responses", provider: "test", model: "offline", timestamp: 0, stopReason: "stop",
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, ...extra,
});
const question = (extra = {}) => ({ params: {
	question: "Which approach?", options: [{ label: "Keep", description: "Keep the existing design." }, { label: "Replace" }], ...extra,
} });
const toolCall = (id = "call", args = { path: "example.txt" }) => ({ type: "toolCall", id, name: "inspect_data", arguments: args });
const toolResult = (text, extra = {}) => ({
	role: "toolResult", toolCallId: "call", toolName: "inspect_data", content: textContent(text), isError: false, timestamp: 0, ...extra,
});

function fixture(t, { rows = 24, bindings = {}, hideThinking = true, send = async () => "started" } = {}) {
	const previousKeys = getKeybindings();
	const keys = new KeybindingsManager(bindings);
	setKeybindings(keys); // Editor and keyHint use the runtime's global manager.
	const listeners = new Set();
	const queues = { steering: [], followUp: [] };
	const manager = SessionManager.inMemory(process.cwd());
	const session = {
		sessionManager: manager, settingsManager: SettingsManager.inMemory(), state: { streamingMessage: undefined },
		get messages() { return manager.buildSessionContext().messages; },
		getSteeringMessages: () => queues.steering, getFollowUpMessages: () => queues.followUp,
		getToolDefinition: () => undefined,
		extensionRunner: {
			getMarkdownTransformers: () => [], getMessageRenderer: () => undefined,
			resolveToolRenderers: (_name, next) => next(),
		},
	};
	const agent = { name: "child", task: "Offline UI regression", model: "test/offline", thinking: "high",
		status: "running", session, view: createAgentViewState(hideThinking) };
	const actions = {
		send: t.mock.fn(send), abort: t.mock.fn(async () => {}),
		answer: t.mock.fn(() => { agent.pending = undefined; }),
		subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
	};
	const tui = { terminal: { rows }, requestRender: t.mock.fn() };
	const done = t.mock.fn();
	let component;
	const f = {
		agent, actions, tui, keys, manager, session, listeners, done,
		get component() { return component; },
		open() { component = createAgentView(agent, actions, tui, theme, keys, done); component.focused = true; },
		close() { component.dispose(); },
		input: (data) => component.handleInput(data),
		lines: (width = 80) => component.render(width),
		text: (width = 80) => plain(component.render(width).join("\n")),
		append: (message) => manager.appendMessage(message),
		notify() { for (const listener of listeners) listener(); },
		event(event) {
			if (event.type === "queue_update") Object.assign(queues, { steering: event.steering, followUp: event.followUp });
			updateAgentView(agent.view, event);
			f.notify();
		},
	};
	f.open();
	t.after(() => { f.close(); setKeybindings(previousKeys); });
	return f;
}

function fits(f, width, cursor = true) {
	const lines = f.lines(width);
	assert.ok(lines.length <= f.tui.terminal.rows, `${lines.length} rows exceed ${f.tui.terminal.rows}`);
	for (const line of lines) assert.ok(visibleWidth(line) <= width, `line exceeds ${width} columns: ${plain(line)}`);
	if (cursor) {
		const cursors = lines.filter((line) => line.includes(CURSOR_MARKER));
		assert.equal(cursors.length, 1, "focused editor cursor must remain in the visible viewport");
		assert.ok(visibleWidth(cursors[0].split(CURSOR_MARKER)[0]) < width, "cursor must not be clipped at the right edge");
	}
	return plain(lines.join("\n"));
}

function pageThrough(f, width = 80, limit = 80) {
	let text = "";
	f.text(width); // ScrollView must have layout before a jump can take effect.
	f.input(key.bottom);
	const end = f.text(width);
	f.input(key.top);
	for (let i = 0; i < limit; i++) {
		const page = fits(f, width, !f.agent.pending || f.agent.view.question.phase !== "choices");
		text += `\n${page}`;
		if (page === end) return text;
		f.input(key.pageDown);
	}
	assert.fail("paging did not reach the end within the bounded test history");
}

test("view state is independent and tracks root tool partials, completion, and interrupted calls", () => {
	const state = createAgentViewState(true);
	const other = createAgentViewState(false);
	assert.equal(state.following, true);
	assert.equal(state.expanded, false);
	assert.equal(other.hideThinking, false);
	const start = { type: "tool_execution_start", toolCallId: "call", toolName: "inspect_data", args: { path: "a" } };
	updateAgentView(state, start);
	updateAgentView(state, { ...start, toolCallId: "call/1", parentToolCallId: "call" });
	updateAgentView(state, { type: "tool_execution_update", toolCallId: "call", toolName: "inspect_data", args: start.args,
		partialResult: { content: textContent("partial"), details: { progress: 1 } } });
	assert.deepEqual(state.tools.get("call"), { args: start.args, started: true, complete: false,
		result: { content: textContent("partial"), details: { progress: 1 }, isError: false } });
	updateAgentView(state, { type: "tool_execution_end", toolCallId: "call", toolName: "inspect_data",
		result: { content: textContent("final") }, isError: true, durationMs: 17 });
	assert.deepEqual(state.tools.get("call").result, { content: textContent("final"), isError: true, durationMs: 17 });
	assert.equal(state.tools.get("call").complete, true);
	for (const type of ["tool_execution_update", "tool_execution_end"]) {
		updateAgentView(state, { type, toolCallId: "call/1", parentToolCallId: "call", partialResult: {}, result: {} });
	}
	assert.equal(state.tools.size, 1);
	assert.equal(other.tools.size, 0);
	for (const aborted of [false, true]) {
		updateAgentView(state, { ...start, toolCallId: "unfinished" });
		updateAgentView(state, { type: "agent_settled", aborted });
		assert.equal(state.tools.get("unfinished").complete, true);
		assert.equal(state.tools.get("unfinished").result.isError, true);
		assert.match(state.tools.get("unfinished").result.content[0].text, aborted ? /aborted/i : /without a result/i);
		assert.equal(state.tools.get("call").result.durationMs, 17, "settling must not overwrite completed results");
	}
});

test("assistant markdown and fenced code use the native renderer, not raw markdown syntax", (t) => {
	const f = fixture(t, { rows: 40 });
	const message = assistant("**Native heading**\n\n```js\nconst answer = 42;\n```\n\nA *formatted* conclusion.");
	f.append(message);
	const text = f.text();
	const native = new AssistantMessageComponent(message, true, getMarkdownTheme(), "Thinking…", f.session.settingsManager.getOutputPad());
	const nativeLines = native.render(80);
	for (const line of nativeLines.map((line) => plain(line).trim()).filter(Boolean)) assert.ok(text.includes(line), line);
	const codeLine = nativeLines.find((line) => plain(line).includes("const answer = 42;"));
	assert.ok(f.lines().includes(codeLine), "code highlighting must match the live native renderer (no stored ANSI snapshot)");
	assert.match(text, /Native heading/);
	assert.match(text, /const answer = 42;/);
	assert.doesNotMatch(text, /\*\*Native|\*formatted\*/); // Native Pi intentionally displays styled code fences.
	fits(f, 80);
});

test("thinking and tool expansion expose full results, including a tail beyond 500 characters", (t) => {
	const f = fixture(t);
	f.append(assistant([{ type: "thinking", thinking: "PRIVATE_THOUGHT" }, ...textContent("Visible reply"), toolCall()], { stopReason: "toolUse" }));
	const output = Array.from({ length: 32 }, (_, i) => `output-${i}: ${"x".repeat(48)}`).join("\n") + "\nFULL_RESULT_TAIL";
	assert.ok(output.indexOf("FULL_RESULT_TAIL") > 500);
	f.append(toolResult(output));
	assert.doesNotMatch(pageThrough(f), /PRIVATE_THOUGHT|FULL_RESULT_TAIL/);
	f.input(key.thinking);
	assert.equal(f.agent.view.hideThinking, false);
	assert.match(pageThrough(f), /PRIVATE_THOUGHT/);
	f.input(key.tools);
	assert.equal(f.agent.view.expanded, true);
	assert.match(pageThrough(f), /FULL_RESULT_TAIL/);
	f.input(key.tools);
	f.input(key.thinking);
	assert.doesNotMatch(pageThrough(f), /PRIVATE_THOUGHT|FULL_RESULT_TAIL/);
});

test("raw branch history remains readable after model context compaction", (t) => {
	const f = fixture(t);
	f.append({ role: "user", content: "PRE_COMPACTION_USER", timestamp: 0 });
	f.append(assistant("PRE_COMPACTION_ASSISTANT"));
	const kept = f.append({ role: "user", content: "KEPT_USER", timestamp: 1 });
	f.manager.appendCompaction("COMPACTION_SUMMARY", kept, 12_345);
	f.append(assistant("POST_COMPACTION_REPLY"));
	assert.doesNotMatch(JSON.stringify(f.session.messages), /PRE_COMPACTION/);
	f.input(key.tools);
	const history = pageThrough(f);
	for (const marker of ["PRE_COMPACTION_USER", "PRE_COMPACTION_ASSISTANT", "KEPT_USER", "COMPACTION_SUMMARY", "POST_COMPACTION_REPLY"]) {
		assert.ok(history.includes(marker), marker);
	}
});

test("failed and empty children show a diagnostic rather than a blank transcript", (t) => {
	const f = fixture(t);
	f.agent.status = "failed";
	assert.match(f.text(), /Child failed\./);
	f.append(assistant([], { stopReason: "error", errorMessage: "Provider refused the request" }));
	assert.match(f.text(), /Error: Provider refused the request/);
	f.event({ type: "compaction_start", reason: "manual" });
	assert.match(f.text(), /Compacting context/);
	f.event({ type: "compaction_end", reason: "manual", aborted: false, willRetry: false, result: undefined, errorMessage: "summary unavailable" });
	assert.equal(f.agent.view.activity, undefined);
	assert.match(f.text(), /Compaction failed: summary unavailable/);
});

test("streamed tool arguments, partial results, queues, and retry activity stay live", (t) => {
	const f = fixture(t, { rows: 32 });
	f.session.state.streamingMessage = assistant([toolCall("call", { path: "par" })]);
	f.event({ type: "tool_execution_start", toolCallId: "call", toolName: "inspect_data", args: { path: "par" } });
	assert.match(f.text(), /par/);
	f.session.state.streamingMessage = assistant([toolCall("call", { path: "complete-path" })]);
	f.event({ type: "tool_execution_update", toolCallId: "call", toolName: "inspect_data", args: { path: "complete-path" }, partialResult: { content: textContent("PARTIAL_RESULT") } });
	assert.match(f.text(), /complete-path/);
	assert.match(f.text(), /PARTIAL_RESULT/);
	f.event({ type: "queue_update", steering: ["one", "two"], followUp: ["three"] });
	assert.match(f.text(), /3 queued message\(s\)/);
	f.event({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 1000, errorMessage: "rate limit" });
	assert.match(f.text(), /Retry 1\/3: rate limit/);
	f.event({ type: "auto_retry_end", success: true, attempt: 1 });
	assert.equal(f.agent.view.activity, undefined);
	f.append(assistant([toolCall("call", { path: "complete-path" })], { stopReason: "toolUse" }));
	f.session.state.streamingMessage = undefined;
	f.append(toolResult("FINAL_RESULT"));
	f.event({ type: "tool_execution_end", toolCallId: "call", toolName: "inspect_data", result: { content: textContent("FINAL_RESULT") }, isError: false, durationMs: 3 });
	assert.match(f.text(), /FINAL_RESULT/);
	assert.doesNotMatch(f.text(), /PARTIAL_RESULT/);
	f.event({ type: "queue_update", steering: [], followUp: [] });
	assert.doesNotMatch(f.text(), /queued message/);
});

for (const chunked of [false, true]) {
	test(`multiline bracketed paste (${chunked ? "split chunks" : "one chunk"}) and Ctrl-J never submit early`, async (t) => {
		const f = fixture(t);
		if (chunked) for (const chunk of ["\x1b[200~first", "\nsecond", "\n", "third\x1b[201~"]) f.input(chunk);
		else f.input(paste("first\nsecond\nthird"));
		f.input(key.newline);
		f.input("fourth");
		assert.equal(f.agent.view.draft, "first\nsecond\nthird\nfourth");
		assert.equal(f.actions.send.mock.callCount(), 0);
		fits(f, 40);
		f.input(key.enter);
		await flush();
		assert.equal(f.actions.send.mock.calls[0].arguments[0], "first\nsecond\nthird\nfourth");
		assert.equal(f.agent.view.draft, "");
	});
}

test("a question arriving during a chunked paste does not steal or strand the message draft", async (t) => {
	const f = fixture(t);
	f.input("\x1b[200~first");
	f.agent.pending = question();
	f.text();
	f.input("\nsecond\x1b[20");
	f.text();
	f.input("1~");
	f.text();
	assert.equal(f.agent.view.draft, "first\nsecond");
	assert.equal(f.agent.view.question.request, f.agent.pending);
	f.agent.pending = undefined;
	f.text();
	f.input(key.enter);
	await flush();
	assert.equal(f.actions.send.mock.calls[0].arguments[0], "first\nsecond");
	assert.equal(f.agent.view.draft, "");
});

for (const phase of ["comment", "custom"]) {
	test(`main draft and ${phase} survive question transitions and closing/reopening`, (t) => {
		const f = fixture(t);
		f.input(paste("main draft\nsecond line"));
		f.agent.pending = question();
		assert.doesNotMatch(f.text(), /main draft/);
		if (phase === "custom") { f.input(key.up); f.input(key.enter); }
		else f.input(key.tab);
		f.input(paste("question draft\nwith details"));
		f.close();
		assert.equal(f.listeners.size, 0);
		f.open();
		assert.equal(f.listeners.size, 1);
		assert.match(f.text(), /question draft/);
		assert.equal(f.agent.view.draft, "main draft\nsecond line");
		f.input(key.escape);
		assert.equal(f.agent.view.question.phase, "choices");
		f.input(phase === "custom" ? key.enter : key.tab);
		assert.match(f.text(), /with details/);
		f.input(key.enter);
		const answer = f.actions.answer.mock.calls[0].arguments[0];
		if (phase === "custom") assert.deepEqual(answer, { answer: "question draft\nwith details", wasCustom: true });
		else assert.deepEqual(answer, { answer: "Keep", selectedIndex: 1, comment: "question draft\nwith details" });
		assert.match(f.text(), /main draft/);
		assert.match(f.text(), /second line/);
		f.close();
		f.open();
		assert.match(f.text(), /main draft/);
		assert.equal(f.actions.send.mock.callCount(), 0);
	});
}

test("question disappearing without an answer restores the main draft", (t) => {
	const f = fixture(t);
	f.input("unfinished guidance");
	f.agent.pending = question();
	f.text();
	f.input(key.tab);
	f.input("unfinished comment");
	f.agent.pending = undefined;
	assert.match(f.text(), /unfinished guidance/);
	assert.doesNotMatch(f.text(), /unfinished comment/);
	assert.equal(f.agent.view.question, undefined);
});

test("async send failure keeps the original multiline draft and exposes the error", async (t) => {
	const pending = Promise.withResolvers();
	const f = fixture(t, { rows: 12, send: () => pending.promise });
	const lines = Array.from({ length: 12 }, (_, i) => `  keep indentation ${i}  `);
	const draft = lines.join("\n");
	for (const [i, line] of lines.entries()) { if (i) f.input(key.newline); f.input(line); }
	f.input(key.enter);
	assert.match(f.text(40), /Sending/);
	pending.reject(new Error("offline send rejected"));
	await flush();
	assert.equal(f.agent.view.draft, draft);
	assert.match(fits(f, 40), /Send failed: offline send rejected/);
});

test("editing while a send is pending survives completion, and duplicate submission is suppressed", async (t) => {
	const pending = Promise.withResolvers();
	const f = fixture(t, { send: () => pending.promise });
	f.input("first message");
	f.input(key.enter);
	f.input(key.enter);
	assert.equal(f.actions.send.mock.callCount(), 1);
	f.input(key.newline);
	f.input("new edits");
	pending.resolve("queued");
	await flush();
	assert.equal(f.agent.view.draft, "first message\nnew edits");
	assert.match(f.text(), /new edits/);
	assert.match(f.text(), /Guidance accepted/);
});

for (const result of ["queued", "handled", "started"]) {
	test(`successful ${result} send clears only its unchanged draft`, async (t) => {
		const f = fixture(t, { send: async () => result });
		f.input("hello child");
		f.input(key.enter);
		await flush();
		assert.equal(f.agent.view.draft, "");
		assert.doesNotMatch(f.text(), /hello child/);
		if (result !== "started") assert.match(f.text(), result === "queued" ? /Guidance accepted/ : /handled by child extension/);
	});
}

test("oversize questions, labels, and multiline comments fit small terminals with a visible editor cursor", (t) => {
	const f = fixture(t, { rows: 12 });
	f.agent.name = "child 界".repeat(30);
	f.agent.profile = "profile\nwith\ttabs";
	f.agent.pending = question({ question: "**Long question**\n\n" + "why 界? ".repeat(150),
		options: Array.from({ length: 9 }, (_, i) => ({ label: `${i} ${"long 界 label ".repeat(20)}`, description: "tradeoff ".repeat(100) })) });
	for (const width of [40, 24]) fits(f, width, false);
	for (let i = 0; i < 8; i++) f.input(key.down);
	fits(f, 40, false);
	f.input(key.tab);
	// Type real editor lines: a large native paste folds into a single placeholder.
	for (let i = 0; i < 30; i++) { f.input(`line ${i} ${"界x".repeat(30)}`); f.input(key.newline); }
	f.input("VISIBLE_CURSOR_TAIL");
	for (const rows of [12, 8, 4]) {
		f.tui.terminal.rows = rows;
		for (const width of [40, 24]) assert.match(fits(f, width), /VISIBLE_CURSOR_TAIL/);
	}
	f.tui.terminal.rows = 12;
	f.input(key.escape);
	fits(f, 40, false);
	f.input(key.tab);
	assert.match(fits(f, 40), /VISIBLE_CURSOR_TAIL/);
});

test("paging exposes the full question and the selected option's complete description", (t) => {
	const f = fixture(t, { rows: 12 });
	f.agent.pending = question({ question: "QUESTION_START\n\n" + "question text ".repeat(90) + "QUESTION_END",
		options: [{ label: "First", description: "UNSELECTED_DESCRIPTION" },
			{ label: "Second", description: "DESCRIPTION_START " + "selected tradeoff ".repeat(100) + "DESCRIPTION_END" }] });
	f.text(40);
	f.input(key.down);
	const pages = pageThrough(f, 40);
	for (const marker of ["QUESTION_START", "QUESTION_END", "DESCRIPTION_START", "DESCRIPTION_END"]) assert.ok(pages.includes(marker), marker);
	assert.doesNotMatch(pages, /UNSELECTED_DESCRIPTION/);
	f.input(key.enter);
	assert.deepEqual(f.actions.answer.mock.calls[0].arguments[0], { answer: "Second", selectedIndex: 2 });
});

test("history scroll holds on append and reopen, then bottom resumes following", (t) => {
	const f = fixture(t);
	f.append(assistant(Array.from({ length: 80 }, (_, i) => `history-line-${i}`).join("\n")));
	assert.match(f.text(), /history-line-79/);
	f.input(key.pageUp);
	f.text();
	const top = f.agent.view.scrollTop;
	assert.equal(f.agent.view.following, false);
	f.append(assistant("APPENDED_WHILE_READING"));
	assert.doesNotMatch(f.text(), /APPENDED_WHILE_READING/);
	assert.equal(f.agent.view.scrollTop, top);
	f.close();
	f.open();
	assert.doesNotMatch(f.text(), /APPENDED_WHILE_READING/);
	assert.equal(f.agent.view.scrollTop, top);
	f.input(key.bottom);
	assert.match(f.text(), /APPENDED_WHILE_READING/);
	assert.equal(f.agent.view.following, true);
	f.append(assistant("LIVE_APPEND"));
	assert.match(f.text(), /LIVE_APPEND/);
});

test("injected remapped keys drive editor, question selection, expansion, and application actions", async (t) => {
	const f = fixture(t, { bindings: {
		"app.interrupt": "f2", "app.clear": "f3", "app.tools.expand": "f4", "app.thinking.toggle": "f5",
		"tui.input.submit": "f6", "tui.input.newLine": "f7", "tui.select.down": "f9", "tui.select.confirm": "f10", "tui.input.tab": "f11",
		"tui.select.pageUp": "f12", "tui.altScreen.bottom": "alt+b",
	} });
	assert.match(f.text(), /f6 send/);
	f.input("one");
	f.input("\x1b[18~");
	f.input("two");
	f.input(key.enter);
	assert.equal(f.actions.send.mock.callCount(), 0);
	f.input("\x1b[17~");
	await flush();
	assert.equal(f.actions.send.mock.calls[0].arguments[0], "one\ntwo");
	f.append(assistant(Array.from({ length: 40 }, (_, i) => `remapped-scroll-${i}`).join("\n")));
	f.text();
	f.input(key.pageUp);
	assert.equal(f.agent.view.following, true);
	f.input("\x1b[24~");
	assert.equal(f.agent.view.following, false);
	f.input("\x1bb");
	assert.match(f.text(), /remapped-scroll-39/);
	assert.equal(f.agent.view.following, true);
	f.input(key.tools);
	assert.equal(f.agent.view.expanded, false);
	f.input("\x1bOS");
	f.input("\x1b[15~");
	assert.equal(f.agent.view.expanded, true);
	assert.equal(f.agent.view.hideThinking, false);
	f.agent.pending = question();
	f.text();
	f.input(key.down);
	assert.equal(f.agent.view.question.selected, 0);
	f.input("\x1b[20~");
	f.input("\x1b[23~");
	f.input("comment");
	f.input("\x1b[17~");
	assert.deepEqual(f.actions.answer.mock.calls[0].arguments[0], { answer: "Replace", selectedIndex: 2, comment: "comment" });
	f.agent.pending = question();
	f.input("\x1b[21~");
	assert.equal(f.actions.answer.mock.callCount(), 2);
	f.input(key.escape);
	assert.equal(f.done.mock.callCount(), 0);
	f.input("\x1bOQ");
	assert.equal(f.done.mock.callCount(), 1);
	f.input("\x1bOR");
	await flush();
	assert.equal(f.actions.abort.mock.callCount(), 1);
});

test("disposal removes redraw listeners and ignores late subscription/send completion renders", async (t) => {
	const pending = Promise.withResolvers();
	const f = fixture(t, { send: () => pending.promise });
	assert.equal(f.listeners.size, 1);
	const lateListener = [...f.listeners][0];
	f.notify();
	assert.equal(f.tui.requestRender.mock.callCount(), 1);
	f.input("pending guidance");
	f.input(key.enter);
	f.close();
	assert.equal(f.listeners.size, 0);
	const renders = f.tui.requestRender.mock.callCount();
	lateListener();
	f.notify();
	pending.resolve("started");
	await flush();
	assert.equal(f.tui.requestRender.mock.callCount(), renders);
});

test("persisted tool results remain authoritative over execution-event previews", (t) => {
	const f = fixture(t);
	f.append(assistant([toolCall()], { stopReason: "toolUse" }));
	f.event({ type: "tool_execution_end", toolCallId: "call", toolName: "inspect_data",
		result: { content: textContent("UNREDACTED_PREVIEW") }, isError: false, durationMs: 10 });
	f.append(toolResult("REDACTED_FINAL"));
	assert.match(f.text(), /REDACTED_FINAL/);
	assert.doesNotMatch(f.text(), /UNREDACTED_PREVIEW/);
});

test("orphan tool results remain visible in chronological order across redraws", (t) => {
	const f = fixture(t, { rows: 40 });
	f.append(toolResult("ORPHAN_RESULT"));
	f.append(assistant("LATER_REPLY"));
	for (let i = 0; i < 3; i++) {
		const text = f.text();
		assert.match(text, /ORPHAN_RESULT/);
		assert.ok(text.indexOf("ORPHAN_RESULT") < text.indexOf("LATER_REPLY"));
	}
});

for (const Renderer of [TuiMainScreen, TuiAltScreen]) {
	test(`${Renderer.name} composites the child overlay, preserves focus, and handles resize`, async (t) => {
		const f = fixture(t);
		f.close();
		f.append(assistant("**NATIVE_CHILD_CONTENT**"));
		const terminal = {
			columns: 80, rows: 24, kittyProtocolActive: false,
			start(onInput) { this.input = onInput; }, stop() {}, async drainInput() {}, write() {}, moveBy() {}, hideCursor() {}, showCursor() {},
			clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {}, setProgramStatus() {},
		};
		const tui = new Renderer(terminal, false, here);
		const component = createAgentView(f.agent, f.actions, tui, theme, f.keys, () => {});
		t.after(() => { component.dispose(); tui.stop(); });
		tui.addChild(new Text("PARENT_UNDERLAY_SENTINEL"));
		tui.showOverlay(component, { width: "100%", maxHeight: "100%", anchor: "top-left" });
		tui.start();
		const settle = () => new Promise((resolve) => setTimeout(resolve, 40));
		const screen = () => Renderer === TuiAltScreen ? tui.getScreenLines() : tui.captureRenderState().previousLines;
		await settle();
		assert.equal(tui.getFocusedComponent(), component);
		assert.equal(component.focused, true);
		assert.match(plain(screen().join("\n")), /NATIVE_CHILD_CONTENT/);
		assert.doesNotMatch(plain(screen().join("\n")), /PARENT_UNDERLAY_SENTINEL/);
		assert.ok(screen().every((line) => visibleWidth(line) <= 80));
		terminal.columns = 40;
		terminal.rows = 12;
		tui.requestRender(true);
		await settle();
		assert.equal(tui.getFocusedComponent(), component);
		assert.equal(screen().length, 12);
		assert.ok(screen().every((line) => visibleWidth(line) <= 40));
		f.append(assistant(Array.from({ length: 40 }, (_, index) => `native-input-history-${index}`).join("\n")));
		tui.requestRender();
		await settle();
		terminal.input(key.pageUp);
		await settle();
		assert.equal(f.agent.view.following, false);
		terminal.input(key.bottom);
		await settle();
		assert.equal(f.agent.view.following, true);
		terminal.input(paste("resized draft"));
		await settle();
		assert.equal(f.agent.view.draft, "resized draft");
		assert.match(plain(screen().join("\n")), /resized draft/);
	});
}

test("disposed views reject late keyboard and mouse actions", (t) => {
	const f = fixture(t);
	f.input("unsent");
	f.close();
	f.input(key.enter);
	f.input("\x03");
	assert.equal(f.actions.send.mock.callCount(), 0);
	assert.equal(f.actions.abort.mock.callCount(), 0);
	assert.equal(f.component.handleMouse({ type: "wheel", wheelDelta: 2 }), undefined);
});

test("wheel events scroll the active viewport and are consumed even at its boundaries", (t) => {
	const f = fixture(t);
	f.append(assistant(Array.from({ length: 50 }, (_, i) => `wheel-line-${i}`).join("\n")));
	f.text();
	const wheel = (wheelDelta) => f.component.handleMouse({ type: "wheel", button: "none", x: 0, y: 0,
		screenX: 0, screenY: 0, width: 80, height: 24, shift: false, alt: false, ctrl: false, wheelDelta });
	const bottom = f.agent.view.scrollTop;
	assert.equal(wheel(-3)?.handled, true);
	assert.equal(f.agent.view.scrollTop, bottom - 3);
	assert.equal(f.agent.view.following, false);
	for (const delta of [-10_000, -3, 10_000, 3, 0]) assert.equal(wheel(delta)?.handled, true);
	assert.equal(f.agent.view.following, true);
	f.agent.pending = question({ question: "Question ".repeat(200) + "WHEEL_QUESTION_TAIL" });
	const first = f.text();
	const transcriptTop = f.agent.view.scrollTop;
	assert.equal(wheel(10_000)?.handled, true);
	assert.notEqual(f.text(), first);
	assert.match(f.text(), /WHEEL_QUESTION_TAIL/);
	assert.equal(f.agent.view.scrollTop, transcriptTop, "question wheel must not move transcript history");
	assert.equal(wheel(3)?.handled, true);
});
