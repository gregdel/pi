import assert from "node:assert/strict";
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
const { KeybindingsManager } = await jiti.import(join(runtime, "core/keybindings.js"));
const { getKeybindings, setKeybindings, visibleWidth } = await jiti.import("@earendil-works/pi-tui");
const { createAgentPicker } = await jiti.import(join(here, "../extensions/subagents.ts"));
const { initTheme } = await jiti.import("@earendil-works/pi-coding-agent");
initTheme("dark", false);
const flush = () => new Promise(setImmediate);

function fixture(t, { rows = 24, bindings = {} } = {}) {
	const previous = getKeybindings();
	const keys = new KeybindingsManager(bindings);
	setKeybindings(keys);
	const agents = [
		{ name: "Joe", profile: "planner", status: "done", createdAt: 1, task: "Plan the change", model: "test/model", thinking: "high" },
		{ name: "Bob", status: "running", createdAt: 2, task: "Review the change", model: "test/model", thinking: "high" },
	];
	const listeners = new Set();
	const tui = { terminal: { rows }, requestRender: t.mock.fn() };
	const done = t.mock.fn();
	const remove = t.mock.fn(async (agent) => { agents.splice(agents.indexOf(agent), 1); });
	const component = createAgentPicker(() => [...agents], remove,
		(listener) => { listeners.add(listener); return () => listeners.delete(listener); },
		tui, { fg: (_color, text) => text, bold: (text) => text }, keys, done);
	t.after(() => { component.dispose(); setKeybindings(previous); });
	const text = (width = 100) => plain(component.render(width).join("\n"));
	return { agents, component, done, remove, listeners, tui, text,
		selected: () => text().split("\n").find((line) => line.startsWith("→")),
	};
}

for (const action of ["open", "delete"]) {
	test(`status reordering preserves the selected identity for ${action}`, async (t) => {
		const f = fixture(t);
		assert.match(f.selected(), /Bob/);
		f.component.handleInput("\x1b[B");
		assert.match(f.selected(), /Joe/);
		f.agents[1].status = "done";
		assert.match(f.selected(), /Joe/);
		if (action === "open") {
			f.component.handleInput("\r");
			assert.equal(f.done.mock.calls[0].arguments[0], f.agents[0]);
		} else {
			f.component.handleInput("\x04");
			assert.match(f.text(), /Delete Joe and its conversation/);
			assert.equal(f.remove.mock.callCount(), 0, "retained history needs confirmation");
			f.agents[1].status = "waiting";
			f.component.handleInput("\r");
			await flush();
			assert.equal(f.remove.mock.calls[0].arguments[0].name, "Joe");
			assert.deepEqual(f.agents.map((agent) => agent.name), ["Bob"]);
		}
	});
}

test("filtering includes profiles and handles empty results and removed selections", (t) => {
	const f = fixture(t);
	f.component.handleInput("planner");
	assert.match(f.selected(), /Joe/);
	f.agents.splice(0, 1);
	assert.match(f.text(), /No matches/);
	f.component.handleInput("\r");
	assert.equal(f.done.mock.callCount(), 0);
	f.component.handleInput("\x15");
	assert.match(f.selected(), /Bob/);
});

test("cancelled deletion does not remove the selected conversation", (t) => {
	const f = fixture(t);
	f.component.handleInput("\x04");
	f.component.handleInput("\x1b");
	assert.equal(f.remove.mock.callCount(), 0);
	assert.equal(f.done.mock.callCount(), 0);
	f.component.handleInput("\x1b");
	assert.equal(f.done.mock.callCount(), 1);
});

test("short pickers retain search and action hints instead of clipping controls", (t) => {
	const f = fixture(t);
	f.component.focused = true;
	for (const rows of [2, 3, 4, 5, 6, 8, 12]) {
		f.tui.terminal.rows = rows;
		for (const width of [20, 40, 80]) {
			const lines = f.component.render(width);
			assert.ok(lines.length <= rows);
			assert.ok(lines.every((line) => visibleWidth(line) <= width));
			assert.match(plain(lines.join("\n")), /enter open/);
		}
	}
});

test("picker respects remapped actions, terminal size, and disposal", (t) => {
	const f = fixture(t, { rows: 12, bindings: { "tui.select.down": "ctrl+n", "app.session.delete": "ctrl+x" } });
	f.agents[0].task = "A long task 中文 🧪 ".repeat(30);
	f.component.handleInput("\x0e");
	assert.match(f.selected(), /Joe/);
	for (const width of [20, 40, 80]) {
		const lines = f.component.render(width);
		assert.ok(lines.length <= 12);
		assert.ok(lines.every((line) => visibleWidth(line) <= width));
	}
	assert.match(f.text(), /ctrl\+x delete/i);
	f.component.handleInput("\x18");
	assert.match(f.text(), /Delete Joe/);
	assert.equal(f.listeners.size, 1);
	f.component.dispose();
	assert.equal(f.listeners.size, 0);
	f.component.handleInput("\r");
	assert.equal(f.remove.mock.callCount(), 0);
});
