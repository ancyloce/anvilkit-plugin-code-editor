/**
 * PLAN-0036 P1-09 / FR-030 — the completed validation gate.
 *
 * Covers the four surfaces the AI protocol consumes verbatim (FR-C13, no
 * fork): `documentBounded`, `intents`, `jsonSchema`, and `salvageJson`,
 * plus the adversarial fixtures the plan names — unknown type, bad enum,
 * depth bomb, and `__proto__`/`constructor` keys.
 */
import type { Config, Data } from "@puckeditor/core";
import { describe, expect, it } from "vitest";
import {
	deriveSchemas,
	MAX_NODE_DEPTH,
	salvageJson,
	stripFence,
	validateDocument,
	validateDocumentBounded,
	validateIntents,
} from "../gate/index.js";

const config = {
	components: {
		Badge: {
			fields: {
				label: { type: "text" },
				variant: {
					type: "select",
					options: [
						{ label: "Default", value: "default" },
						{ label: "Ghost", value: "ghost" },
					],
				},
			},
		},
		Card: {
			fields: { title: { type: "text" }, content: { type: "slot" } },
		},
	},
} as unknown as Config;

const schemas = deriveSchemas(config);

const badge = (id: string, props: Record<string, unknown> = {}) => ({
	type: "Badge",
	props: { id, label: "Pro", variant: "default", ...props },
});

const doc = (content: unknown[]): unknown => ({
	root: { props: {} },
	content,
	zones: {},
});

/** A Card chain `depth` levels deep, each nesting into its `content` slot. */
function nest(depth: number): unknown {
	let node: unknown = badge("leaf");
	for (let level = 0; level < depth; level += 1) {
		node = {
			type: "Card",
			props: { id: `card-${level}`, title: "t", content: [node] },
		};
	}
	return node;
}

describe("documentBounded — depth", () => {
	it("accepts a document nested within the cap", () => {
		const result = validateDocumentBounded(doc([nest(3)]), schemas);
		expect(result.ok).toBe(true);
	});

	it("REJECTS a depth bomb instead of overflowing the stack", () => {
		const result = validateDocumentBounded(
			doc([nest(MAX_NODE_DEPTH + 5)]),
			schemas,
		);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.diagnostics.length).toBeGreaterThan(0);
	});

	it("agrees with the unbounded schema on documents within the cap", () => {
		// The bounded twin exists to bound recursion, not to change meaning:
		// inside the cap the two must accept exactly the same documents.
		for (const depth of [0, 1, 2, 5]) {
			const value = doc([nest(depth)]);
			expect(validateDocument(value, schemas).ok).toBe(
				validateDocumentBounded(value, schemas).ok,
			);
		}
	});

	it("agrees on rejection too, for a document that is invalid for other reasons", () => {
		const value = doc([badge("b1", { variant: "nope" })]);
		expect(validateDocument(value, schemas).ok).toBe(false);
		expect(validateDocumentBounded(value, schemas).ok).toBe(false);
	});
});

describe("adversarial fixtures", () => {
	it("rejects an unknown component type", () => {
		const result = validateDocument(
			doc([{ type: "Nope", props: { id: "x" } }]),
			schemas,
		);
		expect(result.ok).toBe(false);
	});

	it("rejects a value outside a select field's authored vocabulary", () => {
		const value = doc([badge("b1", { variant: "ghosts" })]);
		expect(validateDocument(value, schemas).ok).toBe(false);
		expect(validateDocumentBounded(value, schemas).ok).toBe(false);
	});

	it("points the diagnostic at the offending prop on the bounded schema", () => {
		// The bounded schema dispatches on `type` (discriminated union), so it
		// names the exact prop. The unbounded twin must stay a plain `z.union`
		// to survive `z.lazy` (zod#4264) and reports at the node instead —
		// acceptable, because untrusted input, where the AI repair loop needs
		// the precise path, goes through the BOUNDED schema.
		const result = validateDocumentBounded(
			doc([badge("b1", { variant: "ghosts" })]),
			schemas,
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.diagnostics.some((d) => d.path.includes("variant"))).toBe(
				true,
			);
		}
	});

	it("rejects a node with no id", () => {
		const result = validateDocument(
			doc([{ type: "Badge", props: { label: "x" } }]),
			schemas,
		);
		expect(result.ok).toBe(false);
	});

	it.each(["__proto__", "constructor", "prototype"])(
		"rejects a `%s` key anywhere in the tree",
		(key) => {
			// Built via defineProperty so `__proto__` is a real OWN key rather
			// than a prototype assignment the literal syntax would perform.
			const props: Record<string, unknown> = { id: "b1", label: "Pro" };
			Object.defineProperty(props, key, {
				value: { polluted: true },
				enumerable: true,
				writable: true,
				configurable: true,
			});
			const result = validateDocument(doc([{ type: "Badge", props }]), schemas);
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.diagnostics.some((d) => d.message.includes(key))).toBe(
					true,
				);
			}
		},
	);

	it("accepts a clean document", () => {
		expect(validateDocument(doc([badge("b1")]), schemas).ok).toBe(true);
	});
});

