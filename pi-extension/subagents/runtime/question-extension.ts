// The `question` tool lives in pi-memo-question (dependency): one tool for the main agent and every child.
import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";

/** Real path of pi-memo-question's extension, or undefined if the package is not installed. */
export function resolveQuestionExtension(): string | undefined {
  try {
    const pkg = createRequire(import.meta.url).resolve("pi-memo-question/package.json");
    // Real path: pi de-duplicates extensions by path, so a profile that also installs the package loads it once.
    return realpathSync(join(dirname(pkg), "extensions", "question.ts"));
  } catch {
    return undefined;
  }
}
