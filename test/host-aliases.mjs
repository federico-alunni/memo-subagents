// Run native Node tests with the host packages Pi's extension loader provides.
// Host location, first match wins:
//   1. PI_HOST_DIR (directory of @earendil-works/pi-coding-agent) -> aliased
//   2. host packages installed next to the repo (CI: npm install --no-save) -> plain Node resolution
//   3. Homebrew global install (macOS only) -> aliased
// In every case the legacy `@sinclair/typebox` specifier is mapped to `typebox`, as Pi's loader does.
// There is no per-OS default: without PI_HOST_DIR and without the packages in node_modules the run stops with a hint.
import { registerHooks, createRequire, stripTypeScriptTypes } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const HOST_PKG = "@earendil-works/pi-coding-agent";

function installedLocally() {
	try {
		for (const spec of [HOST_PKG, "@earendil-works/pi-tui", "@earendil-works/pi-ai", "typebox"]) import.meta.resolve(spec);
		return true;
	} catch {
		return false;
	}
}

const aliases = {};
const HOMEBREW_HOST = "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent";

if (process.env.PI_HOST_DIR || !installedLocally()) {
	const hostDir = process.env.PI_HOST_DIR ?? (existsSync(HOMEBREW_HOST) ? HOMEBREW_HOST : undefined);
	if (!hostDir) {
		throw new Error(
			"pi host packages not found. Set PI_HOST_DIR=<directory of @earendil-works/pi-coding-agent> " +
				"or install them: npm install --no-save @earendil-works/pi-coding-agent @earendil-works/pi-ai @earendil-works/pi-tui typebox",
		);
	}
	const dir = hostDir.replace(/\/?$/, "/");
	const require = createRequire(`${dir}package.json`);
	Object.assign(aliases, {
		[HOST_PKG]: `${dir}dist/index.js`,
		"@earendil-works/pi-tui": require.resolve("@earendil-works/pi-tui"),
		"@earendil-works/pi-ai": `${dir}node_modules/@earendil-works/pi-ai/dist/compat.js`,
		"@earendil-works/pi-agent-core": `${dir}node_modules/@earendil-works/pi-agent-core/dist/index.js`,
		typebox: require.resolve("typebox"),
		"@sinclair/typebox": require.resolve("typebox"),
	});
} else {
	aliases["@sinclair/typebox"] = import.meta.resolve("typebox");
}

registerHooks({
	resolve(specifier, context, nextResolve) {
		const target = aliases[specifier];
		return nextResolve(target ? (target.startsWith("file:") ? target : pathToFileURL(target).href) : specifier, context);
	},
	// pi loads TypeScript through jiti; plain Node refuses to strip types under node_modules, where the
	// pi-memo-question dependency (shipped as .ts source) is installed.
	load(url, context, nextLoad) {
		if (url.endsWith(".ts") && url.includes("/node_modules/pi-memo-question/")) {
			const source = stripTypeScriptTypes(readFileSync(fileURLToPath(url), "utf8"), { mode: "strip" });
			return { format: "module", source, shortCircuit: true };
		}
		return nextLoad(url, context);
	},
});

// The agent grid of the tests: the default 1×2, whatever the machine's config says (tests that need another
// grid set PI_SUBAGENT_GRID themselves).
process.env.PI_SUBAGENT_GRID = "1x2";
