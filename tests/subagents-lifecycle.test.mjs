import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
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
const { default: factory } = await jiti.import(join(here, "../extensions/subagents.ts"));
const { AgentSession, ModelRegistry, ModelRuntime, initTheme } = await jiti.import("@earendil-works/pi-coding-agent");
const { createAssistantMessageEventStream } = await jiti.import("@earendil-works/pi-ai");
const runtimeDir = dirname(fileURLToPath(resolver.esmResolve("@earendil-works/pi-coding-agent")));
const { KeybindingsManager } = await jiti.import(join(runtimeDir, "core/keybindings.js"));
const { theme } = await jiti.import(join(runtimeDir, "modes/interactive/theme/theme.js"));
initTheme("dark");
const flush = () => new Promise(setImmediate);
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
async function until(check) {
	for (let i = 0; i < 100; i++) { if (check()) return; await flush(); }
	assert.ok(check(), "condition did not complete");
}
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

async function fixture(t, builtins = []) {
	const dir = await mkdtemp(join(here, ".subagents-test-"));
	const cwd = join(dir, "project");
	const agentDir = join(dir, "agent");
	await mkdir(cwd);
	await mkdir(join(agentDir, "extensions"), { recursive: true });
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const state = { input: async () => {}, before: async () => {}, compact: async () => {}, settled: async () => {} };
	const releases = [];
	const hold = () => { const gate = deferred(); releases.push(gate.resolve); return gate; };
	globalThis.__subagentLifecycleTest = state;
	await writeFile(join(agentDir, "extensions/hooks.ts"), `export default pi => {
		pi.on("input", (...args) => globalThis.__subagentLifecycleTest.input(...args));
		pi.on("before_agent_start", (...args) => globalThis.__subagentLifecycleTest.before(...args));
		pi.on("session_before_compact", (...args) => globalThis.__subagentLifecycleTest.compact(...args));
		pi.on("agent_settled", (...args) => globalThis.__subagentLifecycleTest.settled(...args));
	}`);
	const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false,
		authPath: join(agentDir, "auth.json"), modelsStorePath: join(agentDir, "models-cache.json") });
	const requests = [];
	runtime.registerProvider("offline", {
		api: "openai-completions", apiKey: "offline-test", baseUrl: "http://unused.invalid",
		models: [{ id: "test", name: "Test", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 1024,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
		streamSimple(model, context, options) {
			const stream = createAssistantMessageEventStream();
			const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
				content: [{ type: "text", text: `Offline answer ${requests.length + 1}` }], stopReason: "stop", timestamp: Date.now(), usage };
			let finished = false;
			const finish = (aborted = false) => {
				if (finished) return;
				finished = true;
				options.signal?.removeEventListener("abort", onAbort);
				if (aborted) { message.stopReason = "aborted"; stream.push({ type: "error", reason: "aborted", error: message }); }
				else stream.push({ type: "done", reason: "stop", message });
				stream.end();
			};
			const onAbort = () => finish(true);
			options.signal?.addEventListener("abort", onAbort, { once: true });
			requests.push({ context, finish });
			if (options.signal?.aborted) onAbort();
			return stream;
		},
	});
	t.mock.method(ModelRuntime, "create", async () => runtime);
	let child;
	const bind = AgentSession.prototype.bindExtensions;
	t.mock.method(AgentSession.prototype, "bindExtensions", function (options) { child = this; return bind.call(this, options); });
	const handlers = new Map();
	const commands = new Map();
	const tools = new Map();
	const results = [];
	const screens = [];
	const ctx = { cwd, mode: "tui", model: runtime.getModel("offline", "test"), thinkingLevel: "off",
		modelRegistry: new ModelRegistry(runtime), isProjectTrusted: () => false,
		ui: { setStatus() {}, notify() {}, custom(build) {
			return new Promise((resolve) => {
				const screen = {};
				screen.component = build({ terminal: { rows: 24 }, requestRender() {} }, theme, new KeybindingsManager(), (result) => {
					screen.component?.dispose(); resolve(result);
				});
				screen.component.focused = true;
				screen.input = (text) => screen.component.handleInput(text);
				screen.text = () => plain(screen.component.render(100).join("\n"));
				screens.push(screen);
			});
		} },
	};
	factory({
		on: (name, handler) => handlers.set(name, handler), registerTool: (tool) => tools.set(tool.name, tool),
		registerCommand: (name, command) => commands.set(name, command), getThinkingLevel: () => "off",
		getActiveTools: () => ["read", "delegate", "ask_question", ...builtins],
		getAllTools: () => builtins.map((name) => ({ name })), getCommands: () => [],
		sendMessage: (message) => results.push(message),
	});
	handlers.get("session_start")({}, ctx);
	let shutDown = false;
	const shutdown = async () => { if (!shutDown) { shutDown = true; await handlers.get("session_shutdown")({}, ctx); } };
	t.after(async () => {
		state.input = async () => {};
		state.before = async () => {};
		state.compact = async () => ({ cancel: true });
		state.settled = async () => {};
		for (const release of releases) release();
		for (const request of requests) request.finish();
		await shutdown();
		for (const screen of screens) screen.component.dispose();
		delete globalThis.__subagentLifecycleTest;
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		await rm(dir, { recursive: true, force: true });
	});
	const started = tools.get("delegate").execute("test", { task: "Initial task" }, undefined, undefined, ctx);
	screens[0].input("\r");
	await until(() => screens.length === 2);
	screens[1].input("\r");
	await started;
	return {
		state, requests, results, screens, shutdown, hold, get child() { return child; },
		async open() {
			const count = screens.length;
			void commands.get("agent").handler("Joe", ctx);
			await until(() => screens.length > count);
			return screens.at(-1);
		},
		async blockSettlement() {
			const entered = deferred();
			const release = hold();
			state.settled = async () => { entered.resolve(); await release.promise; };
			requests.at(-1).finish();
			await entered.promise;
			return release.resolve;
		},
		async picker() { void commands.get("agent").handler("", ctx); await flush(); return screens.at(-1); },
		send(screen, text) { screen.input(`\x1b[200~${text}\x1b[201~`); screen.input("\r"); },
	};
}

