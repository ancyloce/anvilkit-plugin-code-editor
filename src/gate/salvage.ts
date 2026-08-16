import type { ApplyResult, Diagnostic } from "../projection/types.js";

/**
 * `salvageJson` (design 0022 §5) — the **AI path only**.
 *
 * Models wrap JSON in markdown fences, trail commas, and occasionally
 * drop a quote. Rather than burning a repair turn on a formatting slip,
 * this recovers the payload in three escalating steps:
 *
 *   1. strip a leading/trailing markdown code fence;
 *   2. strict `JSON.parse`;
 *   3. `jsonrepair`, then parse again.
 *
 * It is deliberately NOT used on human input: `parseJson` stays strict so
 * a typo in the code panel surfaces as a diagnostic instead of being
 * silently "repaired" into a different document (PRD 0023 §8.3).
 *
 * `jsonrepair` is loaded with a dynamic `import()` so it stays out of the
 * plugin's eager entry chunk — the code panel never reaches this path, and
 * FR-C10's entry budget must not pay for it.
 */

/** ```json … ``` or ``` … ``` wrapping the whole payload. */
const FENCE =
	/^\s*```(?:json|jsonc|javascript|js)?\s*\n?([\s\S]*?)\n?\s*```\s*$/;

/** Remove one wrapping markdown fence, if present. */
export function stripFence(text: string): string {
	return FENCE.exec(text)?.[1] ?? text;
}

function diagnosticOf(error: unknown): Diagnostic {
	return {
		path: "",
		message: error instanceof Error ? error.message : String(error),
		severity: "error",
	};
}

/**
 * Best-effort parse of a model-produced JSON payload.
 *
 * Returns the parsed value plus whether repair was needed — callers log
 * that rather than silently accepting malformed output, so a model that
 * degrades is visible instead of masked.
 */
export async function salvageJson(
	text: string,
): Promise<ApplyResult<unknown> & { readonly repaired?: boolean }> {
	const unfenced = stripFence(text);

	try {
		return { ok: true, value: JSON.parse(unfenced), repaired: false };
	} catch {
		// fall through to repair
	}

	try {
		const { jsonrepair } = await import("jsonrepair");
		return {
			ok: true,
			value: JSON.parse(jsonrepair(unfenced)),
			repaired: true,
		};
	} catch (error) {
		return { ok: false, diagnostics: [diagnosticOf(error)] };
	}
}
