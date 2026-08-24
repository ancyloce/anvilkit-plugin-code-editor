import type { Data } from "@puckeditor/core";
import { emitJson, isEquivalent } from "../projection/json.js";
import type { ApplyResult, Diagnostic } from "../projection/types.js";
import { type CommitPorts, completeSnapshot } from "./coalesce.js";

/**
 * The buffer state machine (design 0022 §8.5).
 *
 * Deliberately timer-free: the host decides when a debounce or idle window
 * elapsed and calls the matching method. That keeps every transition
 * deterministic under test — including the one that matters most, that a
 * whole editing session produces exactly ONE history-recording commit.
 *
 *   CLEAN --edit--> DIRTY --debounceElapsed--> (validate)
 *     ok + changed -> interim apply (non-recording), stays DIRTY
 *     ok + noop    -> DIRTY, marked in-sync
 *     invalid      -> DIRTY with diagnostics; the canvas keeps the last
 *                     valid document (never a partial apply)
 *   DIRTY --idleElapsed | blur | save--> COMMIT (one recording setData) -> CLEAN
 *   externalChange while CLEAN -> re-emit the buffer from the document
 *   externalChange while DIRTY -> STALE (rebase or discard; never a silent
 *                                clobber of either side)
 */

export type SyncState = "clean" | "dirty" | "stale";

export type SyncMode = "live" | "manual";

export interface SyncSnapshot {
	readonly state: SyncState;
	readonly mode: SyncMode;
	/** Current buffer text — what the editor shows. */
	readonly text: string;
	readonly diagnostics: readonly Diagnostic[];
	/** True when the buffer parses and matches the applied document. */
	readonly inSync: boolean;
	/** Recording commits performed this session (the undo-depth claim). */
	readonly commitCount: number;
}

export interface SyncControllerOptions {
	/** The document at mount. */
	readonly initial: Data;
	/** Canonical text projection. JSON remains the default for P0 callers. */
	readonly emit?: (data: Data) => string;
	/** Parse + gate a buffer. The controller never validates by itself. */
	readonly validate: (text: string) => ApplyResult<Data>;
	readonly ports: CommitPorts;
	/**
	 * Collab forces `manual`: keystroke-level interim applies would fight
	 * the CRDT, so the user applies explicitly (FR-C14).
	 */
	readonly mode?: SyncMode;
}

export class SyncController {
	#state: SyncState = "clean";
	#mode: SyncMode;
	#text: string;
	#diagnostics: readonly Diagnostic[] = [];
	/** Last document accepted by the gate — the interim/commit payload. */
	#pending: Data;
	/** The document the canvas currently holds (last applied or external). */
	#applied: Data;
	#commitCount = 0;
	#dirtySinceCommit = false;
	/** Successful validation cached for this exact buffer revision. */
	#validatedText: string | null = null;
	/** Buffer text captured when an external change arrived mid-edit. */
	#staleIncoming: Data | null = null;

	constructor(private readonly options: SyncControllerOptions) {
		this.#mode = options.mode ?? "live";
		this.#applied = options.initial;
		this.#pending = options.initial;
		this.#text = this.#emit(options.initial);
	}

