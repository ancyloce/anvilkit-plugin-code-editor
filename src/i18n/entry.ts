import type { RegistryEntry } from "@anvilkit/core/i18n";
import enMessages from "../../i18n/messages/en.json" with { type: "json" };

const PACKS: Record<string, () => Promise<Record<string, string>>> = {
	zh: async () => (await import("../../i18n/messages/zh.json")).default,
	ja: async () => (await import("../../i18n/messages/ja.json")).default,
	ko: async () => (await import("../../i18n/messages/ko.json")).default,
};

/** The plugin's i18n catalog, registered via `ctx.registerMessages`. */
export const CODE_EDITOR_ENTRY: RegistryEntry = {
	namespace: "codeEditor",
	en: enMessages,
	loadMessages: async (locale: string) => (await PACKS[locale]?.()) ?? {},
};
