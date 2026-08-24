import type { Config } from "@puckeditor/core";
import { describe, expect, it } from "vitest";
import { parseTsx, TSX_GRAMMAR_VERSION } from "../projection/tsx-parse.js";

const config = {
	components: {
		Badge: { fields: { label: { type: "text" }, variant: { type: "select" } } },
		Button: {
			fields: {
				label: { type: "text" },
				disabled: { type: "radio" },
				meta: { type: "object" },
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
					arrayFields: {
						label: { type: "text" },
						content: { type: "slot" },
					},
				},
			},
		},
	},
} as unknown as Config;

function page(body: string): string {
	return `export default function Page() {\n\treturn (${body});\n}\n`;
}

function rejected(source: string) {
	const result = parseTsx(page(source), config);
	expect(result.ok).toBe(false);
	if (result.ok) throw new Error("Expected TSX to be rejected");
	const diagnostic = result.diagnostics[0];
	expect(diagnostic?.line).toBeGreaterThan(0);
	expect(diagnostic?.col).toBeGreaterThan(0);
	expect(diagnostic?.hintKey).toMatch(/^codeEditor\.hint\./);
	expect(diagnostic?.message).toMatch(/panel|Slots/);
	return diagnostic;
}

describe("parseTsx — grammar v1", () => {
	it("exports the frozen grammar version", () => {
		expect(TSX_GRAMMAR_VERSION).toBe(1);
	});

	it("parses literals, explicit slots, and designated JSX text", () => {
		const result = parseTsx(
			page(`
		<>
			<Button akId="button-1" disabled={false} meta={{"count":2,"tags":["a",null]}}>Go</Button>
			<Card akId="card-1" title="Plans">
				<Card.content><Badge akId="badge-1" label="Pro" /></Card.content>
				<Card.footer />
			</Card>
		</>`),
			config,
		);
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error(result.diagnostics[0]?.message);
		expect(result.value.content).toEqual([
			{
				type: "Button",
				akId: "button-1",
				props: {
					disabled: false,
					meta: { count: 2, tags: ["a", null] },
					label: "Go",
				},
			},
			{
				type: "Card",
				akId: "card-1",
				props: {
					title: "Plans",
					content: [
						{ type: "Badge", akId: "badge-1", props: { label: "Pro" } },
					],
					footer: [],
				},
			},
		]);
	});

	it("round-trips the valid iN encoding for array-item slots", () => {
		const result = parseTsx(
			page(`
		<Tabs akId="tabs-1" items={[{"label":"One"},{"label":"Two"}]}>
			<Tabs.items.i0.content><Badge akId="b1" label="First" /></Tabs.items.i0.content>
			<Tabs.items.i1.content />
		</Tabs>`),
			config,
		);
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error(result.diagnostics[0]?.message);
		expect(result.value.content[0]?.props.items).toEqual([
			{
				label: "One",
				content: [{ type: "Badge", akId: "b1", props: { label: "First" } }],
			},
			{ label: "Two", content: [] },
		]);
	});

	it("accepts an empty document fragment", () => {
		expect(parseTsx(page("<></>"), config)).toEqual({
			ok: true,
			value: { content: [] },
		});
	});
});

describe("parseTsx — rejection table", () => {
	it("rejects identifiers", () => {
		expect(rejected("<Button label={copy} />")?.message).toContain(
			"Identifiers",
		);
	});

	it("rejects calls", () => {
		expect(rejected('<Button label={translate("go")} />')?.message).toContain(
			"Function calls",
		);
	});

	it("rejects member expressions", () => {
		expect(rejected("<Button label={data.title} />")?.message).toContain(
			"Member expressions",
		);
	});

	it("rejects spreads", () => {
		expect(rejected("<Button {...props} />")?.message).toContain(
			"Spread attributes",
		);
	});

	it("rejects conditionals", () => {
		expect(
			rejected('<Button label={ready ? "Go" : "Wait"} />')?.message,
		).toContain("Conditional");
	});

	it("rejects map and loop expressions", () => {
		expect(
			rejected("<Button>{items.map(renderItem)}</Button>")?.message,
		).toContain("Loops and map");
	});

	it("rejects hooks", () => {
		const result = parseTsx(
			"export default function Page() { const value = useMemo(() => 'x', []); return <Button label=\"Go\" />; }",
			config,
		);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("Expected hook rejection");
		expect(result.diagnostics[0]).toMatchObject({
			hintKey: "codeEditor.hint.bindings",
		});
		expect(result.diagnostics[0]?.message).toContain("Hooks");
	});

	it("rejects event handlers with an Interactions hint", () => {
		expect(rejected('<Button label="Go" onClick={() => {}} />')).toMatchObject({
			hintKey: "codeEditor.hint.interactions",
		});
	});

	it("rejects style objects with computed values with an Appearance hint", () => {
		expect(
			rejected('<Button label="Go" style={{color: theme.primary}} />'),
		).toMatchObject({
			hintKey: "codeEditor.hint.appearance",
		});
	});

	it("rejects unknown components", () => {
		expect(rejected("<Unknown />")?.message).toContain(
			"not in the editor whitelist",
		);
	});

	it("rejects unknown props", () => {
		expect(rejected('<Button label="Go" mystery="x" />')?.message).toContain(
			"is not declared",
		);
	});

	it("rejects missing and duplicate explicit slot tags", () => {
		expect(
			rejected('<Card title="Plans"><Card.content /></Card>')?.message,
		).toContain("Card.footer");
		expect(
			rejected(
				'<Card title="Plans"><Card.content /><Card.content /><Card.footer /></Card>',
			)?.message,
		).toContain("more than once");
	});

	it("rejects array-slot indices not backed by the array literal", () => {
		expect(
			rejected("<Tabs items={[]}><Tabs.items.i0.content /></Tabs>")?.message,
		).toContain("not present");
	});

	it("rejects executable statements in the Page frame", () => {
		const result = parseTsx(
			"export default function Page() { const copy = 'Go'; return <Button label=\"Go\" />; }",
			config,
		);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("Expected frame rejection");
		expect(result.diagnostics[0]?.message).toContain(
			"exactly one return statement",
		);
	});

	it("rejects nesting beyond the depth cap", () => {
		let nested = '<Badge label="deep" />';
		for (let index = 0; index < 33; index += 1) {
			nested = `<Card title="${index}"><Card.content>${nested}</Card.content><Card.footer /></Card>`;
		}
		expect(rejected(nested)?.message).toContain("maximum depth");
	});

	it("returns syntax errors with line and column", () => {
		const result = parseTsx(page("<Button label= />"), config);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("Expected syntax rejection");
		expect(result.diagnostics[0]?.line).toBeGreaterThan(0);
		expect(result.diagnostics[0]?.col).toBeGreaterThan(0);
	});
});
