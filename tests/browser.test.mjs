import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
	const opened = await f.execute({ action: "open", url: "http://localhost:5173", headed: true });
	const config = `--config=${join(f.ctx.cwd, ".playwright-cli", opened.details.session, "browser.config.json")}`;
	assert.deepEqual(cliArgs(f.calls.at(-1)), ["open", "http://localhost:5173/", "--headed", config]);
	await f.execute({ action: "goto", url: "https://example.org/login" });
	assert.deepEqual(cliArgs(f.calls.at(-1)), ["goto", "https://example.org/login"]);
	process.env.PI_BROWSER_URL = "http://localhost:8080";
	await f.execute({ action: "open" });
	assert.deepEqual(cliArgs(f.calls.at(-1)), ["open", "http://localhost:8080/", config]);
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

test("open enforces isolated configuration without changing executable or sandbox settings", async (t) => {
	const f = await fixture(t);
	const inherited = {
		PLAYWRIGHT_MCP_CDP_ENDPOINT: "http://localhost:9222",
		PLAYWRIGHT_MCP_USER_DATA_DIR: "/personal/profile",
		PLAYWRIGHT_MCP_STORAGE_STATE: "/personal/cookies.json",
		PLAYWRIGHT_MCP_EXTENSION: "true",
		PLAYWRIGHT_MCP_ISOLATED: "false",
		PLAYWRIGHT_MCP_OUTPUT_DIR: "/shared/output",
		PLAYWRIGHT_MCP_EXECUTABLE_PATH: "/custom/chromium",
		PLAYWRIGHT_MCP_SANDBOX: "true",
	};
	for (const [key, value] of Object.entries(inherited)) {
		const previous = process.env[key];
		process.env[key] = value;
		t.after(() => {
			if (previous === undefined) delete process.env[key];
			else process.env[key] = previous;
		});
	}
	await mkdir(join(f.ctx.cwd, ".playwright"));
	await writeFile(join(f.ctx.cwd, ".playwright/cli.config.json"), JSON.stringify({ extension: true }));
	const result = await f.execute({ action: "open", url: "http://localhost:3000" });
	const call = f.calls.at(-1);
	const path = call.args.find((arg) => arg.startsWith("--config="))?.slice(9);
	const outputDir = join(f.ctx.cwd, ".playwright-cli", result.details.session);
	assert.equal(path, join(outputDir, "browser.config.json"));
	assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
		browser: {
			isolated: true, cdpEndpoint: "", remoteEndpoint: "", userDataDir: "",
			contextOptions: { storageState: { cookies: [], origins: [] } },
		},
		extension: false, outputDir,
	});
	for (const assignment of [
		"PLAYWRIGHT_MCP_CDP_ENDPOINT=", "PLAYWRIGHT_MCP_USER_DATA_DIR=", "PLAYWRIGHT_MCP_STORAGE_STATE=",
		"PLAYWRIGHT_MCP_EXTENSION=false", "PLAYWRIGHT_MCP_ISOLATED=true",
		`PLAYWRIGHT_MCP_OUTPUT_DIR=${outputDir}`, "PLAYWRIGHT_MCP_EXECUTABLE_PATH=/custom/chromium",
	]) assert.ok(call.args.includes(assignment), assignment);
	assert.ok(!call.args.some((arg) => arg.startsWith("PLAYWRIGHT_MCP_SANDBOX=")));
	assert.equal(process.env.PLAYWRIGHT_MCP_SANDBOX, "true");
});