test("the real child SDK session registers and activates inherited codemode and tool search", async (t) => {
	const f = await fixture(t, ["codemode", "tool_search"]);
	await until(() => f.requests.length === 1);
	assert.ok(f.child.getActiveToolNames().includes("codemode"));
	assert.ok(f.child.getActiveToolNames().includes("tool_search"));
	assert.ok(f.child.getToolDefinition("codemode"));
	assert.ok(f.child.getToolDefinition("tool_search"));
	assert.equal(f.child.getToolDefinition("delegate"), undefined);
});

test("guidance crossing settlement during input starts and publishes a new run, rather than stranding a queue", async (t) => {
	const f = await fixture(t);
	await until(() => f.requests.length === 1);
	const screen = await f.open();
	const entered = deferred();
	const release = deferred();
	f.state.input = async (event) => { if (event.text === "Guidance") { entered.resolve(); await release.promise; } };
	f.send(screen, "Guidance");
	await entered.promise;
	f.requests[0].finish();
	await until(() => f.results.length === 1);
	release.resolve();
	await until(() => f.requests.length === 2);
	assert.equal(f.child.getSteeringMessages().length, 0);
	assert.equal(f.requests[1].context.messages.at(-1).content[0].text, "Guidance");
	f.requests[1].finish();
	await until(() => f.results.length === 2);
	assert.deepEqual(f.results.map((result) => result.details.run), [1, 2]);
});

test("guidance during settlement waits, then publishes its own answer exactly once", async (t) => {
	const f = await fixture(t);
	await until(() => f.requests.length === 1);
	const release = await f.blockSettlement();
	const screen = await f.open();
	f.send(screen, "New guidance");
	await flush();
	assert.equal(f.requests.length, 1);
	assert.deepEqual(f.results, []);
	assert.match(screen.text(), /Sending/);
	assert.match(screen.text(), /New guidance/);
	release();
	await until(() => f.requests.length === 2);
	assert.deepEqual(f.results.map((result) => result.details.run), [1]);
	assert.match(f.results[0].content, /Offline answer 1$/);
	assert.equal(f.child.getSteeringMessages().length, 0);
	assert.equal(f.requests[1].context.messages.at(-1).content[0].text, "New guidance");
	f.requests[1].finish();
	await until(() => f.results.length === 2);
	await flush();
	assert.deepEqual(f.results.map((result) => result.details.run), [1, 2]);
	assert.match(f.results[1].content, /Offline answer 2$/);
	assert.doesNotMatch(screen.text(), /Sending/);
});

