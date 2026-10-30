import childProcess, { type ChildProcess } from "node:child_process";

import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";

interface Entry {
	source: string;
	path: string;
	theme: string;
	mode: string;
	listeners: Map<object, () => void>;
	lines?: string[];
	done: boolean;
	running: boolean;
}

const MAX_SOURCE = 128 * 1024;
const MAX_CACHE = 32;
const MAX_CACHE_CHARS = 2 * 1024 * 1024;

/** Session-local, bounded highlighting. There is no subprocess work until a TUI session starts. */
export class BatHighlighter {
	private mode: "waiting" | "active" | "off" = "waiting";
	private waiting = new Map<object, () => void>();
	private cache = new Map<string, Entry>();
	private children = new Set<ChildProcess>();
	private generation = 0;
	private missing = false;

	constructor(private launch: typeof childProcess.execFile = childProcess.execFile) {}

	start(): void {
		this.mode = "active";
		const waiting = [...this.waiting.values()];
		this.waiting.clear();
		for (const notify of waiting) notify();
	}

	stop(): void {
		this.mode = "off";
		this.generation++;
		this.waiting.clear();
		this.cache.clear();
		for (const child of this.children) child.kill("SIGKILL");
		this.children.clear();
		this.missing = false;
	}

	request(source: string, path: string, theme: Theme, client: object, notify: () => void): string[] | undefined {
		if (this.mode === "waiting") this.waiting.set(client, notify);
		if (this.mode !== "active" || this.missing || !source || source.length > MAX_SOURCE) return undefined;
		const name = process.env.BAT_THEME || theme.appearance;
		const mode = theme.getColorMode();
		const key = JSON.stringify([path, name, mode, process.env.BAT_THEME_LIGHT, process.env.BAT_THEME_DARK, source]);
		let entry = this.cache.get(key);
		if (!entry) {
			// Evict completed work, never active requests. Count ANSI output as well as source and cache keys.
			const size = () => [...this.cache].reduce((n, [k, e]) => n + k.length + e.source.length + (e.lines?.join("\n").length ?? 0), 0);
			while (this.cache.size >= MAX_CACHE || size() + key.length + source.length > MAX_CACHE_CHARS) {
				const oldest = [...this.cache].find(([, e]) => e.done);
				if (!oldest) return undefined;
				this.cache.delete(oldest[0]);
			}
			entry = { source, path, theme: name, mode, listeners: new Map(), done: false, running: false };
			this.cache.set(key, entry);
		}
		if (!entry.done) entry.listeners.set(client, notify);
		this.pump();
		return entry.lines;
	}

	private pump(): void {
		if (this.mode !== "active" || this.missing) return;
		for (const entry of this.cache.values()) {
			if (this.children.size >= 2) break;
			if (entry.done || entry.running) continue;
			entry.running = true;
			const generation = this.generation;
			const args = [
				"--no-config", "--style=plain", "--decorations=never", "--color=always", "--paging=never",
				"--wrap=never", "--tabs=0", "--strip-ansi=always", `--theme=${entry.theme}`,
				`--file-name=${entry.path}`, "--", "-",
			];
			const child = this.launch("bat", args, {
				encoding: "utf8", timeout: 2000, maxBuffer: 1024 * 1024, killSignal: "SIGKILL",
				env: { ...process.env, COLORTERM: entry.mode === "truecolor" ? "truecolor" : "" },
			}, (error, stdout) => {
				this.children.delete(child);
				if (generation !== this.generation) return;
				entry.done = true;
				if (error && "code" in error && error.code === "ENOENT") this.missing = true;
				// Only accept SGR styling around the exact supplied text, not terminal commands or changed content.
				// eslint-disable-next-line no-control-regex -- allow only generated SGR styling
				const withoutSgr = stdout.replace(/\x1b\[[\d;]*m/g, "");
				if (!error && withoutSgr === entry.source && stripTerminalSequences(stdout) === withoutSgr) {
					entry.lines = stdout.split("\n");
				}
				// A verbose highlighter must not inflate the cache beyond its input budget.
				const size = [...this.cache].reduce((n, [k, e]) => n + k.length + e.source.length + (e.lines?.join("\n").length ?? 0), 0);
				if (size > MAX_CACHE_CHARS) entry.lines = undefined;
				const listeners = [...entry.listeners.values()];
				entry.listeners.clear();
				for (const notify of listeners) notify();
				this.pump();
			});
			this.children.add(child);
			// A failed or timed-out process may close stdin before it consumes the snippet.
			child.stdin?.on("error", () => {});
			child.stdin?.end(entry.source);
		}
	}
}
