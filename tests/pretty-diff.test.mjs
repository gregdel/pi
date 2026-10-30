import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
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
const { default: extension } = await jiti.import(join(here, "../extensions/pretty-diff.ts"));
const { BatHighlighter } = await jiti.import(join(here, "../extensions/pretty-diff/bat.ts"));
const { validateToolArguments } = await jiti.import("@earendil-works/pi-ai");
const { createEditToolDefinition, createReadToolDefinition, createWriteToolDefinition, generateDiffString, initTheme, ToolExecutionComponent } =
	await jiti.import("@earendil-works/pi-coding-agent");
const runtime = dirname(fileURLToPath(resolver.esmResolve("@earendil-works/pi-coding-agent")));
const { theme } = await jiti.import(join(runtime, "modes/interactive/theme/theme.js"));
const { createToolHtmlRenderer } = await jiti.import(join(runtime, "core/export-html/tool-renderer.js"));
const { backgroundAnsi, colorToOklch, colorToRgb, getCapabilities, mixColors, oklchColor, setCapabilities, visibleWidth } = await jiti.import("@earendil-works/pi-tui");
initTheme("dark");
const content = (text) => [{ type: "text", text }];
const result = (text = "Success", details) => ({ content: content(text), details });
const diff = (before = "const value = 1;\n", after = "const value = 2;\n") => generateDiffString(before, after).diff;
const diffBase = () => oklchColor(colorToOklch(theme.colors.toolPendingBg).l, 0, 0);
const wordColor = (tint) => mixColors(oklchColor(theme.appearance === "dark" ? 0 : 1, 0, 0), tint, theme.appearance === "dark" ? 0.32 : 0.04);

function fixture(t) {
	const handlers = new Map();
	let resolve;
	extension({
		on: (name, handler) => handlers.set(name, handler),
		registerToolRenderer: (handler) => { resolve = handler; },
	});
	t.after(() => { handlers.get("session_shutdown")(); initTheme("dark"); });
	return {
		resolve, handlers,
		start: (mode = "tui") => handlers.get("session_start")({}, { mode }),
		row(name = "edit", args = { path: "/nonexistent/example.ts" }, output = result("Success", { diff: diff() }), isError = false) {
			const redraw = t.mock.fn();
			const renderer = resolve(name, () => name === "read" ? createReadToolDefinition("/nonexistent") : undefined);
			const row = new ToolExecutionComponent(name, "call", args, { outputPad: 0 }, renderer,
				{ requestRender: redraw }, "/nonexistent");
			row.setArgsComplete();
			if (output) row.updateResult({ ...output, isError });
			return { row, redraw, renderer, text: (width = 100) => plain(row.render(width).join("\n")) };
		},
	};
}

function fakeBat(t) {
	const jobs = [];
	const launch = t.mock.fn((command, args, options, callback) => {
		const child = { stdin: new EventEmitter(), kill: t.mock.fn(() => true) };
		const job = { command, args, options, child, input: undefined,
			finish(error = null, output) { callback(error, output ?? `\x1b[38;2;100;150;200m${job.input}\x1b[0m`, ""); },
		};
		child.stdin.end = (source) => { job.input = source; };
		jobs.push(job);
		return child;
	});
	return { jobs, launch };
}

function fits(row, width) {
	const lines = row.render(width);
	assert.ok(lines.every((line) => visibleWidth(line) <= width), `overflow at ${width}: ${plain(lines.join("\n"))}`);
	return plain(lines.join("\n"));
}