for (const action of ["abort", "delete", "shutdown"]) {
	test(`${action} cancels guidance waiting for settlement without starting another run`, async (t) => {
		const f = await fixture(t);
		await until(() => f.requests.length === 1);
		const release = await f.blockSettlement();
		const screen = await f.open();
		f.send(screen, "Waiting guidance");
		await flush();
		assert.match(screen.text(), /Sending/);
		let done;
		if (action === "abort") screen.input("\x03");
		else if (action === "shutdown") done = f.shutdown();
		else {
			const picker = await f.picker();
			picker.input("\x04");
			picker.input("\r");
		}
		release();
		if (done) await done;
		await until(() => /Send failed:/.test(screen.text()));
		assert.match(screen.text(), /Waiting guidance/);
		assert.doesNotMatch(screen.text(), /Sending/);
		assert.equal(f.requests.length, 1);
		assert.deepEqual(f.results.map((result) => result.details.run), action === "abort" ? [1] : []);
		assert.match(screen.text(), action === "abort" ? /Message cancelled/ : /Agent deleted/);
	});
}

test("abort cancels waiting guidance even after the previous result was published, and allows a retry", async (t) => {
	const f = await fixture(t);
	await until(() => f.requests.length === 1);
	f.requests[0].finish();
	await until(() => f.results.length === 1);
	const completed = deferred();
	const release = f.hold();
	const prompt = f.child.prompt.bind(f.child);
	// Hold the owning promise after Pi publishes settlement, while status is done.
	t.mock.method(f.child, "prompt", async (text, options) => {
		await prompt(text, options);
		if (text === "Second task") { completed.resolve(); await release.promise; }
	});
	const screen = await f.open();
	f.send(screen, "Second task");
	await until(() => f.requests.length === 2);
	f.requests[1].finish();
	await completed.promise;
	assert.deepEqual(f.results.map((result) => result.details.run), [1, 2]);
	f.send(screen, "Third task");
	await flush();
	assert.match(screen.text(), /Sending/);
	screen.input("\x03");
	release.resolve();
	await until(() => /Send failed: Message cancelled/.test(screen.text()));
	assert.match(screen.text(), /Third task/);
	assert.equal(f.requests.length, 2);
	assert.deepEqual(f.results.map((result) => result.details.run), [1, 2]);
	screen.input("\r");
	await until(() => f.requests.length === 3);
	assert.equal(f.requests[2].context.messages.at(-1).content[0].text, "Third task");
	f.requests[2].finish();
	await until(() => f.results.length === 3);
	assert.deepEqual(f.results.map((result) => result.details.run), [1, 2, 3]);
	assert.match(f.results[2].content, /Offline answer 3$/);
});

test("guidance handled after settlement publishes a handled result, not the previous answer", async (t) => {
	const f = await fixture(t);
	await until(() => f.requests.length === 1);
	const release = await f.blockSettlement();
	f.state.input = async () => ({ action: "handled" });
	const screen = await f.open();
	f.send(screen, "Handled guidance");
	await flush();
	assert.deepEqual(f.results, []);
	release();
	await until(() => f.results.length === 2);
	await flush();
	assert.equal(f.requests.length, 1);
	assert.deepEqual(f.results.map((result) => result.details.run), [1, 2]);
	assert.match(f.results[0].content, /Offline answer 1$/);
	assert.match(f.results[1].content, /Message handled by child extension\.$/);
	assert.doesNotMatch(screen.text(), /Sending|Handled guidance/);
});

test("guidance rejected before acceptance after settlement surfaces the failure and retains its draft", async (t) => {
	const f = await fixture(t);
	await until(() => f.requests.length === 1);
	const release = await f.blockSettlement();
	t.mock.method(ModelRuntime.prototype, "hasConfiguredAuth", () => false);
	t.mock.method(ModelRuntime.prototype, "checkAuth", async () => undefined);
	const screen = await f.open();
	f.send(screen, "Rejected guidance");
	await flush();
	assert.deepEqual(f.results, []);
	release();
	await until(() => /Send failed:/.test(screen.text()));
	assert.match(screen.text(), /Rejected guidance/);
	assert.doesNotMatch(screen.text(), /Sending/);
	assert.equal(f.requests.length, 1);
	assert.deepEqual(f.results.map((result) => result.details.run), [1, 2]);
	assert.match(f.results[0].content, /Offline answer 1$/);
	assert.match(f.results[1].content, /Child run failed: No API key found/);
});

