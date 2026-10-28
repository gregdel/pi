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
const { default: extension } = await jiti.import(join(here, "../extensions/status-bar.ts"));
const { SettingsManager } = await jiti.import("@earendil-works/pi-coding-agent");
const { visibleWidth } = await jiti.import("@earendil-works/pi-tui");
const flush = () => new Promise(setImmediate);
const now = Date.UTC(2026, 0, 1);
const token = (account = "test-account") => `header.${Buffer.from(JSON.stringify({
	"https://api.openai.com/auth": { chatgpt_account_id: account },
})).toString("base64url")}.signature`;
const window = (seconds, used, resetMinutes) => ({
	limit_window_seconds: seconds, used_percent: used, reset_at: now / 1000 + resetMinutes * 60,
});
const limits = (primary = window(18_000, 22, 150), secondary = window(604_800, 55, 4440)) => ({
	rate_limit: { primary_window: primary, secondary_window: secondary },
});
const response = (data = limits()) => new Response(JSON.stringify(data));

function fixture(t, { provider = "openai-codex", mode = "tui", oauth = true, fetch = async () => response() } = {}) {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now });
	t.mock.method(SettingsManager, "create", () => ({ getCompactionEnabled: () => true }));
	const request = t.mock.method(globalThis, "fetch", fetch);
	const handlers = new Map();
	let component;
	const redraw = t.mock.fn();
	const unsubscribe = t.mock.fn();
	const ctx = {
		mode, cwd: dirname(here), model: { provider, id: "test-model", contextWindow: 200_000 },
		isProjectTrusted: () => false,
		modelRegistry: {
			isUsingOAuth: () => oauth,
			getApiKeyForProvider: t.mock.fn(async () => token()),
			getProvider: () => ({ auth: { oauth: { isSubscription: true } } }),
		},
		getContextUsage: () => ({ percent: 10, contextWindow: 200_000 }),
		sessionManager: { getEntries: () => [], getSessionName: () => undefined, getCwd: () => "/project" },
		ui: { setFooter(factory) {
			component = factory({ requestRender: redraw }, {}, {
				onBranchChange: () => unsubscribe, getGitBranch: () => "main",
				getExtensionStatuses: () => new Map(), getAvailableProviderCount: () => 1,
			});
		} },
	};
	extension({ on: (name, handler) => handlers.set(name, handler) });
	const emit = (name) => handlers.get(name)?.({}, ctx);
	t.after(() => { emit("session_shutdown"); component?.dispose(); });
	return { ctx, request, redraw, unsubscribe, emit, component: () => component,
		text: (width = 500) => plain(component.render(width).join("\n")),
	};
}

test("Codex footer uses Pi auth and displays remaining quota and both reset countdowns", async (t) => {
	const f = fixture(t);
	assert.equal(f.request.mock.callCount(), 0, "loading the factory has no side effects");
	f.emit("session_start");
	await flush();
	assert.equal(f.request.mock.callCount(), 1);
	assert.deepEqual(f.ctx.modelRegistry.getApiKeyForProvider.mock.calls[0].arguments, ["openai-codex"]);
	const [url, options] = f.request.mock.calls[0].arguments;
	assert.equal(url, "https://chatgpt.com/backend-api/wham/usage");
	assert.equal(options.headers.Authorization, `Bearer ${token()}`);
	assert.equal(options.headers["ChatGPT-Account-Id"], "test-account");
	assert.equal(options.redirect, "error");
	assert.match(f.text(), /5h 78%\/2h30m · 1w 45%\/3d2h/);
	assert.ok(f.redraw.mock.callCount() > 0);
	assert.doesNotMatch(f.text(), /test-account|signature/);
	for (const width of [1, 20, 80, 160, 500]) {
		assert.ok(f.component().render(width).every((line) => visibleWidth(line) <= width));
	}
	assert.match(f.text(40), /5h\s+78%\/2h30m/);
});

test("refreshes once a minute with fresh credentials and updates the countdown", async (t) => {
	const f = fixture(t);
	f.emit("session_start");
	await flush();
	f.ctx.modelRegistry.getApiKeyForProvider.mock.mockImplementation(async () => token("refreshed-account"));
	t.mock.timers.tick(59_999);
	assert.equal(f.request.mock.callCount(), 1);
	t.mock.timers.tick(1);
	await flush();
	assert.equal(f.request.mock.callCount(), 2);
	assert.equal(f.request.mock.calls[1].arguments[1].headers["ChatGPT-Account-Id"], "refreshed-account");
	assert.match(f.text(), /5h 78%\/2h29m/);
});

