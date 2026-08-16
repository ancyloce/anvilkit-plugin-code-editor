/**
 * P0-16 acceptance (plan 0036): gate diagnostics become inline CodeMirror
 * markers, and the CodeMirror chunk is reachable ONLY through a dynamic
 * import so the editor route does not carry it before the panel opens.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import type { Diagnostic } from "../projection/types.js";
import { toCodeMirrorDiagnostics } from "../react/diagnostics.js";

const doc = (text: string) => EditorState.create({ doc: text }).doc;

describe("gate diagnostics → CodeMirror markers (P0-16)", () => {
	it("maps a located parse error to that line and column", () => {
		const text = '{\n\t"content": [,]\n}';
		const diagnostics: Diagnostic[] = [
			{
				path: "",
				message: "Unexpected token",
				line: 2,
				col: 14,
				severity: "error",
			},
		];
		const [marker] = toCodeMirrorDiagnostics(doc(text), diagnostics);
		const line = doc(text).line(2);
		expect(marker?.severity).toBe("error");
		expect(marker?.from).toBeGreaterThanOrEqual(line.from);
		expect(marker?.from).toBeLessThanOrEqual(line.to);
		expect(marker?.message).toBe("Unexpected token");
	});

	it("anchors a schema diagnostic to the line naming the failing key", () => {
		const text = '{\n\t"content": [\n\t\t{ "type": "Nope" }\n\t]\n}';
		const [marker] = toCodeMirrorDiagnostics(doc(text), [
			{
				path: "content[0].type",
				message: "Invalid literal",
				severity: "error",
			},
		]);
		const typeLine = doc(text).line(3);
		expect(marker?.from).toBeGreaterThanOrEqual(typeLine.from);
		expect(marker?.to).toBeLessThanOrEqual(typeLine.to);
		// The path is prefixed so a marker is self-describing in the gutter.
		expect(marker?.message).toContain("content[0].type");
	});

	it("never drops a marker, even when the path is not in the text", () => {
		const text = "{}";
		const markers = toCodeMirrorDiagnostics(doc(text), [
			{ path: "root.props.missing", message: "Required", severity: "error" },
		]);
		expect(markers).toHaveLength(1);
		expect(markers[0]?.from).toBe(0);
	});

	it("carries warning severity through", () => {
		const [marker] = toCodeMirrorDiagnostics(doc("{}"), [
			{ path: "", message: "Heads up", severity: "warning" },
		]);
		expect(marker?.severity).toBe("warning");
	});

	it("clamps an out-of-range line instead of throwing", () => {
		const markers = toCodeMirrorDiagnostics(doc("{}"), [
			{ path: "", message: "far away", line: 99, col: 99, severity: "error" },
		]);
		expect(markers).toHaveLength(1);
		expect(markers[0]?.from).toBeLessThanOrEqual(2);
	});
});

describe("CodeMirror chunk splitting (FR-C10, P0-16)", () => {
	const srcDir = join(import.meta.dirname, "..");

	/** Static `import … from "x"` specifiers only — not dynamic ones. */
	function staticImportsOf(file: string): string[] {
		const source = readFileSync(join(srcDir, file), "utf8");
		return [
			...source.matchAll(/^\s*import[^\n]*?from\s+["']([^"']+)["']/gm),
		].map((match) => match[1] as string);
	}

	it("only the binding module imports @codemirror/* statically", () => {
		for (const file of [
			"index.ts",
			"plugin.ts",
			"react/CodePanel.tsx",
			"react/CodeMirrorSurface.tsx",
		]) {
			const codemirror = staticImportsOf(file).filter((specifier) =>
				specifier.startsWith("@codemirror/"),
			);
			expect(
				codemirror,
				`${file} pulls CodeMirror into the entry chunk`,
			).toEqual([]);
		}
		// The binding is where they legitimately live.
		expect(
			staticImportsOf("react/editor-binding.ts").filter((s) =>
				s.startsWith("@codemirror/"),
			).length,
		).toBeGreaterThan(0);
	});

	it("the surface reaches the binding through a dynamic import", () => {
		const source = readFileSync(
			join(srcDir, "react/CodeMirrorSurface.tsx"),
			"utf8",
		);
		expect(source).toMatch(/import\(\s*["']\.\/editor-binding\.js["']\s*\)/);
	});
});
