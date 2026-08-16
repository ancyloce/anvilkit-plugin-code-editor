/**
 * The shared validation gate. Plugin-local for now; promoted to
 * `@anvilkit/schema` at the third consumer (PRD 0023 RESOLVED-2), which is
 * why nothing here imports React or the plugin context.
 */

export { salvageJson, stripFence } from "./salvage.js";
export {
	type DerivedSchemas,
	type DeriveOptions,
	deriveSchemas,
	findForbiddenKeys,
	JSON_SCHEMA_DEPTH,
	MAX_NODE_DEPTH,
} from "./schema.js";
export {
	type GateResult,
	toDiagnostics,
	validateDocument,
	validateDocumentBounded,
	validateIntents,
} from "./validate.js";
