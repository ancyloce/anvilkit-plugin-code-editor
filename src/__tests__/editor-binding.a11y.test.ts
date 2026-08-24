// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { createEditorBinding } from "../react/editor-binding.js";

describe("CodeMirror accessibility", () => {
	it("names the contenteditable textbox", () => {
		const parent = document.createElement("div");
		document.body.append(parent);
		const binding = createEditorBinding({
			parent,
			doc: "{}",
			ariaLabel: "Code",
			onChange: () => undefined,
		});

		expect(
			parent.querySelector<HTMLElement>('[role="textbox"]')?.getAttribute(
				"aria-label",
			),
		).toBe("Code");
		binding.destroy();
	});
});
