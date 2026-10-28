import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters as plain } from "node:util";

const here = dirname(fileURLToPath(import.meta.url));
const packageFile = process.env.PI_PACKAGE_DIR ? join(process.env.PI_PACKAGE_DIR, "package.json") : import.meta.url;
const { createJiti } = createRequire(packageFile)("jiti");
const resolver = createJiti(packageFile, { fsCache: false });
const jiti = createJiti(import.meta.url, {
	fsCache: false, moduleCache: false,
	alias: Object.fromEntries([
		"@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox",
	].map((name) => [name, fileURLToPath(resolver.esmResolve(name === "@earendil-works/pi-ai" ? `${name}/compat` : name))])),
});
const runtime = dirname(fileURLToPath(resolver.esmResolve("@earendil-works/pi-coding-agent")));
const { default: factory } = await jiti.import(join(here, "../extensions/workon.ts"));
const { CONFIG_DIR_NAME, SessionManager, AgentSession, convertToLlm } = await jiti.import("@earendil-works/pi-coding-agent");
const { ExtensionRunner } = await jiti.import(join(runtime, "core/extensions/runner.js"));
const { prepareCompaction } = await jiti.import(join(runtime, "core/compaction/compaction.js"));
const { createAssistantMessageEventStream } = await jiti.import("@earendil-works/pi-ai");
const { parse } = createRequire(import.meta.url)("yaml");
const models = [
	{ provider: "test", id: "zeta", name: "Zeta" },
	{ provider: "test", id: "alpha", name: "Alpha" },
].map((model) => ({ ...model, api: "openai-completions", reasoning: false, input: ["text"],
	contextWindow: 128000, maxTokens: 1024,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }));
const step = (command = "/zeta $TASK", thinkingLevel = "medium") => ({
	command, provider: "test", model: "zeta", thinkingLevel,
});
const user = (content) => ({ role: "user", content, timestamp: Date.now() });
const assistant = (stopReason = "stop", text = "done") => ({
	role: "assistant", content: [{ type: "text", text }], api: "test", provider: "test", model: "zeta",
	stopReason, timestamp: Date.now(),
	usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
});

