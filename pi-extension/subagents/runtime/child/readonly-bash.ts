/**
 * Read-only bash policy (`bash: "readonly"`) enforced inside runtime children by the
 * child extension. Ported from pi-issue-round (same author, MIT).
 *
 * It is a per-command argv allowlist, never a denylist: read commands have
 * write/exec options (rg --pre, git diff --output, git --ext-diff, sort -o,
 * find -exec), so any unknown option is rejected. It is a workflow guard, not an
 * OS sandbox: an allowed git command still reads repository configuration.
 */

// Shell grammar is rejected before splitting: there is no shell parser, so the
// validated argv must be exactly what bash executes. Quotes, globs, expansions,
// redirections and separators are refused. `~` (home expansion) and `^`
// (revision suffix) are inert and cannot produce an option. Vertical tab/form
// feed are refused because bash does not split on them.
const unsafe = /[;&|<>`$\\\n\r\v\f(){}*?[\]!'"\x00]/;
const token = /^[a-zA-Z0-9_./,:+#=@%~^-]+$/;

type ArgSpec = {
  /** Standalone options accepted exactly. */
  flags?: readonly string[];
  /** Standalone options accepted by shape, e.g. `-5` or `--format=%h`. */
  patterns?: readonly RegExp[];
  /** Options consuming the next argv entry, with its validator. */
  valued?: Readonly<Record<string, (value: string) => boolean>>;
  /** Positional operands: allowed (default), forbidden, or decided from the parsed argv. */
  positional?: boolean | ((positionals: string[], flags: string[]) => boolean);
};
const num = (value: string) => /^\d{1,9}$/.test(value);
const signedCount = (value: string) => /^\+?\d{1,9}$/.test(value);
const word = (value: string) => !value.startsWith("-");
const name = (value: string) => /^[a-zA-Z0-9_.-]+$/.test(value) && word(value);

function argvAllowed(args: string[], spec: ArgSpec): boolean {
  const flags: string[] = [],
    positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (!arg.startsWith("-")) {
      positionals.push(arg);
      continue;
    }
    const valid = spec.valued && Object.hasOwn(spec.valued, arg) ? spec.valued[arg] : undefined;
    if (valid) {
      const value = args[++i];
      if (value === undefined || value.startsWith("-") || !valid(value)) return false;
      flags.push(arg);
      continue;
    }
    if (spec.flags?.includes(arg) || spec.patterns?.some((p) => p.test(arg))) {
      flags.push(arg);
      continue;
    }
    return false;
  }
  const positional = spec.positional ?? true;
  return typeof positional === "function"
    ? positional(positionals, flags)
    : positional || positionals.length === 0;
}

const headTail: ArgSpec = {
  patterns: [/^-\d{1,9}$/, /^-n\d{1,9}$/],
  valued: { "-n": signedCount, "-c": signedCount },
};
const COMMANDS: Readonly<Record<string, ArgSpec>> = {
  pwd: { positional: false },
  ls: { flags: ["--all"], patterns: [/^-[1aAdFhlRrSt]+$/] },
  // Never wait on stdin.
  cat: { patterns: [/^-[bns]+$/], positional: (p) => p.length > 0 },
  head: headTail,
  tail: headTail,
  wc: { patterns: [/^-[lwcm]+$/] },
  stat: { flags: ["-L", "-x"], valued: { "-f": word, "-c": word } },
  file: { flags: ["-b", "-L", "-i", "-I", "--mime-type"] },
  du: { patterns: [/^-[achksxL]+$/], valued: { "-d": num } },
  realpath: {},
  basename: {},
  dirname: {},
  which: {},
  // No --pre / --search-zip: they spawn programs. -g/-t only take inert values.
  rg: {
    flags: [
      "--files", "--hidden", "--line-number", "--no-heading", "--heading", "--count",
      "--files-with-matches", "--no-ignore", "--ignore-case", "--smart-case",
      "--fixed-strings", "--word-regexp", "--multiline", "--sort=path",
    ],
    patterns: [/^-[nNiSswFlcvHoxuUL]+$/],
    valued: {
      "-A": num, "-B": num, "-C": num, "-m": num, "--max-count": num, "--max-depth": num,
      "-d": num, "-t": name, "--type": name, "-T": name, "--type-not": name,
      "-g": word, "--glob": word, "-e": word,
    },
  },
  grep: {
    patterns: [/^-[rRinlcvwEFHhoqsx]+$/],
    valued: { "-A": num, "-B": num, "-C": num, "-m": num, "-e": word },
  },
};

// Display-only diff options shared by log/show/reflog/diff. Deliberately absent:
// --output, --ext-diff and --textconv (write files or run configured drivers).
const DIFF_DISPLAY = [
  "--stat", "--shortstat", "--numstat", "--name-only", "--name-status", "--no-color",
  "-p", "--patch", "--no-patch", "-s", "-w", "--ignore-all-space", "--word-diff",
  "--minimal", "--check", "--summary",
];
const LOG_LIKE: ArgSpec = {
  flags: [
    ...DIFF_DISPLAY, "--oneline", "--graph", "--all", "--decorate", "--no-decorate",
    "--no-merges", "--merges", "--first-parent", "--reverse", "--abbrev-commit", "--follow",
    "--source", "--topo-order", "--date-order", "--left-right", "--boundary", "--quiet",
    "-i", "--regexp-ignore-case",
  ],
  patterns: [
    /^-\d{1,9}$/, /^-n\d{1,9}$/, /^-U\d{1,9}$/,
    /^--(format|pretty|date|since|until|after|before|author|committer|grep|max-count|skip|decorate|abbrev|unified)=.+$/,
  ],
  valued: { "-n": num },
};
// `git branch NAME` / `git tag NAME` create refs: operands are accepted only
// together with an explicit list-mode option.
const listMode = (modes: string[]) => (positionals: string[], flags: string[]) =>
  positionals.length === 0 || flags.some((flag) => modes.includes(flag));
const CONFIG_READ = ["--get", "--get-all", "--get-regexp", "--list", "-l"];
const GIT: Readonly<Record<string, ArgSpec>> = {
  status: {
    flags: [
      "--porcelain", "--porcelain=v1", "--porcelain=v2", "--short", "-s", "-b", "-sb",
      "--branch", "--ignored", "-uno", "-unormal", "-uall", "--untracked-files=no",
      "--untracked-files=normal", "--untracked-files=all",
    ],
  },
  log: LOG_LIKE,
  show: LOG_LIKE,
  diff: {
    flags: [...DIFF_DISPLAY, "--cached", "--staged", "--porcelain", "--short", "--oneline"],
    patterns: [/^-U\d{1,9}$/, /^--unified=\d{1,9}$/],
  },
  "rev-parse": {
    flags: [
      "--abbrev-ref", "--short", "--show-toplevel", "--git-dir", "--git-common-dir",
      "--verify", "--symbolic-full-name", "--is-inside-work-tree", "--show-prefix", "-q",
      "--quiet",
    ],
    patterns: [/^--short=\d{1,2}$/],
  },
  "rev-list": {
    flags: ["--count", "--all", "--first-parent", "--no-merges", "--reverse", "--left-right", "--oneline"],
    patterns: [/^-\d{1,9}$/, /^--max-count=\d{1,9}$/],
    valued: { "-n": num },
  },
  "merge-base": { flags: ["--is-ancestor", "--all", "--fork-point", "--octopus"] },
  "cat-file": { flags: ["-p", "-t", "-s", "-e"] },
  "show-ref": { flags: ["--heads", "--tags", "--verify", "--hash", "-s", "--abbrev"] },
  "ls-files": {
    flags: [
      "-o", "-m", "-d", "-c", "-s", "-t", "--others", "--modified", "--deleted", "--cached",
      "--stage", "--exclude-standard", "--error-unmatch",
    ],
  },
  "ls-tree": { flags: ["-r", "-t", "-d", "-l", "--name-only", "--full-tree"] },
  blame: {
    flags: ["-w", "-M", "-C", "-s", "-e", "-l", "--porcelain", "--line-porcelain"],
    valued: { "-L": word },
  },
  branch: {
    flags: [
      "--list", "-l", "-a", "--all", "-r", "--remotes", "-v", "-vv", "--show-current",
      "--no-color", "--merged", "--no-merged", "--contains",
    ],
    positional: listMode(["--list", "-l", "--merged", "--no-merged", "--contains"]),
  },
  tag: { flags: ["--list", "-l"], patterns: [/^--sort=.+$/], positional: listMode(["--list", "-l"]) },
  remote: { flags: ["-v", "--verbose"], positional: false },
  // `git config KEY VALUE` writes: a read mode is mandatory.
  config: {
    flags: [...CONFIG_READ, "--show-origin", "--global", "--local"],
    positional: (positionals, flags) =>
      flags.some((f) => CONFIG_READ.includes(f)) &&
      (positionals.length === 0 || !flags.some((f) => f === "--list" || f === "-l")),
  },
};

function gitAllowed(argv: string[]): boolean {
  let i = 1;
  // Only inert global options: never -c (config injection, e.g. core.pager) or --exec-path.
  while (argv[i] === "-C" || argv[i] === "--no-pager") {
    if (argv[i] === "-C") {
      if (!argv[i + 1] || !word(argv[i + 1])) return false;
      i += 2;
    } else i += 1;
  }
  const verb = argv[i],
    args = argv.slice(i + 1);
  // reflog has mutating subcommands (expire, delete): only bare listing or `show`.
  if (verb === "reflog")
    return argvAllowed(args[0] === "show" ? args.slice(1) : args, {
      ...LOG_LIKE,
      positional: args[0] === "show",
    });
  // worktree has mutating subcommands: only `list`.
  if (verb === "worktree")
    return (
      args[0] === "list" &&
      argvAllowed(args.slice(1), { flags: ["--porcelain", "-v"], positional: false })
    );
  const spec = verb && Object.hasOwn(GIT, verb) ? GIT[verb] : undefined;
  return !!spec && argvAllowed(args, spec);
}

/** One plain argv without shell grammar (no pipes, redirections, quotes, globs, `$`, comments), or undefined. */
export function plainArgv(command: string): string[] | undefined {
  if (typeof command !== "string" || !command.trim() || unsafe.test(command)) return undefined;
  const argv = command.trim().split(/[ \t]+/);
  if (!argv.every((arg) => token.test(arg))) return undefined;
  // A word starting with `#` begins a bash comment: bash would run only a prefix
  // of the validated argv (e.g. `git branch new #x --list` creates a branch).
  if (argv.some((arg) => arg.startsWith("#"))) return undefined;
  return argv;
}