	#emit(data: Data): string {
		return this.options.emit?.(data) ?? emitJson(data).text;
	}

	snapshot(): SyncSnapshot {
		return {
			state: this.#state,
			mode: this.#mode,
			text: this.#text,
			diagnostics: this.#diagnostics,
			inSync:
				this.#diagnostics.length === 0 &&
				isEquivalent(this.#pending, this.#applied),
			commitCount: this.#commitCount,
		};
	}

	/** Collab activation (or a user toggle) switches the apply cadence. */
	setMode(mode: SyncMode): void {
		this.#mode = mode;
	}

	/** The user typed. Never validates — that waits for the debounce. */
	edit(text: string): void {
		if (text !== this.#text) this.#validatedText = null;
		this.#text = text;
		if (this.#state === "clean") this.#state = "dirty";
		this.#dirtySinceCommit = true;
	}

	/**
	 * The debounce window elapsed: validate, and in `live` mode apply a
	 * NON-recording interim so the canvas follows the buffer.
	 */
	debounceElapsed(): void {
		if (this.#state !== "dirty") return;
		const result = this.options.validate(this.#text);
		if (!result.ok) {
			// Invalid: surface diagnostics, apply nothing. The canvas keeps
			// the last valid document.
			this.#diagnostics = result.diagnostics;
			return;
		}
		this.#diagnostics = [];
		const next = completeSnapshot(result.value);
		this.#pending = next;
		this.#validatedText = this.#text;
		if (isEquivalent(next, this.#applied)) return; // ok + noop
		if (this.#mode === "live") {
			// Puck subscriptions may fire synchronously from dispatch. Mark the
			// payload as ours before crossing that boundary so the echo is not
			// misclassified as a remote change while this buffer is dirty.
			const previousApplied = this.#applied;
			this.#applied = next;
			try {
				this.options.ports.applyInterim(next);
			} catch (error) {
				this.#applied = previousApplied;
				throw error;
			}
		}
	}

	/**
	 * An idle pause, a blur, or an explicit save. Performs the session's
	 * single recording commit — and only when something actually changed
	 * since the last one, so a blur on an untouched buffer records nothing.
	 */
	commit(): boolean {
		if (this.#state === "stale") return false;
		if (!this.#dirtySinceCommit) return false;
		let next = this.#pending;
		if (this.#validatedText !== this.#text) {
			const result = this.options.validate(this.#text);
			if (!result.ok) {
				this.#diagnostics = result.diagnostics;
				return false;
			}
			this.#diagnostics = [];
			next = completeSnapshot(result.value);
			this.#pending = next;
			this.#validatedText = this.#text;
		}
		// As with interim dispatch, a store subscriber can echo the commit
		// before the port returns. Publish the clean/applied state first and
		// roll it back if the host rejects the dispatch.
		const previousApplied = this.#applied;
		this.#applied = next;
		this.#pending = next;
		this.#dirtySinceCommit = false;
		this.#state = "clean";
		try {
			this.options.ports.commit(next);
		} catch (error) {
			this.#applied = previousApplied;
			this.#dirtySinceCommit = true;
			this.#state = "dirty";
			throw error;
		}
		this.#commitCount += 1;
		return true;
	}

	/**
	 * The document changed outside this panel (canvas edit, collab peer,
	 * AI apply). Clean buffer: re-emit. Dirty buffer: go STALE rather than
	 * clobber either side.
	 */
	externalChange(data: Data): void {
		if (isEquivalent(data, this.#applied)) return;
		if (this.#state === "clean") {
			this.#applied = data;
			this.#pending = data;
			this.#text = this.#emit(data);
			this.#validatedText = null;
			return;
		}
		this.#staleIncoming = data;
		this.#state = "stale";
	}

	/** Take the incoming document, discarding local buffer edits. */
	discardLocal(): void {
		if (this.#state !== "stale" || this.#staleIncoming === null) return;
		const incoming = this.#staleIncoming;
		this.#staleIncoming = null;
		this.#applied = incoming;
		this.#pending = incoming;
		this.#text = this.#emit(incoming);
		this.#diagnostics = [];
		this.#validatedText = null;
		this.#state = "clean";
		this.#dirtySinceCommit = false;
	}

	/**
	 * Rebase: adopt the incoming document as the new base and keep editing
	 * the local buffer on top of it. The local text is preserved verbatim —
	 * the user decides what survives, not a merge heuristic.
	 */
	rebaseOnIncoming(): void {
		if (this.#state !== "stale" || this.#staleIncoming === null) return;
		this.#applied = this.#staleIncoming;
		this.#staleIncoming = null;
		this.#state = "dirty";
	}
}
