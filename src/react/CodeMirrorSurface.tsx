"use client";

// Classic JSX: this package builds `React.createElement`, so the binding is
// mandatory or `dist` throws "React is not defined" at runtime.
import * as React from "react";
import type { Diagnostic } from "../projection/types.js";
import type { EditorBinding } from "./editor-binding.js";

export interface CodeMirrorSurfaceProps {
	readonly text: string;
	readonly diagnostics: readonly Diagnostic[];
	readonly onChange: (text: string) => void;
	readonly onBlur?: () => void;
	readonly readOnly?: boolean;
}

/**
 * Mounts the CodeMirror binding into a host element.
 *
 * The binding module — and with it all four `@codemirror/*` packages — is
 * pulled by a dynamic `import()` in an effect, so the editor route never
 * carries that chunk until the panel is actually opened (FR-C10). Nothing
 * above this component imports `editor-binding` statically.
 */
export function CodeMirrorSurface({
	text,
	diagnostics,
	onChange,
	onBlur,
	readOnly,
}: CodeMirrorSurfaceProps): React.ReactElement {
	const hostRef = React.useRef<HTMLDivElement | null>(null);
	const bindingRef = React.useRef<EditorBinding | null>(null);
	const [ready, setReady] = React.useState(false);

	// Latest callbacks without re-creating the editor on every render.
	const onChangeRef = React.useRef(onChange);
	const onBlurRef = React.useRef(onBlur);
	onChangeRef.current = onChange;
	onBlurRef.current = onBlur;

	React.useEffect(() => {
		let cancelled = false;
		const host = hostRef.current;
		if (host === null) return;

		void import("./editor-binding.js").then(({ createEditorBinding }) => {
			if (cancelled) return;
			bindingRef.current = createEditorBinding({
				parent: host,
				doc: text,
				readOnly,
				onChange: (next) => onChangeRef.current(next),
				onBlur: () => onBlurRef.current?.(),
			});
			setReady(true);
		});

		return () => {
			cancelled = true;
			bindingRef.current?.destroy();
			bindingRef.current = null;
		};
		// Mount once: subsequent text arrives through the effects below.
	}, []);

	React.useEffect(() => {
		if (ready) bindingRef.current?.setText(text);
	}, [ready, text]);

	React.useEffect(() => {
		if (ready) bindingRef.current?.setDiagnostics(diagnostics);
	}, [ready, diagnostics]);

	return <div ref={hostRef} data-anvilkit-code-surface="" className="h-full" />;
}
