import { nodePreset } from "@anvilkit/vitest-config/node";
import { defineConfig, mergeConfig } from "vitest/config";

/**
 * Node preset by default (fast, no DOM bootstrap) for the pure plugin-factory
 * tests; the React panel test opts into jsdom per-file via the
 * `// @vitest-environment jsdom` directive, mirroring `plugin-design-system`.
 */
export default mergeConfig(
	nodePreset,
	defineConfig({
		test: {
			name: "@anvilkit/plugin-code-editor",
			passWithNoTests: true,
			include: [
				"src/**/*.{test,spec}.{ts,tsx}",
				"src/**/__tests__/**/*.{test,spec}.{ts,tsx}",
			],
			setupFiles: ["./src/__tests__/setup-react.ts"],
		},
	}),
);
