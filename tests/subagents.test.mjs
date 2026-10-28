import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

const here = dirname(fileURLToPath(import.meta.url));
const packageFile = process.env.PI_PACKAGE_DIR
	? join(process.env.PI_PACKAGE_DIR, "package.json")
	: import.meta.url;
const require = createRequire(packageFile);
const { createJiti } = require("jiti");
const resolver = createJiti(packageFile, { fsCache: false });
const jiti = createJiti(import.meta.url, {
	fsCache: false,
	moduleCache: false,
	alias: Object.fromEntries([
		"@earendil-works/pi-ai",
		"@earendil-works/pi-coding-agent",
		"@earendil-works/pi-tui",
		"typebox",
	].map((name) => [name, fileURLToPath(resolver.esmResolve(
		name === "@earendil-works/pi-ai" ? `${name}/compat` : name,
	))])),
});
const { default: factory, selectDelegationSettings } = await jiti.import(join(here, "../extensions/subagents.ts"));
const { matchesKey, parseColor, styleText, visibleWidth } = await jiti.import("@earendil-works/pi-tui");
const flush = () => new Promise(setImmediate);
const enter = "\r";
const escape = "\x1b";
const down = "\x1b[B";
const caller = {
	provider: "test", id: "caller", reasoning: true,
	thinkingLevelMap: { xhigh: "xhigh", max: "max" },
};
const other = { provider: "test", id: "alternate", reasoning: false };
const lookalike = { provider: "another", id: "caller", reasoning: true };

function fixture(t, { colorMode = "truecolor", beforeBuild } = {}) {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
	const screens = [];
	const authModels = [];
	const handlers = new Map();
	const thinkingFallback = t.mock.fn(() => "high");
	let tool;
	const theme = {
		fg(_color, text) { return text; },
		bold(text) { return text; },
		style(text, options) { return styleText(text, options, colorMode); },
	};
	const keys = {
		matches(data, action) {
			const bindings = {
				"tui.select.cancel": ["escape", "ctrl+c"],
				"tui.select.up": ["up"],
				"tui.select.down": ["down"],
				"tui.select.confirm": ["enter"],
			};
			return (bindings[action] ?? []).some((key) => matchesKey(data, key));
		},
	};
	const ctx = {
		mode: "tui", cwd: process.cwd(), model: caller, thinkingLevel: "high",
		modelRegistry: {
			getAvailable() { return [other, lookalike, caller]; },
			async getApiKeyAndHeaders(model) {
				authModels.push(model);
				throw new Error("Test stops before child runtime creation");
			},
		},
		ui: {
			setStatus() {},
			custom(build, options) {
				assert.equal(options.overlay, true);
				return new Promise((resolve) => {
					const screen = { closed: false, completions: 0, redraws: 0 };
					const done = (result) => {
						screen.completions++;
						if (screen.closed) return;
						screen.closed = true;
						resolve(result);
						screen.component?.dispose();
					};
					beforeBuild?.();
					screen.component = build({ requestRender() { screen.redraws++; } }, theme, keys, done);
					screen.text = (width = 120) => stripVTControlCharacters(screen.component.render(width).join("\n"));
					screen.input = (data) => screen.component.handleInput(data);
					screens.push(screen);
				});
			},
		},
	};
	factory({
		registerTool(value) { tool = value; },
		registerCommand() {},
		on(name, handler) { handlers.set(name, handler); },
		getThinkingLevel: thinkingFallback,
	});
	handlers.get("session_start")({}, ctx);
	const shutdown = () => handlers.get("session_shutdown")({}, ctx);
	t.after(async () => {
		await shutdown();
		for (const screen of screens) screen.component.dispose();
	});
	return {
		ctx, screens, authModels, thinkingFallback, shutdown,
		select: (context = ctx, signal) => selectDelegationSettings(context, context.thinkingLevel, signal),
		execute: (signal) => tool.execute("test", { task: "Read-only test task" }, signal, undefined, ctx),
		restart: () => handlers.get("session_start")({}, ctx),
	};
}

