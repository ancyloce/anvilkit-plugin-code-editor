import { deepEqualJson } from "@anvilkit/core/editor";
import type { Config, Data, Field } from "@puckeditor/core";
import type { ParsedTsxDocument, ParsedTsxNode } from "./tsx-parse.js";
import type { ApplyResult, Diagnostic } from "./types.js";

const CARRIERS = ["appearance", "interactions", "bindings"] as const;
const MAX_ID_ATTEMPTS = 32;

interface CurrentNode {
	readonly type: string;
	readonly props: Readonly<Record<string, unknown>>;
	readonly [key: string]: unknown;
}

export interface MergeTsxOptions {
	/** Injectable for deterministic tests; production defaults to crypto.randomUUID(). */
	readonly createId?: () => string;
}

function diagnostic(path: string, message: string): Diagnostic {
	return {
		path,
		message,
		severity: "error",
		hintKey: "codeEditor.hint.fields",
	};
}

function fieldsOf(config: Config, type: string): Record<string, Field> {
	return (config.components?.[type]?.fields ?? {}) as Record<string, Field>;
}

function isParsedNode(value: unknown): value is ParsedTsxNode {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { type?: unknown }).type === "string" &&
		typeof (value as { props?: unknown }).props === "object"
	);
}

function isCurrentNode(value: unknown): value is CurrentNode {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { type?: unknown }).type === "string" &&
		typeof (value as { props?: unknown }).props === "object" &&
		(value as { props?: unknown }).props !== null
	);
}

/**
 * Visit the Puck-native nesting vocabulary only: top-level slots and slots
 * declared inside array items. This intermediate tree is never persisted.
 */
function visitParsed(
	node: ParsedTsxNode,
	config: Config,
	path: string,
	visit: (node: ParsedTsxNode, path: string) => void,
): void {
	visit(node, path);
	for (const [fieldName, field] of Object.entries(
		fieldsOf(config, node.type),
	)) {
		const value = node.props[fieldName];
		if (field.type === "slot" && Array.isArray(value)) {
			value.filter(isParsedNode).forEach((child, index) => {
				visitParsed(
					child,
					config,
					`${path}.props.${fieldName}[${index}]`,
					visit,
				);
			});
			continue;
		}
		if (field.type !== "array" || !Array.isArray(value)) continue;
		const itemFields = (field as { arrayFields?: Record<string, Field> })
			.arrayFields;
		if (!itemFields) continue;
		value.forEach((item, itemIndex) => {
			if (typeof item !== "object" || item === null || Array.isArray(item))
				return;
			for (const [itemFieldName, itemField] of Object.entries(itemFields)) {
				const children = (item as Record<string, unknown>)[itemFieldName];
				if (itemField.type !== "slot" || !Array.isArray(children)) continue;
				children.filter(isParsedNode).forEach((child, childIndex) => {
					visitParsed(
						child,
						config,
						`${path}.props.${fieldName}[${itemIndex}].${itemFieldName}[${childIndex}]`,
						visit,
					);
				});
			}
		});
	}
}

/** Walk the same declared slot vocabulary without rebuilding live nodes. */
function visitCurrent(
	node: CurrentNode,
	config: Config,
	visit: (node: CurrentNode) => void,
): void {
	visit(node);
	for (const [fieldName, field] of Object.entries(
		fieldsOf(config, node.type),
	)) {
		const value = node.props[fieldName];
		if (field.type === "slot" && Array.isArray(value)) {
			for (const child of value) {
				if (isCurrentNode(child)) visitCurrent(child, config, visit);
			}
			continue;
		}
		if (field.type !== "array" || !Array.isArray(value)) continue;
		const itemFields = (field as { arrayFields?: Record<string, Field> })
			.arrayFields;
		if (!itemFields) continue;
		for (const item of value) {
			if (typeof item !== "object" || item === null || Array.isArray(item))
				continue;
			for (const [itemFieldName, itemField] of Object.entries(itemFields)) {
				const children = (item as Record<string, unknown>)[itemFieldName];
				if (itemField.type !== "slot" || !Array.isArray(children)) continue;
				for (const child of children) {
					if (isCurrentNode(child)) visitCurrent(child, config, visit);
				}
			}
		}
	}
}

function indexCurrent(
	current: Data,
	config: Config,
): ApplyResult<Map<string, CurrentNode>> {
	const byId = new Map<string, CurrentNode>();
	let duplicate: string | null = null;
	const indexContent = (content: unknown): void => {
		if (!Array.isArray(content)) return;
		for (const item of content) {
			if (!isCurrentNode(item)) continue;
			visitCurrent(item, config, (entry) => {
				const id = entry.props.id;
				if (typeof id !== "string" || id.length === 0) return;
				if (byId.has(id)) duplicate = id;
				else byId.set(id, entry);
			});
		}
	};
	indexContent((current as unknown as { content?: unknown }).content);
	const zones = (current as unknown as { zones?: unknown }).zones;
	if (typeof zones === "object" && zones !== null && !Array.isArray(zones)) {
		for (const content of Object.values(zones)) indexContent(content);
	}
	if (duplicate !== null) {
		return {
			ok: false,
			diagnostics: [
				diagnostic(
					"",
					`The current document contains duplicate node id ${duplicate}; identity merge is ambiguous.`,
				),
			],
		};
	}
	return { ok: true, value: byId };
}

function validateParsedIds(
	parsed: ParsedTsxDocument,
	config: Config,
): ApplyResult<Set<string>> {
	const seen = new Set<string>();
	let failure: Diagnostic | null = null;
	parsed.content.forEach((node, index) => {
		visitParsed(node, config, `content[${index}]`, (entry, path) => {
			if (failure !== null || entry.akId === undefined) return;
			if (seen.has(entry.akId)) {
				failure = diagnostic(
					`${path}.akId`,
					`Duplicate akId ${entry.akId} is not allowed; no identity guess was applied.`,
				);
				return;
			}
			seen.add(entry.akId);
		});
	});
	return failure === null
		? { ok: true, value: seen }
		: { ok: false, diagnostics: [failure] };
}

