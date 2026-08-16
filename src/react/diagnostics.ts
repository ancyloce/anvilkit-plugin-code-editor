import type { Diagnostic as CodeMirrorDiagnostic } from "@codemirror/lint";
import type { Text } from "@codemirror/state";
import type { Diagnostic } from "../projection/types.js";

/**
 * Gate diagnostics → CodeMirror lint markers (design 0022 §8.1).
 *
 * The gate speaks document paths (`content[0].props.id`); CodeMirror wants
 * character offsets. A diagnostic that carries line/col (JSON parse errors)
 * maps precisely; a schema diagnostic maps to the first line whose text
 * mentions the failing path's last segment, and falls back to the whole
 * first line so a marker is never silently dropped.
 */

/** Character offset of a 1-based line/col pair, clamped to the document. */
function offsetOf(doc: Text, line: number, col: number): number {
	const clampedLine = Math.min(Math.max(line, 1), doc.lines);
	const lineInfo = doc.line(clampedLine);
	return Math.min(lineInfo.from + Math.max(col - 1, 1) - 1, lineInfo.to);
}

/** The last identifier in a gate path — `content[0].props.id` → `id`. */
function lastSegment(path: string): string | undefined {
	const segments = path.split(".").filter(Boolean);
	const last = segments.at(-1);
	return last?.replace(/\[\d+\]$/, "") || undefined;
}

/** Range of the first line mentioning `"<key>"`, if any. */
function rangeOfKey(
	doc: Text,
	key: string,
): { from: number; to: number } | null {
	const needle = `"${key}"`;
	for (let lineNumber = 1; lineNumber <= doc.lines; lineNumber += 1) {
		const line = doc.line(lineNumber);
		const index = line.text.indexOf(needle);
		if (index >= 0) {
			return { from: line.from + index, to: line.to };
		}
	}
	return null;
}

export function toCodeMirrorDiagnostics(
	doc: Text,
	diagnostics: readonly Diagnostic[],
): CodeMirrorDiagnostic[] {
	return diagnostics.map((diagnostic) => {
		const severity = diagnostic.severity === "warning" ? "warning" : "error";
		const message =
			diagnostic.path === ""
				? diagnostic.message
				: `${diagnostic.path}: ${diagnostic.message}`;

		if (diagnostic.line !== undefined) {
			const from = offsetOf(doc, diagnostic.line, diagnostic.col ?? 1);
			return { from, to: Math.min(from + 1, doc.length), severity, message };
		}

		const key = lastSegment(diagnostic.path);
		const range = key === undefined ? null : rangeOfKey(doc, key);
		if (range !== null) return { ...range, severity, message };

		const first = doc.line(1);
		return { from: first.from, to: first.to, severity, message };
	});
}