for (const thinking of ["off", "high", "xhigh", "max"]) {
	test(`untouched model picker inherits the caller and ${thinking} after exactly 30 seconds`, async (t) => {
		const f = fixture(t);
		f.ctx.thinkingLevel = thinking;
		const result = f.select();
		const screen = f.screens[0];
		assert.match(screen.text(), /> test\/caller/);
		assert.ok(screen.text().includes(`Default in 30s: test/caller / ${thinking}`));
		f.ctx.model = other;
		f.ctx.thinkingLevel = "low";
		t.mock.timers.tick(29_999);
		assert.equal(screen.closed, false);
		assert.match(screen.text(), /Default in 1s/);
		t.mock.timers.tick(1);
		assert.deepEqual(await result, { model: caller, thinking });
		assert.equal(f.screens.length, 1);
		assert.equal(screen.completions, 1);
		const redraws = screen.redraws;
		t.mock.timers.tick(60_000);
		assert.equal(screen.redraws, redraws);
		screen.input(enter);
		assert.equal(screen.completions, 1);
	});
}

for (const input of ["x", down, "\x1b[A", "\x7f"]) {
	test(`interaction ${JSON.stringify(input)} permanently disables automatic selection`, async (t) => {
		const f = fixture(t);
		const result = f.select();
		const screen = f.screens[0];
		t.mock.timers.tick(29_999);
		screen.input(input);
		assert.match(screen.text(), /Automatic default disabled/);
		const redraws = screen.redraws;
		t.mock.timers.tick(60_000);
		assert.equal(screen.closed, false);
		assert.equal(screen.redraws, redraws);
		screen.input(escape);
		assert.equal(await result, undefined);
	});
}

test("explicit model selection leaves thinking selection manual indefinitely", async (t) => {
	const f = fixture(t);
	const result = f.select();
	f.screens[0].input(enter);
	await flush();
	const screen = f.screens[1];
	assert.match(screen.text(), /Select thinking level/);
	assert.match(screen.text(), /> high/);
	assert.doesNotMatch(screen.text(), /Default in/);
	t.mock.timers.tick(60_000);
	assert.equal(screen.closed, false);
	screen.input("low");
	screen.input(enter);
	assert.deepEqual(await result, { model: caller, thinking: "low" });
});

test("a different model still requires an explicit supported thinking choice", async (t) => {
	const f = fixture(t);
	const result = f.select();
	f.screens[0].input("alternate");
	f.screens[0].input(enter);
	await flush();
	assert.match(f.screens[1].text(), /> off/);
	t.mock.timers.tick(60_000);
	assert.equal(f.screens[1].closed, false);
	f.screens[1].input(enter);
	assert.deepEqual(await result, { model: other, thinking: "off" });
});

for (const key of [escape, "\x03"]) {
	test(`cancel ${JSON.stringify(key)} does not inherit or initialize a child`, async (t) => {
		const f = fixture(t);
		const result = f.execute();
		f.screens[0].input(key);
		assert.match((await result).content[0].text, /cancelled; no child started/);
		t.mock.timers.tick(60_000);
		assert.deepEqual(f.authModels, []);
	});
}

test("cancelling thinking selection never falls back", async (t) => {
	const f = fixture(t);
	const result = f.select();
	f.screens[0].input(enter);
	await flush();
	f.screens[1].input(escape);
	assert.equal(await result, undefined);
	t.mock.timers.tick(60_000);
	assert.equal(f.screens.length, 2);
});

test("pre-aborted delegation never opens a picker", async (t) => {
	const f = fixture(t);
	await assert.rejects(f.execute(AbortSignal.abort()), /Delegation cancelled/);
	assert.equal(f.screens.length, 0);
});

test("abort during UI setup closes the picker and clears its timers", async (t) => {
	const controller = new AbortController();
	const f = fixture(t, { beforeBuild: () => controller.abort() });
	assert.equal(await f.select(f.ctx, controller.signal), undefined);
	const screen = f.screens[0];
	assert.equal(screen.closed, true);
	t.mock.timers.tick(60_000);
	assert.equal(screen.redraws, 0);
	assert.equal(screen.completions, 1);
});

for (const timing of ["before timeout", "after timeout, before continuation"]) {
	test(`abort ${timing} prevents child initialization`, async (t) => {
		const f = fixture(t);
		const controller = new AbortController();
		const result = f.execute(controller.signal);
		t.mock.timers.tick(timing === "before timeout" ? 29_999 : 30_000);
		controller.abort();
		t.mock.timers.tick(60_000);
		assert.match((await result).content[0].text, /cancelled; no child started/);
		assert.deepEqual(f.authModels, []);
		assert.equal(f.screens[0].completions, 1);
	});
}