describe("intents (boundary validator, not an IR)", () => {
	it("accepts every EditorIntent member", () => {
		const result = validateIntents(
			[
				{
					kind: "set-inline-text",
					nodeId: "n1",
					targetId: "label",
					value: "Hi",
				},
				{ kind: "set-interactions", nodeId: "n1", interactions: [] },
				{ kind: "set-bindings", nodeId: "n1", bindings: [] },
				{
					kind: "set-instance-variant",
					nodeIds: ["n1"],
					selection: { size: "lg" },
				},
				{ kind: "rename-node", nodeId: "n1", name: "Hero button" },
				{ kind: "delete-nodes", nodeIds: ["n1", "n2"] },
			],
			schemas,
		);
		expect(result.ok).toBe(true);
	});

	it("rejects an unknown intent kind", () => {
		expect(validateIntents([{ kind: "drop-database" }], schemas).ok).toBe(
			false,
		);
	});

	it("rejects a member missing its node id", () => {
		expect(
			validateIntents([{ kind: "rename-node", name: "x" }], schemas).ok,
		).toBe(false);
	});

	it("rejects an empty node-id list where at least one is required", () => {
		expect(
			validateIntents([{ kind: "delete-nodes", nodeIds: [] }], schemas).ok,
		).toBe(false);
	});
});

describe("jsonSchema (DOC-02 §7.2 prompt payload)", () => {
	it("is a JSON Schema object describing the document envelope", () => {
		expect(typeof schemas.jsonSchema).toBe("object");
		expect(schemas.jsonSchema).toHaveProperty("properties");
	});

	it("survives a JSON round-trip (zod#5777 regression)", () => {
		// The schema is embedded in a prompt, so it must serialize losslessly
		// — a non-JSON value anywhere in it would silently corrupt the payload.
		const round = JSON.parse(JSON.stringify(schemas.jsonSchema));
		expect(round).toEqual(schemas.jsonSchema);
	});

	it("names every registered component", () => {
		const text = JSON.stringify(schemas.jsonSchema);
		for (const type of schemas.componentTypes) {
			expect(text).toContain(type);
		}
	});
});

describe("salvageJson (AI path only)", () => {
	it("parses clean JSON without repair", async () => {
		const result = await salvageJson('{"a":1}');
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value).toEqual({ a: 1 });
			expect(result.repaired).toBe(false);
		}
	});

	it("strips a markdown fence", async () => {
		expect(stripFence('```json\n{"a":1}\n```')).toBe('{"a":1}');
		const result = await salvageJson('```json\n{"a":1}\n```');
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.value).toEqual({ a: 1 });
	});

	it("repairs a trailing comma and reports that it repaired", async () => {
		const result = await salvageJson('{"a":1,}');
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value).toEqual({ a: 1 });
			expect(result.repaired).toBe(true);
		}
	});

	it("fails with a diagnostic when nothing can be salvaged", async () => {
		const result = await salvageJson("this is not json at all {{{");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.diagnostics).toHaveLength(1);
	});

	it("feeds the same gate the human path uses — no fork (FR-C13)", async () => {
		const salvaged = await salvageJson(
			`\`\`\`json\n${JSON.stringify(doc([badge("b1")]))},\n\`\`\``,
		);
		expect(salvaged.ok).toBe(true);
		if (salvaged.ok) {
			expect(validateDocumentBounded(salvaged.value, schemas).ok).toBe(true);
		}
	});
});
