import type { Data } from "@puckeditor/core";
import type { z } from "zod";
import type { Diagnostic } from "../projection/types.js";
import { type DerivedSchemas, findForbiddenKeys } from "./schema.js";

/**
 * The validation gate (design 0022 §5). One currency for every failure —
 * `Diagnostic[]` — shared by the code surface and the AI protocol, and one
 * invariant: **a failed gate never partially applies**.
 */

export type GateResult<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

/** Render a zod path as the dot/bracket form editors and humans expect. */
function pathOf(segments: readonly PropertyKey[]): string {
	let out = "";
	for (const segment of segments) {
		if (typeof segment === "number") {
			out += `[${segment}]`;
			continue;
		}
		out = out === "" ? String(segment) : `${out}.${String(segment)}`;
	}
	return out;
}

/** zod issues → diagnostics, deduped so one bad node reports once per path. */
export function toDiagnostics(error: z.ZodError): Diagnostic[] {
	const seen = new Set<string>();
	const diagnostics: Diagnostic[] = [];
	for (const issue of error.issues) {
		const path = pathOf(issue.path);
		const key = `${path}::${issue.message}`;
		if (seen.has(key)) continue;
		seen.add(key);
		diagnostics.push({ path, message: issue.message, severity: "error" });
	}
	return diagnostics;
}

/**
 * Validate a parsed value as a document for this config. On success the
 * returned value is the PARSED result (zod's output), which is what the
 * commit path applies — never the raw input.
 */
export function validateDocument(
	raw: unknown,
	schemas: DerivedSchemas,
): GateResult<Data> {
	const polluted = prototypePollution(raw);
	if (polluted !== null) return polluted;
	const result = schemas.document.safeParse(raw);
	if (result.success) return { ok: true, value: result.data };
	return { ok: false, diagnostics: toDiagnostics(result.error) };
}

/**
 * Prototype-pollution pre-check, run on the RAW input before any parsing.
 * See `findForbiddenKeys` for why this cannot be a schema refinement.
 */
function prototypePollution(raw: unknown): GateResult<never> | null {
	const offending = findForbiddenKeys(raw);
	if (offending.length === 0) return null;
	return {
		ok: false,
		diagnostics: offending.map((path) => ({
			path,
			message: `Forbidden key \`${path.split(".").at(-1)}\`.`,
			severity: "error" as const,
		})),
	};
}

/**
 * Validate against the depth-BOUNDED schema — the one to use on untrusted
 * input (AI payloads, pasted documents), where an adversarial nesting
 * depth would otherwise be answered by a stack overflow rather than a
 * diagnostic. The authored path keeps using {@link validateDocument}.
 */
export function validateDocumentBounded(
	raw: unknown,
	schemas: DerivedSchemas,
): GateResult<Data> {
	const polluted = prototypePollution(raw);
	if (polluted !== null) return polluted;
	const result = schemas.documentBounded.safeParse(raw);
	if (result.success) return { ok: true, value: result.data };
	return { ok: false, diagnostics: toDiagnostics(result.error) };
}

/**
 * Validate a list of AI-proposed editor intents before they reach
 * `resolveEditorIntent`.
 *
 * A boundary check on untrusted input, NOT a parallel IR (Puck contract
 * rule 5): each validated member resolves immediately to one commit-helper
 * call, nothing is serialized into an intent, and nothing persists.
 */
export function validateIntents(
	raw: unknown,
	schemas: DerivedSchemas,
): GateResult<unknown> {
	const result = schemas.intents.safeParse(raw);
	if (result.success) return { ok: true, value: result.data };
	return { ok: false, diagnostics: toDiagnostics(result.error) };
}
