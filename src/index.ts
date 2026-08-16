export {
	type DeriveOptions,
	type DerivedSchemas,
	deriveSchemas,
	findForbiddenKeys,
	type GateResult,
	JSON_SCHEMA_DEPTH,
	MAX_NODE_DEPTH,
	salvageJson,
	stripFence,
	toDiagnostics,
	validateDocument,
	validateDocumentBounded,
	validateIntents,
} from "./gate/index.js";
export { CODE_EDITOR_ENTRY } from "./i18n/entry.js";
export {
	createPanelVisibilityStore,
	type PanelVisibilityStore,
} from "./panel-visibility.js";
export {
	CODE_EDITOR_SURFACE_ID,
	type CodeEditorPluginOptions,
	createCodeEditorPlugin,
} from "./plugin.js";
export {
	CodePanel,
	type CodePanelProps,
	type PuckApiLike,
} from "./react/CodePanel.js";
export { CodeMirrorSurface } from "./react/CodeMirrorSurface.js";
export { toCodeMirrorDiagnostics } from "./react/diagnostics.js";
export { emitJson, isEquivalent, parseJson } from "./projection/json.js";
export { emitTsx } from "./projection/tsx-emit.js";
export type {
	ApplyResult,
	Diagnostic,
	EmitResult,
	ProjectionKind,
} from "./projection/types.js";
export {
	type CommitPorts,
	completeSnapshot,
	SyncController,
	type SyncControllerOptions,
	type SyncMode,
	type SyncSnapshot,
	type SyncState,
} from "./sync/index.js";
