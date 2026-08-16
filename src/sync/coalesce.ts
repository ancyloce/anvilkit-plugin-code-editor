import type { Data } from "@puckeditor/core";

/**
 * Commit ports (design 0022 §8.5). The controller never touches Puck: the
 * React layer supplies these, which keeps the state machine pure and lets
 * the tests assert exactly how many RECORDING commits a session produced.
 *
 * **Both `setData` forms shallow-merge** over the existing document
 * (precedent: `plugin-ai-copilot` `dispatchPageReplace`), so an implementation
 * must hand over a COMPLETE snapshot — explicit `content`, `zones` and
 * `root` — or stale keys survive. {@link completeSnapshot} does that here so
 * every port implementation inherits the guarantee.
 */
export interface CommitPorts {
	/**
	 * Interim apply: the canvas follows the buffer while the user is still
	 * typing. MUST be non-recording — these are not undo steps.
	 */
	readonly applyInterim: (data: Data) => void;
	/**
	 * The session's single history-recording commit ("one user intent = at
	 * most ONE history-recording setData").
	 */
	readonly commit: (data: Data) => void;
}

/**
 * Fill the top-level keys a shallow merge would otherwise leave stale.
 * Returns the same object when nothing was missing, so an unchanged
 * document stays referentially stable.
 */
export function completeSnapshot(data: Data): Data {
	const candidate = data as unknown as Record<string, unknown>;
	const hasContent = Array.isArray(candidate.content);
	const hasZones = candidate.zones !== undefined;
	const hasRoot = candidate.root !== undefined;
	if (hasContent && hasZones && hasRoot) return data;
	return {
		...(candidate as object),
		content: hasContent ? candidate.content : [],
		zones: hasZones ? candidate.zones : {},
		root: hasRoot ? candidate.root : { props: {} },
	} as unknown as Data;
}
