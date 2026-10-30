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
const { childExtensionFactories, expandProfileTask, loadProfile } = await jiti.import(join(root, "extensions/subagents.ts"));

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

function loader(f, packages = [root], options = {}) {
	return new DefaultResourceLoader({
		cwd: f.cwd, agentDir: f.agentDir,
		settingsManager: SettingsManager.inMemory({ packages }),
		noSkills: true, noThemes: true, noContextFiles: true,
		disabledBuiltinExtensions: ["mcp", "llama.cpp", "codemode", "tool-search"],
		...options,
	});
}

const profile = (name, instructions = "User instructions") =>
	`---\nname: ${name}\ndescription: Test profile\ntemplate: plan\n---\n${instructions}\n`;
const prompt = (filePath, content) => ({ name: "plan", filePath, content });

async function customProfile(f) {
	await write(join(f.agentDir, "agents/custom.md"), profile("custom"));
	return loadProfile("custom", f.ctx);
}

test("Pi loads all six package extensions and four prompts without dotfiles", async (t) => {
	const f = await fixture(t);
	const resources = loader(f);
	await resources.reload();
	assert.deepEqual(resources.getExtensions().errors, []);
	assert.deepEqual(resources.getExtensions().extensions.map((item) => item.path).sort(), [
		"ask-question", "browser", "keep-model-on-new", "pretty-diff", "status-bar", "subagents",
	].map((name) => join(root, "extensions", `${name}.ts`)).sort());
	assert.deepEqual(resources.getPrompts().diagnostics, []);
	assert.deepEqual(resources.getPrompts().prompts.map((item) => item.name).sort(), ["plan", "ponytail", "review", "update-memory"]);
	assert.throws(() => loadProfile("planner", f.ctx), /Could not read agent profile/);
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
	assert.equal(expandProfileTask(await customProfile(f), "task", f.cwd, resources.getPrompts().prompts), "Personal task");
});

test("personal profiles load and malformed profiles fail explicitly", async (t) => {
	const f = await fixture(t);
	const custom = await customProfile(f);
	assert.equal(custom.source, "user");
	assert.match(custom.instructions, /User instructions/);
	await write(join(f.agentDir, "agents/custom.md"), "not a profile");
	assert.throws(() => loadProfile("custom", f.ctx), /Invalid agent profile/);
});

test("project profiles require both current trust and a saved trust decision", async (t) => {
	const f = await fixture(t);
	await customProfile(f);
	await write(join(f.cwd, ".pi/agents/custom.md"), profile("custom", "Project instructions"));
	assert.equal(loadProfile("custom", f.ctx).source, "user");
	const trusted = { ...f.ctx, isProjectTrusted: () => true };
	assert.equal(loadProfile("custom", trusted).source, "user");
	new ProjectTrustStore(f.agentDir).set(f.cwd, true);
	assert.equal(loadProfile("custom", f.ctx).source, "user");
	assert.equal(loadProfile("custom", trusted).source, "project");
	assert.match(loadProfile("custom", trusted).instructions, /Project instructions/);
});

test("unknown project-only profiles fail closed without saved trust", async (t) => {
	const f = await fixture(t);
	await write(join(f.cwd, ".pi/agents/custom.md"), profile("custom"));
	assert.throws(() => loadProfile("custom", f.ctx), /requires saved project trust/);
	for (const name of ["../custom", "/custom", "Custom", ""]) {
		assert.throws(() => loadProfile(name, f.ctx), /Agent profile name must match/);
	}
});

test("template precedence preserves personal overrides and project isolation", async (t) => {
	const f = await fixture(t);
	const custom = await customProfile(f);
	const bundled = prompt(join(root, "prompts/plan.md"), "Package $ARGUMENTS");
	const user = prompt(join(f.agentDir, "prompts/plan.md"), "User $ARGUMENTS");
	const project = prompt(join(f.cwd, ".pi/prompts/plan.md"), "Project $ARGUMENTS");
	const unrelated = prompt(join(f.cwd, "other-package/plan.md"), "Other $ARGUMENTS");
	const prompts = [unrelated, project, bundled, user];
	assert.equal(expandProfileTask(custom, "task", f.cwd, prompts), "User task");
	assert.equal(expandProfileTask(custom, "task", f.cwd, [unrelated, project, bundled]), "Package task");
	assert.equal(expandProfileTask({ ...custom, source: "project" }, "task", f.cwd, prompts), "Project task");
	assert.throws(() => expandProfileTask(custom, "task", f.cwd, [project, unrelated]), /requires a prompt template/);
	assert.throws(() => expandProfileTask(custom, "task", f.cwd, [{ ...bundled, content: "No argument placeholder" }]), /must contain \$ARGUMENTS/);
});

test("profile task expansion treats replacement metacharacters literally", async (t) => {
	const f = await fixture(t);
	const custom = await customProfile(f);
	const task = "quotes '\"\n$$ $& $` $' $1 $ARGUMENTS";
	const templates = [prompt(join(root, "prompts/plan.md"), "before $ARGUMENTS between $ARGUMENTS after")];
	assert.equal(expandProfileTask(custom, task, f.cwd, templates), `before ${task} between ${task} after`);
});