function allocateId(
	createId: () => string,
	reserved: Set<string>,
	path: string,
): ApplyResult<string> {
	for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt += 1) {
		const candidate = createId();
		if (candidate.length > 0 && !reserved.has(candidate)) {
			reserved.add(candidate);
			return { ok: true, value: candidate };
		}
	}
	return {
		ok: false,
		diagnostics: [
			diagnostic(
				path,
				`Unable to allocate a fresh node id after ${MAX_ID_ATTEMPTS} attempts.`,
			),
		],
	};
}

function mergeNode(
	parsed: ParsedTsxNode,
	path: string,
	config: Config,
	currentById: ReadonlyMap<string, CurrentNode>,
	reserved: Set<string>,
	createId: () => string,
): ApplyResult<CurrentNode> {
	const current =
		parsed.akId === undefined ? undefined : currentById.get(parsed.akId);
	let id: string;
	if (current !== undefined && parsed.akId !== undefined) {
		id = parsed.akId;
		reserved.add(id);
	} else {
		const allocated = allocateId(createId, reserved, `${path}.props.id`);
		if (!allocated.ok) return allocated;
		id = allocated.value;
	}

	const defaults =
		current === undefined
			? ((config.components?.[parsed.type]?.defaultProps ?? {}) as Record<
					string,
					unknown
				>)
			: {};
	const props: Record<string, unknown> = {
		...defaults,
		...parsed.props,
		id,
	};

	for (const [fieldName, field] of Object.entries(
		fieldsOf(config, parsed.type),
	)) {
		const value = parsed.props[fieldName];
		if (field.type === "slot" && Array.isArray(value)) {
			const children: CurrentNode[] = [];
			for (let index = 0; index < value.length; index += 1) {
				const child = value[index];
				if (!isParsedNode(child)) continue;
				const merged = mergeNode(
					child,
					`${path}.props.${fieldName}[${index}]`,
					config,
					currentById,
					reserved,
					createId,
				);
				if (!merged.ok) return merged;
				children.push(merged.value);
			}
			props[fieldName] = children;
			continue;
		}
		if (field.type !== "array" || !Array.isArray(value)) continue;
		const itemFields = (field as { arrayFields?: Record<string, Field> })
			.arrayFields;
		if (!itemFields) continue;
		const items: unknown[] = [];
		for (let itemIndex = 0; itemIndex < value.length; itemIndex += 1) {
			const item = value[itemIndex];
			if (typeof item !== "object" || item === null || Array.isArray(item)) {
				items.push(item);
				continue;
			}
			const nextItem: Record<string, unknown> = {
				...(item as Record<string, unknown>),
			};
			for (const [itemFieldName, itemField] of Object.entries(itemFields)) {
				const childValues = nextItem[itemFieldName];
				if (itemField.type !== "slot" || !Array.isArray(childValues)) continue;
				const children: CurrentNode[] = [];
				for (
					let childIndex = 0;
					childIndex < childValues.length;
					childIndex += 1
				) {
					const child = childValues[childIndex];
					if (!isParsedNode(child)) continue;
					const merged = mergeNode(
						child,
						`${path}.props.${fieldName}[${itemIndex}].${itemFieldName}[${childIndex}]`,
						config,
						currentById,
						reserved,
						createId,
					);
					if (!merged.ok) return merged;
					children.push(merged.value);
				}
				nextItem[itemFieldName] = children;
			}
			items.push(nextItem);
		}
		props[fieldName] = items;
	}

	if (current !== undefined) {
		for (const carrier of CARRIERS) {
			if (Object.hasOwn(current.props, carrier)) {
				// Parsed TSX cannot contain carriers. Restoring the complete current
				// value therefore preserves every nested leaf without a lossy
				// reconstruction or a second carrier schema.
				props[carrier] = current.props[carrier];
			}
		}
		if (current.type === parsed.type && deepEqualJson(current.props, props)) {
			return { ok: true, value: current };
		}
	}

	return {
		ok: true,
		value:
			current === undefined
				? { type: parsed.type, props }
				: { ...current, type: parsed.type, props },
	};
}

/**
 * Merge a parsed TSX projection back into the current Puck document.
 *
 * Identity is matched only by `akId`. Matched nodes retain their id,
 * invisible carriers and Puck-owned sibling state; new/unmatched nodes get
 * config defaults plus a fresh id. Root props and legacy zones stay on the
 * authoritative current document because the TSX projection never exposes
 * them. Any failure returns diagnostics and the caller applies nothing.
 */
export function mergeTsxDocument(
	parsed: ParsedTsxDocument,
	current: Data,
	config: Config,
	options: MergeTsxOptions = {},
): ApplyResult<Data> {
	const indexed = indexCurrent(current, config);
	if (!indexed.ok) return indexed;
	const parsedIds = validateParsedIds(parsed, config);
	if (!parsedIds.ok) return parsedIds;

	const createId = options.createId ?? (() => crypto.randomUUID());
	const reserved = new Set(indexed.value.keys());
	const content: CurrentNode[] = [];
	for (let index = 0; index < parsed.content.length; index += 1) {
		const merged = mergeNode(
			parsed.content[index] as ParsedTsxNode,
			`content[${index}]`,
			config,
			indexed.value,
			reserved,
			createId,
		);
		if (!merged.ok) return merged;
		content.push(merged.value);
	}

	return {
		ok: true,
		value: { ...current, content } as Data,
	};
}
