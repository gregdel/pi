import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);
const packageFile = process.env.PI_PACKAGE_DIR
	? join(process.env.PI_PACKAGE_DIR, "package.json") : import.meta.url;
const { createJiti } = createRequire(packageFile)("jiti");
const resolver = createJiti(packageFile, { fsCache: false });
const jiti = createJiti(import.meta.url, {
	fsCache: false, moduleCache: false,
	alias: Object.fromEntries([
		"@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox",
	].map((name) => [name, fileURLToPath(resolver.esmResolve(name === "@earendil-works/pi-ai" ? `${name}/compat` : name))])),
});
const { DefaultResourceLoader, ProjectTrustStore, SettingsManager } = await jiti.import("@earendil-works/pi-coding-agent");
const { expandProfileTask, loadProfile } = await jiti.import(join(root, "extensions/subagents.ts"));

async function fixture(t) {
	const dir = await mkdtemp(join(here, ".package-test-"));
	const cwd = join(dir, "project");
	const agentDir = join(dir, "agent");
	await mkdir(cwd);
	await mkdir(agentDir);
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	t.after(async () => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		await rm(dir, { recursive: true, force: true });
	});
	return { cwd, agentDir, ctx: { cwd, isProjectTrusted: () => false } };
}

async function write(path, content) {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, content);
}

function loader(f, packages = [root]) {
	return new DefaultResourceLoader({
		cwd: f.cwd, agentDir: f.agentDir,
		settingsManager: SettingsManager.inMemory({ packages }),
		noSkills: true, noThemes: true, noContextFiles: true,
		disabledBuiltinExtensions: ["mcp", "llama.cpp", "codemode", "tool-search"],
	});
}

const profile = (name, instructions = "User instructions") =>
	`---\nname: ${name}\ndescription: Test profile\ntemplate: plan\n---\n${instructions}\n`;
const prompt = (filePath, content) => ({ name: "plan", filePath, content });

test("Pi loads all six package extensions and four prompts without dotfiles", async (t) => {
	const f = await fixture(t);
	const resources = loader(f);
	await resources.reload();
	assert.deepEqual(resources.getExtensions().errors, []);
	assert.deepEqual(resources.getExtensions().extensions.map((item) => item.path).sort(), [
		"ask-question", "browser", "keep-model-on-new", "status-bar", "subagents", "workon",
	].map((name) => join(root, "extensions", `${name}.ts`)).sort());
	assert.deepEqual(resources.getPrompts().diagnostics, []);
	assert.deepEqual(resources.getPrompts().prompts.map((item) => item.name).sort(), ["plan", "ponytail", "review", "update-memory"]);
	const planner = loadProfile("planner", f.ctx);
	assert.equal(planner.source, "package");
	const task = 'Investigate "quoted input"\nKeep $1 and $ARGUMENTS literal';
	assert.ok(expandProfileTask(planner, task, f.cwd, resources.getPrompts().prompts).includes(task));

	// Exercise the deferred YAML import through Pi's real extension loader.
	await write(join(f.cwd, ".pi/flow_test.yaml"), "steps: []\n");
	const flow = resources.getExtensions().extensions.find((item) => item.path.endsWith("/workon.ts"));
	const notices = [];
	await flow.commands.get("flow").handler("test task", {
		...f.ctx, isProjectTrusted: () => true, isIdle: () => true,
		ui: { setStatus() {}, notify(message) { notices.push(message); } },
	});
	assert.deepEqual(notices, ["flow stopped: flow test: steps must be a non-empty list"]);
});

test("the example narrows loading to questions, subagents, and the planning prompt", async (t) => {
	const f = await fixture(t);
	const example = JSON.parse(await readFile(join(root, "examples/settings.json"), "utf8"));
	example.packages[0].source = root;
	const resources = loader(f, example.packages);
	await resources.reload();
	assert.deepEqual(resources.getExtensions().errors, []);
	assert.deepEqual(resources.getExtensions().extensions.map((item) => item.path).sort(), [
		join(root, "extensions/ask-question.ts"), join(root, "extensions/subagents.ts"),
	]);
	assert.deepEqual(resources.getPrompts().prompts.map((item) => item.name), ["plan"]);
});

