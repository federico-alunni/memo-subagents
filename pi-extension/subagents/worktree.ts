/**
 * Optional git worktree isolation for subagents.
 *
 * A child launched with `worktree: true` runs in a fresh `git worktree` on a
 * new branch. The worktree is kept after completion (no automatic merge); the
 * master receives path/branch/state in the result and can clean up with the
 * `subagent_worktrees` tool. Nothing here ever forces: no `--force`, no
 * `branch -D`, and ref deletion during rollback is conditional on the ref
 * still pointing at the base commit.
 */
import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { resolveConfigPath } from "./config-path.ts";

const GIT_TIMEOUT_MS = 120_000;

// ── config ──

export interface WorktreeConfig {
  /** Absolute root; worktrees go to `<root>/<repoName>/<slug>-<id8>`. */
  root?: string;
  /** Prefix for generated branch names. Default `memo/`. */
  branchPrefix: string;
  /** Template for generated branch names, e.g. `convoy/{name}`. Overrides branchPrefix. */
  branchTemplate?: string;
  /** Template for worktree directory paths, e.g. `{dir}/{repoName}-worktrees/{name}`. Overrides root. */
  pathTemplate?: string;
}

export const DEFAULT_BRANCH_PREFIX = "memo/";

function invalidConfig(source: string, message: string): never {
  throw new Error(`Invalid subagent worktree config in ${source}: ${message}`);
}

export function parseWorktreeConfig(rawConfig: unknown, source = "config.json"): WorktreeConfig {
  if (rawConfig == null || typeof rawConfig !== "object" || Array.isArray(rawConfig)) {
    invalidConfig(source, "root must be an object");
  }
  const value = (rawConfig as Record<string, unknown>).worktrees;
  if (value == null) return { branchPrefix: DEFAULT_BRANCH_PREFIX };
  if (typeof value !== "object" || Array.isArray(value)) invalidConfig(source, "worktrees must be an object");
  const section = value as Record<string, unknown>;
  const unsupported = Object.keys(section).filter(
    (key) => key !== "root" && key !== "branchPrefix" && key !== "branchTemplate" && key !== "pathTemplate",
  );
  if (unsupported.length > 0) {
    invalidConfig(source, `worktrees has unsupported key(s): ${unsupported.join(", ")}`);
  }
  const config: WorktreeConfig = { branchPrefix: DEFAULT_BRANCH_PREFIX };
  if (section.root != null) {
    if (typeof section.root !== "string" || !isAbsolute(section.root)) {
      invalidConfig(source, "worktrees.root must be an absolute path");
    }
    config.root = resolve(section.root);
  }
  if (section.branchPrefix != null) {
    if (
      typeof section.branchPrefix !== "string" ||
      !/^[A-Za-z0-9._/-]*$/.test(section.branchPrefix) ||
      section.branchPrefix.startsWith("-") ||
      section.branchPrefix.startsWith("/")
    ) {
      invalidConfig(source, "worktrees.branchPrefix must be a simple ref prefix such as \"memo/\"");
    }
    config.branchPrefix = section.branchPrefix;
  }
  if (section.branchTemplate != null && typeof section.branchTemplate === "string") {
    config.branchTemplate = section.branchTemplate;
  }
  if (section.pathTemplate != null && typeof section.pathTemplate === "string") {
    config.pathTemplate = section.pathTemplate;
  }
  return config;
}

