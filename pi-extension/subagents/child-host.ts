/**
 * Host composition for child pi processes.
 *
 * A Herdr pane does not inherit the parent pi process environment, and a
 * profile started with `pi -ne` does not load packages from settings.json.
 * Hosts that need their children to load extra extensions (for example a
 * custom model provider) or to see extra variables declare them here:
 *
 * - `PI_MEMO_SUBAGENTS_CHILD_EXTENSIONS`: ':'-separated absolute extension paths,
 *   each passed to the child as `-e <path>` after the runtime child extension.
 * - `PI_MEMO_SUBAGENTS_CHILD_ENV`: ','-separated variable names forwarded from
 *   this process into the child command. `PI_*` names (including
 *   `PI_MEMO_*`) are refused: they are owned by pi and by this package.
 *
 * Applied by the agent runtime (hostCompositionFromEnv) to `subagent` launches and `subagent_resume`.
 * No other variable family is read: in particular `IR_CHILD_*` is ignored.
 */

export const CHILD_EXTENSIONS_ENV = "PI_MEMO_SUBAGENTS_CHILD_EXTENSIONS";
export const CHILD_ENV_ENV = "PI_MEMO_SUBAGENTS_CHILD_ENV";

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Absolute, de-duplicated extension paths declared by the host. */
export function hostChildExtensions(env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  for (const raw of (env[CHILD_EXTENSIONS_ENV] ?? "").split(":")) {
    const path = raw.trim();
    if (path.startsWith("/") && !out.includes(path)) out.push(path);
  }
  return out;
}

/** `[name, value]` pairs for listed, valid, defined, non-reserved variables. */
export function hostChildEnv(env: NodeJS.ProcessEnv = process.env): [string, string][] {
  const out: [string, string][] = [];
  const seen = new Set<string>();
  for (const raw of (env[CHILD_ENV_ENV] ?? "").split(",")) {
    const name = raw.trim();
    if (!ENV_NAME.test(name) || seen.has(name)) continue;
    if (name.startsWith("PI_")) continue; // includes PI_MEMO_SUBAGENTS_* and PI_MEMO_RUNTIME_*
    const value = env[name];
    if (value === undefined) continue;
    seen.add(name);
    out.push([name, value]);
  }
  return out;
}