/**
 * True when a plain argv starts with one of the extra allowed command prefixes (e.g. "npm test",
 * "gh issue view"). The rest of the argv must be plain tokens too.
 */
export function allowedExtraCommand(command: string, allow: readonly string[]): boolean {
  const argv = plainArgv(command);
  if (!argv) return false;
  return allow.some((entry) => {
    const prefix = typeof entry === "string" ? entry.trim().split(/[ \t]+/).filter(Boolean) : [];
    return prefix.length > 0 && prefix.length <= argv.length && prefix.every((word, i) => argv[i] === word);
  });
}

/**
 * True only for one validated, read-only argv with no shell grammar. No `gh`:
 * a read-only child gets external data from its parent.
 */
export function readonlyCommand(command: string): boolean {
  const argv = plainArgv(command);
  if (!argv) return false;
  const cmd = argv[0];
  if (cmd === "git") return gitAllowed(argv);
  const spec = Object.hasOwn(COMMANDS, cmd) ? COMMANDS[cmd] : undefined;
  return !!spec && argvAllowed(argv.slice(1), spec);
}

/** Guidance shown to the model in context and in every rejection. */
export const READONLY_BASH_HINT =
  "Read-only bash accepts ONE plain command per call, without pipes, redirections, quotes, globs or $: " +
  "e.g. `tail -n 20 FILE`, `head -50 FILE`, `cat FILE`, `ls -la DIR`, `wc -l FILE`, `rg -n PATTERN DIR`, " +
  "`git log -10 --oneline`, `git show REV --stat`, `git diff --cached`, `git status -sb`, " +
  "`git reflog -n 10`, `git -C DIR log -5`. To read a file prefer the read tool; for patterns with spaces use grep/rg tools.";

export function readonlyBashRejection(prefix: string): string {
  return `${prefix}: bash command is not an allowed read-only form. ${READONLY_BASH_HINT}`;
}