/** Reads the user config (see config-path.ts); missing file means defaults. */
export function loadWorktreeConfig(configPath = resolveConfigPath()): WorktreeConfig {
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { branchPrefix: DEFAULT_BRANCH_PREFIX };
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON in subagent config ${configPath}: ${(error as Error).message}`);
  }
  return parseWorktreeConfig(parsed, configPath);
}

// ── git ──

export class GitError extends Error {
  readonly code: number | null;
  readonly stderr: string;
  constructor(message: string, code: number | null, stderr: string) {
    super(message);
    this.code = code;
    this.stderr = stderr;
  }
}

export async function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      "git",
      ["-c", "core.fsmonitor=false", "-C", cwd, ...args],
      {
        encoding: "utf8",
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: 32 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
      },
      (error, stdout, stderr) => {
        if (error) {
          const code = typeof (error as any).code === "number" ? (error as any).code : null;
          const detail = (stderr || error.message).trim();
          reject(new GitError(`git ${args[0]} failed: ${detail}`, code, stderr ?? ""));
          return;
        }
        resolvePromise(stdout);
      },
    );
  });
}

async function gitOk(cwd: string, args: string[]): Promise<boolean> {
  try {
    await git(cwd, args);
    return true;
  } catch {
    return false;
  }
}

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** Realpath of the deepest existing ancestor joined with the missing tail. */
function realish(path: string): string {
  const abs = resolve(path);
  let head = abs;
  const tail: string[] = [];
  while (!existsSync(head)) {
    const parent = dirname(head);
    if (parent === head) return abs;
    tail.unshift(basename(head));
    head = parent;
  }
  return join(real(head), ...tail);
}

export interface PorcelainWorktree {
  path: string;
  head?: string;
  branch?: string;
  detached?: boolean;
  bare?: boolean;
  locked?: string | true;
  prunable?: string | true;
}

export function parseWorktreeListPorcelainZ(output: string): PorcelainWorktree[] {
  const out: PorcelainWorktree[] = [];
  let current: PorcelainWorktree | null = null;
  for (const field of output.split("\0")) {
    if (field === "") {
      if (current) out.push(current);
      current = null;
      continue;
    }
    const space = field.indexOf(" ");
    const key = space === -1 ? field : field.slice(0, space);
    const value = space === -1 ? undefined : field.slice(space + 1);
    if (key === "worktree") {
      if (current) out.push(current);
      current = { path: value ?? "" };
      continue;
    }
    if (!current) continue;
    if (key === "HEAD") current.head = value;
    else if (key === "branch") current.branch = value;
    else if (key === "detached") current.detached = true;
    else if (key === "bare") current.bare = true;
    else if (key === "locked") current.locked = value ?? true;
    else if (key === "prunable") current.prunable = value ?? true;
  }
  if (current) out.push(current);
  return out;
}

export async function listWorktrees(repo: string): Promise<PorcelainWorktree[]> {
  return parseWorktreeListPorcelainZ(await git(repo, ["worktree", "list", "--porcelain", "-z"]));
}

function findListed(list: PorcelainWorktree[], path: string): PorcelainWorktree | undefined {
  const target = realish(path);
  return list.find((entry) => entry.path === path || realish(entry.path) === target);
}

/** Count of `git status --porcelain` entries (tracked changes + untracked). */
async function statusCounts(cwd: string): Promise<{ dirty: number; untracked: number }> {
  const output = await git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=normal"]);
  let dirty = 0;
  let untracked = 0;
  const fields = output.split("\0");
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i];
    if (!entry) continue;
    const xy = entry.slice(0, 2);
    if (xy === "??") untracked++;
    else dirty++;
    // Renames/copies carry the original path as a separate NUL field.
    if (xy[0] === "R" || xy[0] === "C") i++;
  }
  return { dirty, untracked };
}

// ── naming ──

export function slugifyName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug || "subagent";
}

export function defaultWorktreePath(toplevel: string, slugId: string, config: WorktreeConfig): string {
  const repoName = basename(toplevel);
  return config.root
    ? join(config.root, repoName, slugId)
    : join(dirname(toplevel), `${repoName}-memo-worktrees`, slugId);
}

// ── plan / create / rollback ──

export interface WorktreePlan {
  id: string;
  name: string;
  /** Source checkout toplevel (realpath). */
  repo: string;
  /** Directory the caller asked for (params.cwd / agent cwd / ctx.cwd). */
  sourceCwd: string;
  /** Source cwd relative to the toplevel ("" at the root). */
  rel: string;
  path: string;
  branch: string;
  /** Base as requested (`HEAD` by default). */
  baseRef: string;
  baseSha: string;
  /** Uncommitted tracked changes + untracked files in the source checkout. */
  sourceDirty: number;
  sourceUntracked: number;
  shallow: boolean;
  warnings: string[];
}

export interface WorktreeInfo {
  id: string;
  name: string;
  repo: string;
  sourceCwd: string;
  path: string;
  /** Child cwd inside the worktree (`<path>/<rel>`). */
  cwd: string;
  branch: string;
  base: string;
  createdAt: number;
  warnings: string[];
}

export async function planWorktree(options: {
  sourceCwd: string;
  id: string;
  name: string;
  branch?: string;
  base?: string;
  path?: string;
  config?: WorktreeConfig;
}): Promise<WorktreePlan> {
  const config = options.config ?? { branchPrefix: DEFAULT_BRANCH_PREFIX };
  if (!existsSync(options.sourceCwd)) {
    throw new Error(`Worktree source directory does not exist: ${options.sourceCwd}`);
  }
  const sourceCwd = real(options.sourceCwd);
  let toplevelRaw: string;
  try {
    toplevelRaw = (await git(sourceCwd, ["rev-parse", "--show-toplevel"])).trim();
  } catch {
    throw new Error(`worktree: ${sourceCwd} is not inside a git work tree`);
  }
  if (!toplevelRaw) throw new Error(`worktree: ${sourceCwd} is not inside a git work tree`);
  const repo = real(toplevelRaw);
  const rel = relative(repo, sourceCwd);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`worktree: ${sourceCwd} is outside its repository toplevel ${repo}`);
  }

  const id8 = options.id.slice(0, 8);
  const slugName = slugifyName(options.name);
  const slugId = `${slugName}-${id8}`;
  const vars: Record<string, string> = {
    name: slugName,
    rawName: options.name,
    id: options.id,
    id8,
    slugId,
    repo,
    repoName: basename(repo),
    dir: dirname(repo),
  };
  const renderTpl = (tpl: string) => tpl.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, k) => vars[k] ?? "");

  let branch: string;
  if (options.branch?.trim()) {
    branch = options.branch.trim();
  } else if (process.env.PI_SUBAGENT_WORKTREE_BRANCH?.trim()) {
    const envBranch = process.env.PI_SUBAGENT_WORKTREE_BRANCH.trim();
    branch = envBranch.includes("{") ? renderTpl(envBranch) : `${envBranch}${slugId}`;
  } else if (config.branchTemplate) {
    branch = renderTpl(config.branchTemplate);
  } else {
    branch = `${config.branchPrefix}${slugId}`;
  }

  if (branch.startsWith("-") || !(await gitOk(repo, ["check-ref-format", `refs/heads/${branch}`]))) {
    throw new Error(`worktree: invalid branch name "${branch}"`);
  }
  if (await gitOk(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])) {
    throw new Error(`worktree: branch "${branch}" already exists; refusing to adopt it`);
  }

  const baseRef = options.base?.trim() || "HEAD";
  if (baseRef.startsWith("-")) throw new Error(`worktree: invalid base "${baseRef}"`);
  let baseSha: string;
  try {
    baseSha = (await git(repo, ["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`])).trim();
  } catch {
    baseSha = "";
  }
  if (!/^[0-9a-f]{40,64}$/.test(baseSha)) {
    throw new Error(
      baseRef === "HEAD"
        ? "worktree: the source repository has no commits yet"
        : `worktree: base "${baseRef}" does not resolve to a commit`,
    );
  }

  let resolvedPath: string;
  if (options.path?.trim()) {
    resolvedPath = realish(resolve(options.path.trim()));
  } else if (process.env.PI_SUBAGENT_WORKTREE_PATH?.trim()) {
    const envPath = process.env.PI_SUBAGENT_WORKTREE_PATH.trim();
    resolvedPath = envPath.includes("{")
      ? realish(resolve(renderTpl(envPath)))
      : realish(join(resolve(envPath), basename(repo), slugId));
  } else if (config.pathTemplate) {
    resolvedPath = realish(resolve(renderTpl(config.pathTemplate)));
  } else {
    resolvedPath = realish(defaultWorktreePath(repo, slugId, config));
  }
  const path = resolvedPath;
  if (existsSync(path)) throw new Error(`worktree: path already exists: ${path}`);
  const listed = await listWorktrees(repo);
  if (findListed(listed, path)) throw new Error(`worktree: path is already registered with git: ${path}`);
  if (path === repo || path.startsWith(repo + sep)) {
    throw new Error(`worktree: refusing to create a worktree inside the source checkout (${path})`);
  }

  const { dirty, untracked } = await statusCounts(sourceCwd);
  const shallow = (await git(repo, ["rev-parse", "--is-shallow-repository"])).trim() === "true";
  const warnings: string[] = [];
  if (dirty + untracked > 0) warnings.push(dirtySourceWarning(dirty + untracked, baseSha));
  if (shallow) warnings.push("The source repository is a shallow clone; history in the worktree is truncated.");

  return {
    id: options.id,
    name: options.name,
    repo,
    sourceCwd,
    rel,
    path,
    branch,
    baseRef,
    baseSha,
    sourceDirty: dirty,
    sourceUntracked: untracked,
    shallow,
    warnings,
  };
}