function assertWordBands(row, sign, segments) {
	const source = segments.map(([text]) => text).join("");
	const prefix = `${sign}1 `;
	const line = row.render(Math.max(80, visibleWidth(source) + prefix.length + 1))
		.find((line) => plain(line).startsWith(prefix + source));
	assert.ok(line, "source line is preserved");
	const tint = theme.colors[sign === "+" ? "toolDiffAdded" : "toolDiffRemoved"];
	const base = backgroundAnsi(mixColors(diffBase(), tint, 0.12), theme.getColorMode());
	const marked = backgroundAnsi(wordColor(tint), theme.getColorMode());
	let background = "";
	const actual = [];
	// eslint-disable-next-line no-control-regex -- inspect generated styling in the test fixtures
	for (const part of line.split(/(\x1b\[[\d;]*m)/)) {
		if (part.startsWith("\x1b[")) {
			if (part.startsWith("\x1b[48;")) background = part;
			else if (part === "\x1b[0m" || part === "\x1b[49m") background = "";
		} else {
			for (let i = 0; i < part.length; i++) actual.push(background);
		}
	}
	const expected = segments.flatMap(([text, changed]) => Array(text.length).fill(changed ? marked : base));
	assert.deepEqual(actual.slice(prefix.length, prefix.length + source.length), expected);
}

test("only renderer and lifecycle registrations; other tools delegate unchanged", (t) => {
	const f = fixture(t);
	assert.deepEqual([...f.handlers.keys()], ["session_start", "session_shutdown"]);
	const other = { renderShell: "self" };
	for (const name of ["bash", "mcp__files__edit", "mcp__files__read", "unknown"]) {
		const next = t.mock.fn(() => other);
		assert.equal(f.resolve(name, next), other);
		assert.equal(next.mock.callCount(), 1);
	}
});

test("saved file_path arguments retain paths, sanitization, and filename-based highlighting", (t) => {
	const fake = fakeBat(t);
	t.mock.method(childProcess, "execFile", fake.launch);
	const f = fixture(t);
	f.start();
	for (const name of ["read", "edit", "write"]) {
		for (const path of [undefined, "ignored.py"]) {
			const args = { file_path: "saved\nfile.ts", path, content: "const value = 1;", offset: 42, limit: 1 };
			const output = name === "edit" ? result("Success", { diff: diff() }) : result("const value = 1;");
			const saved = JSON.parse(JSON.stringify({ args, output }));
			const r = f.row(name, saved.args, saved.output);
			assert.match(r.text(), new RegExp(`${name} saved file\\.ts${name === "read" ? ":42-42" : ""}`));
			assert.doesNotMatch(r.text(), /ignored\.py/);
		}
	}
	assert.ok(fake.jobs.length > 0);
	assert.ok(fake.jobs.every((job) => job.args.includes("--file-name=saved file.ts")));
});

test("read, edit, and write omit the colored shell while preserving padding and Bat highlighting", (t) => {
	const fake = fakeBat(t);
	t.mock.method(childProcess, "execFile", fake.launch);
	const f = fixture(t);
	f.start();
	const rows = [f.row(), f.row("write", { path: "file.ts", content: "const value = 1;" }),
		f.row("read", { path: "file.ts" }, result("const value = 1;"))];
	const pending = f.row("write", { path: "file.ts" }, null);
	pending.row.updateResult(result("progress"), true);
	const failed = f.row("edit", { path: "file.ts" }, result("Permission denied"), true);
	for (const r of [...rows, pending, failed]) {
		assert.equal(r.renderer.renderShell, "self");
		for (const padding of [0, 2]) {
			r.row.setOutputPad(padding);
			const lines = r.row.render(80);
			const title = lines.find((line) => /^(read|edit|write) /.test(plain(line).trimStart()));
			assert.ok(plain(title).startsWith(" ".repeat(padding)));
			for (const token of ["toolSuccessBg", "toolPendingBg", "toolErrorBg"]) {
				assert.ok(!lines.join("\n").includes(backgroundAnsi(theme.colors[token], theme.getColorMode())));
			}
			for (const width of [1, 2, 3, 12, 80]) fits(r.row, width);
		}
	}
	for (const job of fake.jobs) job.finish();
	for (const r of rows) assert.match(r.text(), /· bat/);
});

test("unchanged preview boxes reuse width-safe output across redraws", (t) => {
	const f = fixture(t);
	const box = f.resolve("write", () => undefined).renderResult(result(), { expanded: true, isPartial: false }, theme, {
		args: { path: "file.ts", content: "const value = 1;\n".repeat(30) }, state: {},
		outputPad: 2, isError: false, invalidate() {},
	});
	const first = box.render(80);
	assert.equal(box.render(80), first);
	for (const width of [1, 2, 40, 80]) {
		fits(box, width);
		const lines = box.render(width);
		assert.equal(box.render(width), lines);
	}
	box.setPaddingX(0);
	assert.notDeepEqual(box.render(80), first);
	const dark = box.render(80);
	initTheme("light");
	box.invalidate();
	const light = box.render(80);
	assert.notDeepEqual(light, dark);
	assert.equal(box.render(80), light);
});

test("read and write highlight each source only once per render", (t) => {
	const fake = fakeBat(t);
	t.mock.method(childProcess, "execFile", fake.launch);
	const fg = t.mock.method(theme.constructor.prototype, "fg");
	const f = fixture(t);
	f.start();
	const source = "plain source";
	const rows = [f.row("read", { path: "file.unknown" }, result(source)),
		f.row("write", { path: "file.unknown", content: source })];
	for (const width of [80, 40]) {
		const before = fg.mock.calls.length;
		for (const r of rows) assert.match(r.text(width), /plain source/);
		const highlighted = fg.mock.calls.slice(before).filter((call) => call.arguments[0] === "mdCodeBlock");
		assert.deepEqual(highlighted.map((call) => call.arguments[1]), [source, source]);
	}
});

test("edit uses actual saved output, not requested replacements or current files", (t) => {
	const f = fixture(t);
	const args = Object.freeze({ path: "/deleted/file.ts", edits: Object.freeze([{ oldText: "WRONG", newText: "WRONG" }]) });
	const output = Object.freeze(result("Success", Object.freeze({ diff: diff() })));
	const before = JSON.stringify({ args, output });
	const r = f.row("edit", args, output);
	assert.match(r.text(), /\+1 −1 · Pi colors/);
	assert.match(r.text(), /const value = 1/);
	assert.match(r.text(), /const value = 2/);
	assert.doesNotMatch(r.text(), /WRONG|Could not edit/);
	assert.equal(JSON.stringify({ args, output }), before);
	const wordBg = backgroundAnsi(wordColor(theme.colors.toolDiffAdded), theme.getColorMode());
	assert.ok(r.row.render(100).join("\n").includes(wordBg), "changed words have a stronger background");
});

test("word bands preserve unmarked gaps, boundaries, and long contiguous replacements", (t) => {
	const f = fixture(t);
	const cases = [
		[
			[["head ", false], ["old", true], [" middle ", false], ["left", true], [" tail", false]],
			[["head ", false], ["new", true], [" middle ", false], ["right", true], [" tail", false]],
		],
		[
			[["(old)", true], [" unchanged suffix", false]],
			[["[new]", true], [" unchanged suffix", false]],
		],
		[
			[["unchanged ".repeat(100), false], ["a".repeat(2000), true]],
			[["unchanged ".repeat(100), false], ["b".repeat(2000), true]],
		],
	];
	for (const [before, after] of cases) {
		const text = (segments) => segments.map(([text]) => text).join("");
		const r = f.row("edit", { path: "file.unknown" }, result("Success", { diff: diff(text(before), text(after)) }));
		assertWordBands(r.row, "-", before);
		assertWordBands(r.row, "+", after);
		r.row.invalidate();
		assertWordBands(r.row, "-", before);
		assertWordBands(r.row, "+", after);
	}
	const added = f.row("edit", { path: "file.unknown" }, result("Success", { diff: diff("", "only additions") }));
	assertWordBands(added.row, "+", [["only additions", false]]);
});

test("multiple hunks, blank lines, pure insertion/deletion, unrelated and unequal replacements", (t) => {
	const f = fixture(t);
	const inputs = [
		["", "new\n\nlines\n"], ["old\nlines\n", ""],
		["one\n" + "context\n".repeat(20) + "two\n", "ONE\n" + "context\n".repeat(20) + "TWO\n"],
		["const a = 1;\nconst b = 2;\n", "const a = 3;\nconst b = 4;\n"],
		["completely unrelated\n", "xyz 123\n"], ["old\n", "new\nextra\n"],
	];
	for (const [before, after] of inputs) {
		const r = f.row("edit", { path: "file.ts" }, result("Success", { diff: diff(before, after) }));
		r.row.setExpanded(true);
		assert.doesNotMatch(r.text(), /Tool output|undefined/);
		fits(r.row, 25);
	}
});

for (const text of ["", "line", "line\n", "line\n\n", "const value = 1;\n"]) {
	test(`write preview is explicitly not an overwrite diff: ${JSON.stringify(text)}`, (t) => {
		const f = fixture(t);
		const r = f.row("write", { path: "file.ts", content: text }, result());
		assert.match(r.text(), /Written content \(not an overwrite diff\)/);
		assert.doesNotMatch(r.text(), /\+1 −|Added|Created/);
		if (text) assert.match(r.text(), /line|const value/);
		else assert.match(r.text(), /\(empty\)/);
	});
}

test("pending, failed, malformed, and custom results remain readable without success previews", (t) => {
	const f = fixture(t);
	const pending = f.row("write", { path: "file.ts", content: "not written" }, null);
	assert.doesNotMatch(pending.text(), /Written content|not written/);
	pending.row.updateResult(result("progress"), true);
	assert.match(pending.text(), /Working/);
	for (const name of ["read", "edit", "write"]) {
		const r = f.row(name, { path: "file.ts", content: "not written" }, result("Permission denied\nmore details", { diff: diff() }), true);
		assert.match(r.text(), /Permission denied/);
		assert.doesNotMatch(r.text(), /const value|Written content|not written/);
	}
	for (const details of [undefined, null, 123, { diff: 123 }, { diff: "malformed custom diff" }]) {
		const r = f.row("edit", null, result("Custom output", details));
		assert.match(r.text(), /Custom output|malformed custom diff/);
		assert.doesNotMatch(r.text(), /undefined|\[object Object\]/);
	}
});

test("collapsed previews are bounded by visual rows; expansion and resize preserve long content", (t) => {
	const f = fixture(t);
	const r = f.row("write", { path: "file.txt", content: "x".repeat(3000) + "TAIL\n" + "line\n".repeat(30) });
	const collapsed = fits(r.row, 40);
	assert.ok(r.row.render(40).length < 26);
	assert.match(collapsed, /more/);
	assert.doesNotMatch(collapsed, /TAIL/);
	r.row.setExpanded(true);
	assert.match(fits(r.row, 40), /TAIL/);
	for (const width of [1, 2, 3, 10, 80, 160]) fits(r.row, width);
});

test("word bands cover whole graphemes across Bat styling, resizing, and theme changes", (t) => {
	const fake = fakeBat(t);
	t.mock.method(childProcess, "execFile", fake.launch);
	const f = fixture(t);
	f.start();
	const before = [["const ", false], ["é", true], [" = '", false], ["👩‍💻", true],
		["'; const face = '", false], ["😀", true], ["';", false]];
	const after = [["const ", false], ["è", true], [" = '", false], ["👨‍🚀", true],
		["'; const face = '", false], ["😁", true], ["';", false]];
	const text = (segments) => segments.map(([text]) => text).join("");
	const r = f.row("edit", { path: "file.ts" }, result("Success", { diff: diff(text(before), text(after)) }));
	r.row.setExpanded(true);
	for (const appearance of ["dark", "light"]) {
		initTheme(appearance);
		r.row.invalidate();
		const jobsBefore = fake.jobs.length;
		assertWordBands(r.row, "-", before);
		assertWordBands(r.row, "+", after);
		assert.match(r.text(), /Pi colors/);
		assert.equal(fake.jobs.length, jobsBefore + 2);
		for (const job of fake.jobs.slice(jobsBefore)) {
			// Place resets inside combining/ZWJ graphemes, not just at word boundaries.
			const styled = [...job.input].map((char) => `\x1b[38;2;100;150;200m${char}\x1b[0m\x1b[49m`).join("");
			job.finish(null, styled);
		}
		assert.match(r.text(), /· bat/);
		for (const width of [12, 40, 80]) fits(r.row, width);
		assertWordBands(r.row, "-", before);
		assertWordBands(r.row, "+", after);
	}
});

test("Unicode, tabs, CRLF, hostile controls, and unknown languages fit narrow terminals", (t) => {
	const f = fixture(t);
	const r = f.row("edit", { path: "中文👩‍💻\n\x1b]52;c;secret\x07.unknown" }, result("Success", {
		diff: diff("\tconst é = '👩‍💻';\r\n", "\tconst é = '👨‍💻 中文';\r\n") + "\n 9 \x1b]52;c;secret\x07\x00text",
	}));
	const ansi = r.row.render(100).join("\n");
	for (const control of ["\x1b]", "\x00", "\r", "\t"]) assert.ok(!ansi.includes(control));
	assert.match(plain(ansi), /中文/);
	for (const width of [1, 2, 3, 12, 40, 100]) fits(r.row, width);
});

for (const colorMode of ["truecolor", "256color"]) {
	test(`diff backgrounds use neutral shading in dark and light themes (${colorMode})`, (t) => {
		const caps = getCapabilities();
		t.after(() => setCapabilities(caps));
		setCapabilities({ ...caps, trueColor: colorMode === "truecolor" });
		const f = fixture(t);
		for (const appearance of ["dark", "light"]) {
			initTheme(appearance);
			assert.equal(theme.getColorMode(), colorMode);
			const r = f.row();
			const lines = r.row.render(100);
			for (const [sign, token, channel] of [["-", "toolDiffRemoved", "r"], ["+", "toolDiffAdded", "g"]]) {
				const line = lines.find((text) => plain(text).trimStart().startsWith(`${sign}1 const value`));
				assert.ok(line);
				for (const [amount, color] of [[0.12, mixColors(diffBase(), theme.colors[token], 0.12)],
					[theme.appearance === "dark" ? 0.32 : 0.04, wordColor(theme.colors[token])]]) {
					const context = `${colorMode} ${appearance} ${token} ${amount}: ${JSON.stringify(line)}`;
					assert.ok(line.includes(backgroundAnsi(color, colorMode)), context);
					// Different RGB shades can share a 256-color palette index.
					if (colorMode === "truecolor") {
						const oldColor = mixColors(theme.colors.toolSuccessBg, theme.colors[token], amount);
						assert.ok(!line.includes(backgroundAnsi(oldColor, colorMode)), context);
					}
					const rgb = colorToRgb(color);
					assert.ok(rgb[channel] > rgb[channel === "r" ? "g" : "r"], `${token} has its own hue in ${appearance} mode`);
				}
			}
		}
	});
}

test("changed number tokens retain readable contrast in dark and light themes", async (t) => {
	const { wcagContrast } = await jiti.import(join(runtime, "modes/interactive/theme/system-theme.js"));
	const caps = getCapabilities();
	t.after(() => setCapabilities(caps));
	setCapabilities({ ...caps, trueColor: true });
	const f = fixture(t);
	for (const appearance of ["dark", "light"]) {
		initTheme(appearance);
		const lines = f.row().row.render(100);
		for (const sign of ["-", "+"]) {
			const line = lines.find((text) => plain(text).startsWith(`${sign}1 const value`));
			// Read the actual foreground and background immediately before the changed digit.
			// eslint-disable-next-line no-control-regex -- inspect generated SGR colors
			const styling = /((?:\x1b\[[\d;]*m)+)[12](?=\x1b|;)/.exec(line)?.[1];
			assert.ok(styling, "changed digit has styling");
			const colors = new Map();
			// eslint-disable-next-line no-control-regex -- inspect generated truecolor styling
			for (const match of styling.matchAll(/\x1b\[(38|48);2;(\d+);(\d+);(\d+)m/g)) {
				colors.set(match[1], { r: Number(match[2]), g: Number(match[3]), b: Number(match[4]) });
			}
			assert.ok(colors.has("38") && colors.has("48"), "changed digit has explicit foreground and background");
			const contrast = wcagContrast(colors.get("38"), colors.get("48"));
			assert.ok(contrast >= 4.5, `${appearance} ${sign}: ${contrast.toFixed(2)}:1`);
		}
	}
});

test("theme invalidation refreshes backgrounds and native syntax colors", (t) => {
	const f = fixture(t);
	const r = f.row();
	const dark = r.row.render(100).join("\n");
	initTheme("light");
	r.row.invalidate();
	const light = r.row.render(100).join("\n");
	assert.notEqual(dark, light);
	assert.equal(plain(dark), plain(light));
});

test("expanded rendering has a source/row cap and announces truncation", (t) => {
	const f = fixture(t);
	for (const source of ["line\n".repeat(5000), "x".repeat(140_000)]) {
		const r = f.row("write", { path: "file.unknown", content: source });
		r.row.setExpanded(true);
		assert.ok(r.row.render(80).length < 4010);
		assert.match(r.text(80), /preview limit/);
	}
});

test("large word-marked diffs preserve content and bands through repeated expanded renders", (t) => {
	const f = fixture(t);
	const before = "x".repeat(1201) + " " + "a".repeat(2798);
	const after = "x".repeat(1201) + " " + "b".repeat(2798);
	const savedDiff = diff((before + "\n").repeat(16), (after + "\n").repeat(16));
	assert.ok(savedDiff.length < 128 * 1024, "fixture stays within the preview cap");
	const r = f.row("edit", { path: "file.unknown" }, result("Success", { diff: savedDiff }));
	r.row.setExpanded(true);
	const expected = before.replace(/\s/g, "").repeat(16) + after.replace(/\s/g, "").repeat(16);
	for (const width of [100, 80, 100]) {
		r.row.invalidate();
		const lines = r.row.render(width);
		assert.ok(lines.every((line) => visibleWidth(line) <= width));
		// Skip the spacer, tool call, and preview title before checking wrapped source.
		const body = plain(lines.slice(3).join("\n"));
		assert.equal(body.replace(/^[+-]\s*\d+ /gm, "").replace(/\s/g, ""), expected);
		for (const token of ["toolDiffRemoved", "toolDiffAdded"]) {
			const marked = backgroundAnsi(wordColor(theme.colors[token]), theme.getColorMode());
			assert.ok(lines.some((line) => line.includes(marked)), "word marks remain enabled on long replacements");
		}
		assert.doesNotMatch(r.text(width), /preview limit/);
	}
});

for (const [offset, limit] of [[42, 30], ["42", 30], [42, "30"], ["42", "30"]]) {
	test(`read preserves saved output, offsets, and continuation notices for ${JSON.stringify({ offset, limit })}`, async (t) => {
		const fake = fakeBat(t);
		t.mock.method(childProcess, "execFile", fake.launch);
		const f = fixture(t);
		f.start();
		const readFile = t.mock.fn(async () => Buffer.from(Array.from({ length: 100 }, (_, i) => `const value${i + 1} = ${i + 1};`).join("\n")));
		const read = createReadToolDefinition("/nonexistent", { operations: { access: async () => {}, readFile } });
		const args = Object.freeze({ path: "remote.ts", offset, limit });
		const validated = validateToolArguments(read, { type: "toolCall", id: "read", name: "read", arguments: args });
		const output = await read.execute("read", validated, undefined, undefined, { cwd: "/nonexistent" });
		const saved = JSON.parse(JSON.stringify({ args, output }));
		const before = JSON.stringify(saved);
		const r = f.row("read", saved.args, saved.output);
		assert.match(r.text(), /remote.ts:42-71/);
		assert.match(r.text(), /42 const value42 = 42;/);
		assert.match(r.text(), /Use offset=72 to continue/);
		assert.match(r.text(), /more \(/);
		assert.equal(fake.jobs.length, 1);
		assert.match(fake.jobs[0].input, /^const value42/);
		assert.doesNotMatch(fake.jobs[0].input, /Use offset|more lines in file/);
		r.row.setExpanded(true);
		assert.match(r.text(), /71 const value71 = 71;/);
		assert.equal(fake.jobs.length, 2);
		for (const job of fake.jobs) job.finish();
		assert.match(r.text(), /Read content · bat/);
		assert.equal(readFile.mock.callCount(), 1);
		assert.equal(JSON.stringify(saved), before);
	});
}

test("read, write, and edit share Bat requests, including when only the read offset changes", (t) => {
	const fake = fakeBat(t);
	t.mock.method(childProcess, "execFile", fake.launch);
	const f = fixture(t);
	f.start();
	const source = "const value = 1;";
	const args = { path: "shared.ts" };
	const read = f.row("read", { ...args, content: "not the returned content" }, result(source));
	const write = f.row("write", { ...args, content: source });
	const edit = f.row("edit", args, result("Success", { diff: diff("", source) }));
	for (const r of [read, write, edit]) r.text();
	assert.equal(fake.jobs.length, 1);
	assert.equal(fake.jobs[0].input, source);
	fake.jobs[0].finish();
	for (const r of [read, write, edit]) assert.match(r.text(), /· bat/);
	read.row.updateArgs({ ...args, offset: 91 });
	assert.match(read.text(), /91 const value = 1;/);
	assert.equal(fake.jobs.length, 1);
});

test("read keeps built-in line/byte truncation notices visible even when collapsed, and does not highlight oversize-line diagnostics", async (t) => {
	const fake = fakeBat(t);
	t.mock.method(childProcess, "execFile", fake.launch);
	const f = fixture(t);
	f.start();
	for (const source of ["line\n".repeat(2500), ("x".repeat(100) + "\n").repeat(1000), "x".repeat(60 * 1024)]) {
		const read = createReadToolDefinition("/nonexistent", { operations: {
			access: async () => {}, readFile: async () => Buffer.from(source),
		} });
		const output = await read.execute("read", { path: "remote.ts" }, undefined, undefined, { cwd: "/nonexistent" });
		assert.ok(output.details.truncation.truncated);
		const before = JSON.stringify(output);
		const jobsBefore = fake.jobs.length;
		const r = f.row("read", { path: "remote.ts" }, output);
		if (output.details.truncation.firstLineExceedsLimit) {
			assert.match(r.text(), /Line 1 .* exceeds .* limit/);
			assert.doesNotMatch(r.text(), /Read content|Pi colors|· bat/);
			assert.equal(fake.jobs.length, jobsBefore);
		} else {
			assert.match(r.text(), /\[Showing lines .*Use offset=\d+ to continue\.\]/);
			assert.doesNotMatch(fake.jobs.at(-1).input, /Use offset|Showing lines/);
			r.row.setExpanded(true);
			assert.match(r.text(), /Use offset=\d+ to continue/);
		}
		assert.equal(JSON.stringify(output), before);
	}
});

test("read preserves image rendering and hidden/unsupported-image placeholders without invoking Bat", (t) => {
	const fake = fakeBat(t);
	t.mock.method(childProcess, "execFile", fake.launch);
	const caps = getCapabilities();
	t.after(() => setCapabilities(caps));
	const f = fixture(t);
	f.start();
	const output = { content: [...content("Read image file [image/png]"), {
		type: "image", mimeType: "image/png",
		data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1kAAAAASUVORK5CYII=",
	}] };
	setCapabilities({ ...caps, images: null });
	const unsupported = f.row("read", { path: "image.png" }, output);
	unsupported.row.setExpanded(true);
	assert.match(unsupported.text(), /Read image file \[image\/png\]/);
	assert.match(unsupported.text(), /\[Image: \[image\/png\] 1x1\]/);
	setCapabilities({ ...caps, images: "kitty" });
	const supported = f.row("read", { path: "image.png" }, output);
	supported.row.setExpanded(true);
	assert.ok(supported.row.render(100).some((line) => line.includes("\x1b_G")));
	supported.row.setShowImages(false);
	assert.match(supported.text(), /\[Image: \[image\/png\] 1x1\]/);
	assert.ok(supported.row.render(100).every((line) => !line.includes("\x1b_G")));
	assert.equal(fake.jobs.length, 0);
});

test("read pending/errors stay plain, and a missing Bat falls back safely for narrow Unicode previews", (t) => {
	const fake = fakeBat(t);
	t.mock.method(childProcess, "execFile", fake.launch);
	const f = fixture(t);
	f.start();
	const pending = f.row("read", { path: "file.ts" }, null);
	pending.row.updateResult(result("partial"), true);
	assert.match(pending.text(), /Working/);
	const failed = f.row("read", { path: "file.ts" }, result("Permission denied"), true);
	assert.match(failed.text(), /Permission denied/);
	assert.equal(fake.jobs.length, 0);
	const r = f.row("read", { path: "中文\nfile.unknown", offset: 123 }, result("\t👩‍💻 é 中文\r\n\x1b]52;c;secret\x07\x00text\n" + "line\n".repeat(30)));
	assert.match(r.text(), /123 .*中文/);
	fake.jobs[0].finish(Object.assign(new Error("missing"), { code: "ENOENT" }), "");
	assert.match(r.text(), /Pi colors/);
	r.row.setExpanded(true);
	for (const width of [1, 2, 3, 12, 80]) fits(r.row, width);
	const ansi = r.row.render(100).join("\n");
	for (const control of ["\x1b]", "\x00", "\r", "\t"]) assert.ok(!ansi.includes(control));
	assert.equal(fake.jobs.length, 1);
});

test("real built-in remote operations and JSON-resumed rows retain actual edits without local reads", async (t) => {
	const f = fixture(t);
	let source = "const one = 1;\nconst two = 2;\n";
	const edit = createEditToolDefinition("/nonexistent", { operations: {
		access: async () => {}, readFile: async () => Buffer.from(source),
		writeFile: async (_path, text) => { source = text; },
	} });
	const args = { path: "remote.ts", edits: [
		{ oldText: "one = 1", newText: "one = 3" }, { oldText: "two = 2", newText: "two = 4" },
	] };
	const output = await edit.execute("call", args, undefined, undefined, { cwd: "/nonexistent" });
	assert.match(source, /one = 3/);
	const saved = JSON.parse(JSON.stringify({ args, output }));
	const live = f.row("edit", args, output);
	const resumed = fixture(t).row("edit", saved.args, saved.output);
	assert.equal(live.text(), resumed.text());
	const write = createWriteToolDefinition("/nonexistent", { operations: {
		mkdir: async () => {}, writeFile: async (_path, text) => { source = text; },
	} });
	const writeArgs = { path: "remote.ts", content: "entire rewrite" };
	const written = await write.execute("write", writeArgs, undefined, undefined, { cwd: "/nonexistent" });
	assert.equal(written.details, undefined);
	assert.match(f.row("write", writeArgs, written).text(), /entire rewrite/);
});

for (const mode of ["rpc", "json", "print"]) {
	test(`no highlighter processes in ${mode} mode, including renderer calls for exports`, (t) => {
		const fake = fakeBat(t);
		t.mock.method(childProcess, "execFile", fake.launch);
		const f = fixture(t);
		f.start(mode);
		assert.match(f.row().text(), /Pi colors/);
		assert.match(f.row("read", { path: "file.ts" }, result("const value = 1;")).text(), /Pi colors/);
		assert.equal(fake.jobs.length, 0);
	});
}

test("Bat updates pre-session history rows asynchronously, caches, and keeps calls independent", (t) => {
	const fake = fakeBat(t);
	t.mock.method(childProcess, "execFile", fake.launch);
	const f = fixture(t);
	const first = f.row();
	assert.match(first.text(), /Pi colors/);
	assert.equal(fake.jobs.length, 0);
	f.start();
	first.text();
	assert.equal(fake.jobs.length, 2);
	fake.jobs[0].finish();
	fake.jobs[1].finish();
	assert.match(first.text(), /· bat/);
	assert.ok(first.redraw.mock.callCount() > 0);
	const second = f.row();
	assert.match(second.text(), /· bat/);
	assert.equal(fake.jobs.length, 2, "identical snippets are reused across rows");
	const other = f.row("write", { path: "other.py", content: "print(42)" });
	assert.doesNotMatch(other.text(), /const value/);
	assert.equal(fake.jobs.length, 3, "old/new identical views deduplicate");
});

test("late Bat completions cannot replace a row's newer result", (t) => {
	const fake = fakeBat(t);
	t.mock.method(childProcess, "execFile", fake.launch);
	const f = fixture(t);
	f.start();
	const r = f.row("write", { path: "file.ts", content: "old content" });
	r.text();
	r.row.updateArgs({ path: "file.ts", content: "new content" });
	r.text();
	fake.jobs[0].finish();
	assert.match(r.text(), /new content/);
	assert.doesNotMatch(r.text(), /old content/);
	fake.jobs[1].finish();
	assert.match(r.text(), /· bat/);
});

test("large multi-hunk diffs cannot churn the Bat cache indefinitely", (t) => {
	const fake = fakeBat(t);
	t.mock.method(childProcess, "execFile", fake.launch);
	const f = fixture(t);
	f.start();
	const source = Array.from({ length: 40 }, (_, i) => `-${i + 1} const value = ${i};\n+${i + 1} const value = ${i + 1};\n     ...`).join("\n");
	const r = f.row("edit", { path: "file.ts" }, result("Success", { diff: source }));
	r.row.setExpanded(true);
	r.text();
	for (let i = 0; i < fake.jobs.length; i++) {
		assert.ok(i < 32, "highlighting did not settle");
		fake.jobs[i].finish();
		r.text();
	}
	assert.ok(fake.jobs.length <= 16);
	assert.match(r.text(), /bat \/ Pi colors/);
});

test("unrelated and unequal replacement runs do not get misleading word marks", (t) => {
	const f = fixture(t);
	const wordBg = backgroundAnsi(wordColor(theme.colors.toolDiffAdded), theme.getColorMode());
	for (const [before, after] of [["alpha beta", "123 xyz"], ["const value = 1;", "const value = 2;\nextra"]]) {
		const r = f.row("edit", { path: "file.ts" }, result("Success", { diff: diff(before, after) }));
		assert.ok(!r.row.render(100).join("\n").includes(wordBg));
	}
});

test("Bat follows Pi appearance and recolors when the theme changes", (t) => {
	const fake = fakeBat(t);
	const bat = new BatHighlighter(fake.launch);
	t.after(() => { bat.stop(); initTheme("dark"); });
	const previous = process.env.BAT_THEME;
	delete process.env.BAT_THEME;
	t.after(() => { if (previous !== undefined) process.env.BAT_THEME = previous; });
	bat.start();
	bat.request("source", "file.ts", theme, {}, () => {});
	assert.ok(fake.jobs[0].args.includes("--theme=dark"));
	initTheme("light");
	bat.request("source", "file.ts", theme, {}, () => {});
	assert.ok(fake.jobs[1].args.includes("--theme=light"));
});

test("HTML export is immediately readable without waiting for Bat", (t) => {
	const f = fixture(t);
	const renderer = createToolHtmlRenderer({ getToolRenderers: (name) => f.resolve(name, () => undefined), theme, cwd: "/missing" });
	assert.match(renderer.renderCall("call", "edit", { path: "saved.ts" }), /saved.ts/);
	const html = renderer.renderResult("call", "edit", content("Success"), { diff: diff() }, false);
	assert.match(html.expanded, /const/);
	assert.match(html.expanded, /Pi colors/);
	const readCall = renderer.renderCall("read-call", "read", { path: "saved.ts", offset: 42, limit: 1 });
	assert.match(readCall, /saved.ts/);
	assert.match(readCall, /:42-42/);
	const readHtml = renderer.renderResult("read-call", "read", content("const value = 1;\n\n[10 more lines in file. Use offset=43 to continue.]"), undefined, false);
	assert.match(readHtml.expanded, /Read content/);
	assert.match(readHtml.expanded, /42/);
	assert.match(readHtml.expanded, /offset=43/);
	assert.match(readHtml.expanded, /Pi colors/);
});

test("Bat invocation is shell-free, stdin-only, bounded, and honors theme environment", (t) => {
	const fake = fakeBat(t);
	const bat = new BatHighlighter(fake.launch);
	t.after(() => bat.stop());
	const previous = process.env.BAT_THEME;
	process.env.BAT_THEME = "Catppuccin Mocha";
	t.after(() => { if (previous === undefined) delete process.env.BAT_THEME; else process.env.BAT_THEME = previous; });
	const notify = t.mock.fn();
	bat.start();
	const path = "-file'; $(touch impossible).ts";
	const source = "const value = '中文 👩‍💻';";
	assert.equal(bat.request(source, path, theme, {}, notify), undefined);
	const job = fake.jobs[0];
	assert.equal(job.command, "bat");
	assert.equal(job.input, source);
	assert.ok(job.args.includes(`--file-name=${path}`));
	assert.ok(job.args.includes("--theme=Catppuccin Mocha"));
	assert.ok(job.args.includes("--no-config"));
	assert.ok(job.args.includes("--paging=never"));
	assert.ok(job.args.includes("--strip-ansi=always"));
	assert.deepEqual(job.args.slice(-2), ["--", "-"]);
	assert.equal(job.options.shell, undefined);
	assert.equal(job.options.timeout, 2000);
	assert.equal(job.options.maxBuffer, 1024 * 1024);
	job.finish();
	assert.equal(notify.mock.callCount(), 1);
	assert.equal(plain(bat.request(source, path, theme, {}, notify).join("\n")), source);
});

for (const failure of ["ENOENT", "EACCES", "timeout", "maxBuffer", "changed text", "terminal commands"]) {
	test(`Bat ${failure} falls back without retrying the same failed request`, (t) => {
		const fake = fakeBat(t);
		const bat = new BatHighlighter(fake.launch);
		t.after(() => bat.stop());
		bat.start();
		const client = {};
		const notify = t.mock.fn();
		bat.request("source", "file.ts", theme, client, notify);
		const error = failure === "changed text" || failure === "terminal commands" ? null : Object.assign(new Error(failure), { code: failure });
		fake.jobs[0].finish(error, failure === "terminal commands" ? "\x1b]52;c;secret\x07source" : "wrong");
		assert.equal(bat.request("source", "file.ts", theme, client, notify), undefined);
		assert.equal(fake.jobs.length, 1);
		assert.equal(notify.mock.callCount(), 1);
		if (failure === "ENOENT") {
			bat.request("another", "file.ts", theme, {}, notify);
			assert.equal(fake.jobs.length, 1, "missing Bat is not retried for every row");
		}
	});
}

test("Bat queues at most two processes, deduplicates listeners, and bounds the cache", (t) => {
	const fake = fakeBat(t);
	const bat = new BatHighlighter(fake.launch);
	t.after(() => bat.stop());
	bat.start();
	const notify = t.mock.fn();
	const client = {};
	for (let i = 0; i < 40; i++) bat.request(`source ${i}`, "file.ts", theme, client, notify);
	for (let i = 0; i < 10; i++) bat.request("source 0", "file.ts", theme, client, notify);
	assert.equal(fake.jobs.length, 2);
	for (let i = 0; i < fake.jobs.length; i++) fake.jobs[i].finish();
	assert.equal(fake.jobs.length, 32);
	assert.equal(notify.mock.callCount(), 32);
	bat.request("evicts completed work", "file.ts", theme, client, notify);
	assert.equal(fake.jobs.length, 33);
	bat.request("x".repeat(140_000), "file.ts", theme, client, notify);
	assert.equal(fake.jobs.length, 33);
});

test("shutdown kills active Bat children, discards queued work, and ignores late callbacks", (t) => {
	const fake = fakeBat(t);
	const bat = new BatHighlighter(fake.launch);
	const notify = t.mock.fn();
	bat.start();
	for (const source of ["one", "two", "three"]) bat.request(source, "file.ts", theme, {}, notify);
	fake.jobs[0].child.stdin.emit("error", new Error("EPIPE"));
	bat.stop();
	assert.ok(fake.jobs.every((job) => job.child.kill.mock.calls[0].arguments[0] === "SIGKILL"));
	for (const job of fake.jobs) job.finish();
	assert.equal(notify.mock.callCount(), 0);
	assert.equal(fake.jobs.length, 2);
	assert.equal(bat.request("one", "file.ts", theme, {}, notify), undefined);
});

test("installed Bat preserves Unicode, long lines, blank lines, and final-newline variants", async (t) => {
	const available = childProcess.spawnSync("bat", ["--version"], { encoding: "utf8" });
	if (available.error?.code === "ENOENT") { t.skip("bat is not exposed; no installation attempted"); return; }
	assert.equal(available.status, 0);
	const bat = new BatHighlighter();
	t.after(() => bat.stop());
	bat.start();
	for (const source of ["const 中文 = '👩‍💻';", "a".repeat(1000) + "\n", "one\n\n", "last line without newline"]) {
		await new Promise((resolve) => bat.request(source, "file.ts", theme, {}, resolve));
		const lines = bat.request(source, "file.ts", theme, {}, () => {});
		assert.ok(lines, "bat output was accepted");
		assert.equal(plain(lines.join("\n")), source);
		assert.notEqual(lines.join("\n"), source, "syntax color is present");
	}
});
