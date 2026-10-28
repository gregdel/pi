import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(process.env.PI_PACKAGE_DIR
	? join(process.env.PI_PACKAGE_DIR, "package.json")
	: import.meta.url);
const { createJiti } = require("jiti");
const resolver = createJiti(process.env.PI_PACKAGE_DIR
	? join(process.env.PI_PACKAGE_DIR, "package.json")
	: import.meta.url);
const jiti = createJiti(import.meta.url, {
	fsCache: false,
	moduleCache: false,
	alias: Object.fromEntries([
		"@earendil-works/pi-ai",
		"@earendil-works/pi-coding-agent",
		"typebox",
	].map((name) => [name, fileURLToPath(resolver.esmResolve(
		name === "@earendil-works/pi-ai" ? `${name}/compat` : name,
	))])),
});
const factory = await jiti.import(join(here, "../extensions/browser.ts"), { default: true });
const run = promisify(execFile);

async function fixture(t, exec = async () => ({ stdout: "ok", stderr: "", code: 0, killed: false })) {
	const cwd = await mkdtemp(join(here, ".browser-test-"));
	const calls = [];
	const notifications = [];
	const handlers = new Map();
	let tool;
	factory({
		registerTool(value) { tool = value; },
		on(name, handler) { handlers.set(name, handler); },
		async exec(command, args, options) {
			calls.push({ command, args, options });
			return exec(command, args, options);
		},
	});
	const ctx = {
		cwd,
		sessionManager: { getSessionId: () => "test-session" },
		ui: { notify(message, level) { notifications.push({ message, level }); } },
	};
	const shutdown = () => handlers.get("session_shutdown")({}, ctx);
	t.after(async () => {
		await shutdown();
		await rm(cwd, { recursive: true, force: true });
	});
	return {
		tool, ctx, calls, notifications, shutdown,
		execute: (params, context = ctx) => tool.execute("test", params, undefined, undefined, context),
	};
}

function cliArgs(call) {
	return call.args.slice(call.args.indexOf("cli") + 2);
}

test("generic HTTP(S) navigation and validation before execution", async (t) => {
	const f = await fixture(t);
	assert.equal(f.tool.name, "browser");
	assert.equal(f.tool.executionMode, "sequential");
	const previous = process.env.PI_BROWSER_URL;
	delete process.env.PI_BROWSER_URL;
	t.after(() => {
		if (previous === undefined) delete process.env.PI_BROWSER_URL;
		else process.env.PI_BROWSER_URL = previous;
	});
	await assert.rejects(f.execute({ action: "open" }), /requires/);
	for (const url of ["file:///etc/passwd", "javascript:alert(1)", "/relative", "ftp://example.org"]) {
		await assert.rejects(f.execute({ action: "open", url }));
	}
	assert.equal(f.calls.length, 0);
	await f.execute({ action: "open", url: "http://localhost:5173", headed: true });
	assert.deepEqual(cliArgs(f.calls.at(-1)), ["open", "http://localhost:5173/", "--headed"]);
	await f.execute({ action: "goto", url: "https://example.org/login" });
	assert.deepEqual(cliArgs(f.calls.at(-1)), ["goto", "https://example.org/login"]);
	process.env.PI_BROWSER_URL = "http://localhost:8080";
	await f.execute({ action: "open" });
	assert.deepEqual(cliArgs(f.calls.at(-1)), ["open", "http://localhost:8080/"]);
});

test("action arguments preserve text without shell interpolation", async (t) => {
	const f = await fixture(t);
	const text = '"; $(touch unsafe) --flag\nhello';
	const cases = [
		[{ action: "fill", target: "e2", text, submit: true }, ["fill", "--submit", "--", "e2", text]],
		[{ action: "fill", target: "e2", text: "" }, ["fill", "--", "e2", ""]],
		[{ action: "type", text }, ["type", "--", text]],
		[{ action: "click", target: "e1" }, ["click", "e1"]],
		[{ action: "hover", target: "e1" }, ["hover", "e1"]],
		[{ action: "select", target: "e1", value: "option" }, ["select", "--", "e1", "option"]],
		[{ action: "check", target: "e1" }, ["check", "e1"]],
		[{ action: "uncheck", target: "e1" }, ["uncheck", "e1"]],
		[{ action: "press", key: "Enter" }, ["press", "Enter"]],
		[{ action: "resize", width: 390, height: 844 }, ["resize", "390", "844"]],
		[{ action: "console", level: "error" }, ["console", "error"]],
		[{ action: "requests" }, ["requests"]],
		[{ action: "reload" }, ["reload"]],
		[{ action: "back" }, ["go-back"]],
		[{ action: "forward" }, ["go-forward"]],
	];
	for (const [params, expected] of cases) {
		await f.execute(params);
		assert.deepEqual(cliArgs(f.calls.at(-1)), expected);
	}
	for (const params of [{ action: "click" }, { action: "fill", target: "e1" }, { action: "resize", width: 390 }]) {
		await assert.rejects(f.execute(params), /requires/);
	}
});

