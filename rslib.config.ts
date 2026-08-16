import { pluginReact } from "@rsbuild/plugin-react";
import { defineConfig } from "@rslib/core";

export default defineConfig({
	source: {
		entry: {
			index: [
				"./src/**/*.{ts,tsx}",
				"!./src/**/*.{test,spec}.{ts,tsx}",
				"!./src/**/__tests__/**",
			],
		},
	},
	lib: [
		{
			bundle: false,
			dts: { autoExtension: true },
			id: "esm",
			format: "esm",
		},
		{
			bundle: false,
			dts: { autoExtension: true, distPath: "./dist/cjs" },
			id: "cjs",
			format: "cjs",
		},
	],
	output: {
		target: "web",
		externals: [
			"@anvilkit/core",
			"@anvilkit/ui",
			"@puckeditor/core",
			"react",
			"react-dom",
		],
	},
	performance: {
		// rslib defaults performance.buildCache to true, but rspack 2.x's
		// persistent cache storage is not concurrency-safe under Turbo's
		// parallel `^build` fan-out (concurrency: 32) -> SIGABRT or
		// silently missing/corrupted dist output (e.g. missing .d.ts).
		buildCache: false,
	},
	plugins: [pluginReact()],
});
