"use client";

// This package builds CLASSIC JSX, so every .tsx must bind React itself —
// without this the built `dist` throws "React is not defined" at runtime and
// typecheck will not catch it (hook-enforced repo rule).
import * as React from "react";
import type { Config, Data } from "@puckeditor/core";
import { deriveSchemas, validateDocument } from "../gate/index.js";
import { parseJson } from "../projection/json.js";
import { emitTsx } from "../projection/tsx-emit.js";
import type { ApplyResult, ProjectionKind } from "../projection/types.js";
import type { PanelVisibilityStore } from "../panel-visibility.js";
import { SyncController, type SyncSnapshot } from "../sync/index.js";
import { CodeMirrorSurface } from "./CodeMirrorSurface.js";

/** Debounce before validating a burst of keystrokes (design §8.5). */
const DEBOUNCE_MS = 200;
/** Idle pause that ends a session and records the single commit. */
const IDLE_MS = 1500;

/**
 * Minimal view of the Puck API this panel needs. Reaching Puck through the
 * plugin context's public getter (the same seam `plugin-ai-copilot` uses)
 * keeps the panel on the public surface — no core internals.
 */
export interface PuckApiLike {
	readonly appState: { readonly data: Data };
	readonly config: Config;
	readonly dispatch: (action: {
		type: "setData";
		recordHistory?: boolean;
		data: (previous: Data) => Data;
	}) => void;
}

export interface CodePanelProps {
	/** Live Puck API accessor, injected by `register(ctx)`. */
	readonly getPuckApi?: () => PuckApiLike | null;
	/** Change ticks from `EditorApi.subscribe` (design §8.2). */
	readonly subscribe?: (listener: () => void) => () => void;
	/**
	 * Open/closed state driven by the header action. Absent means always
	 * open (the standalone/testing case).
	 */
	readonly visibility?: PanelVisibilityStore;
	/**
	 * Which text views to offer. `"json"` is editable; `"tsx"` is the P1
	 * read-only projection (writing it is the P2 `tsxWrite` flag). A single
	 * entry hides the tab strip entirely.
	 */
	readonly projections?: readonly ProjectionKind[];
	/**
	 * Message resolver. The plugin context has no translation seam yet, so
	 * the default reads the package's own English catalog — the strings
	 * still live in one place, and wiring a real `t` later is one line.
	 */
	readonly t?: (key: string) => string;
}

/** English fallbacks, kept in step with `i18n/messages/en.json`. */
const EN: Record<string, string> = {
	"codeEditor.projection.json": "JSON",
	"codeEditor.projection.tsx": "TSX",
	"codeEditor.projection.label": "Projection",
	"codeEditor.projection.readOnly": "Read-only view of the document",
};

const defaultT = (key: string): string => EN[key] ?? key;

/**
 * The code panel surface (design 0022 §8.1): the document as editable JSON.
 *
 * Everything about *how* edits reach the document lives in `SyncController`
 * — this component owns only the timers, the CodeMirror mount and the
 * status line, so the interesting behaviour stays unit-testable without a
 * DOM.
 */