test("option-like text and select values remain positional", async (t) => {
	const f = await fixture(t);
	for (const text of ["--help", "--submit", "--session=other", "-x", "--", "true", "false", ""]) {
		for (const submit of [false, true]) {
			await f.execute({ action: "fill", target: "e2", text, submit });
			assert.deepEqual(cliArgs(f.calls.at(-1)), ["fill", ...(submit ? ["--submit"] : []), "--", "e2", text]);
		}
		await f.execute({ action: "type", text });
		assert.deepEqual(cliArgs(f.calls.at(-1)), ["type", "--", text]);
		if (text !== "") {
			await f.execute({ action: "select", target: "e2", value: text });
			assert.deepEqual(cliArgs(f.calls.at(-1)), ["select", "--", "e2", text]);
		}
	}
});

test("select permits an empty value but still requires a value and target", async (t) => {
	const f = await fixture(t);
	await f.execute({ action: "select", target: "e2", value: "" });
	assert.deepEqual(cliArgs(f.calls.at(-1)), ["select", "--", "e2", ""]);
	const count = f.calls.length;
	for (const params of [
		{ action: "select", target: "e2" },
		{ action: "select", value: "" },
		{ action: "select", target: "", value: "" },
	]) {
		await assert.rejects(f.execute(params), /requires/);
	}
	assert.equal(f.calls.length, count);
});

test("isolates sessions and only cleans up browsers used by this runtime", async (t) => {
	const f = await fixture(t);
	await f.shutdown();
	assert.equal(f.calls.length, 0);
	const first = await f.execute({ action: "open", url: "http://localhost:3000" });
	const second = await f.execute({ action: "open", url: "http://localhost:3000" }, {
		...f.ctx, sessionManager: { getSessionId: () => "another-session" },
	});
	assert.notEqual(first.details.session, second.details.session);
	await f.shutdown();
	assert.deepEqual(f.calls.slice(-2).map(cliArgs), [["close"], ["close"]]);
	const count = f.calls.length;
	await f.shutdown();
	assert.equal(f.calls.length, count);
	await f.execute({ action: "open", url: "http://localhost:3000" });
	await f.execute({ action: "close" });
	const closedCount = f.calls.length;
	await f.shutdown();
	assert.equal(f.calls.length, closedCount);
});

test("failed launches remain eligible for cleanup", async (t) => {
	const f = await fixture(t, async (_command, args) => ({
		stdout: "", stderr: "launch failed", code: args.includes("open") ? 1 : 0,
	}));
	await assert.rejects(f.execute({ action: "open", url: "http://localhost:3000" }), /launch failed/);
	await f.shutdown();
	assert.deepEqual(cliArgs(f.calls.at(-1)), ["close"]);
});

test("interrupted actions reject even with exit code zero", async (t) => {
	let output = "partial output";
	const f = await fixture(t, async () => ({
		stdout: output, stderr: "", code: 0, killed: true,
	}));
	for (const params of [
		{ action: "goto", url: "http://localhost:3000" },
		{ action: "click", target: "e1" },
		{ action: "snapshot" },
		{ action: "screenshot" },
	]) {
		await assert.rejects(f.execute(params), /interrupted \(timeout or cancellation\)\npartial output/);
	}
	output = "";
	await assert.rejects(f.execute({ action: "reload" }), /interrupted \(timeout or cancellation\)/);
});

test("interrupted opens remain eligible for cleanup", async (t) => {
	const f = await fixture(t, async (_command, args) => ({
		stdout: "", stderr: "", code: 0, killed: args.includes("open"),
	}));
	await assert.rejects(f.execute({ action: "open", url: "http://localhost:3000" }), /interrupted/);
	await f.shutdown();
	assert.deepEqual(cliArgs(f.calls.at(-1)), ["close"]);
	assert.equal(f.notifications.length, 0);
});

test("interrupted explicit closes remain eligible for cleanup", async (t) => {
	let interruptClose = true;
	const f = await fixture(t, async (_command, args) => ({
		stdout: "", stderr: "", code: 0, killed: args.includes("close") && interruptClose,
	}));
	await f.execute({ action: "open", url: "http://localhost:3000" });
	await assert.rejects(f.execute({ action: "close" }), /interrupted/);
	interruptClose = false;
	await f.shutdown();
	assert.deepEqual(f.calls.slice(-2).map(cliArgs), [["close"], ["close"]]);
	const count = f.calls.length;
	await f.shutdown();
	assert.equal(f.calls.length, count);
});

test("interrupted shutdown closes warn and remain tracked until successful", async (t) => {
	let interruptClose = true;
	const f = await fixture(t, async (_command, args) => ({
		stdout: "", stderr: args.includes("close") ? "partial close" : "", code: 0,
		killed: args.includes("close") && interruptClose,
	}));
	await f.execute({ action: "open", url: "http://localhost:3000" });
	await f.shutdown();
	assert.equal(f.notifications.length, 1);
	assert.equal(f.notifications[0].level, "warning");
	assert.match(f.notifications[0].message, /Could not close browser .*interrupted/);
	assert.match(f.notifications[0].message, /partial close/);
	interruptClose = false;
	await f.shutdown();
	assert.deepEqual(f.calls.slice(-2).map(cliArgs), [["close"], ["close"]]);
	const count = f.calls.length;
	await f.shutdown();
	assert.equal(f.calls.length, count);
	assert.equal(f.notifications.length, 1);
});

