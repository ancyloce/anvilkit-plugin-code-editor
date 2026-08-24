/**
 * Projection vocabulary (design 0022 §8.1). A *projection* is a text view
 * of the document: JSON now, TSX from P1. Every projection emits text from
 * a document and applies text back to one, and every failure speaks the
 * same currency as the validation gate — `Diagnostic[]`.
 */

/** Which text view of the document a panel tab shows. */
export type ProjectionKind = "json" | "tsx";

/** One problem with a projection's input, addressed to a document path. */
export interface Diagnostic {
	/** Dot/bracket path into the document, e.g. `content[0].props.id`. */
	readonly path: string;
	readonly message: string;
	/** 1-based text position, when the projection can locate one. */
	readonly line?: number;
	readonly col?: number;
	readonly severity: "error" | "warning";
	/** Namespaced catalog key for the visual seam that owns the rejected edit. */
	readonly hintKey?: string;
}

/** Text emitted from a document, tagged with the revision it came from. */
export interface EmitResult {
	readonly text: string;
	/** Monotonic counter tied to subscribe ticks — a stale-buffer guard. */
	readonly revision: number;
}

/**
 * The outcome of applying text back to a document. A failed apply carries
 * diagnostics and NO value: the gate never partially applies (design §5).
 */
export type ApplyResult<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };
