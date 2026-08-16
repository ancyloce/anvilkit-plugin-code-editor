import type { Config, Data, Field } from "@puckeditor/core";
import { z } from "zod";

/**
 * Schema derivation (design 0022 §5). The document schema is derived from
 * the live Puck `Config` — the component whitelist, and each component's
 * declared fields, ARE the contract. Nothing here is hand-maintained per
 * component, so a wrapper's new field is gated the moment it is declared.
 *
 * This module is promotion-ready per PRD 0023 RESOLVED-2: pure functions
 * over zod + Puck types, with NO React and no plugin-context imports, so it
 * can move to `@anvilkit/schema` unchanged once a third consumer appears.
 */

export interface DerivedSchemas {
	/** Unbounded, `z.lazy` through slots — the AUTHORITATIVE gate. */
	readonly document: z.ZodType<Data>;
	/**
	 * Depth-BOUNDED twin of {@link document}: structurally identical, but
	 * slot recursion is unrolled a fixed number of times instead of going
	 * through `z.lazy`, so a hostile "depth bomb" is rejected by the schema
	 * rather than by the stack.
	 *
	 * Accepts exactly the documents {@link document} accepts up to
	 * `maxDepth` nesting levels — the equivalence the gate suite pins.
	 */
	readonly documentBounded: z.ZodType<Data>;
	/**
	 * Boundary validator for AI-proposed editor intents.
	 *
	 * **Not a parallel IR** (Puck contract rule 5): this schema exists only
	 * to check untrusted model output before it reaches
	 * `resolveEditorIntent`, which resolves each member immediately to one
	 * commit-helper call. Nothing is serialized INTO an intent and nothing
	 * persists — document state never round-trips through this type.
	 */
	readonly intents: z.ZodType<unknown>;
	/** The component type names the document may use. */
	readonly componentTypes: readonly string[];
	/**
	 * JSON Schema of the bounded document, for prompt embedding and
	 * constrained decoding (DOC-02 §7.2). Unrolled to `jsonSchemaDepth`.
	 */
	readonly jsonSchema: Record<string, unknown>;
}

export interface DeriveOptions {
	/**
	 * Runtime nesting cap for {@link DerivedSchemas.documentBounded}.
	 * Defaults to 16 — DOC-02 §15 correction 3 unified the runtime tree
	 * cap to 16 across the validator, the extractor and this gate.
	 */
	readonly maxDepth?: number;
	/**
	 * Unrolling depth for {@link DerivedSchemas.jsonSchema} only. Defaults
	 * to 4: the embedded schema is a prompt payload, and 16 levels of
	 * unrolled JSON Schema is far too large to embed (DOC-02 §7.2 keeps
	 * N=4 alive solely for this purpose).
	 */
	readonly jsonSchemaDepth?: number;
}

/** DOC-02 §15 correction 3: one runtime tree cap everywhere. */
export const MAX_NODE_DEPTH = 16;
/** JSON-Schema unrolling depth for prompt embedding (DOC-02 §7.2). */
export const JSON_SCHEMA_DEPTH = 4;

/**
 * Keys that must never appear in an authored or generated document:
 * assigning them during a merge is prototype pollution.
 */
const FORBIDDEN_KEYS = ["__proto__", "constructor", "prototype"] as const;

/** Field → value schema, per the §3.4 normative table. */
function schemaOfField(field: Field, node: z.ZodType): z.ZodType {
	switch (field.type) {
		case "text":
		case "textarea":
			return z.string();
		case "number":
			return z.number();
		case "radio":
		case "select": {
			const values = (field.options ?? []).map((option) => option.value);
			// Puck option values may be string | number | boolean, so a plain
			// literal union carries the exact authored vocabulary.
			return values.length === 0
				? z.unknown()
				: z.union(
						values.map((value) =>
							z.literal(value as string | number | boolean),
						),
					);
		}
		case "array": {
			const itemFields = field.arrayFields ?? {};
			return z.array(objectOfFields(itemFields, node));
		}
		case "object":
			return objectOfFields(field.objectFields ?? {}, node);
		case "slot":
			// Slots recurse into the component union — the only nesting
			// mechanism, and why the document schema must be lazy.
			return z.array(node);
		default:
			// `custom` (the hidden authoring carriers) and anything a future
			// Puck adds: accepted verbatim rather than guessed at.
			return z.unknown();
	}
}

function objectOfFields(
	fields: Record<string, Field>,
	node: z.ZodType,
): z.ZodType {
	const shape: Record<string, z.ZodType> = {};
	for (const [name, field] of Object.entries(fields)) {
		shape[name] = schemaOfField(field, node).optional();
	}
	// Loose: unknown props (ids, carriers a component has not declared yet)
	// are preserved rather than stripped — the same choice the canvas IR
	// schemas make.
	return z.looseObject(shape);
}

/**
 * Derive the document schema for a config.
 *
 * The component union is a plain `z.union`, NOT `z.discriminatedUnion`:
 * the latter breaks inference through `z.lazy` recursion (zod#4264), which
 * every slot-bearing component needs.
 */