test("snapshots, screenshot images, safe filenames, and full truncated output", async (t) => {
	const large = "snapshot line\n".repeat(2100);
	const png = Buffer.from("test png bytes");
	const f = await fixture(t, async (_command, args, options) => {
		const filename = args.find((arg) => arg.startsWith("--filename="))?.slice(11);
		if (filename) await writeFile(filename, args.includes("screenshot") ? png : large);
		if (args.includes("click")) {
			await writeFile(join(options.cwd, ".playwright-cli/linked.yml"), "- button Hello");
			return { stdout: "[Snapshot](.playwright-cli/linked.yml)", stderr: "", code: 0 };
		}
		return { stdout: "ok", stderr: "", code: 0 };
	});
	for (const filename of ["../escape", "/absolute", ".", "..", "sub/path"]) {
		await assert.rejects(f.execute({ action: "screenshot", filename }), /plain file name/);
	}
	const snapshot = await f.execute({ action: "snapshot", filename: "page", depth: 3, boxes: true });
	assert.equal(snapshot.details.truncated, true);
	assert.equal(await readFile(snapshot.details.fullOutputPath, "utf8"), large);
	assert.match(snapshot.content[0].text, /Output truncated/);
	const click = await f.execute({ action: "click", target: "e1" });
	assert.match(click.content[0].text, /button Hello/);
	const screenshot = await f.execute({ action: "screenshot", filename: "page", fullPage: true, hires: true });
	assert.equal(screenshot.content[1].mimeType, "image/png");
	assert.equal(screenshot.content[1].data, png.toString("base64"));
	assert.ok(f.calls.at(-1).args.includes("--full-page"));
	assert.ok(f.calls.at(-1).args.includes("--hires"));
});

test("real Playwright/Chromium UI smoke test", { skip: process.env.PI_BROWSER_SMOKE !== "1" }, async (t) => {
	const server = createServer((_req, res) => {
		res.setHeader("Content-Type", "text/html");
		res.end(`
			<title>Browser smoke</title>
			<form onsubmit="event.preventDefault(); document.querySelector('#submitted').textContent = 'Submitted: ' + document.querySelector('#name').value">
				<label>Name<input id="name"></label><button type="submit">Save</button>
			</form>
			<output id="submitted"></output>
			<label>Choice<select id="choice" onchange="document.querySelector('#selected').textContent = 'Selected: [' + this.value + ']'">
				<option value="">Reset</option><option value="--help">Literal help</option>
			</select></label>
			<output id="selected"></output>
		`);
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise((resolve) => server.close(resolve)));
	const f = await fixture(t, async (command, args, options) => {
		try {
			return { ...await run(command, args, {
				...options,
				env: { ...process.env, XDG_CACHE_HOME: join(options.cwd, ".cache") },
				maxBuffer: 8 * 1024 * 1024,
			}), code: 0 };
		} catch (error) {
			return { stdout: error.stdout ?? "", stderr: error.stderr ?? "", code: error.code ?? 1 };
		}
	});
	await f.execute({ action: "open", url: `http://127.0.0.1:${server.address().port}` });
	await f.execute({ action: "resize", width: 390, height: 844 });
	await f.execute({ action: "fill", target: "#name", text: "Hello Pi" });
	await f.execute({ action: "click", target: "button" });
	const snapshot = await f.execute({ action: "snapshot" });
	assert.match(snapshot.content[0].text, /Submitted: Hello Pi/);
	await f.execute({ action: "fill", target: "#name", text: "--help" });
	assert.ok((await f.execute({ action: "snapshot" })).content[0].text.includes("--help"));
	await f.execute({ action: "fill", target: "#name", text: "" });
	await f.execute({ action: "click", target: "#name" });
	await f.execute({ action: "type", text: "--session=other" });
	assert.ok((await f.execute({ action: "snapshot" })).content[0].text.includes("--session=other"));
	await f.execute({ action: "fill", target: "#name", text: "--submit", submit: true });
	assert.ok((await f.execute({ action: "snapshot" })).content[0].text.includes("Submitted: --submit"));
	await f.execute({ action: "select", target: "#choice", value: "--help" });
	assert.ok((await f.execute({ action: "snapshot" })).content[0].text.includes("Selected: [--help]"));
	await f.execute({ action: "select", target: "#choice", value: "" });
	assert.ok((await f.execute({ action: "snapshot" })).content[0].text.includes("Selected: []"));
	const screenshot = await f.execute({ action: "screenshot" });
	assert.equal(Buffer.from(screenshot.content[1].data, "base64").subarray(1, 4).toString(), "PNG");
	await f.execute({ action: "console", level: "error" });
	await f.execute({ action: "requests" });
	await f.execute({ action: "close" });
});