function fixture(t) {
	const cwd = mkdtempSync(join(here, ".workon-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	const configDir = join(cwd, CONFIG_DIR_NAME);
	mkdirSync(configDir);
	const handlers = new Map();
	const actions = [], editors = [], inputs = [], screens = [], editorCalls = [];
	const notifications = [], sent = [], statuses = [];
	let command;
	const summaryRequests = [];
	let summaryStopReason = "stop";
	const ctx = {
		cwd, mode: "tui", scopedModels: [], model: models[0], thinkingLevel: "off",
		sessionManager: SessionManager.inMemory(cwd),
		isProjectTrusted: () => true, isIdle: () => true, abort: t.mock.fn(),
		modelRegistry: {
			find: (provider, id) => models.find((model) => model.provider === provider && model.id === id),
			getAvailable: () => models,
			streamSimple(model, context) {
				summaryRequests.push({ model, context });
				const stream = createAssistantMessageEventStream();
				const message = { ...assistant(summaryStopReason, `Scoped checkpoint ${summaryRequests.length}`), api: model.api };
				stream.push(summaryStopReason === "error" || summaryStopReason === "aborted"
					? { type: "error", reason: summaryStopReason, error: message }
					: { type: "done", reason: summaryStopReason, message });
				stream.end();
				return stream;
			},
		},
		ui: {
			notify: (message, level) => notifications.push({ message, level }),
			setStatus: (key, value) => statuses.push({ key, value }),
			confirm: async () => true,
			input: async () => inputs.shift(),
			editor: async (title, initial) => {
				editorCalls.push({ title, initial });
				return editors.length ? editors.shift() : initial;
			},
			custom: async (build) => {
				let result, completed = false;
				const component = build({ requestRender() {} }, {
					fg: (_color, text) => text, bold: (text) => text,
				}, {}, (value) => { result = value; completed = true; });
				const screen = {
					component,
					text: () => plain(component.render(140).join("\n")),
					selected: () => plain(component.render(140).join("\n")).split("\n").find((line) => line.startsWith("→ ")),
				};
				screens.push(screen);
				assert.ok(actions.length, `unexpected picker: ${screen.text()}`);
				const action = actions.shift();
				if (typeof action === "function") action(screen);
				else if (action === undefined) component.handleInput("\x1b");
				else {
					if (action) component.handleInput(action);
					component.handleInput("\r");
				}
				assert.ok(completed, `picker did not finish: ${screen.text()}`);
				return result;
			},
		},
	};
	const setModel = t.mock.fn(async () => true);
	factory({
		on: (name, handler) => handlers.set(name, handler),
		registerCommand: (name, value) => { assert.equal(name, "flow"); command = value; },
		getCommands: () => [
			{ name: "zeta", source: "prompt" }, { name: "alpha", source: "skill" },
			{ name: "flow", source: "extension" },
		],
		setModel, setThinkingLevel: t.mock.fn(),
		sendUserMessage: (text, options) => sent.push({ text, options }),
	});
	const emit = (name, event = {}) => handlers.get(name)?.(event, ctx);
	const runner = Object.assign(Object.create(ExtensionRunner.prototype), {
		extensions: [{ path: "workon.ts", handlers: new Map([...handlers].map(([name, fn]) => [name, [fn]])) }],
		createContext: () => ctx,
		emitError: (error) => assert.fail(JSON.stringify(error)),
	});
	const path = (name) => join(configDir, `flow_${name}.yaml`);
	const save = (name, steps) => writeFileSync(path(name), JSON.stringify({ steps }));
	const begin = (prompt = "expanded step prompt") => emit("before_agent_start", { messageType: "user", prompt }).message;
	const settle = async (reason = "stop", aborted = false) => {
		if (reason) emit("message_end", { message: assistant(reason) });
		await emit("agent_settled", { aborted });
	};
	return { ctx, actions, editors, inputs, screens, editorCalls, notifications, sent, statuses, setModel,
		summaryRequests, failSummary: (reason) => { summaryStopReason = reason; },
		emit, runner, path, save, begin, settle, run: (args) => command.handler(args, ctx) };
}

for (const reason of ["stop", "toolUse", undefined]) {
	test(`aborted settlement overrides ${reason ?? "missing"} assistant stop reason`, async (t) => {
		const f = fixture(t);
		f.save("demo", [step(), step("/alpha $TASK")]);
		await f.run("demo task");
		f.begin();
		await f.settle(reason === undefined ? null : reason, true);
		assert.equal(f.sent.length, 1);
		assert.match(f.notifications.at(-1).message, /step 1: aborted/);
		assert.equal(f.statuses.at(-1).value, undefined);
		await f.emit("agent_settled", { aborted: false });
		assert.equal(f.sent.length, 1);
	});
}

for (const reason of ["aborted", "error", "length", null]) {
	test(`abnormal settlement ${reason ?? "without response"} does not advance`, async (t) => {
		const f = fixture(t);
		f.save("demo", [step(), step()]);
		await f.run("demo task");
		await f.settle(reason);
		assert.equal(f.sent.length, 1);
		assert.match(f.notifications.at(-1).message, /flow stopped after step 1/);
	});
}

test("successful settlement advances once, completes, and restores unfiltered context", async (t) => {
	const f = fixture(t);
	f.save("demo", [step(), step("/alpha $TASK")]);
	await f.run("demo task");
	const first = f.begin();
	await f.settle();
	assert.equal(f.sent[1].text, "/alpha task");
	const second = f.begin();
	assert.equal(second.details.step, 2);
	const messages = [user("history"), { role: "custom", ...first }, assistant(), { role: "custom", ...second }, assistant()];
	assert.deepEqual(f.emit("context", { messages }).messages, messages.slice(3));
	await f.settle();
	assert.equal(f.notifications.at(-1).message, "flow complete");
	assert.equal(f.emit("context", { messages }), undefined);
	assert.equal(await f.emit("session_before_compact"), undefined);
});

test("aborting the final step cannot report completion", async (t) => {
	const f = fixture(t);
	f.save("demo", [step()]);
	await f.run("demo task");
	await f.settle("stop", true);
	assert.match(f.notifications.at(-1).message, /aborted/);
	assert.ok(!f.notifications.some(({ message }) => message === "flow complete"));
});

test("task placeholders expand literally, including all replacement-string metacharacters", async (t) => {
	const f = fixture(t);
	f.save("demo", [step("/zeta before=$TASK after=$TASK")]);
	const task = "$$ $& $` $' $1 $<name> $TASK\nsecond line";
	await f.run(`demo ${task}`);
	assert.equal(f.sent[0].text, `/zeta before=${task} after=${task}`);
	assert.deepEqual(f.sent[0].options, { expandPromptTemplates: true });
});

test("context isolation is active-only, matches both generation and step, and fails closed", async (t) => {
	const f = fixture(t);
	const old = { role: "custom", customType: "flow-step", content: "old", details: { generation: 1, step: 1 } };
	assert.equal(f.emit("context", { messages: [old, user("normal prompt")] }), undefined);
	f.save("demo", [step(), step()]);
	await f.run("demo task");
	assert.deepEqual(f.emit("context", { messages: [old] }), { messages: [] }, "pending boundary is not an old matching marker");
	assert.equal(f.emit("before_agent_start", { messageType: "custom", message: old }), undefined);
	const marker = { role: "custom", ...f.begin() };
	const messages = [old, user("earlier history"), marker, assistant(), user("follow-up")];
	assert.deepEqual(f.emit("context", { messages }).messages, messages.slice(2));
	for (const details of [undefined, null, {}, [], { generation: 99, step: 1 }, { generation: 1, step: 2 }]) {
		assert.deepEqual(f.emit("context", { messages: [{ ...marker, details }, user("untrusted tail")] }), { messages: [] });
	}
	await f.settle();
	f.begin();
	assert.deepEqual(f.emit("context", { messages }), { messages: [] }, "previous step is not a fallback");
	await f.run("abort");
	assert.equal(f.ctx.abort.mock.callCount(), 1);
	assert.equal(f.emit("context", { messages }), undefined);
	await f.run("demo another task");
	f.begin();
	assert.deepEqual(f.emit("context", { messages }), { messages: [] }, "previous run is not a fallback");
});

for (const reason of ["manual", "threshold", "overflow"]) {
	test(`compaction hook defers ${reason} while the next step lacks a boundary`, async (t) => {
		const f = fixture(t);
		assert.equal(await f.emit("session_before_compact", { reason }), undefined);
		f.save("demo", [step()]);
		await f.run("demo task");
		assert.deepEqual(await f.emit("session_before_compact", { reason }), { cancel: true });
		await f.run("abort");
		assert.equal(await f.emit("session_before_compact", { reason }), undefined);
	});
}

function compactionHost(f, settings) {
	const events = [], failures = [];
	const host = Object.assign(Object.create(AgentSession.prototype), {
		agent: { state: { model: models[0] }, hasQueuedMessages: () => false }, sessionManager: f.ctx.sessionManager,
		settingsManager: { getCompactionSettings: () => settings },
		_extensionRunner: { hasHandlers: (name) => name === "session_before_compact", emit: (event) => f.emit(event.type, event) },
		_emit: (event) => events.push(event), _emitSessionCompactFailed: async (event) => failures.push(event),
		_resolveIdleWaitIfIdle() {}, _refreshFinalizedContext() {},
		_runDefaultCompaction: () => assert.fail("must not send previous steps to a summarizer"),
	});
	return { host, events, failures };
}

for (const reason of ["threshold", "overflow"]) {
	test(`Pi's actual ${reason} compaction summarizes only the active step, including repeated checkpoints`, async (t) => {
		const f = fixture(t);
		f.save("demo", [step(), step()]);
		await f.run("demo task");
		const manager = f.ctx.sessionManager;
		manager.appendMessage(user("PRIVATE previous conversation ".repeat(100)));
		const first = f.begin("PRIVATE first step");
		manager.appendCustomMessageEntry(first.customType, first.content, false, first.details);
		manager.appendMessage(assistant("stop", "PRIVATE first result ".repeat(100)));
		await f.settle();
		const second = f.begin("active step prompt");
		manager.appendCustomMessageEntry(second.customType, second.content, false, second.details);
		manager.appendMessage(assistant("stop", "active result ".repeat(100)));
		const settings = { enabled: true, reserveTokens: 10, keepRecentTokens: 20 };
		const preparation = prepareCompaction(manager.getBranch(), settings);
		assert.match(JSON.stringify(preparation.messagesToSummarize), /PRIVATE/);
		const before = await f.runner.emitContext(manager.buildSessionProjection().messages);
		assert.equal(before[0].customType, "flow-step");
		assert.doesNotMatch(JSON.stringify(convertToLlm(before)), /PRIVATE/);
		const { host, events, failures } = compactionHost(f, settings);
		const entriesBefore = manager.getEntries().length;
		assert.equal(await host._runAutoCompaction(reason, reason === "overflow"), reason === "overflow");
		assert.equal(events.at(-1).aborted, false);
		assert.equal(failures.length, 0);
		assert.equal(manager.getEntries().length, entriesBefore + 1);
		assert.equal(f.summaryRequests.length, 1);
		assert.match(JSON.stringify(f.summaryRequests), /active step prompt/);
		assert.doesNotMatch(JSON.stringify(f.summaryRequests), /PRIVATE/);
		const compacted = manager.buildSessionProjection().messages;
		assert.ok(!compacted.some((message) => message.role === "custom" && message.details?.step === 2));
		const after = await f.runner.emitContext(compacted);
		assert.equal(after[0].role, "compactionSummary");
		assert.equal(after[0].summary, "Scoped checkpoint 1");
		assert.doesNotMatch(JSON.stringify(convertToLlm(after)), /PRIVATE/);
		assert.deepEqual(manager.getBranch().at(-1).details.flowStep, { generation: 1, step: 2 });
		assert.equal(manager.getBranch().at(-1).usage.totalTokens, 2);

		manager.appendMessage(user("active follow-up"));
		manager.appendMessage(assistant("stop", "another active result ".repeat(100)));
		await host._runAutoCompaction(reason, reason === "overflow");
		assert.equal(f.summaryRequests.length, 2);
		assert.match(JSON.stringify(f.summaryRequests[1]), /Scoped checkpoint 1/);
		assert.doesNotMatch(JSON.stringify(f.summaryRequests), /PRIVATE/);
		const again = await f.runner.emitContext(manager.buildSessionProjection().messages);
		assert.equal(again[0].summary, "Scoped checkpoint 2");

		// Unscoped checkpoints are never trusted, even when an unrelated extension inserts one.
		const latest = manager.getBranch().at(-1);
		manager.appendCompaction("PRIVATE cross-step summary", latest.firstKeptEntryId, latest.tokensBefore);
		assert.deepEqual(await f.runner.emitContext(manager.buildSessionProjection().messages), []);
		assert.equal(await host._runAutoCompaction(reason, false), false);
		assert.equal(f.summaryRequests.length, 2);
	});
}

test("compaction drops only earlier history without summarizing when the active step still fits", async (t) => {
	const f = fixture(t);
	const manager = f.ctx.sessionManager;
	manager.appendMessage(user("PRIVATE old request ".repeat(1000)));
	manager.appendMessage(assistant("stop", "PRIVATE old reply ".repeat(1000)));
	f.save("demo", [step()]);
	await f.run("demo task");
	const marker = f.begin("short active step");
	const markerId = manager.appendCustomMessageEntry(marker.customType, marker.content, false, marker.details);
	manager.appendMessage(assistant());
	const settings = { enabled: true, reserveTokens: 10, keepRecentTokens: 1000 };
	const { host, events } = compactionHost(f, settings);
	await host._runAutoCompaction("threshold", false);
	assert.equal(events.at(-1).aborted, false);
	assert.equal(f.summaryRequests.length, 0);
	assert.equal(manager.getBranch().at(-1).firstKeptEntryId, markerId);
	const messages = await f.runner.emitContext(manager.buildSessionProjection().messages);
	assert.equal(messages[0].customType, "flow-step");
	assert.doesNotMatch(JSON.stringify(messages), /PRIVATE/);
});

for (const reason of ["length", "error", "aborted"]) {
	test(`failed ${reason} scoped summarization never falls back to canonical history`, async (t) => {
		const f = fixture(t);
		f.save("demo", [step()]);
		await f.run("demo task");
		const manager = f.ctx.sessionManager;
		manager.appendMessage(user("PRIVATE previous history ".repeat(100)));
		const marker = f.begin("active step prompt");
		manager.appendCustomMessageEntry(marker.customType, marker.content, false, marker.details);
		manager.appendMessage(assistant("stop", "active result ".repeat(100)));
		f.failSummary(reason);
		const { host, events } = compactionHost(f, { enabled: true, reserveTokens: 10, keepRecentTokens: 20 });
		assert.equal(await host._runAutoCompaction("overflow", true), false);
		assert.equal(events.at(-1).aborted, true);
		assert.equal(manager.getBranch().at(-1).type, "message");
		assert.doesNotMatch(JSON.stringify(f.summaryRequests), /PRIVATE/);
		assert.match(f.notifications.at(-1).message, /flow compaction failed/);
	});
}

test("editing replaces the chosen command token, preserving arguments and sorted picker defaults", async (t) => {
	const f = fixture(t);
	const args = '\t--flag "$TASK"\nmore arguments';
	f.save("demo", [step(`/zeta${args}`, "high")]);
	f.actions.push("Edit flow: demo", "Edit step 1", (screen) => {
		assert.match(screen.selected(), /\/zeta/);
		screen.component.handleInput("/alpha");
		screen.component.handleInput("\r");
	}, (screen) => {
		assert.match(screen.selected(), /test\/zeta/);
		screen.component.handleInput("\r");
	}, (screen) => {
		assert.match(screen.selected(), /high/);
		screen.component.handleInput("\r");
	}, "Save flow", "Cancel");
	await f.run("setup");
	assert.deepEqual(f.editorCalls, [{ title: "Step command", initial: `/alpha${args}` }]);
	assert.deepEqual(parse(readFileSync(f.path("demo"), "utf8")).steps, [step(`/alpha${args}`, "high")]);
	assert.equal(f.actions.length, 0);
	assert.ok(f.notifications.some(({ message }) => message === "saved flow: demo"));
});

test("a missing picker selection defaults to the first displayed sorted item", async (t) => {
	const f = fixture(t);
	f.inputs.push("new");
	f.actions.push("Create flow", "Add step", (screen) => {
		assert.match(screen.selected(), /\/alpha/);
		assert.doesNotMatch(screen.text(), /\/flow/);
		screen.component.handleInput("\r");
	}, (screen) => {
		assert.match(screen.selected(), /test\/alpha/);
		screen.component.handleInput("\r");
	}, "off", "Save flow", "Cancel");
	await f.run("setup");
	assert.deepEqual(parse(readFileSync(f.path("new"), "utf8")).steps, [{
		command: "/alpha", provider: "test", model: "alpha", thinkingLevel: "off",
	}]);
});

for (const malformed of ["steps: [", "steps: []", "steps:\n - command: /missing"]) {
	test(`malformed flow ${JSON.stringify(malformed)} does not block setup management`, async (t) => {
		const f = fixture(t);
		writeFileSync(f.path("bad"), malformed);
		f.save("good", [step()]);
		f.editors.push("renamed");
		f.inputs.push("new");
		f.actions.push("Edit flow: bad", "Rename flow: bad", "Delete flow: renamed",
			"Create flow", "Add step", "/alpha", "test/alpha", "off", "Save flow",
			"Edit flow: good", "Save flow", "Cancel");
		await f.run("setup");
		assert.ok(f.notifications.some(({ message }) => message.startsWith("could not edit flow:")));
		assert.ok(!f.notifications.some(({ message }) => message.startsWith("flow setup stopped:")));
		assert.equal(existsSync(f.path("bad")), false);
		assert.equal(existsSync(f.path("renamed")), false);
		assert.ok(existsSync(f.path("new")));
		assert.ok(f.notifications.some(({ message }) => message === "saved flow: good"));
		assert.equal(f.actions.length, 0);
	});
}