export function dirtySourceWarning(count: number, baseSha: string): string {
  return (
    `The source checkout has ${count} uncommitted/untracked change(s) that are NOT included ` +
    `in the worktree (it starts from ${baseSha.slice(0, 7)}).`
  );
}

export async function createWorktree(plan: WorktreePlan): Promise<WorktreeInfo> {
  mkdirSync(dirname(plan.path), { recursive: true });
  let addError: unknown;
  try {
    await git(plan.repo, ["worktree", "add", "-b", plan.branch, plan.path, plan.baseSha]);
  } catch (error) {
    addError = error;
  }

  const info: WorktreeInfo = {
    id: plan.id,
    name: plan.name,
    repo: plan.repo,
    sourceCwd: plan.sourceCwd,
    path: plan.path,
    cwd: plan.rel ? join(plan.path, plan.rel) : plan.path,
    branch: plan.branch,
    base: plan.baseSha,
    createdAt: Date.now(),
    warnings: [...plan.warnings],
  };

  let problem: string | undefined = addError ? (addError as Error).message : undefined;
  if (!problem) {
    // Read back: registered, on the new branch, at the base commit.
    const listed = findListed(await listWorktrees(plan.repo), plan.path);
    if (!listed) problem = "worktree was not registered after git worktree add";
    else if (listed.branch !== `refs/heads/${plan.branch}`) problem = `worktree is on ${listed.branch ?? "a detached HEAD"}, expected ${plan.branch}`;
    else if (listed.head !== plan.baseSha) problem = `worktree HEAD ${listed.head} differs from base ${plan.baseSha}`;
  }
  if (problem) {
    const rollback = await rollbackWorktree(info);
    const note = rollback.errors.length > 0 ? ` Rollback incomplete: ${rollback.errors.join("; ")}` : " Rolled back.";
    throw new Error(`worktree: creation failed: ${problem}.${note}`);
  }
  if (!existsSync(info.cwd)) {
    info.warnings.push(`${plan.rel} does not exist at ${plan.baseSha.slice(0, 7)}; the child starts at the worktree root.`);
    info.cwd = plan.path;
  }
  return info;
}

