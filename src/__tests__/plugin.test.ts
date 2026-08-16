/**
 * P0-13 acceptance (plan 0036): the plugin mounts, and FR-C15's no-op path
 * is exercised — without `ctx.editor` it warns exactly once and registers
 * nothing beyond its message catalog.
 */
import type { StudioPluginContext } from "@anvilkit/core";
import { describe, expect, it, vi } from "vitest";
import {
	CODE_EDITOR_SURFACE_ID,
	type CodeEditorPluginOptions,
	createCodeEditorPlugin,
} from "../plugin.js";

/**
 * Minimal plugin context covering only the seams this plugin touches. The
 * single cast lives here so no test body carries one.
 */
function registerWith(
	withEditor: boolean,
	options: CodeEditorPluginOptions = {},
) {
	const surfaces: string[] = [];
	let messages = 0;
	const unregister = vi.fn();
	const ctx = {
		registerMessages: () => {
			messages += 1;
		},
		registerEditorSurface: (surface: { id: string }) => {
			surfaces.push(surface.id);
			return unregister;
		},
		...(withEditor ? { editor: {} } : {}),
	} as unknown as StudioPluginContext;

	const registration = createCodeEditorPlugin(options).register(ctx);
	return { registration, surfaces, unregister, messageCount: () => messages };
}

describe("createCodeEditorPlugin", () => {
	it("declares frozen meta with the package version", () => {
		const plugin = createCodeEditorPlugin();
		expect(plugin.meta.id).toBe("anvilkit-plugin-code-editor");
		expect(plugin.meta.version).toMatch(/^\d+\.\d+\.\d+$/);
	});

	it("registers the editor surface when ctx.editor is present", () => {
		const { surfaces, messageCount } = registerWith(true);
		expect(messageCount()).toBe(1);
		expect(surfaces).toEqual([CODE_EDITOR_SURFACE_ID]);
	});

	it("unregisters its surface on destroy", async () => {
		const { registration, unregister } = registerWith(true);
		const resolved = await registration;
		resolved.hooks?.onDestroy?.();
		expect(unregister).toHaveBeenCalledTimes(1);
	});

	it("FR-C15: no-ops with ONE warning when ctx.editor is absent", async () => {
		const warnings: string[] = [];
		const { registration, surfaces, messageCount } = registerWith(false, {
			onUnavailable: (message) => warnings.push(message),
		});
		const resolved = await registration;

		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("editor.features.enabled");
		// The catalog still registers (labels stay resolvable); the surface
		// does not, and there is nothing to tear down.
		expect(messageCount()).toBe(1);
		expect(surfaces).toEqual([]);
		expect(resolved.hooks).toBeUndefined();
	});
});
