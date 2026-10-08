// Where the user's `config.json` equivalent lives.
//
// pi reconciles git packages with `git reset --hard` + `git clean -fdx`, which deletes every untracked or ignored
// file in the package checkout. A config kept in the package root would be lost at each `pi update --extensions`,
// so the user config lives in the agent directory instead. The package-root `config.json` stays as a fallback
// (local checkouts, `pi install /path`), `config.json.example` as the last default for `status`.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const USER_CONFIG_NAME = "pi-memo-subagents.json";
export const CONFIG_ENV = "PI_MEMO_SUBAGENTS_CONFIG";

export const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

/** Global agent directory, respecting PI_CODING_AGENT_DIR. */
export function agentConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

/**
 * Config file to read, first match wins:
 * 1. `PI_MEMO_SUBAGENTS_CONFIG` (explicit path, used as is even if missing so a typo is reported by the loader);
 * 2. `<agent dir>/pi-memo-subagents.json`;
 * 3. `~/.pi/agent/pi-memo-subagents.json`: children launched with another profile (`PI_CODING_AGENT_DIR` set to
 *    the profile) still read the user's global config;
 * 4. `<package root>/config.json` (legacy / local checkout; also the path reported when nothing exists).
 */
export function resolveConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env[CONFIG_ENV]?.trim();
  if (explicit) return explicit;
  for (const dir of [agentConfigDir(env), join(homedir(), ".pi", "agent")]) {
    const user = join(dir, USER_CONFIG_NAME);
    if (existsSync(user)) return user;
  }
  return join(PACKAGE_ROOT, "config.json");
}