/**
 * Undo a creation: `git worktree remove` (never --force), then delete the
 * branch only if it still points at the base commit.
 */
export async function rollbackWorktree(
  info: Pick<WorktreeInfo, "repo" | "path" | "branch" | "base">,
): Promise<{ removed: boolean; branchDeleted: boolean; errors: string[] }> {
  const errors: string[] = [];
  let removed = false;
  let branchDeleted = false;
  const listed = findListed(await listWorktrees(info.repo).catch(() => []), info.path);
  if (listed) {
    try {
      await git(info.repo, ["worktree", "remove", info.path]);
      removed = true;
    } catch (error) {
      errors.push((error as Error).message);
    }
  } else {
    removed = !existsSync(info.path);
    if (!removed) errors.push(`left unregistered directory ${info.path} in place`);
  }
  if (removed) {
    try {
      await git(info.repo, ["update-ref", "-d", `refs/heads/${info.branch}`, info.base]);
      branchDeleted = true;
    } catch (error) {
      if (await gitOk(info.repo, ["show-ref", "--verify", "--quiet", `refs/heads/${info.branch}`])) {
        errors.push(`branch ${info.branch} kept: ${(error as Error).message}`);
      }
    }
  }
  return { removed, branchDeleted, errors };
}

// ── state ──

