import { javascript } from "@codemirror/lang-javascript";
import { lintGutter, setDiagnostics } from "@codemirror/lint";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import type { Diagnostic } from "../projection/types.js";
import { toCodeMirrorDiagnostics } from "./diagnostics.js";

/**
 * A minimal in-repo CodeMirror binding (design 0022 §8.1). Deliberately not
 * `@uiw/react-codemirror`: the whole surface is one `EditorView` lifecycle
 * plus two imperative updates, which is far less than a wrapper dependency
 * costs in bundle weight and version coupling.
 */

export interface EditorBindingOptions {
	readonly parent: HTMLElement;
	readonly doc: string;
	/** Accessible name for the contenteditable element with role=textbox. */
	readonly ariaLabel: string;
	/** Fired on every user edit (the controller decides when to validate). */
	readonly onChange: (text: string) => void;
	/** Fired when focus leaves the editor — a commit trigger (§8.5). */
	readonly onBlur?: () => void;
	readonly readOnly?: boolean;
}

export interface EditorBinding {
	/** Replace the buffer without emitting `onChange` (external re-emit). */
	readonly setText: (text: string) => void;
	/** Show the gate's diagnostics as inline lint markers. */
	readonly setDiagnostics: (diagnostics: readonly Diagnostic[]) => void;
	readonly destroy: () => void;
}

export function createEditorBinding(
	options: EditorBindingOptions,
): EditorBinding {
	const view = new EditorView({
		parent: options.parent,
		state: EditorState.create({
			doc: options.doc,
				extensions: [
				lineNumbers(),
				lintGutter(),
				EditorView.contentAttributes.of({
					"aria-label": options.ariaLabel,
				}),
				// The JSON buffer is highlighted by the JavaScript grammar:
				// `@codemirror/lang-javascript` is the D5-approved language
				// package (it also carries the TSX grammar P1/P2 need), and
				// JSON is a subset of what it parses.
				javascript(),
				keymap.of([]),
				EditorView.editable.of(options.readOnly !== true),
				EditorView.updateListener.of((update) => {
					if (update.docChanged) {
						options.onChange(update.state.doc.toString());
					}
					if (update.focusChanged && !update.view.hasFocus) {
						options.onBlur?.();
					}
				}),
			],
		}),
	});

	return {
		setText(text) {
			if (text === view.state.doc.toString()) return;
			// `changes` alone does not fire the update listener as a user
			// edit, so a re-emit cannot be mistaken for typing.
			view.dispatch({
				changes: { from: 0, to: view.state.doc.length, insert: text },
			});
		},
		setDiagnostics(diagnostics) {
			view.dispatch(
				setDiagnostics(
					view.state,
					toCodeMirrorDiagnostics(view.state.doc, diagnostics),
				),
			);
		},
		destroy() {
			view.destroy();
		},
	};
}