export function CodePanel(props: CodePanelProps): React.ReactElement {
	const { getPuckApi, subscribe, visibility } = props;
	const projections = props.projections ?? ["json", "tsx"];
	const t = props.t ?? defaultT;
	const [kind, setKind] = React.useState<ProjectionKind>(
		projections[0] ?? "json",
	);
	// `useSyncExternalStore` keeps the surface in step with the header
	// action without the plugin owning any React state.
	const isOpen = React.useSyncExternalStore(
		React.useCallback(
			(listener: () => void) => visibility?.subscribe(listener) ?? (() => undefined),
			[visibility],
		),
		() => visibility?.isOpen() ?? true,
		() => visibility?.isOpen() ?? true,
	);
	const controllerRef = React.useRef<SyncController | null>(null);
	const apiRef = React.useRef<PuckApiLike | null>(null);
	const [api, setApi] = React.useState<PuckApiLike | null>(null);
	const [snapshot, setSnapshot] = React.useState<SyncSnapshot | null>(null);
	const debounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
	const idleRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

	const getPuckApiRef = React.useRef(getPuckApi);
	getPuckApiRef.current = getPuckApi;

	/**
	 * Acquire the Puck API **after mount**, never during render.
	 *
	 * `ctx.getPuckApi()` throws while `<Puck>` is still mounting, and this
	 * surface is a sibling of the Puck subtree — so the first effect can
	 * still run too early. A bounded retry rides that out instead of
	 * crashing the surface (core catches a throwing surface and unmounts
	 * it permanently, which is how this reached E2E as a blank panel).
	 */
	React.useEffect(() => {
		if (!isOpen || apiRef.current !== null) return;
		let attempts = 0;
		let timer: ReturnType<typeof setTimeout> | null = null;

		const attempt = (): void => {
			attempts += 1;
			let resolved: PuckApiLike | null = null;
			try {
				resolved = getPuckApiRef.current?.() ?? null;
			} catch {
				resolved = null; // still mounting
			}
			if (resolved !== null) {
				apiRef.current = resolved;
				setApi(resolved);
				return;
			}
			if (attempts < 50) timer = setTimeout(attempt, 100);
		};
		attempt();

		return () => {
			if (timer !== null) clearTimeout(timer);
		};
	}, [isOpen]);

	// One controller per acquired API, built from the live document.
	if (controllerRef.current === null && api !== null) {
		const schemas = deriveSchemas(api.config);
		const validate = (text: string): ApplyResult<Data> => {
			const parsed = parseJson(text);
			if (!parsed.ok) return parsed;
			const gated = validateDocument(parsed.value, schemas);
			return gated.ok
				? { ok: true, value: gated.value }
				: { ok: false, diagnostics: gated.diagnostics };
		};
		controllerRef.current = new SyncController({
			initial: api.appState.data,
			validate,
			ports: {
				applyInterim: (data) =>
					api.dispatch({
						type: "setData",
						recordHistory: false,
						data: () => data,
					}),
				commit: (data) =>
					api.dispatch({
						type: "setData",
						recordHistory: true,
						data: () => data,
					}),
			},
		});
	}

	const publish = React.useCallback(() => {
		setSnapshot(controllerRef.current?.snapshot() ?? null);
	}, []);

	// Initial paint of the buffer, once the controller exists.
	React.useEffect(() => {
		if (api !== null) publish();
	}, [api, publish]);

	// Document changes made outside this panel (canvas, AI, collab peer).
	React.useEffect(() => {
		if (subscribe === undefined || api === null) return;
		return subscribe(() => {
			controllerRef.current?.externalChange(api.appState.data);
			publish();
		});
	}, [subscribe, api, publish]);

	React.useEffect(
		() => () => {
			if (debounceRef.current !== null) clearTimeout(debounceRef.current);
			if (idleRef.current !== null) clearTimeout(idleRef.current);
		},
		[],
	);

	const handleChange = React.useCallback(
		(text: string) => {
			const controller = controllerRef.current;
			if (controller === null) return;
			controller.edit(text);
			publish();

			if (debounceRef.current !== null) clearTimeout(debounceRef.current);
			debounceRef.current = setTimeout(() => {
				controller.debounceElapsed();
				publish();
			}, DEBOUNCE_MS);

			// Restart the idle window on every keystroke: the commit lands
			// once the user actually stops, which is what makes a session one
			// undo step rather than one per pause.
			if (idleRef.current !== null) clearTimeout(idleRef.current);
			idleRef.current = setTimeout(() => {
				controller.commit();
				publish();
			}, IDLE_MS);
		},
		[publish],
	);

	const handleBlur = React.useCallback(() => {
		controllerRef.current?.commit();
		publish();
	}, [publish]);

	// Closed: render nothing heavy. `CodeMirrorSurface` stays unmounted, so
	// its dynamic import — and the whole CodeMirror chunk — is never
	// requested until the user opens the panel for the first time (FR-C10).
	if (!isOpen) {
		return (
			<section
				aria-label="Code editor"
				data-anvilkit-surface="code-editor"
				data-anvilkit-code-open="false"
				hidden
			/>
		);
	}

	if (api === null || snapshot === null) {
		return (
			<section
				aria-label="Code editor"
				data-anvilkit-surface="code-editor"
				data-anvilkit-code-open="true"
				data-anvilkit-code-status="loading"
			>
				<p className="p-3 text-muted-foreground text-sm">Loading the document…</p>
			</section>
		);
	}

	return (
		<section
			aria-label="Code editor"
			data-anvilkit-surface="code-editor"
			data-anvilkit-code-open="true"
			className="flex h-full flex-col"
		>
			{projections.length > 1 ? (
				<div
					role="tablist"
					aria-label={t("codeEditor.projection.label")}
					className="flex gap-1 border-b px-2 py-1"
				>
					{projections.map((projection) => (
						<button
							key={projection}
							type="button"
							role="tab"
							aria-selected={projection === kind}
							data-anvilkit-code-projection={projection}
							onClick={() => setKind(projection)}
							className="rounded px-2 py-0.5 text-xs aria-selected:bg-muted aria-selected:text-foreground"
						>
							{t(`codeEditor.projection.${projection}`)}
						</button>
					))}
				</div>
			) : null}
			<div className="min-h-0 flex-1 overflow-auto">
				{kind === "tsx" ? (
					// P1 read view (design §8.4): a projection of the live
					// document, printed fresh each render. Writing it is the P2
					// `tsxWrite` flag, so `onChange` is deliberately inert.
					<CodeMirrorSurface
						text={emitTsx(api.appState.data, api.config).text}
						diagnostics={[]}
						onChange={() => undefined}
						readOnly
					/>
				) : (
					<CodeMirrorSurface
						text={snapshot.text}
						diagnostics={snapshot.diagnostics}
						onChange={handleChange}
						onBlur={handleBlur}
					/>
				)}
			</div>
			<footer
				aria-live="polite"
				data-anvilkit-code-status={snapshot.state}
				className="border-t px-3 py-1.5 text-muted-foreground text-xs"
			>
				{kind === "tsx"
					? t("codeEditor.projection.readOnly")
					: snapshot.diagnostics.length > 0
						? `${snapshot.diagnostics.length} problem(s)`
						: snapshot.state === "stale"
						? "Changed elsewhere — rebase or discard"
						: snapshot.inSync
							? "Synced"
							: "Unsaved edits"}
			</footer>
		</section>
	);
}