export interface WorktreeState {
  path: string;
  exists: boolean;
  registered: boolean;
  branch?: string;
  head?: string;
  base?: string;
  commitsAhead?: number;
  dirty?: number;
  untracked?: number;
  locked?: string | true;
  operation?: string;
  error?: string;
}

async function inProgressOperation(path: string): Promise<string | undefined> {
  const gitDir = (await git(path, ["rev-parse", "--absolute-git-dir"])).trim();
  const markers: Array<[string, string]> = [
    ["MERGE_HEAD", "merge"],
    ["rebase-merge", "rebase"],
    ["rebase-apply", "rebase/am"],
    ["CHERRY_PICK_HEAD", "cherry-pick"],
    ["REVERT_HEAD", "revert"],
    ["BISECT_LOG", "bisect"],
  ];
  return markers.find(([file]) => existsSync(join(gitDir, file)))?.[1];
}

export async function getWorktreeState(info: { repo: string; path: string; base?: string }): Promise<WorktreeState> {
  const state: WorktreeState = { path: info.path, exists: existsSync(info.path), registered: false, base: info.base };
  try {
    const listed = existsSync(info.repo) ? findListed(await listWorktrees(info.repo), info.path) : undefined;
    state.registered = !!listed;
    if (listed?.locked) state.locked = listed.locked;
    if (!state.exists || !listed) return state;
    state.head = (await git(info.path, ["rev-parse", "HEAD"])).trim();
    state.branch = listed.branch?.replace(/^refs\/heads\//, "");
    if (info.base) {
      state.commitsAhead = Number.parseInt(
        (await git(info.path, ["rev-list", "--count", `${info.base}..HEAD`])).trim(),
        10,
      );
    }
    const counts = await statusCounts(info.path);
    state.dirty = counts.dirty;
    state.untracked = counts.untracked;
    state.operation = await inProgressOperation(info.path);
  } catch (error) {
    state.error = (error as Error).message;
  }
  return state;
}

export function formatWorktreeLine(info: { path: string; branch: string; base: string }, state?: WorktreeState): string {
  const base7 = info.base.slice(0, 7);
  if (!state || state.error || !state.exists) {
    return `Worktree: ${info.path} (branch ${info.branch}, base ${base7}${state && !state.exists ? ", missing" : ""})`;
  }
  const ahead = state.commitsAhead ?? 0;
  const clean = (state.dirty ?? 0) + (state.untracked ?? 0) === 0 ? "clean" : "dirty";
  return `Worktree: ${info.path} (branch ${info.branch}, ${ahead} commit${ahead === 1 ? "" : "s"} ahead of ${base7}, ${clean})`;
}

// ── removal ──

export interface RemoveResult {
  ok: boolean;
  removed: boolean;
  branchDeleted: boolean;
  messages: string[];
}

export async function removeWorktree(
  info: { repo: string; path: string; branch: string; base?: string },
  options: { deleteBranch?: boolean; inUse?: boolean } = {},
): Promise<RemoveResult> {
  const refuse = (message: string): RemoveResult => ({ ok: false, removed: false, branchDeleted: false, messages: [message] });
  if (options.inUse) return refuse(`Refusing: ${info.path} is in use by a running subagent.`);
  const state = await getWorktreeState(info);
  if (state.error) return refuse(`Refusing: cannot inspect ${info.path}: ${state.error}`);
  if (!state.registered) return refuse(`Refusing: ${info.path} is not a registered worktree of ${info.repo}.`);
  if (state.locked) return refuse(`Refusing: ${info.path} is locked${state.locked === true ? "" : ` (${state.locked})`}.`);
  if (!state.exists) return refuse(`Refusing: ${info.path} is registered but missing; run git worktree prune manually.`);
  if (state.operation) return refuse(`Refusing: a ${state.operation} is in progress in ${info.path}.`);
  if ((state.dirty ?? 0) > 0 || (state.untracked ?? 0) > 0) {
    return refuse(
      `Refusing: ${info.path} has ${state.dirty ?? 0} uncommitted and ${state.untracked ?? 0} untracked change(s).`,
    );
  }
  try {
    await git(info.repo, ["worktree", "remove", info.path]);
  } catch (error) {
    return refuse(`git worktree remove failed: ${(error as Error).message}`);
  }
  const result: RemoveResult = { ok: true, removed: true, branchDeleted: false, messages: [`Removed worktree ${info.path}.`] };
  if (options.deleteBranch) {
    try {
      await git(info.repo, ["branch", "-d", info.branch]);
      result.branchDeleted = true;
      result.messages.push(`Deleted branch ${info.branch}.`);
    } catch (error) {
      result.messages.push(`Kept branch ${info.branch} (git branch -d refused: ${(error as GitError).stderr.trim() || (error as Error).message}).`);
    }
  } else {
    result.messages.push(`Kept branch ${info.branch}.`);
  }
  return result;
}

// ── registry ──

export interface WorktreeRecord {
  id: string;
  name: string;
  agent?: string;
  repo: string;
  sourceCwd: string;
  path: string;
  cwd: string;
  branch: string;
  base: string;
  sessionFile?: string;
  parentSession?: string;
  createdAt: number;
  removedAt?: number;
}

export function worktreeRegistryDir(agentConfigDir: string): string {
  return join(agentConfigDir, "pi-memo-subagents", "worktrees");
}

function recordFile(dir: string, id: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`Invalid worktree record id: ${id}`);
  return join(dir, `${id}.json`);
}

