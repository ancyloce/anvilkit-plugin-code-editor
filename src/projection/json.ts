import type { Data } from "@puckeditor/core";
import type { ApplyResult, Diagnostic, EmitResult } from "./types.js";

/**
 * The JSON projection (design 0022 §8.3): an identity view of the document.
 *
 * Emit is a canonical stringify — keys sorted, tab indent — so the same
 * document always produces byte-identical text and a diff reflects a real
 * change rather than key ordering.
 *
 * Apply is a STRICT parse. `salvageJson` is deliberately not used on human
 * input: a typo should surface as a diagnostic, not be silently "repaired"
 * into a different document (that repair path exists only for AI payloads).
 */

/** Recursively rebuild a value with object keys in sorted order. */
function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (value === null || typeof value !== "object") return value;
	const source = value as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(source).sort()) {
		out[key] = canonicalize(source[key]);
	}
	return out;
}

/** Canonical text for a document. */
export function emitJson(data: Data, revision = 0): EmitResult {
	return {
		text: `${JSON.stringify(canonicalize(data), null, "\t")}\n`,
		revision,
	};
}

/**
 * Locate a `JSON.parse` failure in the source text. V8 reports a character
 * offset ("at position 42"); converting it to line/col lets the editor put
 * the marker where the problem is instead of at the top of the buffer.
 */
function positionOf(
	text: string,
	error: unknown,
): { line: number; col: number } {
	const message = error instanceof Error ? error.message : String(error);
	const offset = Number(message.match(/position (\d+)/)?.[1] ?? Number.NaN);
	if (Number.isNaN(offset)) return { line: 1, col: 1 };
	const before = text.slice(0, offset);
	const lines = before.split("\n");
	return { line: lines.length, col: (lines.at(-1)?.length ?? 0) + 1 };
}

/**
 * Strict parse of edited text. Returns the raw parsed value — schema
 * validation is the gate's job (`validateDocument`), kept separate so the
 * same parse serves both the human and AI paths.
 */
export function parseJson(text: string): ApplyResult<unknown> {
	try {
		return { ok: true, value: JSON.parse(text) };
	} catch (error) {
		const { line, col } = positionOf(text, error);
		const diagnostic: Diagnostic = {
			path: "",
			message: error instanceof Error ? error.message : String(error),
			line,
			col,
			severity: "error",
		};
		return { ok: false, diagnostics: [diagnostic] };
	}
}

/** True when two documents are byte-identical under the canonical form. */
export function isEquivalent(a: Data, b: Data): boolean {
	return emitJson(a).text === emitJson(b).text;
}
