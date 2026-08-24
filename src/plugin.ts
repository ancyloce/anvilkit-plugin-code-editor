import type { StudioPlugin, StudioPluginLifecycleHooks } from "@anvilkit/core";
import { createElement } from "react";
import config from "../meta/config.json" with { type: "json" };
import packageJson from "../package.json" with { type: "json" };
import { CODE_EDITOR_ENTRY } from "./i18n/entry.js";
import {
	createPanelVisibilityStore,
	type PanelVisibilityStore,
} from "./panel-visibility.js";
import { CodePanel, type PuckApiLike } from "./react/CodePanel.js";

const META = {
	...config,
	version: packageJson.version,
} as const;

/** Surface id — re-registering the same id replaces the entry. */
export const CODE_EDITOR_SURFACE_ID = "code-editor";

export interface CodeEditorPluginOptions {
	/**
	 * Projections to offer. `"json"` is editable; `"tsx"` is the P1
	 * read-only canonical projection (design §8.4) — writing it arrives
	 * behind the P2 `tsxWrite` flag.
	 */
	readonly projections?: readonly ("json" | "tsx")[];
	/** Enable constrained TSX writes. Default false preserves P1. */
	readonly tsxWrite?: boolean;
	/**
	 * Set by hosts whose plugin roster contains an active collaboration
	 * adapter. This forces manual apply and overrides `sync.mode`.
	 */
	readonly collaborationActive?: boolean;
	/** Optional sync cadence; defaults to live, 200 ms / 1.5 s. */
	readonly sync?: {
		readonly mode?: "live" | "manual";
		readonly debounceMs?: number;
		readonly commitIdleMs?: number;
	};
	/** Open the panel at mount. Default false — see FR-C10. */
	readonly initiallyOpen?: boolean;
	/**
	 * Called instead of `console.warn` when the plugin no-ops because the
	 * host did not enable the visual editor. Injectable so the no-op path
	 * is testable without spying on the console.
	 */
	readonly onUnavailable?: (message: string) => void;
}

const UNAVAILABLE_MESSAGE =
	"[@anvilkit/plugin-code-editor] The visual editor is not enabled " +
	"(`editor.features.enabled`), so `ctx.editor` is absent. The code panel " +
	"is disabled for this mount; no editor surface or header action was " +
	"registered.";

/**
 * Create the code-editor plugin (PRD 0023 / design 0022 §8).
 *
 * `register` wires the i18n catalog, the editor surface that hosts the code
 * panel, and a header action to toggle it. The plugin **requires**
 * `ctx.editor`: when the host has not enabled the visual editor it degrades
 * to a single logged warning and registers nothing (FR-C15) rather than
 * throwing or half-registering a surface that could never read a document.
 */
export function createCodeEditorPlugin(
	options: CodeEditorPluginOptions = {},
): StudioPlugin {
	return {
		meta: META,
		register(ctx) {
			ctx.registerMessages?.(CODE_EDITOR_ENTRY);

			// FR-C15: the whole surface reads through `EditorApi`, so without
			// `ctx.editor` there is nothing to project. Warn once, register
			// nothing else, and let the rest of Studio run untouched.
			if (ctx.editor === undefined) {
				const warn = options.onUnavailable ?? ((m: string) => console.warn(m));
				warn(UNAVAILABLE_MESSAGE);
				return { meta: META };
			}

			// Closed by default: the CodeMirror chunk must not load until
			// the user actually opens the panel (FR-C10).
			const visibility: PanelVisibilityStore = createPanelVisibilityStore(
				options.initiallyOpen ?? false,
			);

			let unregisterSurface: (() => void) | undefined;
			if (typeof ctx.registerEditorSurface === "function") {
				unregisterSurface = ctx.registerEditorSurface({
					id: CODE_EDITOR_SURFACE_ID,
					// `getPuckApi` is the plugin context's public seam (the
					// same one `plugin-ai-copilot` commits through); the panel
					// never reaches into core internals.
						render: () =>
						createElement(CodePanel, {
							getPuckApi: () =>
								ctx.getPuckApi() as unknown as PuckApiLike | null,
							readData: () => ctx.getData(),
							// The plugin API nests the canonical EditorApi one
							// level down (`ctx.editor.editor`).
							subscribe: (listener: () => void) =>
								ctx.editor?.editor.subscribe(listener) ?? (() => undefined),
							visibility,
							projections: options.projections,
							tsxWrite: options.tsxWrite ?? false,
							collaborationActive: options.collaborationActive ?? false,
							sync: options.sync,
						}),
				});
			}

			const onDestroy: NonNullable<
				StudioPluginLifecycleHooks["onDestroy"]
			> = () => {
				unregisterSurface?.();
				unregisterSurface = undefined;
			};

			return {
				meta: META,
				hooks: { onDestroy },
				headerActions: [
					{
						id: "code-editor-toggle",
						labelKey: "codeEditor.toggle",
						icon: "code",
						onClick: () => visibility.toggle(),
					},
				],
			};
		},
	};
}
