"use client";

// Classic JSX: this package builds `React.createElement`, so the binding is
// mandatory or `dist` throws "React is not defined" at runtime.
import * as React from "react";
import type { Diagnostic } from "../projection/types.js";
import type { EditorBinding } from "./editor-binding.js";

export interface CodeMirrorSurfaceProps {
	readonly text: string;
	readonly diagnostics: readonly Diagnostic[];
	/** Accessible name applied to CodeMirror's contenteditable textbox. */
	readonly ariaLabel: string;
	readonly onChange: (text: string) => void;
	readonly onBlur?: () => void;
	readonly onLoadError?: (error: Error) => void;
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
	ariaLabel,
	onChange,
	onBlur,
	onLoadError,
	readOnly,
}: CodeMirrorSurfaceProps): React.ReactElement {
	const hostRef = React.useRef<HTMLDivElement | null>(null);
	const bindingRef = React.useRef<EditorBinding | null>(null);
	const [bindingVersion, setBindingVersion] = React.useState(0);

	// Latest callbacks without re-creating the editor on every render.
	const onChangeRef = React.useRef(onChange);
	const onBlurRef = React.useRef(onBlur);
	const onLoadErrorRef = React.useRef(onLoadError);
	const textRef = React.useRef(text);
	React.useEffect(() => {
		onChangeRef.current = onChange;
		onBlurRef.current = onBlur;
		onLoadErrorRef.current = onLoadError;
		textRef.current = text;
	}, [onBlur, onChange, onLoadError, text]);

	React.useEffect(() => {
		let cancelled = false;
		const host = hostRef.current;
		if (host === null) return;

		void import("./editor-binding.js").then(({ createEditorBinding }) => {
			if (cancelled) return;
			bindingRef.current = createEditorBinding({
				parent: host,
				doc: textRef.current,
				ariaLabel,
				readOnly,
				onChange: (next) => onChangeRef.current(next),
				onBlur: () => onBlurRef.current?.(),
			});
			setBindingVersion((version) => version + 1);
		}).catch((error: unknown) => {
			if (cancelled) return;
			onLoadErrorRef.current?.(
				error instanceof Error ? error : new Error(String(error)),
			);
		});

		return () => {
			cancelled = true;
			bindingRef.current?.destroy();
			bindingRef.current = null;
		};
	}, [ariaLabel, readOnly]);

	React.useEffect(() => {
		if (bindingVersion > 0) bindingRef.current?.setText(text);
	}, [bindingVersion, text]);

	React.useEffect(() => {
		if (bindingVersion > 0) bindingRef.current?.setDiagnostics(diagnostics);
	}, [bindingVersion, diagnostics]);

	return <div ref={hostRef} data-anvilkit-code-surface="" className="h-full" />;
}
