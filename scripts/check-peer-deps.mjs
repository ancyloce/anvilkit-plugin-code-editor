#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PACKAGE_ROOT = resolve(__dirname, "..");
const PACKAGE_JSON = resolve(PACKAGE_ROOT, "package.json");
const CORE_PACKAGE_JSON = resolve(
	PACKAGE_ROOT,
	"../../../runtime/core/package.json",
);
const REQUIRED_PEERS = ["react", "react-dom", "@puckeditor/core"];
// Plugin React peer ranges must include every range core supports so a
// host running on React 19 (which core supports) does not see an
// avoidable install warning when this plugin is installed alongside core.
const CORE_MIRRORED_PEERS = ["react", "react-dom"];

function normalizeRange(range) {
	if (typeof range !== "string") {
		return [];
	}
	return range
		.split("||")
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
}

async function main() {
	const pkg = JSON.parse(await readFile(PACKAGE_JSON, "utf8"));
	const corePkg = JSON.parse(await readFile(CORE_PACKAGE_JSON, "utf8"));
	const dependencies = pkg.dependencies ?? {};
	const devDependencies = pkg.devDependencies ?? {};
	const peerDependencies = pkg.peerDependencies ?? {};
	const peerDependenciesMeta = pkg.peerDependenciesMeta ?? {};
	const corePeerDependencies = corePkg.peerDependencies ?? {};

	const missingRequiredPeers = REQUIRED_PEERS.filter(
		(name) => !(name in peerDependencies),
	);
	const missingFromDevDependencies = Object.keys(peerDependencies).filter(
		(name) => !(name in devDependencies),
	);
	const missingPeerMeta = Object.keys(peerDependencies).filter((name) => {
		const meta = peerDependenciesMeta[name];
		return !meta || meta.optional !== false;
	});
	const leakedToDependencies = REQUIRED_PEERS.filter((name) => name in dependencies);

	const narrowerThanCore = [];
	for (const name of CORE_MIRRORED_PEERS) {
		const pluginRange = peerDependencies[name];
		const coreRange = corePeerDependencies[name];
		if (typeof pluginRange !== "string" || typeof coreRange !== "string") {
			continue;
		}
		const pluginParts = normalizeRange(pluginRange);
		const coreParts = normalizeRange(coreRange);
		// Cheap structural comparison: every disjunct in the core range
		// must show up in the plugin range, otherwise the plugin is
		// narrower. We compare on the leading major specifier of each
		// disjunct (e.g. ">=19.0.0", "^19") rather than parsing semver, so
		// the check tolerates differences in the minor/patch tail
		// (`>=19.0.0` vs `>=19.0.0`) but still flags missing majors.
		const majorOf = (part) => {
			const match = /^[\^~]?(\d+)/.exec(part);
			return match ? match[1] : null;
		};
		const pluginMajors = new Set(
			pluginParts.map(majorOf).filter((value) => value !== null),
		);
		const missingMajors = coreParts
			.map(majorOf)
			.filter((value) => value !== null && !pluginMajors.has(value));
		if (missingMajors.length > 0) {
			narrowerThanCore.push({ name, pluginRange, coreRange, missingMajors });
		}
	}

	if (
		missingRequiredPeers.length === 0 &&
		missingFromDevDependencies.length === 0 &&
		missingPeerMeta.length === 0 &&
		leakedToDependencies.length === 0 &&
		narrowerThanCore.length === 0
	) {
		console.log(
			"check-peer-deps: OK — peer deps are mirrored in devDependencies, absent from dependencies, and not narrower than @anvilkit/core.",
		);
		return;
	}

	console.error("check-peer-deps: FAIL");
	console.error("");

	if (missingRequiredPeers.length > 0) {
		console.error(
			`  Missing required peerDependencies: ${missingRequiredPeers.join(", ")}`,
		);
		console.error('  Add them under "peerDependencies" in package.json.');
		console.error("");
	}

	if (missingFromDevDependencies.length > 0) {
		console.error(
			`  Missing from devDependencies: ${missingFromDevDependencies.join(", ")}`,
		);
		console.error(
			'  Mirror every peer dependency in "devDependencies" so local builds resolve.',
		);
		console.error("");
	}

	if (missingPeerMeta.length > 0) {
		console.error(
			`  Missing or invalid peerDependenciesMeta: ${missingPeerMeta.join(", ")}`,
		);
		console.error(
			'  Every peer dependency must have "peerDependenciesMeta": { "<name>": { "optional": false } }.',
		);
		console.error("");
	}

	if (leakedToDependencies.length > 0) {
		console.error(
			`  Leaked into dependencies: ${leakedToDependencies.join(", ")}`,
		);
		console.error(
			'  Remove required peers from "dependencies" so consumers do not install duplicate runtime copies.',
		);
		console.error("");
	}

	if (narrowerThanCore.length > 0) {
		console.error(
			"  Plugin peer ranges narrower than @anvilkit/core — install warnings under React 19:",
		);
		for (const entry of narrowerThanCore) {
			console.error(
				`    ${entry.name}: plugin "${entry.pluginRange}" vs core "${entry.coreRange}" (missing majors: ${entry.missingMajors.join(", ")})`,
			);
		}
		console.error(
			"  Broaden the plugin range to cover the same majors core declares.",
		);
		console.error("");
	}

	process.exit(1);
}

main().catch((error) => {
	console.error("check-peer-deps: crashed unexpectedly");
	console.error(error);
	process.exit(2);
});
