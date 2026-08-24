import type { Config, Data, Field } from "@puckeditor/core";
import type { EmitResult } from "./types.js";

/**
 * The TSX projection (design 0022 §8.4), READ-ONLY in P1.
 *
 * A canonical printer over the document. Rules, in the design's own order:
 *
 * - components appear in whitelist order of appearance (document order);
 * - `akId` is the FIRST attribute — the reserved identity carrier that
 *   makes the P2 write path an identity-preserving merge rather than a
 *   re-create;
 * - serializable props print as literals;
 * - every slot field prints as an explicit `<Component.slotName>` tag,
 *   uniformly for single- and multi-slot components — Puck identifies
 *   slots purely by prop name, so the projection mirrors that model and
 *   invents no default-children shorthand (PRD 0023 §15 RESOLVED-3);
 * - the hidden authoring carriers (`appearance`/`interactions`/
 *   `bindings`) are NOT projected — the identity merge preserves them
 *   (§8.6), and projecting them would invite editing state that has an
 *   owning panel;
 * - deterministic formatting: tabs, one attribute per line above three.
 *
 * The vocabulary deliberately matches `emitReact`'s export output; the
 * difference is `akId` carriage, which the export artifact strips. The
 * document is the source of truth — this text is a projection of it,
 * never a second IR.
 *
 * Slot fields are read from the live `Config` rather than guessed at
 * structurally: an empty slot and an empty array prop are indistinguishable
 * by value alone, and the config already declares which is which.
 */

const INDENT = "\t";
/** Above this many attributes, each one gets its own line (design §8.4). */
const MAX_INLINE_ATTRS = 3;
/** Hidden authoring carriers — deliberately never projected. */
const CARRIERS = new Set(["appearance", "interactions", "bindings"]);

interface PuckNode {
	readonly type: string;
	readonly props: Record<string, unknown>;
}

function indent(depth: number): string {
	return INDENT.repeat(depth);
}

function isNode(value: unknown): value is PuckNode {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as PuckNode).type === "string" &&
		typeof (value as PuckNode).props === "object"
	);
}

/** Field map for a component type, or an empty map for unknown types. */
function fieldsOf(config: Config, type: string): Record<string, Field> {
	return (config.components?.[type]?.fields ?? {}) as Record<string, Field>;
}

/**
 * Slot-bearing paths inside one `array` field's items, e.g. Tabs' and
 * Accordion's `items[].content` (DOC-01 §3.8).
 */
function slotKeysOfArrayItems(field: Field): readonly string[] {
	const itemFields = (field as { arrayFields?: Record<string, Field> })
		.arrayFields;
	if (!itemFields) return [];
	return Object.keys(itemFields).filter(
		(key) => itemFields[key]?.type === "slot",
	);
}

/** A JS literal, formatted deterministically (no spaces, sorted keys). */
function literal(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(literal).join(",")}]`;
	if (value !== null && typeof value === "object") {
		const source = value as Record<string, unknown>;
		return `{${Object.keys(source)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${literal(source[key])}`)
			.join(",")}}`;
	}
	if (typeof value === "bigint") return "null";
	return JSON.stringify(value) ?? "null";
}

/** One `name="…"` / `name={…}` attribute segment. */
function attribute(name: string, value: unknown): string {
	if (typeof value !== "string") return `${name}={${literal(value)}}`;
	// JSX quoted attributes do not implement JavaScript string escapes:
	// `label="a\\"b"` terminates at the quote and `"a\\nb"` parses as the
	// two characters backslash+n. Keep the readable canonical form for safe
	// text, and use a brace-wrapped JS literal whenever escaping is required.
	return /["\\\r\n\t]/.test(value)
		? `${name}={${JSON.stringify(value)}}`
		: `${name}=${JSON.stringify(value)}`;
}

/** `<Type.slot>` … `</Type.slot>` around already-rendered children. */
function slotTag(
	tag: string,
	children: readonly PuckNode[],
	config: Config,
	depth: number,
): string {
	const pad = indent(depth);
	if (children.length === 0) return `${pad}<${tag} />`;
	const body = children
		.map((child) => renderNode(child, config, depth + 1))
		.join("\n");
	return `${pad}<${tag}>\n${body}\n${pad}</${tag}>`;
}

function renderNode(node: PuckNode, config: Config, depth: number): string {
	const pad = indent(depth);
	const fields = fieldsOf(config, node.type);
	const attrs: string[] = [];
	const slots: string[] = [];

	// `akId` first: the reserved identity carrier (§8.4).
	const id = node.props.id;
	if (typeof id === "string") attrs.push(attribute("akId", id));

	for (const key of Object.keys(node.props)) {
		if (key === "id" || CARRIERS.has(key)) continue;
		const value = node.props[key];
		const field = fields[key];

		if (field?.type === "slot") {
			slots.push(
				slotTag(
					`${node.type}.${key}`,
					(Array.isArray(value) ? value : []).filter(isNode),
					config,
					depth + 1,
				),
			);
			continue;
		}

		// DOC-01 RESOLVED-1 / PRD 0023 grammar v1: slots nested in array
		// items use indexed member tags that mirror the prop path. JSX member
		// segments cannot start with a digit, so `i0` is the canonical encoding of array
		// index 0. The P2 parser decodes it losslessly. The item's non-slot
		// fields stay in the `items` prop literal; only node arrays move out.
		if (field?.type === "array") {
			const slotKeys = slotKeysOfArrayItems(field);
			if (slotKeys.length > 0 && Array.isArray(value)) {
				const items = value as Record<string, unknown>[];
				attrs.push(
					attribute(
						key,
						items.map((item) => {
							const rest: Record<string, unknown> = { ...item };
							for (const slotKey of slotKeys) delete rest[slotKey];
							return rest;
						}),
					),
				);
				items.forEach((item, index) => {
					for (const slotKey of slotKeys) {
						slots.push(
							slotTag(
								`${node.type}.${key}.i${index}.${slotKey}`,
								(Array.isArray(item[slotKey]) ? item[slotKey] : []).filter(
									isNode,
								),
								config,
								depth + 1,
							),
						);
					}
				});
				continue;
			}
		}

		attrs.push(attribute(key, value));
	}

	const multiline = attrs.length > MAX_INLINE_ATTRS;
	const attrSegment = multiline
		? `\n${attrs.map((attr) => `${indent(depth + 1)}${attr}`).join("\n")}\n${pad}`
		: attrs.length > 0
			? ` ${attrs.join(" ")}`
			: "";

	if (slots.length === 0) {
		// A multiline attribute block already ends on its own indented line,
		// so the slash closes it directly; an inline one needs a separator.
		return `${pad}<${node.type}${attrSegment}${multiline ? "/>" : " />"}`;
	}
	return `${pad}<${node.type}${attrSegment}>\n${slots.join("\n")}\n${pad}</${node.type}>`;
}

/**
 * Canonical TSX text for a document. Deterministic: the same document
 * always produces byte-identical text, so a diff reflects a real change.
 */
export function emitTsx(data: Data, config: Config, revision = 0): EmitResult {
	const content = (
		Array.isArray((data as { content?: unknown }).content)
			? (data as unknown as { content: unknown[] }).content
			: []
	).filter(isNode);

	const body =
		content.length === 0
			? `${indent(2)}<></>`
			: [
					`${indent(2)}<>`,
					...content.map((node) => renderNode(node, config, 3)),
					`${indent(2)}</>`,
				].join("\n");

	const text = [
		"export default function Page() {",
		`${indent(1)}return (`,
		body,
		`${indent(1)});`,
		"}",
		"",
	].join("\n");

	return { text, revision };
}