export function writeWorktreeRecord(dir: string, record: WorktreeRecord): string {
  mkdirSync(dir, { recursive: true });
  const file = recordFile(dir, record.id);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  renameSync(tmp, file);
  return file;
}

export function readWorktreeRecords(dir: string): WorktreeRecord[] {
  if (!existsSync(dir)) return [];
  const out: WorktreeRecord[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".json")) continue;
    try {
      const record = JSON.parse(readFileSync(join(dir, entry), "utf8")) as WorktreeRecord;
      if (record && typeof record.id === "string" && typeof record.path === "string") out.push(record);
    } catch {
      // Skip partial or foreign files.
    }
  }
  return out.sort((a, b) => a.createdAt - b.createdAt);
}

export function findWorktreeRecordBySession(dir: string, sessionFile: string): WorktreeRecord | undefined {
  const target = realish(sessionFile);
  return readWorktreeRecords(dir)
    .filter((record) => record.sessionFile && (record.sessionFile === sessionFile || realish(record.sessionFile) === target))
    .at(-1);
}

export function markWorktreeRecordRemoved(dir: string, id: string, at = Date.now()): WorktreeRecord | undefined {
  const file = recordFile(dir, id);
  if (!existsSync(file)) return undefined;
  const record = JSON.parse(readFileSync(file, "utf8")) as WorktreeRecord;
  record.removedAt = at;
  writeWorktreeRecord(dir, record);
  return record;
}

/** Repository toplevel for `cwd`, or undefined outside git. */
export async function repoToplevel(cwd: string): Promise<string | undefined> {
  try {
    const top = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
    return top ? real(top) : undefined;
  } catch {
    return undefined;
  }
}

export function samePath(a: string, b: string): boolean {
  return a === b || realish(a) === realish(b);
}
