// @vitest-environment jsdom

import * as React from "react";
import type { Config, Data } from "@puckeditor/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { emitJson } from "../projection/json.js";
import { emitTsx } from "../projection/tsx-emit.js";
import type { CodeMirrorSurfaceProps } from "../react/CodeMirrorSurface.js";
import { CodePanel, type PuckApiLike } from "../react/CodePanel.js";

vi.mock("../react/CodeMirrorSurface.js", () => ({
	CodeMirrorSurface: ({
		text,
		onChange,
		onBlur,
		readOnly,
	}: CodeMirrorSurfaceProps) => (
		<textarea
			aria-label="Code buffer"
			value={text}
			readOnly={readOnly}
			onChange={(event) => onChange(event.currentTarget.value)}
			onBlur={onBlur}
		/>
	),
}));

const config = {
	components: {
		Badge: {
			fields: { label: { type: "text" } },
			defaultProps: { label: "Default" },
			render: () => null,
		},
	},
} as unknown as Config;

const docWithLabel = (label: string): Data =>
	({
		root: { props: {} },
		content: [{ type: "Badge", props: { id: "badge-1", label } }],
		zones: {},
	}) as unknown as Data;

const initial = docWithLabel("Start");

interface DispatchRecord {
	readonly recordHistory: boolean | undefined;
	readonly data: Data;
}

function createHarness(): {
	readonly api: PuckApiLike;
	readonly dispatches: DispatchRecord[];
	readonly current: () => Data;
} {
	let current = initial;
	const dispatches: DispatchRecord[] = [];
	const api: PuckApiLike = {
		get appState() {
			return { data: current };
		},
		config,
		dispatch(action) {
			current = action.data(current);
			dispatches.push({
				recordHistory: action.recordHistory,
				data: current,
			});
		},
	};
	return { api, dispatches, current: () => current };
}

function labelOf(data: Data): unknown {
	return (data.content[0] as { props?: { label?: unknown } } | undefined)?.props
		?.label;
}

function findCodeBuffer(): ReturnType<typeof screen.findByRole> {
	// Writable TSX loads its parser and merger lazily; under the full package
	// suite that chunk can arrive just after Testing Library's 1 s default.
	return screen.findByRole(
		"textbox",
		{ name: "Code buffer" },
		{ timeout: 5_000 },
	);
}

describe("CodePanel TSX write flag (P2-04)", () => {
	it("keeps the canonical P1 projection read-only when the flag is off", async () => {
		const { api, dispatches } = createHarness();
		render(
			<CodePanel getPuckApi={() => api} projections={["tsx"]} tsxWrite={false} />,
		);

		const buffer = await findCodeBuffer();
		expect(buffer).toHaveProperty("readOnly", true);
		expect((buffer as HTMLTextAreaElement).value).toBe(
			emitTsx(initial, config).text,
		);
		fireEvent.change(buffer, {
			target: { value: emitTsx(initial, config).text.replace("Start", "Ignored") },
		});
		expect(dispatches).toHaveLength(0);
	});

	it("parses, merges, gates, and coalesces opted-in TSX edits", async () => {
		const { api, dispatches, current } = createHarness();
		render(
			<CodePanel
				getPuckApi={() => api}
				projections={["tsx"]}
				tsxWrite
				sync={{ debounceMs: 1, commitIdleMs: 10 }}
			/>,
		);

		const buffer = await findCodeBuffer();
		fireEvent.change(buffer, {
			target: { value: emitTsx(initial, config).text.replace("Start", "Edited") },
		});

		await waitFor(() =>
			expect(dispatches.some((entry) => entry.recordHistory === false)).toBe(
				true,
			),
		);
		await waitFor(() =>
			expect(dispatches.filter((entry) => entry.recordHistory === true)).toHaveLength(
				1,
			),
		);
		expect(labelOf(current())).toBe("Edited");
	});

	it("commits a live buffer before switching projections", async () => {
		const { api, dispatches, current } = createHarness();
		render(
			<CodePanel
				getPuckApi={() => api}
				projections={["json", "tsx"]}
				tsxWrite
				sync={{ debounceMs: 1_000, commitIdleMs: 10_000 }}
			/>,
		);

		const jsonBuffer = await findCodeBuffer();
		fireEvent.change(jsonBuffer, {
			target: { value: emitJson(docWithLabel("Switched")).text },
		});
		fireEvent.click(screen.getByRole("tab", { name: "TSX" }));

		await waitFor(() =>
			expect(
				(screen.getByRole("textbox", { name: "Code buffer" }) as HTMLTextAreaElement)
					.value,
			).toContain("Switched"),
		);
		expect(
			dispatches.some((entry) => entry.recordHistory === true),
		).toBe(true);
		expect(labelOf(current())).toBe("Switched");
	});

	it("reads the fresh raw document when a dispatch notifies synchronously", async () => {
		let current = {
			...initial,
			content: [
				{ type: "Badge", props: { id: "badge-1", label: "Current" } },
			],
		} as Data;
		let listener = () => undefined;
		const snapshotApi: PuckApiLike = {
			appState: { data: initial },
			config,
			dispatch(action) {
				current = action.data(current);
				listener();
			},
		};
		render(
			<CodePanel
				getPuckApi={() => snapshotApi}
				readData={() => current}
				subscribe={(next) => {
					listener = next;
					return () => undefined;
				}}
				projections={["tsx"]}
				tsxWrite
				sync={{ debounceMs: 1, commitIdleMs: 10 }}
			/>,
		);

		const buffer = await findCodeBuffer();
		expect((buffer as HTMLTextAreaElement).value).toContain("Current");
		fireEvent.change(buffer, {
			target: {
				value: emitTsx(current, config).text.replace("Current", "Fresh"),
			},
		});
		await waitFor(() =>
			expect(
				screen
					.getByText("Synced")
					.closest("footer")
					?.getAttribute("data-anvilkit-code-status"),
			).toBe("clean"),
		);
		expect(labelOf(current)).toBe("Fresh");
	});

	it("forces collaboration to explicit manual Apply with no typing broadcast", async () => {
		const { api, dispatches, current } = createHarness();
		render(
			<CodePanel
				getPuckApi={() => api}
				projections={["tsx"]}
				tsxWrite
				collaborationActive
				sync={{ mode: "live", debounceMs: 1, commitIdleMs: 5 }}
			/>,
		);

		const buffer = await findCodeBuffer();
		fireEvent.change(buffer, {
			target: {
				value: emitTsx(initial, config).text.replace("Start", "Manual"),
			},
		});
		await new Promise((resolve) => setTimeout(resolve, 25));
		expect(dispatches).toHaveLength(0);

		const explanation =
			"Collaboration is active. Changes apply only when you choose Apply.";
		expect(screen.getAllByTitle(explanation)).toHaveLength(2);
		fireEvent.click(screen.getByRole("button", { name: "Apply" }));

		expect(dispatches).toHaveLength(1);
		expect(dispatches[0]?.recordHistory).toBe(true);
		expect(labelOf(current())).toBe("Manual");
	});
});