for (const trusted of [false, true]) {
	test(`real Pi dedup preserves allowed fallback and user precedence (trusted=${trusted})`, async (t) => {
		const f = await fixture(t);
		const settings = SettingsManager.create(f.cwd, f.agentDir, { projectTrusted: trusted });
		await write(join(f.agentDir, "settings.json"), JSON.stringify({ packages: [root] }));
		const projectPath = join(f.cwd, ".pi/prompts/plan.md");
		await write(projectPath, "Project $ARGUMENTS");
		const resources = loader(f, [root], { settingsManager: settings });
		await resources.reload();
		const custom = await customProfile(f);
		const expand = (source = "user") => {
			const { prompts, diagnostics } = resources.getPrompts();
			return expandProfileTask({ ...custom, source }, "task", f.cwd, prompts, diagnostics);
		};
		const bundled = expand();
		assert.notEqual(bundled, "Project task");
		assert.ok(bundled.includes("task"));
		assert.equal(expand("project"), trusted ? "Project task" : bundled);
		if (trusted) assert.ok(resources.getPrompts().diagnostics.some((d) => d.collision?.loserPath === join(root, "prompts/plan.md")));

		await write(join(f.agentDir, "prompts/plan.md"), "Personal $ARGUMENTS");
		await resources.reload();
		assert.equal(expand(), "Personal task");
		assert.equal(expand("project"), trusted ? "Project task" : "Personal task");
	});
}

for (const filter of [[], ["!prompts/plan.md"], ["-prompts/plan.md"]]) {
	test(`dedup fallback never revives a package-disabled template ${JSON.stringify(filter)}`, async (t) => {
		const f = await fixture(t);
		await write(join(f.cwd, ".pi/prompts/plan.md"), "Project $ARGUMENTS");
		const resources = loader(f, [{ source: root, prompts: filter }], {
			settingsManager: SettingsManager.inMemory({ packages: [{ source: root, prompts: filter }] }, { projectTrusted: true }),
		});
		await resources.reload();
		const { prompts, diagnostics } = resources.getPrompts();
		const custom = await customProfile(f);
		assert.throws(() => expandProfileTask(custom, "task", f.cwd, prompts, diagnostics), /requires a prompt template/);
	});
}

test("disabled personal prompts do not override enabled bundled fallback", async (t) => {
	const f = await fixture(t);
	await write(join(f.agentDir, "prompts/plan.md"), "Disabled $ARGUMENTS");
	await write(join(f.agentDir, "settings.json"), JSON.stringify({ packages: [root], prompts: ["-prompts/plan.md"] }));
	const resources = loader(f, [root], { settingsManager: SettingsManager.create(f.cwd, f.agentDir) });
	await resources.reload();
	const { prompts, diagnostics } = resources.getPrompts();
	assert.doesNotMatch(expandProfileTask(await customProfile(f), "task", f.cwd, prompts, diagnostics), /Disabled/);
});

test("child built-in factories follow parent registrations and Pi enablement/replacement rules", async (t) => {
	const f = await fixture(t);
	const parent = {
		getAllTools: () => [{ name: "codemode" }, { name: "tool_search" }],
		getCommands: () => [{ name: "mcp", source: "extension" }],
	};
	const factories = childExtensionFactories(parent);
	assert.deepEqual(factories.map((item) => item.name), ["codemode", "tool-search", "mcp"]);
	assert.ok(factories.every((item) => item.builtin && item.replaceable));
	assert.deepEqual(childExtensionFactories({ getAllTools: () => [], getCommands: () => [] }), []);
	const resources = loader(f, [], { extensionFactories: factories, disabledBuiltinExtensions: [] });
	await resources.reload();
	assert.deepEqual(resources.getExtensions().errors, []);
	assert.deepEqual(resources.getExtensions().extensions.map((item) => item.path).sort(), ["builtin:codemode", "builtin:mcp", "builtin:tool-search"]);

	await write(join(f.agentDir, "settings.json"), JSON.stringify({ extensions: ["-builtin:mcp", "-builtin:codemode"] }));
	const disabled = loader(f, [], { extensionFactories: factories, disabledBuiltinExtensions: [], settingsManager: SettingsManager.create(f.cwd, f.agentDir) });
	await disabled.reload();
	assert.deepEqual(disabled.getExtensions().extensions.map((item) => item.path), ["builtin:tool-search"]);

	await write(join(f.agentDir, "settings.json"), "{}");
	await write(join(f.agentDir, "extensions/replacement.ts"), 'export default pi => { pi.registerCommand("mcp", { handler: async () => {} }); }');
	const replacement = loader(f, [], { extensionFactories: factories, disabledBuiltinExtensions: [] });
	await replacement.reload();
	assert.deepEqual(replacement.getExtensions().errors, []);
	assert.ok(!replacement.getExtensions().extensions.some((item) => item.path === "builtin:mcp"));
});
