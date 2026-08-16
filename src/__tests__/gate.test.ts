/**
 * P0-14 acceptance (plan 0036): a valid document passes the gate; an
 * invalid one yields diagnostics and NO value (never a partial apply); and
 * the gate module stays React-free so it can be promoted to
 * `@anvilkit/schema` unchanged (PRD 0023 RESOLVED-2).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config, Data } from "@puckeditor/core";
import { describe, expect, it } from "vitest";
import { deriveSchemas, validateDocument } from "../gate/index.js";
import { emitJson, isEquivalent, parseJson } from "../projection/json.js";

/** A config shaped like the component editor's, kept local and tiny. */
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
			render: () => null,
		},
		Card: {
			fields: {
				title: { type: "text" },
				content: { type: "slot" },
			},
			render: () => null,
		},
	},
} as unknown as Config;

const schemas = deriveSchemas(config);

const validDocument = {
	root: { props: { title: "T" } },
	content: [
		{ type: "Badge", props: { id: "badge-1", label: "Hi", variant: "ghost" } },
		{
			type: "Card",
			props: {
				id: "card-1",
				title: "Card",
				content: [
					{ type: "Badge", props: { id: "nested-1", label: "In slot" } },
				],
			},
		},
	],
	zones: {},
} as unknown as Data;

describe("deriveSchemas / validateDocument (P0-14)", () => {
	it("derives the component whitelist from the config alone", () => {
		expect(schemas.componentTypes).toEqual(["Badge", "Card"]);
	});

	it("accepts a valid document, including slot-nested nodes", () => {
		const result = validateDocument(validDocument, schemas);
		expect(result.ok).toBe(true);
	});

	it("rejects an unknown component type with a located diagnostic", () => {
		const result = validateDocument(
			{ content: [{ type: "Nope", props: { id: "x" } }] },
			schemas,
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.diagnostics.length).toBeGreaterThan(0);
		expect(result.diagnostics[0]?.path).toContain("content[0]");
		expect(result.diagnostics[0]?.severity).toBe("error");
	});

	it("rejects an option value outside the declared union", () => {
		const result = validateDocument(
			{
				content: [
					{ type: "Badge", props: { id: "b", variant: "not-a-variant" } },
				],
			},
			schemas,
		);
		expect(result.ok).toBe(false);
	});

	it("requires a non-empty node id", () => {
		const missing = validateDocument(
			{ content: [{ type: "Badge", props: { label: "x" } }] },
			schemas,
		);
		expect(missing.ok).toBe(false);
		const empty = validateDocument(
			{ content: [{ type: "Badge", props: { id: "" } }] },
			schemas,
		);
		expect(empty.ok).toBe(false);
	});

	it("preserves undeclared props (hidden carriers survive the gate)", () => {
		const withCarrier = {
			content: [
				{
					type: "Badge",
					props: {
						id: "b",
						label: "x",
						appearance: { targets: { root: { hidden: true } } },
					},
				},
			],
		};
		const result = validateDocument(withCarrier, schemas);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const node = (
			result.value.content as unknown as {
				props: Record<string, unknown>;
			}[]
		)[0];
		expect(node?.props.appearance).toBeDefined();
	});

	it("a failed gate returns NO value — never a partial document", () => {
		const result = validateDocument({ content: "not-an-array" }, schemas);
		expect(result.ok).toBe(false);
		expect(Object.hasOwn(result, "value")).toBe(false);
	});
});

describe("JSON projection (P0-14)", () => {
	it("emits canonical text: sorted keys, tab indent, trailing newline", () => {
		const { text } = emitJson({
			content: [],
			zones: {},
			root: { props: {} },
		} as unknown as Data);
		expect(text.startsWith("{\n\t")).toBe(true);
		expect(text.endsWith("\n")).toBe(true);
		// `content` sorts before `root` before `zones`.
		expect(text.indexOf('"content"')).toBeLessThan(text.indexOf('"root"'));
		expect(text.indexOf('"root"')).toBeLessThan(text.indexOf('"zones"'));
	});

	it("is stable: key order in the input cannot change the output", () => {
		const a = { content: [], root: { props: { b: 1, a: 2 } } };
		const b = { root: { props: { a: 2, b: 1 } }, content: [] };
		expect(emitJson(a as unknown as Data).text).toBe(
			emitJson(b as unknown as Data).text,
		);
		expect(isEquivalent(a as unknown as Data, b as unknown as Data)).toBe(true);
	});

	it("round-trips a document through emit → parse → gate", () => {
		const { text } = emitJson(validDocument);
		const parsed = parseJson(text);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		const gated = validateDocument(parsed.value, schemas);
		expect(gated.ok).toBe(true);
	});

	it("reports a located diagnostic for malformed JSON (no silent repair)", () => {
		const result = parseJson('{\n\t"content": [,]\n}');
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.diagnostics[0]?.severity).toBe("error");
		expect(result.diagnostics[0]?.line).toBeGreaterThanOrEqual(1);
	});
});

describe("gate promotion-readiness (PRD 0023 RESOLVED-2)", () => {
	/** Module specifiers of every `import … from "x"` in a source file. */
	function importsOf(source: string): string[] {
		return [...source.matchAll(/from\s+["']([^"']+)["']/g)].map(
			(match) => match[1] as string,
		);
	}

	it("imports only zod, Puck types and sibling gate/projection modules", () => {
		const dir = join(import.meta.dirname, "..", "gate");
		const allowed = /^(zod|@puckeditor\/core|\.\.?\/)/;
		for (const file of ["schema.ts", "validate.ts", "index.ts"]) {
			const specifiers = importsOf(readFileSync(join(dir, file), "utf8"));
			for (const specifier of specifiers) {
				expect(
					allowed.test(specifier),
					`${file} imports "${specifier}", which blocks promotion to @anvilkit/schema`,
				).toBe(true);
			}
			// The two that would specifically break promotion.
			expect(specifiers).not.toContain("react");
			expect(specifiers).not.toContain("@anvilkit/core");
		}
	});
});