test("reopening a view serializes waiting submissions through acceptance, then steers the running child", async (t) => {
	const f = await fixture(t);
	await until(() => f.requests.length === 1);
	const release = await f.blockSettlement();
	const entered = deferred();
	const inputRelease = f.hold();
	const secondRelease = f.hold();
	const inputs = [];
	f.state.input = async (event) => {
		inputs.push(event.text);
		if (event.text === "First guidance") { entered.resolve(); await inputRelease.promise; }
		if (event.text === "Second guidance") await secondRelease.promise;
	};
	const first = await f.open();
	f.send(first, "First guidance");
	await flush();
	first.input("\x1b");
	const second = await f.open();
	second.input("\x15"); // deleteToLineStart
	f.send(second, "Second guidance");
	await flush();
	assert.deepEqual(inputs, []);
	assert.deepEqual(f.results, []);
	release();
	await entered.promise;
	await flush();
	assert.deepEqual(inputs, ["First guidance"]);
	assert.equal(f.requests.length, 1);
	inputRelease.resolve();
	await until(() => inputs.length === 2);
	assert.deepEqual(inputs, ["First guidance", "Second guidance"]);
	await until(() => f.requests.length === 2);
	assert.equal(f.requests[1].context.messages.at(-1).content[0].text, "First guidance");
	secondRelease.resolve();
	await until(() => f.child.getSteeringMessages().length === 1);
	f.requests[1].finish();
	await until(() => f.requests.length === 3);
	assert.equal(f.requests[2].context.messages.at(-1).content[0].text, "Second guidance");
	f.requests[2].finish();
	await until(() => f.results.length === 2);
	assert.deepEqual(f.results.map((result) => result.details.run), [1, 2]);
	assert.match(f.results[1].content, /Offline answer 3$/);
});

test("queued and handled guidance do not invent runs or publish old replies", async (t) => {
	const f = await fixture(t);
	await until(() => f.requests.length === 1);
	const screen = await f.open();
	f.send(screen, "Queued guidance");
	await until(() => f.child.getSteeringMessages().length === 1);
	await flush();
	assert.match(screen.text(), /1 queued message/);
	f.state.input = async (event) => event.text === "Handled guidance" ? { action: "handled" } : undefined;
	f.send(screen, "Handled guidance");
	await flush();
	assert.equal(f.child.getSteeringMessages().length, 1);
	f.requests[0].finish();
	await until(() => f.requests.length === 2);
	f.requests[1].finish();
	await until(() => f.results.length === 1);
	assert.equal(f.results[0].details.run, 1);
	f.send(screen, "Handled guidance");
	await until(() => f.results.length === 2);
	assert.equal(f.results[1].details.run, 2);
	assert.equal(f.results[1].content.split("\n\n")[1], "Message handled by child extension.");
});

for (const action of ["abort", "delete", "shutdown"]) {
	test(`${action} cancels compaction before preflight acceptance`, async (t) => {
		const f = await fixture(t);
		await until(() => f.requests.length === 1);
		f.requests[0].finish();
		await until(() => f.results.length === 1);
		const entered = deferred();
		let compactionSignal;
		f.state.compact = async (event) => {
			compactionSignal = event.signal;
			entered.resolve();
			await new Promise((resolve) => event.signal.addEventListener("abort", resolve, { once: true }));
			return { cancel: true };
		};
		f.child.settingsManager.applyOverrides({ compaction: { enabled: true, reserveTokens: 128000, keepRecentTokens: 0 } });
		const screen = await f.open();
		f.send(screen, "Resume with compaction");
		await entered.promise;
		assert.equal(compactionSignal.aborted, false);
		let done;
		if (action === "abort") screen.input("\x03"); // app.clear
		else if (action === "shutdown") done = f.shutdown();
		else {
			const picker = await f.picker();
			picker.input("\x04");
			picker.input("\r");
		}
		await until(() => compactionSignal.aborted);
		if (done) await done;
		else if (action === "abort") await until(() => f.results.length === 2);
		else await until(() => /No matches/.test(f.screens.at(-1).text()));
		assert.equal(f.requests.length, 1, "cancelled preflight must not send another model request");
		assert.equal(f.results.length, action === "abort" ? 2 : 1);
		if (action === "abort") assert.match(f.results[1].content, /Child run aborted/);
	});
}

test("abort before Pi owns the run is re-applied when input finally starts it", async (t) => {
	const f = await fixture(t);
	await until(() => f.requests.length === 1);
	f.requests[0].finish();
	await until(() => f.results.length === 1);
	const entered = deferred();
	const release = deferred();
	f.state.input = async () => { entered.resolve(); await release.promise; };
	const screen = await f.open();
	f.send(screen, "Slow input");
	await entered.promise;
	screen.input("\x03");
	await flush();
	release.resolve();
	await until(() => f.results.length === 2);
	assert.match(f.results[1].content, /Child run aborted/);
	assert.equal(f.requests.length, 1);
});