test("Pi's prompt discovery preserves personal planning-template overrides", async (t) => {
	const f = await fixture(t);
	const path = join(f.agentDir, "prompts/plan.md");
	await write(path, "---\ndescription: Personal plan\n---\nPersonal $ARGUMENTS");
	const resources = loader(f);
	await resources.reload();
	assert.deepEqual(resources.getExtensions().errors, []);
	assert.equal(resources.getPrompts().prompts.find((item) => item.name === "plan").filePath, path);
	assert.equal(expandProfileTask(loadProfile("planner", f.ctx), "task", f.cwd, resources.getPrompts().prompts), "Personal task");
});

test("personal profiles override bundled defaults, including malformed profiles", async (t) => {
	const f = await fixture(t);
	const path = join(f.agentDir, "agents/planner.md");
	await write(path, profile("planner"));
	assert.equal(loadProfile("planner", f.ctx).source, "user");
	assert.match(loadProfile("planner", f.ctx).instructions, /User instructions/);
	await write(path, "not a profile");
	assert.throws(() => loadProfile("planner", f.ctx), /Invalid agent profile/);
});

test("project profiles require both current trust and a saved trust decision", async (t) => {
	const f = await fixture(t);
	await write(join(f.cwd, ".pi/agents/planner.md"), profile("planner", "Project instructions"));
	assert.equal(loadProfile("planner", f.ctx).source, "package");
	const trusted = { ...f.ctx, isProjectTrusted: () => true };
	assert.equal(loadProfile("planner", trusted).source, "package");
	new ProjectTrustStore(f.agentDir).set(f.cwd, true);
	assert.equal(loadProfile("planner", f.ctx).source, "package");
	assert.equal(loadProfile("planner", trusted).source, "project");
	assert.match(loadProfile("planner", trusted).instructions, /Project instructions/);
});

test("unknown project-only profiles fail closed without saved trust", async (t) => {
	const f = await fixture(t);
	await write(join(f.cwd, ".pi/agents/custom.md"), profile("custom"));
	assert.throws(() => loadProfile("custom", f.ctx), /requires saved project trust/);
	for (const name of ["../planner", "/planner", "Planner", ""]) {
		assert.throws(() => loadProfile(name, f.ctx), /Agent profile name must match/);
	}
});

test("template precedence preserves personal overrides and project isolation", async (t) => {
	const f = await fixture(t);
	const planner = loadProfile("planner", f.ctx);
	const bundled = prompt(join(root, "prompts/plan.md"), "Package $ARGUMENTS");
	const user = prompt(join(f.agentDir, "prompts/plan.md"), "User $ARGUMENTS");
	const project = prompt(join(f.cwd, ".pi/prompts/plan.md"), "Project $ARGUMENTS");
	const unrelated = prompt(join(f.cwd, "other-package/plan.md"), "Other $ARGUMENTS");
	const prompts = [unrelated, project, bundled, user];
	assert.equal(expandProfileTask(planner, "task", f.cwd, prompts), "User task");
	assert.equal(expandProfileTask(planner, "task", f.cwd, [unrelated, project, bundled]), "Package task");
	assert.equal(expandProfileTask({ ...planner, source: "user" }, "task", f.cwd, prompts), "User task");
	assert.equal(expandProfileTask({ ...planner, source: "project" }, "task", f.cwd, prompts), "Project task");
	assert.throws(() => expandProfileTask(planner, "task", f.cwd, [project, unrelated]), /requires a prompt template/);
	assert.throws(() => expandProfileTask(planner, "task", f.cwd, [{ ...bundled, content: "No argument placeholder" }]), /must contain \$ARGUMENTS/);
});
