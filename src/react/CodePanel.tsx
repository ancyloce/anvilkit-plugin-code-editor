"use client";

// This package builds CLASSIC JSX, so every .tsx must bind React itself —
// without this the built `dist` throws "React is not defined" at runtime and
// typecheck will not catch it (hook-enforced repo rule).
import * as React from "react";
import type { Config, Data } from "@puckeditor/core";
import { deriveSchemas } from "../gate/schema.js";
import { validateDocument } from "../gate/validate.js";
import { parseJson } from "../projection/json.js";
import { emitTsx } from "../projection/tsx-emit.js";
import type { ParsedTsxDocument } from "../projection/tsx-parse.js";
import type { ApplyResult, ProjectionKind } from "../projection/types.js";
import type { PanelVisibilityStore } from "../panel-visibility.js";
import {
	SyncController,
	type SyncMode,
	type SyncSnapshot,
} from "../sync/controller.js";
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
	/** Fresh raw document accessor for change notifications. */
	readonly readData?: () => Data;
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
	/** Enable constrained TSX writes. Default false preserves P1 exactly. */
	readonly tsxWrite?: boolean;
	/**
	 * Host-owned capability signal. A roster containing a collaboration
	 * plugin must set this so the panel can suppress keystroke broadcasts.
	 */
	readonly collaborationActive?: boolean;
	/** Sync cadence. Collaboration always overrides `mode` to `manual`. */
	readonly sync?: {
		readonly mode?: SyncMode;
		readonly debounceMs?: number;
		readonly commitIdleMs?: number;
	};
	/**
	 * Message resolver. The plugin context has no translation seam yet, so
	 * the default reads the package's own English catalog — the strings
	 * still live in one place, and wiring a real `t` later is one line.
	 */
	readonly t?: (key: string) => string;
}

/** English fallbacks, kept in step with `i18n/messages/en.json`. */
const EN: Record<string, string> = {
	"codeEditor.panel.title": "Code",
	"codeEditor.projection.json": "JSON",
	"codeEditor.projection.tsx": "TSX",
	"codeEditor.projection.label": "Projection",
	"codeEditor.projection.readOnly": "Read-only view of the document",
	"codeEditor.projection.loading": "Loading the writable TSX grammar…",
	"codeEditor.editor.loadFailed": "Unable to load the code editor.",
	"codeEditor.sync.apply": "Apply",
	"codeEditor.collaboration.manual":
		"Collaboration is active. Changes apply only when you choose Apply.",
};

const defaultT = (key: string): string => EN[key] ?? key;

interface TsxRuntime {
	readonly parseTsx: (
		text: string,
		config: Config,
	) => ApplyResult<ParsedTsxDocument>;
	readonly mergeTsxDocument: (
		parsed: ParsedTsxDocument,
		current: Data,
		config: Config,
	) => ApplyResult<Data>;
}

interface ControllerHandle {
	readonly controller: SyncController;
	readonly externalChange: (data: Data) => void;
}

function createController(
	api: PuckApiLike,
	kind: ProjectionKind,
	mode: SyncMode,
	initial: Data,
	tsxRuntime?: TsxRuntime,
): ControllerHandle {
	let current = initial;
	const schemas = deriveSchemas(api.config);
	const validate = (text: string): ApplyResult<Data> => {
		if (kind === "json") {
			const parsed = parseJson(text);
			if (!parsed.ok) return parsed;
			const gated = validateDocument(parsed.value, schemas);
			return gated.ok
				? { ok: true, value: gated.value }
				: { ok: false, diagnostics: gated.diagnostics };
		}

		if (tsxRuntime === undefined) {
			return {
				ok: false,
				diagnostics: [
					{
						path: "",
						message: "The writable TSX grammar is still loading.",
						severity: "error",
						hintKey: "codeEditor.hint.fields",
					},
				],
			};
		}
		const parsed = tsxRuntime.parseTsx(text, api.config);
		if (!parsed.ok) return parsed;
		const merged = tsxRuntime.mergeTsxDocument(
			parsed.value,
			current,
			api.config,
		);
		if (!merged.ok) return merged;
		const gated = validateDocument(merged.value, schemas);
		return gated.ok
			? { ok: true, value: gated.value }
			: { ok: false, diagnostics: gated.diagnostics };
	};

	const dispatch = (data: Data, recordHistory: boolean): void => {
		current = data;
		api.dispatch({
			type: "setData",
			recordHistory,
			data: () => data,
		});
	};
	const controller = new SyncController({
		initial: current,
		emit:
			kind === "tsx"
				? (data) => emitTsx(data, api.config).text
				: undefined,
		validate,
		mode,
		ports: {
			applyInterim: (data) => dispatch(data, false),
			commit: (data) => dispatch(data, true),
		},
	});

	return {
		controller,
		externalChange(data) {
			current = data;
			controller.externalChange(data);
		},
	};
}