for (const location of ["project", "environment"]) {
	test(`isolated launch preserves safe ${location} settings and source-relative scripts`, async (t) => {
		const f = await fixture(t);
		const directory = join(f.ctx.cwd, location === "project" ? ".playwright" : "other");
		await mkdir(directory);
		const sourcePath = join(directory, "cli.config.json");
		const previous = process.env.PLAYWRIGHT_MCP_CONFIG;
		process.env.PLAYWRIGHT_MCP_CONFIG = location === "project" ? "does-not-exist.json" : sourcePath;
		t.after(() => {
			if (previous === undefined) delete process.env.PLAYWRIGHT_MCP_CONFIG;
			else process.env.PLAYWRIGHT_MCP_CONFIG = previous;
		});
		await writeFile(sourcePath, JSON.stringify({
			browser: {
				launchOptions: { chromiumSandbox: true, slowMo: 50 },
				contextOptions: { viewport: { width: 900, height: 700 }, locale: "en-GB", storageState: "personal.json" },
				initPage: ["page.js"], initScript: ["scripts/init.js"],
			},
			network: { blockedOrigins: ["https://blocked.invalid"] }, timeouts: { action: 1234 },
		}));
		await f.execute({ action: "open", url: "http://localhost:3000" });
		const path = f.calls.at(-1).args.find((arg) => arg.startsWith("--config="))?.slice(9);
		const config = JSON.parse(await readFile(path, "utf8"));
		assert.deepEqual(config.browser.launchOptions, { chromiumSandbox: true, slowMo: 50 });
		assert.deepEqual(config.browser.contextOptions, {
			viewport: { width: 900, height: 700 }, locale: "en-GB", storageState: { cookies: [], origins: [] },
		});
		assert.deepEqual(config.browser.initPage, [join(directory, "page.js")]);
		assert.deepEqual(config.browser.initScript, [join(directory, "scripts/init.js")]);
		assert.deepEqual(config.network, { blockedOrigins: ["https://blocked.invalid"] });
		assert.deepEqual(config.timeouts, { action: 1234 });
	});
}

test("unreadable or unsupported launch configuration fails before executing Playwright", async (t) => {
	const f = await fixture(t);
	const previous = process.env.PLAYWRIGHT_MCP_CONFIG;
	process.env.PLAYWRIGHT_MCP_CONFIG = join(f.ctx.cwd, "missing.json");
	t.after(() => {
		if (previous === undefined) delete process.env.PLAYWRIGHT_MCP_CONFIG;
		else process.env.PLAYWRIGHT_MCP_CONFIG = previous;
	});
	await assert.rejects(f.execute({ action: "open", url: "http://localhost:3000" }), /ENOENT/);
	await writeFile(process.env.PLAYWRIGHT_MCP_CONFIG, "[browser]\nisolated=false");
	await assert.rejects(f.execute({ action: "open", url: "http://localhost:3000" }), /requires a JSON Playwright config/);
	assert.equal(f.calls.length, 0);
});

test("concurrent sessions cannot overwrite the same named screenshot", async (t) => {
	let firstWritten;
	const firstReady = new Promise((resolve) => { firstWritten = resolve; });
	let releaseFirst;
	const secondDone = new Promise((resolve) => { releaseFirst = resolve; });
	let screenshots = 0;
	const f = await fixture(t, async (_command, args) => {
		const filename = args.find((arg) => arg.startsWith("--filename="))?.slice(11);
		if (filename) {
			const number = ++screenshots;
			await writeFile(filename, `session ${number}`);
			if (number === 1) { firstWritten(); await secondDone; }
			else releaseFirst();
		}
		return { stdout: "ok", stderr: "", code: 0 };
	});
	const first = f.execute({ action: "screenshot", filename: "page" });
	await firstReady;
	const second = f.execute({ action: "screenshot", filename: "page" }, {
		...f.ctx, sessionManager: { getSessionId: () => "another-session" },
	});
	const results = await Promise.all([first, second]);
	assert.notEqual(results[0].details.artifactPath, results[1].details.artifactPath);
	assert.deepEqual(results.map((result) => Buffer.from(result.content[1].data, "base64").toString()), ["session 1", "session 2"]);
});

