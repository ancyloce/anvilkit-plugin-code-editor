/**
 * P0-15 acceptance (plan 0036): every transition of the §8.5 state machine
 * is covered, an editing session produces exactly ONE recording commit, and
 * an external change never silently clobbers either side.
 */
import type { Config, Data } from "@puckeditor/core";
import { describe, expect, it } from "vitest";
import { deriveSchemas, validateDocument } from "../gate/index.js";
import { emitJson, parseJson } from "../projection/json.js";
import type { ApplyResult } from "../projection/types.js";
import { SyncController } from "../sync/index.js";

const config = {
	components: {
		Badge: { fields: { label: { type: "text" } }, render: () => null },
	},
} as unknown as Config;

const schemas = deriveSchemas(config);

const docWith = (label: string): Data =>
	({
		root: { props: {} },
		content: [{ type: "Badge", props: { id: "badge-1", label } }],
		zones: {},
	}) as unknown as Data;

const validate = (text: string): ApplyResult<Data> => {
	const parsed = parseJson(text);
	if (!parsed.ok) return parsed;
	const gated = validateDocument(parsed.value, schemas);
	return gated.ok
		? { ok: true, value: gated.value }
		: { ok: false, diagnostics: gated.diagnostics };
};

/** Controller under test plus a record of everything it dispatched. */
function makeController(initial: Data = docWith("start")) {
	const interim: Data[] = [];
	const commits: Data[] = [];
	const controller = new SyncController({
		initial,
		validate,
		ports: {
			applyInterim: (data) => interim.push(data),
			commit: (data) => commits.push(data),
		},
	});
	return { controller, interim, commits };
}

describe("SyncController — states and transitions (P0-15)", () => {
	it("starts CLEAN with the document's canonical text", () => {
		const { controller } = makeController();
		const snapshot = controller.snapshot();
		expect(snapshot.state).toBe("clean");
		expect(snapshot.text).toBe(emitJson(docWith("start")).text);
		expect(snapshot.inSync).toBe(true);
	});

	it("CLEAN --edit--> DIRTY without validating yet", () => {
		const { controller, interim } = makeController();
		controller.edit("{ not json yet");
		expect(controller.snapshot().state).toBe("dirty");
		expect(controller.snapshot().diagnostics).toHaveLength(0);
		expect(interim).toHaveLength(0);
	});

	it("DIRTY + valid change --debounce--> non-recording interim apply", () => {
		const { controller, interim, commits } = makeController();
		controller.edit(emitJson(docWith("edited")).text);
		controller.debounceElapsed();
		expect(interim).toHaveLength(1);
		expect(commits).toHaveLength(0);
		expect(controller.snapshot().state).toBe("dirty");
	});

	it("DIRTY + no-op change --debounce--> no apply, reported in sync", () => {
		const { controller, interim } = makeController();
		// Same document, different key order: canonically identical.
		controller.edit(
			JSON.stringify({
				zones: {},
				content: [{ props: { label: "start", id: "badge-1" }, type: "Badge" }],
				root: { props: {} },
			}),
		);
		controller.debounceElapsed();
		expect(interim).toHaveLength(0);
		expect(controller.snapshot().inSync).toBe(true);
	});

	it("DIRTY + invalid --debounce--> diagnostics, canvas untouched", () => {
		const { controller, interim } = makeController();
		controller.edit('{ "content": [ { "type": "Nope", "props": {} } ] }');
		controller.debounceElapsed();
		const snapshot = controller.snapshot();
		expect(snapshot.diagnostics.length).toBeGreaterThan(0);
		expect(interim).toHaveLength(0);
		expect(snapshot.state).toBe("dirty");
	});

	it("malformed JSON reports a diagnostic and applies nothing", () => {
		const { controller, interim } = makeController();
		controller.edit("{ nope");
		controller.debounceElapsed();
		expect(controller.snapshot().diagnostics).toHaveLength(1);
		expect(interim).toHaveLength(0);
	});

	it("DIRTY --commit--> ONE recording commit, back to CLEAN", () => {
		const { controller, commits } = makeController();
		controller.edit(emitJson(docWith("edited")).text);
		controller.debounceElapsed();
		expect(controller.commit()).toBe(true);
		expect(commits).toHaveLength(1);
		expect(controller.snapshot().state).toBe("clean");
	});

	it("a whole session of edits records exactly ONE commit", () => {
		const { controller, interim, commits } = makeController();
		for (const label of ["a", "ab", "abc", "abcd"]) {
			controller.edit(emitJson(docWith(label)).text);
			controller.debounceElapsed();
		}
		controller.commit();
		expect(interim.length).toBeGreaterThan(1); // canvas followed along…
		expect(commits).toHaveLength(1); // …but undo sees one step.
	});

	it("commit on an untouched buffer records nothing", () => {
		const { controller, commits } = makeController();
		expect(controller.commit()).toBe(false);
		expect(commits).toHaveLength(0);
	});

	it("commit refuses an invalid buffer and keeps the diagnostics", () => {
		const { controller, commits } = makeController();
		controller.edit("{ broken");
		expect(controller.commit()).toBe(false);
		expect(commits).toHaveLength(0);
		expect(controller.snapshot().diagnostics.length).toBeGreaterThan(0);
	});

	it("manual mode validates but never applies interim", () => {
		const { controller, interim, commits } = makeController();
		controller.setMode("manual");
		controller.edit(emitJson(docWith("manual")).text);
		controller.debounceElapsed();
		expect(interim).toHaveLength(0);
		expect(controller.snapshot().diagnostics).toHaveLength(0);
		controller.commit();
		expect(commits).toHaveLength(1);
	});
});

describe("SyncController — external changes never clobber (P0-15)", () => {
	it("external change while CLEAN re-emits the buffer", () => {
		const { controller } = makeController();
		controller.externalChange(docWith("from-canvas"));
		const snapshot = controller.snapshot();
		expect(snapshot.state).toBe("clean");
		expect(snapshot.text).toBe(emitJson(docWith("from-canvas")).text);
	});

	it("external change while DIRTY goes STALE and blocks commit", () => {
		const { controller, commits } = makeController();
		controller.edit(emitJson(docWith("local")).text);
		controller.externalChange(docWith("remote"));
		expect(controller.snapshot().state).toBe("stale");
		expect(controller.commit()).toBe(false);
		expect(commits).toHaveLength(0);
	});

	it("STALE --discard--> incoming document wins, buffer re-emitted", () => {
		const { controller } = makeController();
		controller.edit(emitJson(docWith("local")).text);
		controller.externalChange(docWith("remote"));
		controller.discardLocal();
		const snapshot = controller.snapshot();
		expect(snapshot.state).toBe("clean");
		expect(snapshot.text).toBe(emitJson(docWith("remote")).text);
	});

	it("STALE --rebase--> keeps local text, resumes editing", () => {
		const { controller, commits } = makeController();
		const localText = emitJson(docWith("local")).text;
		controller.edit(localText);
		controller.externalChange(docWith("remote"));
		controller.rebaseOnIncoming();
		const snapshot = controller.snapshot();
		expect(snapshot.state).toBe("dirty");
		expect(snapshot.text).toBe(localText);
		// Editing continues, and the eventual commit is still a single step.
		controller.debounceElapsed();
		expect(controller.commit()).toBe(true);
		expect(commits).toHaveLength(1);
	});
});