function readCurrentData(
	api: PuckApiLike,
	readData?: () => Data,
): Data {
	try {
		return readData?.() ?? api.appState.data;
	} catch {
		return api.appState.data;
	}
}

interface CodePanelViewProps {
	readonly api: PuckApiLike;
	readonly projections: readonly ProjectionKind[];
	readonly kind: ProjectionKind;
	readonly tsxWrite: boolean;
	readonly collaborationActive: boolean;
	readonly tsxLoadFailed: boolean;
	readonly codeMirrorLoadFailed: boolean;
	readonly activeSnapshot: SyncSnapshot | null;
	readonly syncMode: SyncMode;
	readonly t: (key: string) => string;
	readonly onKindChange: (kind: ProjectionKind) => void;
	readonly onChange: (text: string) => void;
	readonly onBlur: () => void;
	readonly onApply: () => void;
	readonly onLoadError: (error: Error) => void;
}

/** Render-only half of the panel; controller lifecycle stays in CodePanel. */
function CodePanelView({
	api,
	projections,
	kind,
	tsxWrite,
	collaborationActive,
	tsxLoadFailed,
	codeMirrorLoadFailed,
	activeSnapshot,
	syncMode,
	t,
	onKindChange,
	onChange,
	onBlur,
	onApply,
	onLoadError,
}: CodePanelViewProps): React.ReactElement {
	const writableTsx = kind === "tsx" && tsxWrite;
	const manual = activeSnapshot?.mode === "manual";
	const loadFailure = "Unable to load the writable TSX grammar";
	const statusText =
		codeMirrorLoadFailed
			? t("codeEditor.editor.loadFailed")
			: activeSnapshot === null
			? t("codeEditor.projection.loading")
			: kind === "tsx" && !tsxWrite
				? t("codeEditor.projection.readOnly")
				: tsxLoadFailed
					? loadFailure
					: activeSnapshot.diagnostics.length > 0
						? `${activeSnapshot.diagnostics.length} problem(s)`
						: activeSnapshot.state === "stale"
							? "Changed elsewhere — rebase or discard"
							: activeSnapshot.inSync
								? "Synced"
								: "Unsaved edits";

	return (
		<section
			aria-label="Code editor"
			data-anvilkit-surface="code-editor"
			data-anvilkit-code-open="true"
			data-anvilkit-code-mode={activeSnapshot?.mode ?? syncMode}
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
							onClick={() => onKindChange(projection)}
							className="rounded px-2 py-0.5 text-xs aria-selected:bg-muted aria-selected:text-foreground"
						>
							{t(`codeEditor.projection.${projection}`)}
						</button>
					))}
				</div>
			) : null}
			{collaborationActive ? (
				<p
					role="status"
					title={t("codeEditor.collaboration.manual")}
					data-anvilkit-code-collaboration="manual"
					className="border-b bg-muted/50 px-3 py-1.5 text-muted-foreground text-xs"
				>
					{t("codeEditor.collaboration.manual")}
				</p>
			) : null}
			<div className="min-h-0 flex-1 overflow-auto">
				{kind === "tsx" && !tsxWrite ? (
					<CodeMirrorSurface
						text={emitTsx(api.appState.data, api.config).text}
						diagnostics={[]}
						ariaLabel={t("codeEditor.panel.title")}
						onChange={() => undefined}
						onLoadError={onLoadError}
						readOnly
					/>
				) : writableTsx && activeSnapshot === null ? (
					<p
						data-anvilkit-code-status={
							tsxLoadFailed ? "tsx-load-failed" : "loading-tsx"
						}
						className="p-3 text-muted-foreground text-sm"
					>
						{tsxLoadFailed ? loadFailure : t("codeEditor.projection.loading")}
					</p>
				) : (
					<CodeMirrorSurface
						text={activeSnapshot?.text ?? ""}
						diagnostics={activeSnapshot?.diagnostics ?? []}
						ariaLabel={t("codeEditor.panel.title")}
						onChange={onChange}
						onBlur={onBlur}
						onLoadError={onLoadError}
					/>
				)}
			</div>
			<footer
				aria-live="polite"
				data-anvilkit-code-status={
					codeMirrorLoadFailed
						? "load-failed"
						: (activeSnapshot?.state ?? "loading")
				}
				className="flex items-center justify-between gap-2 border-t px-3 py-1.5 text-muted-foreground text-xs"
			>
				<span>{statusText}</span>
				{manual && !(kind === "tsx" && !tsxWrite) ? (
					<button
						type="button"
						onClick={onApply}
						disabled={
							activeSnapshot === null || activeSnapshot.state === "stale"
						}
						title={
							collaborationActive
								? t("codeEditor.collaboration.manual")
								: undefined
						}
						className="rounded border px-2 py-0.5 text-foreground disabled:cursor-not-allowed disabled:opacity-50"
					>
						{t("codeEditor.sync.apply")}
					</button>
				) : null}
			</footer>
		</section>
	);
}

