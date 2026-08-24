/**
 * PLAN-0036 P1-08 / FR-021 — canonical TSX printer (design 0022 §8.4).
 *
 * The printer is a PROJECTION, never a second IR: it must be
 * deterministic, carry `akId` first, emit every slot as an explicit
 * `<Component.slotName>` tag, and never project the hidden authoring
 * carriers. Goldens below pin the exact text for the fixture corpus.
 */
import type { Config, Data } from "@puckeditor/core";
import { describe, expect, it } from "vitest";
import { emitTsx } from "../projection/tsx-emit.js";

/**
 * A miniature stand-in for the component-editor config: only the field
 * SHAPES matter to the printer (which prop is a slot, which array carries
 * nested slots), so the render/metadata halves are omitted.
 */
const config = {
	components: {
		Badge: { fields: { label: { type: "text" }, variant: { type: "select" } } },
		Button: {
			fields: {
				label: { type: "text" },
				variant: { type: "select" },
				size: { type: "select" },
				disabled: { type: "radio" },
			},
		},
		Card: {
			fields: {
				title: { type: "text" },
				content: { type: "slot" },
				footer: { type: "slot" },
			},
		},
		Tabs: {
			fields: {
				items: {
					type: "array",
					arrayFields: { label: { type: "text" }, content: { type: "slot" } },
				},
				listVariant: { type: "radio" },
			},
		},
	},
} as unknown as Config;

const page = (content: unknown[]): Data =>
	({ root: { props: {} }, content, zones: {} }) as unknown as Data;

describe("emitTsx — document frame", () => {
	it("emits an empty fragment for an empty document", () => {
		expect(emitTsx(page([]), config).text).toBe(
			[
				"export default function Page() {",
				"\treturn (",
				"\t\t<></>",
				"\t);",
				"}",
				"",
			].join("\n"),
		);
	});

	it("carries the caller's revision through unchanged", () => {
		expect(emitTsx(page([]), config, 7).revision).toBe(7);
	});

	it("is deterministic — the same document yields byte-identical text", () => {
		const data = page([
			{ type: "Badge", props: { id: "b1", label: "Pro", variant: "default" } },
		]);
		expect(emitTsx(data, config).text).toBe(emitTsx(data, config).text);
	});
});

describe("emitTsx — attributes", () => {
	it("puts akId first and prints literals", () => {
		const { text } = emitTsx(
			page([
				{
					type: "Badge",
					props: { label: "Pro", id: "badge-c3", variant: "secondary" },
				},
			]),
			config,
		);
		expect(text).toContain(
			'<Badge akId="badge-c3" label="Pro" variant="secondary" />',
		);
	});

	it("never projects the hidden authoring carriers", () => {
		const { text } = emitTsx(
			page([
				{
					type: "Badge",
					props: {
						id: "b1",
						label: "Pro",
						appearance: { root: { color: "red" } },
						interactions: [{ on: "click" }],
						bindings: [{ prop: "label" }],
					},
				},
			]),
			config,
		);
		expect(text).not.toContain("appearance");
		expect(text).not.toContain("interactions");
		expect(text).not.toContain("bindings");
		expect(text).toContain('<Badge akId="b1" label="Pro" />');
	});

	it("breaks to one attribute per line above three attributes", () => {
		const { text } = emitTsx(
			page([
				{
					type: "Button",
					props: {
						id: "btn",
						label: "Go",
						variant: "default",
						size: "lg",
						disabled: false,
					},
				},
			]),
			config,
		);
		// The element sits at depth 3, so its attributes indent to 4 tabs and
		// the self-closing slash returns to the element's own line.
		expect(text).toContain('\n\t\t\t\takId="btn"\n');
		expect(text).toContain("\n\t\t\t\tdisabled={false}\n");
		expect(text).toMatch(/\n\t{3}\/>/);
	});

	it("prints non-string props as brace-wrapped literals with sorted object keys", () => {
		const { text } = emitTsx(
			page([{ type: "Badge", props: { id: "b1", variant: { z: 1, a: 2 } } }]),
			config,
		);
		expect(text).toContain('variant={{"a":2,"z":1}}');
	});
});

describe("emitTsx — slots (design §8.4, PRD 0023 RESOLVED-3)", () => {
	it("emits one explicit tag per declared slot, uniformly", () => {
		const { text } = emitTsx(
			page([
				{
					type: "Card",
					props: {
						id: "card-b2",
						title: "Plans",
						content: [
							{ type: "Badge", props: { id: "badge-c3", label: "Pro" } },
						],
						footer: [],
					},
				},
			]),
			config,
		);

		expect(text).toContain("<Card.content>");
		expect(text).toContain("</Card.content>");
		// An EMPTY slot still emits its tag — the projection mirrors the
		// declared slot set, not just the populated one.
		expect(text).toContain("<Card.footer />");
		expect(text).toMatch(/<Card\.content>\s*<Badge akId="badge-c3"/);
	});

	it("matches the design §8.4 worked example", () => {
		const { text } = emitTsx(
			page([
				{
					type: "Card",
					props: {
						id: "card-b2",
						title: "Plans",
						content: [
							{
								type: "Badge",
								props: { id: "badge-c3", label: "Pro", variant: "secondary" },
							},
						],
					},
				},
			]),
			config,
		);

		expect(text).toBe(
			[
				"export default function Page() {",
				"\treturn (",
				"\t\t<>",
				'\t\t\t<Card akId="card-b2" title="Plans">',
				"\t\t\t\t<Card.content>",
				'\t\t\t\t\t<Badge akId="badge-c3" label="Pro" variant="secondary" />',
				"\t\t\t\t</Card.content>",
				"\t\t\t</Card>",
				"\t\t</>",
				"\t);",
				"}",
				"",
			].join("\n"),
		);
	});

	it("emits array-nested slots as indexed member tags (DOC-01 OPEN-1 option a)", () => {
		const { text } = emitTsx(
			page([
				{
					type: "Tabs",
					props: {
						id: "tabs-1",
						listVariant: "default",
						items: [
							{
								label: "Overview",
								content: [{ type: "Badge", props: { id: "b1", label: "A" } }],
							},
							{ label: "Details", content: [] },
						],
					},
				},
			]),
			config,
		);

		// The item's non-slot fields stay in the prop literal…
		expect(text).toContain(
			'items={[{"label":"Overview"},{"label":"Details"}]}',
		);
		// …and each nested slot becomes a tag mirroring the prop path. JSX
		// identifiers cannot start with a digit, so `i0` encodes index 0.
		expect(text).toContain("<Tabs.items.i0.content>");
		expect(text).toContain("</Tabs.items.i0.content>");
		expect(text).toContain("<Tabs.items.i1.content />");
		// The node array itself never leaks into the prop literal.
		expect(text).not.toContain('"content"');
	});
});

describe("emitTsx — vocabulary parity with the exporter", () => {
	it("uses the same component tag names the export emits, plus akId", () => {
		const { text } = emitTsx(
			page([{ type: "Button", props: { id: "btn-a1", label: "Get started" } }]),
			config,
		);
		// `emitReact` renders `<Button label="Get started" />`; the projection
		// is that vocabulary with the identity carrier added.
		expect(text).toContain('<Button akId="btn-a1" label="Get started" />');
	});

	it("skips values that are not component nodes inside a slot array", () => {
		const { text } = emitTsx(
			page([
				{
					type: "Card",
					props: { id: "c1", content: ["not-a-node", { nope: true }] },
				},
			]),
			config,
		);
		expect(text).toContain("<Card.content />");
	});
});
