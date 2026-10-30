import {
	formatReadLineRange, getLanguageFromPath, highlightCode, keyHint,
	type ExtensionAPI, type Theme, type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import {
	backgroundAnsi, Box, colorToOklch, mixColors, oklchColor, stripTerminalSequences, Text, truncateToWidth, visibleWidth, wrapTextWithAnsi,
	type Component,
} from "@earendil-works/pi-tui";
import { diffWordsWithSpace } from "diff";

import { BatHighlighter } from "./pretty-diff/bat.ts";

const MAX_CHARS = 128 * 1024;
const MAX_LINES = 4000;
const COLLAPSED_ROWS = 16;
const RESET = "\x1b[0m";
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
type PreviewKind = "edit" | "write" | "read" | "text";
type Span = [number, number];
type Kind = "+" | "-" | " " | "gap";
interface Line { kind: Kind; number: string; text: string; spans: Span[] }
interface Model { lines: Line[]; title: string; truncated: boolean; code: boolean }
function record(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}

function display(text: string): string {
	return stripTerminalSequences(text).replace(/\r\n?/g, "\n").replace(/\t/g, "    ")
		.replace(/\p{Cc}/gu, (c) => c === "\n" ? c : "�");
}

function words(before: Line, after: Line): void {
	if (Math.max(before.text.length, after.text.length) > 4096) return;
	const changes = diffWordsWithSpace(before.text, after.text, { maxEditLength: 128, timeout: 5 });
	if (!changes) return;
	let oldOffset = 0;
	let newOffset = 0;
	let common = 0;
	for (const change of changes) {
		if (change.removed) {
			before.spans.push([oldOffset, oldOffset + change.value.length]);
			oldOffset += change.value.length;
		} else if (change.added) {
			after.spans.push([newOffset, newOffset + change.value.length]);
			newOffset += change.value.length;
		} else {
			oldOffset += change.value.length;
			newOffset += change.value.length;
			common += change.value.trim().length;
		}
	}
	if (!common || common < 0.3 * Math.max(before.text.trim().length, after.text.trim().length)) {
		before.spans = [];
		after.spans = [];
	}
}

function model(source: string, kind: PreviewKind, startLine = 1): Model {
	const clipped = source.slice(0, MAX_CHARS).replace(/[\uD800-\uDBFF]$/u, "");
	const raw = display(clipped).split("\n");
	if (raw.at(-1) === "") raw.pop();
	const truncated = source.length > MAX_CHARS || raw.length > MAX_LINES;
	const lines: Line[] = [];
	for (const text of raw.slice(0, MAX_LINES)) {
		if (kind === "edit") {
			const match = /^([+\- ])(\s*\d+) (.*)$/.exec(text);
			if (match) lines.push({ kind: match[1] as Kind, number: match[2].trim(), text: match[3], spans: [] });
			else if (/^ +\.\.\.$/.test(text)) lines.push({ kind: "gap", number: "", text: "…", spans: [] });
			else return model(source, "text");
		} else lines.push({ kind: " ", number: kind === "text" ? "" : String(lines.length + startLine), text, spans: [] });
	}
	let pairs = 0;
	const deadline = performance.now() + 10;
	for (let i = 0; i < lines.length;) {
		if (lines[i].kind !== "-") { i++; continue; }
		let removedEnd = i;
		while (lines[removedEnd]?.kind === "-") removedEnd++;
		let addedEnd = removedEnd;
		while (lines[addedEnd]?.kind === "+") addedEnd++;
		// Equal-size runs only: positional pairing across insertions/deletions is misleading.
		if (removedEnd - i === addedEnd - removedEnd) {
			for (let k = 0; k < removedEnd - i && pairs < 128 && performance.now() < deadline; k++, pairs++) words(lines[i + k], lines[removedEnd + k]);
		}
		i = addedEnd;
	}
	const additions = lines.filter((line) => line.kind === "+").length;
	const removals = lines.filter((line) => line.kind === "-").length;
	return {
		lines, truncated, code: kind !== "text",
		title: kind === "edit" ? `+${additions} −${removals}${truncated ? " (preview)" : ""}`
			: kind === "write" ? "Written content (not an overwrite diff)" : kind === "read" ? "Read content" : "Tool output",
	};
}

/** Add backgrounds at source UTF-16 offsets, expanding marks to complete graphemes, not terminal cells. */
function paint(line: string, spans: Span[], base: string, marked: string): string {
	if (!spans.length) {
		// eslint-disable-next-line no-control-regex -- restore the band after generated styling
		return base + line.replace(/\x1b\[[\d;]*m/g, (sgr) => sgr + base) + base;
	}
	const expanded: Span[] = [];
	let spanIndex = 0;
	// Word spans are ordered; scan once and merge adjacent marked graphemes.
	for (const { segment, index } of graphemes.segment(stripTerminalSequences(line))) {
		const end = index + segment.length;
		while (spanIndex < spans.length && spans[spanIndex][1] <= index) spanIndex++;
		if (spanIndex === spans.length) break;
		if (spans[spanIndex][0] >= end) continue;
		const previous = expanded.at(-1);
		if (previous?.[1] === index) previous[1] = end;
		else expanded.push([index, end]);
	}
	let rangeIndex = 0;
	let offset = 0;
	let current = base;
	let result = base;
	// Split only at generated SGR codes. The input text itself has already been sanitized.
	// eslint-disable-next-line no-control-regex -- split generated terminal styling, not source text
	for (const part of line.split(/(\x1b\[[\d;]*m)/)) {
		if (part.startsWith("\x1b[")) { result += part + current; continue; }
		for (const char of part) {
			while (rangeIndex < expanded.length && expanded[rangeIndex][1] <= offset) rangeIndex++;
			const wanted = rangeIndex < expanded.length && expanded[rangeIndex][0] <= offset ? marked : base;
			if (wanted !== current) { result += wanted; current = wanted; }
			result += char;
			offset += char.length;
		}
	}
	return result + base;
}

class Preview implements Component {
	private input = "";
	private path = "";
	private kind: PreviewKind = "text";
	private startLine = 1;
	private notice = "";
	private data: Model = model("", "text");
	private theme!: Theme;
	private expanded = false;
	private error = false;
	private notify: () => void = () => {};
	private cached?: { width: number; lines: string[] };

	constructor(private bat: BatHighlighter) {}

	update(input: string, path: string, kind: PreviewKind, theme: Theme, expanded: boolean, error: boolean, notify: () => void, startLine = 1, notice = ""): void {
		if (input !== this.input || path !== this.path || kind !== this.kind || startLine !== this.startLine) {
			this.input = input;
			this.path = path;
			this.kind = kind;
			this.startLine = startLine;
			this.data = model(input, kind, startLine);
		}
		this.notice = notice;
		this.theme = theme;
		this.expanded = expanded;
		this.error = error;
		this.notify = notify;
		this.invalidate();
	}

	invalidate(): void { this.cached = undefined; }

	render(width: number): string[] {
		if (this.cached?.width === width) return this.cached.lines;
		if (width <= 0) return [];
		const { theme, data } = this;
		const refresh = () => { this.invalidate(); this.notify(); };
		const maxRows = this.expanded ? MAX_LINES : COLLAPSED_ROWS;
		const shown = data.lines.slice(0, maxRows + 1);
		const colored = new Map<Line, string>();
		let batReady = data.code && shown.some((line) => line.kind !== "gap");
		let batUsed = false;
		let requests = 0;
		// Omitted context breaks lexer state. Highlight each old/new hunk separately.
		for (let start = 0; start < shown.length;) {
			if (shown[start].kind === "gap") { start++; continue; }
			let end = start;
			while (end < shown.length && shown[end].kind !== "gap") end++;
			for (const side of this.kind === "edit" ? ["-", "+"] : ["-"]) {
				const group = shown.slice(start, end).filter((line) => line.kind !== (side === "-" ? "+" : "-"));
				if (!group.length) continue;
				const source = group.map((line) => line.text).join("\n");
				const highlighted = data.code && requests++ < 16 ? this.bat.request(source, this.path, theme, this, refresh) : undefined;
				if (!highlighted) batReady = false;
				else batUsed = true;
				const fallback = highlighted ?? (data.code && source.length <= MAX_CHARS
					? highlightCode(source, getLanguageFromPath(this.path)) : group.map((line) => line.text));
				group.forEach((line, i) => colored.set(line, fallback[i] ?? line.text));
			}
			start = end;
		}
		const colorLabel = data.code ? ` · ${batReady ? "bat" : batUsed ? "bat / Pi colors" : "Pi colors"}` : "";
		const out = [truncateToWidth(theme.fg(this.error ? "error" : "muted", `${data.title}${colorLabel}`), width)];
		const gutterWidth = Math.max(1, ...data.lines.map((line) => line.number.length));
		// Keep the theme's panel lightness without carrying a panel's hue into the diff.
		const base = oklchColor(colorToOklch(theme.colors.toolPendingBg).l, 0, 0);
		// Move word bands away from syntax foreground lightness, rather than toward it.
		const wordBase = oklchColor(theme.appearance === "dark" ? 0 : 1, 0, 0);
		let hidden = false;
		for (const line of shown) {
			const token = line.kind === "+" ? "toolDiffAdded" : "toolDiffRemoved";
			const changed = line.kind === "+" || line.kind === "-";
			const tint = theme.colors[token];
			const bg = backgroundAnsi(mixColors(base, tint, 0.12), theme.getColorMode());
			const wordBg = backgroundAnsi(mixColors(wordBase, tint, theme.appearance === "dark" ? 0.32 : 0.04), theme.getColorMode());
			const gutter = line.number ? `${line.kind === " " ? " " : line.kind}${line.number.padStart(gutterWidth)} ` : "";
			const styledGutter = theme.fg(changed ? token : "dim", gutter);
			const body = data.code ? colored.get(line) ?? line.text : theme.fg(this.error ? "error" : "toolOutput", line.text);
			// Wrapping, not clipping, makes expansion useful for very long source lines.
			const painted = changed ? paint(body, line.spans, bg, wordBg) : body;
			const rendered = wrapTextWithAnsi(styledGutter + painted, width);
			for (const text of rendered) {
				if (out.length - 1 >= maxRows) { hidden = true; break; }
				const safe = truncateToWidth(text, width, "");
				out.push(changed ? bg + safe + bg + " ".repeat(Math.max(0, width - visibleWidth(safe))) + RESET : safe + RESET);
			}
			if (hidden) break;
		}
		if (hidden || data.truncated) {
			const hint = this.expanded ? "… preview limit reached" : `… more (${keyHint("app.tools.expand", "expand")})`;
			out.push(truncateToWidth(theme.fg("muted", hint), width));
		}
		if (!data.lines.length) out.push(theme.fg("dim", truncateToWidth("(empty)", width)));
		if (this.notice) out.push(...wrapTextWithAnsi(theme.fg("warning", display(this.notice)), width));
		const lines = out.map((line) => truncateToWidth(line, width, ""));
		this.cached = { width, lines };
		return lines;
	}
}

class SafeText extends Text {
	override render(width: number): string[] {
		return width <= 0 ? [] : super.render(width).map((line) => truncateToWidth(line, width, ""));
	}
}

class SafeBox extends Box {
	private fitted?: { width: number; source: string[]; lines: string[] };

	override render(width: number): string[] {
		if (width <= 0) return [];
		const source = super.render(width);
		if (this.fitted?.width === width && this.fitted.source === source) return this.fitted.lines;
		const lines = source.map((line) => truncateToWidth(line, width, ""));
		this.fitted = { width, source, lines };
		return lines;
	}
}

function resultText(result: Parameters<NonNullable<ToolRenderers["renderResult"]>>[0]): string {
	return result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
}

function argsPath(args: unknown): string {
	const values = record(args);
	const path = values.file_path ?? values.path;
	return typeof path === "string" ? display(path).replace(/\n/g, " ") : "";
}

export default function prettyDiff(pi: ExtensionAPI): void {
	const bat = new BatHighlighter();
	pi.on("session_start", (_event, ctx) => { if (ctx.mode === "tui") bat.start(); else bat.stop(); });
	pi.on("session_shutdown", () => bat.stop());
	pi.registerToolRenderer((name, next) => {
		if (name !== "edit" && name !== "write" && name !== "read") return next();
		const fallback = name === "read" ? next() : undefined;
		return {
			renderShell: "self",
			renderCall(args, theme, context) {
				const path = argsPath(args) || "…";
				const range = name === "read" ? formatReadLineRange(record(args).offset, record(args).limit) : "";
				return new SafeText(`${theme.fg("toolTitle", theme.bold(name))} ${theme.fg("accent", path)}${theme.fg("warning", range)}`, context.outputPad, 0);
			},
			renderResult(result, options, theme, context) {
				if (options.isPartial) return new SafeText(theme.fg("muted", "Working…"), context.outputPad, 0);
				const box = new SafeBox(context.outputPad, 0);
				// Let the existing read renderer retain image notes and terminal/HTML fallbacks.
				if (name === "read" && result.content.some((part) => part.type === "image") && fallback?.renderResult) {
					box.addChild(fallback.renderResult(result, options, theme, { ...context, lastComponent: undefined }));
					return box;
				}
				let kind: PreviewKind = "text";
				let input = resultText(result);
				let startLine = 1;
				let notice = "";
				const details: unknown = result.details;
				const args = record(context.args);
				if (!context.isError) {
					if (name === "edit" && details && typeof details === "object" && "diff" in details && typeof details.diff === "string") {
						kind = "edit";
						input = details.diff;
					} else if (name === "write" && typeof args.content === "string") {
						kind = "write";
						input = args.content;
					} else if (name === "read" && !result.content.some((part) => part.type === "image")) {
						const truncation = record(record(details).truncation);
						if (!truncation.firstLineExceedsLimit) {
							kind = "read";
							const offset = typeof args.offset === "string" && args.offset.trim() !== "" ? Number(args.offset) : args.offset;
							const limit = typeof args.limit === "string" && args.limit.trim() !== "" ? Number(args.limit) : args.limit;
							if (typeof offset === "number" && Number.isSafeInteger(offset) && offset > 0) startLine = offset;
							// Separate only built-in continuation notices; never reopen the path or replace saved output with metadata.
							const footer = /\n\n(\[(?:Showing lines \d+-\d+ of \d+(?: \([^\n]+\))?|\d+ more lines in file)\. Use offset=\d+ to continue\.\])$/.exec(input);
							if (footer && footer[1].length <= 1024 && (truncation.truncated || Number.isFinite(limit))) {
								notice = footer[1];
								input = input.slice(0, footer.index);
							}
						}
					}
				}
				const state = context.state as { prettyDiff?: Preview };
				const view = state.prettyDiff ??= new Preview(bat);
				view.update(input, argsPath(context.args), kind, theme, options.expanded, context.isError, context.invalidate, startLine, notice);
				box.addChild(view);
				return box;
			},
		};
	});
}
