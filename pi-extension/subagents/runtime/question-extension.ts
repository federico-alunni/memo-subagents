// The `question` tool lives in pi-memo-question: one tool for the main agent and every child.
//
// pi de-duplicates extensions by real path. The main agent gets the tool from the package the user installed with
// `pi install git:github.com/federico-alunni/pi-memo-question` (checkout under `<agent dir>/git/...`); the copy in
// this package's own `node_modules` (dependency) is a different path and would load the tool twice in a profile
// child. So the installed package wins and the dependency is the fallback for users who did not install it.
import { createRequire } from "node:module";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const INSTALLED_REPO = join("git", "github.com", "federico-alunni", "pi-memo-question");

function real(path: string): string | undefined {
  try {
    return existsSync(path) ? realpathSync(path) : undefined;
  } catch {
    return undefined;
  }
}

/** Extension of the package installed by pi (git source) in one of the agent directories, if any. */
export function installedQuestionExtension(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const dirs = [env.PI_CODING_AGENT_DIR, join(homedir(), ".pi", "agent")].filter((d): d is string => !!d);
  for (const dir of dirs) {
    const found = real(join(dir, INSTALLED_REPO, "extensions", "question.ts"));
    if (found) return found;
  }
  return undefined;
}

/** Real path of pi-memo-question's extension, or undefined if the package is not available at all. */
export function resolveQuestionExtension(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const installed = installedQuestionExtension(env);
  if (installed) return installed;
  try {
    const pkg = createRequire(import.meta.url).resolve("pi-memo-question/package.json");
    return realpathSync(join(dirname(pkg), "extensions", "question.ts"));
  } catch {
    return undefined;
  }
}