test("disposing a picker cancels it and stops countdown renders", async (t) => {
	const f = fixture(t);
	const result = f.select();
	const screen = f.screens[0];
	t.mock.timers.tick(5000);
	screen.component.dispose();
	assert.equal(await result, undefined);
	const redraws = screen.redraws;
	t.mock.timers.tick(60_000);
	assert.equal(screen.redraws, redraws);
	assert.equal(screen.completions, 1);
});

for (const stage of ["model", "thinking"]) {
	test(`shutdown cancels pending ${stage} selection, including without a tool signal`, async (t) => {
		const f = fixture(t);
		const result = f.execute();
		if (stage === "thinking") {
			f.screens[0].input(enter);
			await flush();
		}
		await f.shutdown();
		assert.match((await result).content[0].text, /cancelled; no child started/);
		const screen = f.screens.at(-1);
		const redraws = screen.redraws;
		t.mock.timers.tick(60_000);
		assert.equal(screen.closed, true);
		assert.equal(screen.redraws, redraws);
		assert.deepEqual(f.authModels, []);
		f.restart();
		const next = f.execute();
		assert.equal(f.screens.at(-1).closed, false);
		f.screens.at(-1).input(escape);
		assert.match((await next).content[0].text, /cancelled; no child started/);
	});
}

for (const model of [lookalike, undefined]) {
	test(`an unavailable caller model (${model?.provider ?? "missing"}) never defaults to an alternative`, async (t) => {
		const f = fixture(t);
		f.ctx.model = model;
		f.ctx.modelRegistry.getAvailable = () => [other, caller];
		const rejected = assert.rejects(f.select(), /Caller model unavailable for delegation/);
		t.mock.timers.tick(30_000);
		await rejected;
		assert.equal(f.screens.length, 1);
	});
}

test("inherited thinking is not silently clamped", async (t) => {
	const f = fixture(t);
	f.ctx.model = other;
	const rejected = assert.rejects(f.select(), /Model does not support thinking level high/);
	t.mock.timers.tick(30_000);
	await rejected;
});

test("no authenticated models fails before displaying a picker", async (t) => {
	const f = fixture(t);
	f.ctx.modelRegistry.getAvailable = () => [];
	await assert.rejects(f.select(), /No authenticated models/);
	assert.equal(f.screens.length, 0);
});

test("concurrent selections keep their own snapshots and countdowns", async (t) => {
	const f = fixture(t);
	const first = f.select();
	const second = f.select({ ...f.ctx, model: other, thinkingLevel: "off" });
	f.screens[0].input(down);
	t.mock.timers.tick(30_000);
	assert.deepEqual(await second, { model: other, thinking: "off" });
	assert.equal(f.screens[0].closed, false);
	f.screens[0].input(escape);
	assert.equal(await first, undefined);
});

for (const colorMode of ["truecolor", "256color"]) {
	test(`only model-picker borders use #b58900 in ${colorMode}`, async (t) => {
		const f = fixture(t, { colorMode });
		const result = f.select();
		const component = f.screens[0].component;
		for (const width of [20, 80, 120]) {
			const lines = component.render(width);
			const expected = styleText("─".repeat(width), { fg: parseColor("#b58900") }, colorMode);
			assert.equal(lines[0], expected);
			assert.equal(lines.at(-1), expected);
			assert.ok(lines.every((line) => visibleWidth(line) <= width));
		}
		f.screens[0].input(enter);
		await flush();
		const lines = f.screens[1].component.render(80);
		assert.equal(lines[0], "─".repeat(80));
		assert.equal(lines.at(-1), "─".repeat(80));
		f.screens[1].input(escape);
		await result;
	});
}

test("delegate passes the inherited model to child initialization and uses runtime thinking fallback", async (t) => {
	const f = fixture(t);
	delete f.ctx.thinkingLevel;
	const rejected = assert.rejects(f.execute(), /Test stops before child runtime creation/);
	assert.match(f.screens[0].text(), /test\/caller \/ high/);
	t.mock.timers.tick(30_000);
	await rejected;
	assert.deepEqual(f.authModels, [caller]);
	assert.equal(f.thinkingFallback.mock.callCount(), 1);
	assert.equal(f.screens.length, 1);
});
