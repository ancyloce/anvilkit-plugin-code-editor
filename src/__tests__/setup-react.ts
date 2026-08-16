/**
 * @file Per-file setup loaded by React tests via `setupFiles`.
 *
 * Runs `@testing-library/react`'s `cleanup()` after every test so the
 * jsdom DOM does not leak between cases (multiple `render()` calls in
 * one file would otherwise stack components with the same
 * `data-testid` and produce "found multiple" errors).
 *
 * Also polyfills the minimum Web-API shape `@anvilkit/core` (and Puck's
 * `@dnd-kit` dependency) needs at import time so jsdom mounts that
 * import the studio shell don't crash on first load. Mirrors the
 * polyfills in `packages/core/vitest.setup.ts`.
 *
 * Loaded conditionally — `vitest.config.ts` opts every test file into
 * this setup, but only `// @vitest-environment jsdom` tests will have
 * a DOM to clean up; under node, the polyfill installs are harmless
 * (they no-op when `Element` / `window` are absent).
 */

import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

class ResizeObserverStub {
	observe(): void {
		// intentionally empty — the design-system plugin code under
		// test never inspects ResizeObserver callbacks, only that the
		// constructor exists.
	}
	unobserve(): void {
		// intentionally empty (see observe).
	}
	disconnect(): void {
		// intentionally empty (see observe).
	}
}

if (
	typeof (globalThis as { ResizeObserver?: unknown }).ResizeObserver ===
	"undefined"
) {
	(globalThis as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
		ResizeObserverStub;
}

if (
	typeof window !== "undefined" &&
	typeof (window as { matchMedia?: unknown }).matchMedia !== "function"
) {
	Object.defineProperty(window, "matchMedia", {
		writable: true,
		configurable: true,
		value: (query: string) => ({
			matches: false,
			media: query,
			addEventListener: () => undefined,
			removeEventListener: () => undefined,
			addListener: () => undefined,
			removeListener: () => undefined,
			onchange: null,
			dispatchEvent: () => false,
		}),
	});
}

if (
	typeof Element !== "undefined" &&
	typeof (Element.prototype as { getAnimations?: unknown }).getAnimations !==
		"function"
) {
	Object.defineProperty(Element.prototype, "getAnimations", {
		writable: true,
		configurable: true,
		value: () => [],
	});
}

afterEach(() => {
	cleanup();
});