export function deriveSchemas(
	config: Config,
	options: DeriveOptions = {},
): DerivedSchemas {
	const componentTypes = Object.keys(config.components ?? {});
	const maxDepth = options.maxDepth ?? MAX_NODE_DEPTH;
	const jsonSchemaDepth = options.jsonSchemaDepth ?? JSON_SCHEMA_DEPTH;

	/**
	 * One component-union level, recursing through `child` for its slots.
	 *
	 * `discriminated` picks how the variants combine. A plain `z.union`
	 * reports a failure at the union itself ("Invalid input" on the node),
	 * which is coarse; `z.discriminatedUnion` dispatches on `type` first and
	 * so reports the exact offending prop path. The catch is zod#4264: a
	 * discriminated union does not survive `z.lazy` recursion. The UNROLLED
	 * (bounded) schema has no `z.lazy`, so it gets the precise variant —
	 * which is also the one untrusted input goes through, where a good
	 * diagnostic is what drives the AI repair loop.
	 */
	const nodeUnion = (child: z.ZodType, discriminated: boolean): z.ZodType => {
		const variants = componentTypes.map((type) => {
			const fields = (config.components?.[type]?.fields ?? {}) as Record<
				string,
				Field
			>;
			return z.looseObject({
				type: z.literal(type),
				// Every node carries a stable id; the merge path (P2) matches on it.
				props: objectOfFields(fields, child).and(
					z.looseObject({ id: z.string().min(1) }),
				),
			});
		});
		if (variants.length === 0) return z.never();
		if (variants.length === 1) return variants[0] as z.ZodType;
		if (!discriminated) return z.union(variants);
		// Two-or-more is guaranteed above; zod's signature wants that stated
		// as a non-empty tuple rather than a plain array.
		const [first, ...rest] = variants as [
			(typeof variants)[number],
			...(typeof variants)[number][],
		];
		return z.discriminatedUnion("type", [
			first,
			...rest,
		]) as unknown as z.ZodType;
	};

	const node: z.ZodType = z.lazy(() => nodeUnion(node, false));

	// Unrolled twin: `maxDepth` real levels, then a floor that accepts
	// nothing, so a document nested deeper than the cap fails the SCHEMA
	// rather than exhausting the stack (the "depth bomb" fixture).
	let bounded: z.ZodType = z.never();
	for (let level = 0; level < maxDepth; level += 1) {
		bounded = nodeUnion(bounded, true);
	}

	const documentOf = (child: z.ZodType): z.ZodType<Data> =>
		z.looseObject({
			root: z.looseObject({ props: z.looseObject({}).optional() }).optional(),
			content: z.array(child),
			zones: z.record(z.string(), z.array(child)).optional(),
		}) as unknown as z.ZodType<Data>;

	const document = documentOf(node);
	const documentBounded = documentOf(bounded);

	// A shallower unrolling purely for embedding: JSON Schema has no
	// `z.lazy`, and 16 unrolled levels is an unusable prompt payload.
	let embed: z.ZodType = z.never();
	for (let level = 0; level < jsonSchemaDepth; level += 1) {
		embed = nodeUnion(embed, true);
	}

	return {
		document,
		documentBounded,
		intents: intentsSchema(),
		componentTypes,
		jsonSchema: z.toJSONSchema(documentOf(embed), {
			// The union members are structurally distinct per component, and
			// `io: "input"` keeps the schema describing what a model must
			// PRODUCE rather than what zod outputs.
			io: "input",
			unrepresentable: "any",
		}) as Record<string, unknown>,
	};
}

/**
 * Find `__proto__` / `constructor` / `prototype` keys anywhere in a RAW,
 * not-yet-parsed value.
 *
 * These are the prototype-pollution vector: the commit path merges props
 * into live objects, so a document carrying them must never reach it.
 *
 * This deliberately runs BEFORE `safeParse`, not as a schema refinement.
 * zod rebuilds objects during parsing, and rebuilding drops a `__proto__`
 * own-key (assigning it sets the prototype instead) — so by the time a
 * refinement sees the value the evidence is already gone and the check
 * silently passes. Scanning the raw input also means hostile payloads are
 * rejected before any parsing work is done.
 *
 * @returns dotted paths of every offending key, empty when clean.
 */
export function findForbiddenKeys(raw: unknown): string[] {
	const found: string[] = [];
	const walk = (node: unknown, path: string): void => {
		if (Array.isArray(node)) {
			node.forEach((entry, index) => walk(entry, `${path}[${index}]`));
			return;
		}
		if (node === null || typeof node !== "object") return;
		for (const key of Object.getOwnPropertyNames(node)) {
			const child = path === "" ? key : `${path}.${key}`;
			if ((FORBIDDEN_KEYS as readonly string[]).includes(key)) {
				found.push(child);
				continue;
			}
			walk((node as Record<string, unknown>)[key], child);
		}
	};
	walk(raw, "");
	return found;
}

/**
 * Schema for the `EditorIntent` request vocabulary
 * (`packages/runtime/core/src/types/editor-api-v2.ts:105`).
 *
 * Mirrors that union member for member. `interactions`/`bindings` payloads
 * stay `unknown[]`: their shapes are owned by the interactions and
 * bindings engines, and restating them here would fork a contract this
 * gate does not own.
 */
function intentsSchema(): z.ZodType<unknown> {
	const nodeId = z.string().min(1);
	return z.array(
		z.union([
			z.object({
				kind: z.literal("set-inline-text"),
				nodeId,
				targetId: z.string().min(1),
				value: z.string(),
			}),
			z.object({
				kind: z.literal("set-interactions"),
				nodeId,
				interactions: z.array(z.unknown()),
			}),
			z.object({
				kind: z.literal("set-bindings"),
				nodeId,
				bindings: z.array(z.unknown()),
			}),
			z.object({
				kind: z.literal("set-instance-variant"),
				nodeIds: z.array(nodeId).min(1),
				selection: z.record(z.string(), z.string()),
			}),
			z.object({
				kind: z.literal("rename-node"),
				nodeId,
				name: z.string().min(1),
			}),
			z.object({
				kind: z.literal("delete-nodes"),
				nodeIds: z.array(nodeId).min(1),
			}),
		]),
	);
}