test("linked snapshots cannot read another session or follow an escaping symlink", async (t) => {
	let linkedPath;
	const f = await fixture(t, async (_command, args) => {
		const outputDir = args.find((arg) => arg.startsWith("PLAYWRIGHT_MCP_OUTPUT_DIR="))?.slice("PLAYWRIGHT_MCP_OUTPUT_DIR=".length);
		if (!linkedPath) {
			const secret = join(f.ctx.cwd, "private.txt");
			await writeFile(secret, "private contents");
			linkedPath = join(outputDir, "escape.yml");
			await symlink(secret, linkedPath);
		}
		return { stdout: `[Snapshot](${linkedPath})`, stderr: "", code: 0 };
	});
	const escaped = await f.execute({ action: "click", target: "e1" });
	assert.equal(escaped.details.snapshotPath, undefined);
	assert.ok(!escaped.content[0].text.includes("private contents"));
	await writeFile(join(dirname(linkedPath), "other.yml"), "another session's contents");
	linkedPath = join(dirname(linkedPath), "other.yml");
	const foreign = await f.execute({ action: "click", target: "e1" }, {
		...f.ctx, sessionManager: { getSessionId: () => "another-session" },
	});
	assert.equal(foreign.details.snapshotPath, undefined);
	assert.ok(!foreign.content[0].text.includes("another session's contents"));
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
			const outputDir = args.find((arg) => arg.startsWith("PLAYWRIGHT_MCP_OUTPUT_DIR="))?.slice("PLAYWRIGHT_MCP_OUTPUT_DIR=".length);
			const path = join(outputDir, "linked.yml");
			await writeFile(path, "- button Hello");
			return { stdout: `[Snapshot](${path})`, stderr: "", code: 0 };
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
			<output id="cookies"></output>
			<script>document.querySelector('#cookies').textContent = document.cookie</script>
		`);
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise((resolve) => server.close(resolve)));
	const f = await fixture(t, async (command, args, options) => {
		try {
			return { ...await run(command, args, {
				...options,
				env: {
					...process.env,
					HOME: join(options.cwd, ".home"),
					XDG_CACHE_HOME: join(options.cwd, ".cache"),
					PLAYWRIGHT_MCP_CDP_ENDPOINT: "http://127.0.0.1:1",
					PLAYWRIGHT_MCP_USER_DATA_DIR: join(options.cwd, "personal-profile"),
					PLAYWRIGHT_MCP_EXTENSION: "true",
					PLAYWRIGHT_MCP_ISOLATED: "false",
				},
				maxBuffer: 8 * 1024 * 1024,
			}), code: 0 };
		} catch (error) {
			return { stdout: error.stdout ?? "", stderr: error.stderr ?? "", code: error.code ?? 1 };
		}
	});
	const hostile = {
		browser: {
			cdpEndpoint: "http://127.0.0.1:1",
			remoteEndpoint: "http://127.0.0.1:1",
			userDataDir: join(f.ctx.cwd, "personal-profile"),
			launchOptions: { chromiumSandbox: true },
			contextOptions: { storageState: {
				cookies: [{ name: "private-cookie", value: "secret", domain: "127.0.0.1", path: "/", expires: -1, httpOnly: false, secure: false, sameSite: "Lax" }],
				origins: [],
			} },
		},
		extension: true,
	};
	for (const directory of [join(f.ctx.cwd, ".playwright"), join(f.ctx.cwd, ".home/.playwright")]) {
		await mkdir(directory, { recursive: true });
		await writeFile(join(directory, "cli.config.json"), JSON.stringify(hostile));
	}
	const opened = await f.execute({ action: "open", url: `http://127.0.0.1:${server.address().port}` });
	assert.equal(dirname(opened.details.snapshotPath), join(f.ctx.cwd, ".playwright-cli", opened.details.session));
	assert.ok(!opened.content[0].text.includes("private-cookie"));
	await f.execute({ action: "resize", width: 390, height: 844 });
	await f.execute({ action: "fill", target: "#name", text: "Hello Pi" });
	await f.execute({ action: "click", target: "button" });
	const snapshot = await f.execute({ action: "snapshot" });
	assert.match(snapshot.content[0].text, /Submitted: Hello Pi/);
	assert.ok(!snapshot.content[0].text.includes("private-cookie"));
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