/**
 * The code panel surface (design 0022 §8.1): the document as editable JSON.
 *
 * Everything about *how* edits reach the document lives in `SyncController`
 * — this component owns only the timers, the CodeMirror mount and the
 * status line, so the interesting behaviour stays unit-testable without a
 * DOM.
 */
export function CodePanel(props: CodePanelProps): React.ReactElement {
	const { getPuckApi, readData, subscribe, visibility } = props;
	const projections = props.projections ?? ["json", "tsx"];
	const tsxWrite = props.tsxWrite ?? false;
	const collaborationActive = props.collaborationActive ?? false;
	const syncMode: SyncMode = collaborationActive
		? "manual"
		: (props.sync?.mode ?? "live");
	const debounceMs = props.sync?.debounceMs ?? DEBOUNCE_MS;
	const idleMs = props.sync?.commitIdleMs ?? IDLE_MS;
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
	const controllersRef = React.useRef<{
		json: ControllerHandle | null;
		tsx: ControllerHandle | null;
	}>({ json: null, tsx: null });
	const apiRef = React.useRef<PuckApiLike | null>(null);
	const [api, setApi] = React.useState<PuckApiLike | null>(null);
	const [jsonSnapshot, setJsonSnapshot] =
		React.useState<SyncSnapshot | null>(null);
	const [tsxSnapshot, setTsxSnapshot] =
		React.useState<SyncSnapshot | null>(null);
	const [tsxRuntime, setTsxRuntime] = React.useState<TsxRuntime | null>(null);
	const [tsxLoadFailed, setTsxLoadFailed] = React.useState(false);
	const [codeMirrorLoadFailed, setCodeMirrorLoadFailed] = React.useState(false);
	const debounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
	const idleRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

	const getPuckApiRef = React.useRef(getPuckApi);
	React.useEffect(() => {
		getPuckApiRef.current = getPuckApi;
	}, [getPuckApi]);

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

	// Babel and the writable grammar stay out of the entry path. They are
	// requested only after an opted-in user opens the TSX tab (FR-C10).
	React.useEffect(() => {
		if (
			!isOpen ||
			!tsxWrite ||
			kind !== "tsx" ||
			tsxRuntime !== null ||
			tsxLoadFailed
		)
			return;
		let cancelled = false;
		void Promise.all([
			import("../projection/tsx-parse.js"),
			import("../projection/merge.js"),
		]).then(([parser, merger]) => {
			if (cancelled) return;
			setTsxRuntime({
				parseTsx: parser.parseTsx,
				mergeTsxDocument: merger.mergeTsxDocument,
			});
		}).catch(() => {
			if (!cancelled) setTsxLoadFailed(true);
		});
		return () => {
			cancelled = true;
		};
	}, [isOpen, kind, tsxLoadFailed, tsxRuntime, tsxWrite]);

	// One state machine per projection keeps an in-progress buffer intact
	// when the user switches tabs. The TSX controller is created lazily with
	// the parser chunk; JSON remains identical when `tsxWrite` is false.
	const publish = React.useCallback(() => {
		setJsonSnapshot(
			controllersRef.current.json?.controller.snapshot() ?? null,
		);
		setTsxSnapshot(
			controllersRef.current.tsx?.controller.snapshot() ?? null,
		);
	}, []);

	React.useEffect(() => {
		if (api === null || controllersRef.current.json !== null) return;
		controllersRef.current.json = createController(
			api,
			"json",
			syncMode,
			readCurrentData(api, readData),
		);
		publish();
	}, [api, publish, readData, syncMode]);

	React.useEffect(() => {
		if (
			api === null ||
			!tsxWrite ||
			tsxRuntime === null ||
			controllersRef.current.tsx !== null
		)
			return;
		controllersRef.current.tsx = createController(
			api,
			"tsx",
			syncMode,
			readCurrentData(api, readData),
			tsxRuntime,
		);
		publish();
	}, [api, publish, readData, syncMode, tsxRuntime, tsxWrite]);

	// Initial paint of the buffer, once the controller exists.
	React.useEffect(() => {
		if (api !== null) publish();
	}, [api, publish, tsxRuntime]);

	React.useEffect(() => {
		controllersRef.current.json?.controller.setMode(syncMode);
		controllersRef.current.tsx?.controller.setMode(syncMode);
		publish();
	}, [publish, syncMode]);

	// Document changes made outside this panel (canvas, AI, collab peer).
	React.useEffect(() => {
		if (subscribe === undefined || api === null) return;
		return subscribe(() => {
			// `PuckApi.appState` is a snapshot. Reacquire the public API on
			// every notification or an own dispatch is compared with the stale
			// mount-time document and incorrectly looks like a remote edit.
			let data = api.appState.data;
			try {
				data = readData?.() ?? getPuckApiRef.current?.()?.appState.data ?? data;
			} catch {
				// A transient unbind during teardown has no newer document.
			}
			controllersRef.current.json?.externalChange(data);
			controllersRef.current.tsx?.externalChange(data);
			publish();
		});
	}, [subscribe, api, publish, readData]);

	React.useEffect(
		() => () => {
			if (debounceRef.current !== null) clearTimeout(debounceRef.current);
			if (idleRef.current !== null) clearTimeout(idleRef.current);
		},
		[],
	);

	const handleChange = React.useCallback(
		(text: string) => {
			const projection = kind === "tsx" && tsxWrite ? "tsx" : "json";
			const controller = controllersRef.current[projection]?.controller;
			if (controller === undefined) return;
			controller.edit(text);
			publish();

			if (debounceRef.current !== null) clearTimeout(debounceRef.current);
			debounceRef.current = setTimeout(() => {
				controller.debounceElapsed();
				publish();
			}, debounceMs);

			// Restart the idle window on every keystroke: the commit lands
			// once the user actually stops, which is what makes a session one
			// undo step rather than one per pause. Manual mode never schedules
			// a commit: collab peers see only the explicit Apply intent.
			if (idleRef.current !== null) clearTimeout(idleRef.current);
			if (controller.snapshot().mode === "live") {
				idleRef.current = setTimeout(() => {
					controller.commit();
					publish();
				}, idleMs);
			}
		},
		[debounceMs, idleMs, kind, publish, tsxWrite],
	);

	const handleBlur = React.useCallback(() => {
		const projection = kind === "tsx" && tsxWrite ? "tsx" : "json";
		const controller = controllersRef.current[projection]?.controller;
		if (controller?.snapshot().mode === "live") controller.commit();
		publish();
	}, [kind, publish, tsxWrite]);

	const handleApply = React.useCallback(() => {
		const projection = kind === "tsx" && tsxWrite ? "tsx" : "json";
		controllersRef.current[projection]?.controller.commit();
		publish();
	}, [kind, publish, tsxWrite]);
	const handleCodeMirrorLoadError = React.useCallback(() => {
		setCodeMirrorLoadFailed(true);
	}, []);

	const handleKindChange = React.useCallback(
		(nextKind: ProjectionKind) => {
			if (nextKind === kind) return;
			const projection = kind === "tsx" && tsxWrite ? "tsx" : "json";
			const controller = controllersRef.current[projection]?.controller;
			// Changing tabs unmounts the current CodeMirror surface, so browser
			// blur ordering is not a reliable commit boundary. End live sessions
			// explicitly; manual/collab buffers remain pending until Apply.
			if (controller?.snapshot().mode === "live") controller.commit();
			publish();
			setKind(nextKind);
		},
		[kind, publish, tsxWrite],
	);

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

	if (api === null || jsonSnapshot === null) {
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

	const activeSnapshot = kind === "tsx" && tsxWrite ? tsxSnapshot : jsonSnapshot;
	return (
		<CodePanelView
			api={api}
			projections={projections}
			kind={kind}
			tsxWrite={tsxWrite}
			collaborationActive={collaborationActive}
			tsxLoadFailed={tsxLoadFailed}
			codeMirrorLoadFailed={codeMirrorLoadFailed}
			activeSnapshot={activeSnapshot}
			syncMode={syncMode}
			t={t}
			onKindChange={handleKindChange}
			onChange={handleChange}
			onBlur={handleBlur}
			onApply={handleApply}
			onLoadError={handleCodeMirrorLoadError}
		/>
	);
}
