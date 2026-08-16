/**
 * Panel open/closed state, shared between the header action that toggles it
 * and the surface that renders it.
 *
 * This is what makes "the CodeMirror chunk loads on FIRST OPEN" true rather
 * than aspirational: registered editor surfaces render unconditionally, so
 * without a gate the panel would mount — and dynamic-import CodeMirror — as
 * soon as the editor does. Closed is the default.
 *
 * One store per `register()` call, never module-global: two `<Studio>`
 * mounts on a page must not share a toggle.
 */
export interface PanelVisibilityStore {
	readonly isOpen: () => boolean;
	readonly toggle: () => void;
	readonly open: () => void;
	readonly close: () => void;
	/** Subscribe to changes; returns an unsubscribe. */
	readonly subscribe: (listener: () => void) => () => void;
}

export function createPanelVisibilityStore(
	initiallyOpen = false,
): PanelVisibilityStore {
	let open = initiallyOpen;
	const listeners = new Set<() => void>();

	const set = (next: boolean): void => {
		if (next === open) return;
		open = next;
		for (const listener of listeners) listener();
	};

	return {
		isOpen: () => open,
		toggle: () => set(!open),
		open: () => set(true),
		close: () => set(false),
		subscribe: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
}
