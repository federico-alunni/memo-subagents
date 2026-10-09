// The `question` tool lives in pi-memo-question: one tool for the main agent and every child, always the
// package the user installed (`pi install git:github.com/federico-alunni/pi-memo-question[@ref]`, or a local path in
// `settings.json` `packages`), updated with `pi update --extensions`. pi-memo-subagents never loads a copy of its own:
// a profile child gets it with the profile; an isolated child with `-e <installed extension>` (the same real path,
// so pi loads it once).
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const REPO = "federico-alunni/pi-memo-question";
const EXTENSION = join("extensions", "question.ts");

function real(path: string): string | undefined {
  try {
    return existsSync(path) ? realpathSync(path) : undefined;
  } catch {
    return undefined;
  }
}

function agentDirs(env: NodeJS.ProcessEnv): string[] {
  return [...new Set([env.PI_CODING_AGENT_DIR, join(homedir(), ".pi", "agent")].filter((d): d is string => !!d))];
}

/** Package sources of `<agentDir>/settings.json` (strings or `{ source }` entries). */
function settingsSources(agentDir: string): string[] {
  try {
    const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
    return (Array.isArray(settings?.packages) ? settings.packages : [])
      .map((entry: unknown) => (typeof entry === "string" ? entry : (entry as { source?: unknown })?.source))
      .filter((source: unknown): source is string => typeof source === "string");
  } catch {
    return [];
  }
}

/** Extension file of an installed pi-memo-question source, if `source` is one. */
function fromSource(agentDir: string, source: string): string | undefined {
  const git = /^git:(?:https?:\/\/)?([^/]+)\/(.+?)(?:\.git)?(?:@[^@/]+)?$/.exec(source);
  if (git) return git[2] === REPO ? real(join(agentDir, "git", git[1], git[2], EXTENSION)) : undefined;
  if (/^[a-z]+:/i.test(source)) return undefined;
  const dir = isAbsolute(source) ? source : resolve(agentDir, source);
  const file = real(join(dir, EXTENSION));
  if (!file) return undefined;
  try {
    return JSON.parse(readFileSync(join(dir, "package.json"), "utf8"))?.name === "pi-memo-question" ? file : undefined;
  } catch {
    return undefined;
  }
}

/** Real path of the installed pi-memo-question extension, or undefined when the user did not install it. */
export function installedQuestionExtension(env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const dir of agentDirs(env)) {
    for (const source of settingsSources(dir)) {
      const found = fromSource(dir, source);
      if (found) return found;
    }
    // Installed before (or outside) settings: pi's git checkout location.
    const found = real(join(dir, "git", "github.com", REPO, EXTENSION));
    if (found) return found;
  }
  return undefined;
}

/** The extension children load: the installed package, never a bundled copy. */
export function resolveQuestionExtension(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return installedQuestionExtension(env);
}
