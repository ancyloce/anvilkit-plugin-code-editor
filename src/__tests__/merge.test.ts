import type { Config, Data } from "@puckeditor/core";
import { describe, expect, it, vi } from "vitest";
import { mergeTsxDocument } from "../projection/merge.js";
import type {
	ParsedTsxDocument,
	ParsedTsxNode,
} from "../projection/tsx-parse.js";

const config = {
	components: {
		Badge: {
			defaultProps: {
				label: "New",
				variant: "default",
				appearance: { targets: { root: { opacity: 1 } } },
			},
			fields: {
				label: { type: "text" },
				variant: { type: "select" },
				appearance: { type: "custom" },
				interactions: { type: "custom" },
				bindings: { type: "custom" },
			},
		},
		Card: {
			defaultProps: { title: "Card", content: [], footer: [] },
			fields: {
				title: { type: "text" },
				content: { type: "slot" },
				footer: { type: "slot" },
				appearance: { type: "custom" },
				interactions: { type: "custom" },
				bindings: { type: "custom" },
			},
		},
		Tabs: {
			defaultProps: { items: [] },
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

const node = (
	type: string,
	props: Record<string, unknown>,
	extra: Record<string, unknown> = {},
) => ({ type, props, ...extra });

const data = (content: unknown[]): Data =>
	({
		root: { props: { title: "Authoritative root" } },
		content,
		zones: { "legacy:zone": [] },
		metadata: { revision: 7 },
	}) as unknown as Data;

const parsed = (content: ParsedTsxNode[]): ParsedTsxDocument => ({ content });

describe("mergeTsxDocument — identity and carriers", () => {
	it("keeps matched ids, hidden carriers, and Puck-owned sibling state", () => {
		const appearance = {
			targets: {
				root: { style: { base: { visual: { opacity: 0.5 } } } },
			},
		};
		const interactions = [{ id: "click-1", trigger: "click" }];
		const bindings = [{ prop: "label", source: "customer.name" }];
		const current = data([
			node(
				"Badge",
				{
					id: "badge-1",
					label: "Before",
					variant: "secondary",
					appearance,
					interactions,
					bindings,
					removedByCode: "drop me",
				},
				{ readOnly: true },
			),
		]);

		const result = mergeTsxDocument(
			parsed([
				{
					type: "Badge",
					akId: "badge-1",
					props: { label: "After", variant: "outline" },
				},
			]),
			current,
			config,
		);

		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error(result.diagnostics[0]?.message);
		const merged = result.value.content[0] as unknown as {
			readOnly: boolean;
			props: Record<string, unknown>;
		};
		expect(merged.readOnly).toBe(true);
		expect(merged.props).toEqual({
			id: "badge-1",
			label: "After",
			variant: "outline",
			appearance,
			interactions,
			bindings,
		});
		// Carrier preservation is structural for the changed node.
		expect(merged.props.appearance).toEqual(appearance);
		expect(merged.props).not.toHaveProperty("removedByCode");
	});

	it("retains object identity for nodes whose projected props did not change", () => {
		const unchanged = node("Badge", { id: "same", label: "Same" });
		const changed = node("Badge", { id: "changed", label: "Before" });
		const current = data([unchanged, changed]);
		const result = mergeTsxDocument(
			parsed([
				{ type: "Badge", akId: "same", props: { label: "Same" } },
				{ type: "Badge", akId: "changed", props: { label: "After" } },
			]),
			current,
			config,
		);

		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error(result.diagnostics[0]?.message);
		expect(result.value.content[0]).toBe(unchanged);
		expect(result.value.content[1]).not.toBe(changed);
	});

	it("preserves carriers on nodes nested in top-level and array-item slots", () => {
		const nestedAppearance = { targets: { root: { color: "red" } } };
		const arrayBindings = [{ prop: "label", source: "account.plan" }];
		const current = data([
			node("Card", {
				id: "card-1",
				title: "Before",
				content: [
					node("Badge", {
						id: "slot-badge",
						label: "Before",
						appearance: nestedAppearance,
					}),
				],
				footer: [],
			}),
			node("Tabs", {
				id: "tabs-1",
				items: [
					{
						label: "One",
						content: [
							node("Badge", {
								id: "array-badge",
								label: "Before",
								bindings: arrayBindings,
							}),
						],
					},
				],
			}),
		]);
		const result = mergeTsxDocument(
			parsed([
				{
					type: "Card",
					akId: "card-1",
					props: {
						title: "After",
						content: [
							{
								type: "Badge",
								akId: "slot-badge",
								props: { label: "Nested after" },
							},
						],
						footer: [],
					},
				},
				{
					type: "Tabs",
					akId: "tabs-1",
					props: {
						items: [
							{
								label: "One",
								content: [
									{
										type: "Badge",
										akId: "array-badge",
										props: { label: "Array after" },
									},
								],
							},
						],
					},
				},
			]),
			current,
			config,
		);
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error(result.diagnostics[0]?.message);
		const card = result.value.content[0] as unknown as {
			props: { content: Array<{ props: Record<string, unknown> }> };
		};
		const tabs = result.value.content[1] as unknown as {
			props: {
				items: Array<{ content: Array<{ props: Record<string, unknown> }> }>;
			};
		};
		expect(card.props.content[0]?.props.appearance).toEqual(nestedAppearance);
		expect(tabs.props.items[0]?.content[0]?.props.bindings).toEqual(
			arrayBindings,
		);
	});

	it("gives new nodes config defaults, default carriers, and fresh ids", () => {
		const createId = vi
			.fn()
			.mockReturnValueOnce("new-1")
			.mockReturnValueOnce("new-2");
		const current = data([]);
		const result = mergeTsxDocument(
			parsed([
				{
					type: "Card",
					props: {
						title: "Authored",
						content: [{ type: "Badge", props: { label: "Nested" } }],
						footer: [],
					},
				},
			]),
			current,
			config,
			{ createId },
		);
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error(result.diagnostics[0]?.message);
		const card = result.value.content[0] as unknown as {
			props: {
				id: string;
				content: Array<{ props: Record<string, unknown> }>;
			};
		};
		expect(card.props.id).toBe("new-1");
		expect(card.props.content[0]?.props).toEqual({
			label: "Nested",
			variant: "default",
			appearance: { targets: { root: { opacity: 1 } } },
			id: "new-2",
		});
	});

	it("replaces unknown user-supplied akIds with a fresh id", () => {
		const result = mergeTsxDocument(
			parsed([{ type: "Badge", akId: "not-current", props: { label: "New" } }]),
			data([]),
			config,
			{ createId: () => "fresh-id" },
		);
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error(result.diagnostics[0]?.message);
		expect(
			(result.value.content[0] as { props: { id: string } }).props.id,
		).toBe("fresh-id");
	});

	it("rejects duplicate akIds without mutating the current document", () => {
		const current = data([node("Badge", { id: "same", label: "Before" })]);
		const before = structuredClone(current);
		const result = mergeTsxDocument(
			parsed([
				{ type: "Badge", akId: "same", props: { label: "One" } },
				{ type: "Badge", akId: "same", props: { label: "Two" } },
			]),
			current,
			config,
		);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("Expected duplicate rejection");
		expect(result.diagnostics[0]).toMatchObject({
			path: "content[1].akId",
			hintKey: "codeEditor.hint.fields",
		});
		expect(current).toEqual(before);
	});

	it("drops removed nodes while preserving root, zones, and document metadata", () => {
		const current = data([
			node("Badge", { id: "keep", label: "Keep" }),
			node("Badge", { id: "drop", label: "Drop" }),
		]);
		const result = mergeTsxDocument(
			parsed([{ type: "Badge", akId: "keep", props: { label: "Kept" } }]),
			current,
			config,
		);
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error(result.diagnostics[0]?.message);
		expect(result.value.content).toHaveLength(1);
		expect(result.value.root).toBe(current.root);
		expect(result.value.zones).toBe(current.zones);
		expect((result.value as unknown as { metadata: unknown }).metadata).toBe(
			(current as unknown as { metadata: unknown }).metadata,
		);
	});

	it("retries colliding generated ids and rejects an exhausted allocator", () => {
		const createId = vi
			.fn()
			.mockReturnValueOnce("existing")
			.mockReturnValueOnce("fresh");
		const current = data([
			node("Badge", { id: "existing", label: "Existing" }),
		]);
		const retried = mergeTsxDocument(
			parsed([{ type: "Badge", props: { label: "New" } }]),
			current,
			config,
			{ createId },
		);
		expect(retried.ok).toBe(true);
		expect(createId).toHaveBeenCalledTimes(2);

		const exhausted = mergeTsxDocument(
			parsed([{ type: "Badge", props: { label: "New" } }]),
			current,
			config,
			{ createId: () => "existing" },
		);
		expect(exhausted.ok).toBe(false);
		if (exhausted.ok) throw new Error("Expected allocator rejection");
		expect(exhausted.diagnostics[0]?.message).toContain("32 attempts");
	});
});