for (const options of [{ mode: "rpc" }, { mode: "json" }, { mode: "print" }, { provider: "anthropic" }, { oauth: false }]) {
	test(`no usage requests outside Codex OAuth TUI: ${JSON.stringify(options)}`, async (t) => {
		const f = fixture(t, options);
		f.emit("session_start");
		f.emit("model_select");
		t.mock.timers.tick(120_000);
		await flush();
		assert.equal(f.request.mock.callCount(), 0);
		if (f.component()) assert.doesNotMatch(f.text(), /5h|1w|Codex limits/);
	});
}

for (const [name, data, expected] of [
	["weekly-only primary", limits(window(604_800, 0, 1440), null), /1w 100%\/1d0h/],
	["reversed windows", limits(window(604_800, 100, 60), window(18_000, 0, 5)), /5h 100%\/5m · 1w 0%\/1h0m/],
	["percentage bounds", limits(window(18_000, -5, 1), window(604_800, 110, 1440)), /5h 100%\/1m · 1w 0%/],
	["expired reset", limits(window(18_000, 30, 0), null), /5h \?\/resetting/],
	["unknown duration", limits(window(3600, 20, 20), null), /Codex limits unavailable/],
	["malformed window", limits({ used_percent: "20", reset_at: now / 1000, limit_window_seconds: 18_000 }, null), /Codex limits unavailable/],
	["missing reset", limits({ used_percent: 20, limit_window_seconds: 18_000 }, null), /Codex limits unavailable/],
	["empty payload", {}, /Codex limits unavailable/],
	["null payload", null, /Codex limits unavailable/],
]) {
	test(`handles ${name}`, async (t) => {
		const f = fixture(t, { fetch: async () => response(data) });
		f.emit("session_start");
		await flush();
		assert.match(f.text(), expected);
		if (name === "weekly-only primary") assert.doesNotMatch(f.text(), /5h/);
	});
}

for (const [name, fail] of [
	["network error", async () => { throw new Error("secret server body"); }],
	["unauthorized", async () => new Response("secret server body", { status: 401 })],
	["rate limited", async () => new Response("secret server body", { status: 429 })],
	["invalid JSON", async () => new Response("not JSON")],
]) {
	test(`${name} clears stale data and recovers on the next poll`, async (t) => {
		const f = fixture(t);
		f.emit("session_start");
		await flush();
		assert.match(f.text(), /5h 78%\//);
		f.request.mock.mockImplementation(fail);
		t.mock.timers.tick(60_000);
		await flush();
		assert.match(f.text(), /Codex limits unavailable/);
		assert.doesNotMatch(f.text(), /78%|secret|not JSON/);
		f.request.mock.mockImplementation(async () => response());
		t.mock.timers.tick(60_000);
		await flush();
		assert.match(f.text(), /5h 78%\//);
	});
}

for (const credential of [undefined, "invalid-token", token("")]) {
	test(`unusable credentials never trigger usage requests: ${credential === undefined ? "missing" : "invalid"}`, async (t) => {
		const f = fixture(t);
		f.ctx.modelRegistry.getApiKeyForProvider.mock.mockImplementation(async () => credential);
		f.emit("session_start");
		await flush();
		assert.equal(f.request.mock.callCount(), 0);
		assert.match(f.text(), /Codex limits unavailable/);
	});
}

test("slow requests do not overlap; switching models aborts and ignores late results", async (t) => {
	let finish;
	const f = fixture(t, { fetch: () => new Promise((resolve) => { finish = resolve; }) });
	f.emit("session_start");
	await flush();
	const signal = f.request.mock.calls[0].arguments[1].signal;
	t.mock.timers.tick(120_000);
	await flush();
	assert.equal(f.request.mock.callCount(), 1);
	f.ctx.model = { ...f.ctx.model, provider: "anthropic" };
	f.emit("model_select");
	assert.ok(signal.aborted);
	f.request.mock.mockImplementation(async () => response(limits(window(18_000, 50, 60), null)));
	f.ctx.model = { ...f.ctx.model, provider: "openai-codex" };
	f.emit("model_select");
	await flush();
	assert.match(f.text(), /5h 50%\//);
	finish(response());
	await flush();
	assert.match(f.text(), /5h 50%\//);
	assert.doesNotMatch(f.text(), /78%/);
});

for (const cleanup of ["session_shutdown", "dispose"]) {
	test(`${cleanup} aborts requests, stops polling, and prevents late redraws`, async (t) => {
		let finish;
		const f = fixture(t, { fetch: () => new Promise((resolve) => { finish = resolve; }) });
		f.emit("session_start");
		await flush();
		const signal = f.request.mock.calls[0].arguments[1].signal;
		if (cleanup === "dispose") {
			f.component().dispose();
			f.emit("model_select"); // Another extension may now own the footer.
		} else f.emit(cleanup);
		assert.ok(signal.aborted);
		const renders = f.redraw.mock.callCount();
		finish(response());
		t.mock.timers.tick(120_000);
		await flush();
		assert.equal(f.request.mock.callCount(), 1);
		assert.equal(f.redraw.mock.callCount(), renders);
	});
}
