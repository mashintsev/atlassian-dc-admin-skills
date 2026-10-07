/**
 * ScriptRunner Script Root ↔ local folder synchronization: compare, then push or pull single files.
 *
 * The sync compares three SHA-256 values per path: the local file, the server file and the baseline
 * (the last content known identical on both sides, kept in the export manifest). It only plans: its
 * dry run returns one batch item per file to push or pull, which the CLI confirms in one checklist and
 * runs one by one. Each push or pull carries the SHA-256 it expects on the side it overwrites and
 * re-checks it right before writing, so an edit made after the preview is a conflict, never lost.
 *
 * Deletions are only reported: nothing here deletes a file on either side. Uploads use the Script
 * Editor's `PUT idea/file` (base64 body), gated by the `script-root-write` support-matrix operation;
 * this module never sends DELETE. Source never leaves the tool except into the named local files and
 * the named Script Root path: results, plans, errors and the manifest carry paths, sizes, SHA-256 and
 * outcomes only. Scripts are never run, validated or compiled through ScriptRunner.
 */

import { lstat, readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { AtlassianClient } from "../../client.js";
import { isHttpStatusError, ValidationError, VerificationError } from "../../errors.js";
import type { ToolContext, ToolDef } from "../types.js";
import { alreadySatisfied, dryRunShape } from "../util.js";
import { isScriptRunnerOperationVerified, requireScriptRunnerOperation } from "./scriptrunner.js";
import {
  atomicWrite,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_FILES,
  downloadFiles,
  hasDescendants,
  isUnder,
  loadScriptRoots,
  localTarget,
  MANIFEST_NAME,
  MAX_BYTES_CAP,
  MAX_FILES_CAP,
  pickRoots,
  projectRelative,
  readScriptFile,
  SECRETS_NOTE,
  selectFolder,
  sha256,
  single,
  validateRelative,
  writeLocal,
  type ScriptRootTree,
} from "./scriptRoot.js";

const SR = "/rest/scriptrunner/latest";
const READ_OP = "script-root-read";
const READ_LABEL = "Reading ScriptRunner Script Root files";
const WRITE_OP = "script-root-write";
const WRITE_LABEL = "Writing ScriptRunner Script Root files (script-root-write)";
const ABSENT = "absent";
const PATH_LIMIT = 50;
/** Manifest outcomes after which both sides held the recorded content. */
const BASELINE_OUTCOMES = new Set(["WRITTEN", "ALREADY-SATISFIED", "REPLACED", "PUSHED", "PULLED"]);
/** Backups made by writeLocal: `<file>.bak-<ISO timestamp with - for : and .>`. */
const BACKUP = /\.bak-\d{4}-\d{2}-\d{2}T[\d-]+Z$/;
const DRY_NOTE = "Nothing was changed. Confirm with the user, then re-run with dry_run=false.";

export type SyncClass = "IN-SYNC" | "PUSH" | "PULL" | "CONFLICT" | "DELETED-LOCALLY" | "DELETED-ON-SERVER" | "FAILED";

const short = (sha: string) => sha.slice(0, 12);
const posix = (p: string) => p.split(sep).join("/");

// ---- server write (PUT only) ----

/** An upload failed; the message never carries the response body. */
class ScriptWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScriptWriteError";
  }
}

/** Save one file through the Script Editor; the body is the base64 of the bytes. */
export async function writeScriptFile(client: AtlassianClient, rootPath: string, relativePath: string, bytes: Buffer): Promise<void> {
  try {
    await client.request("PUT", `${SR}/idea/file`, {
      params: { filePath: relativePath, rootPath },
      body: bytes.toString("base64"),
      contentType: "application/octet-stream",
    });
  } catch (e) {
    if (isHttpStatusError(e)) throw new ScriptWriteError(`HTTP ${e.status}`);
    throw new ScriptWriteError((e as Error)?.name || "write error");
  }
}

// ---- comparison ----

/** Three-way classification of one path from its local, server and baseline SHA-256. */
export function classify(local: string | undefined, server: string | undefined, base: string | undefined): Exclude<SyncClass, "FAILED"> {
  if (local !== undefined && server !== undefined) {
    if (local === server) return "IN-SYNC";
    if (base === undefined) return "CONFLICT";
    if (server === base) return "PUSH";
    if (local === base) return "PULL";
    return "CONFLICT";
  }
  if (local !== undefined) return base === undefined ? "PUSH" : "DELETED-ON-SERVER";
  if (server !== undefined) return base === undefined ? "PULL" : "DELETED-LOCALLY";
  throw new Error("classify needs a local or a server file");
}

/** Regular files under `localDir` by POSIX relative path; skips the manifest, backups, temporary and dot entries. */
export async function walkLocal(localDir: string, manifestPath: string): Promise<{ files: Map<string, string>; failed: Map<string, string> }> {
  const skip = resolve(manifestPath);
  const files = new Map<string, string>();
  const failed = new Map<string, string>();
  const visit = async (dir: string, prefix: string) => {
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (e.name.startsWith(".") || BACKUP.test(e.name)) continue;
      const abs = join(dir, e.name);
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (abs === skip) continue;
      if (e.isSymbolicLink()) failed.set(rel, "a symbolic link; not followed");
      else if (e.isDirectory()) await visit(abs, rel);
      else if (!e.isFile()) failed.set(rel, "not a regular file");
      else {
        try {
          files.set(validateRelative(rel, "local path"), abs);
        } catch (err) {
          failed.set(rel, (err as Error).message);
        }
      }
    }
  };
  await visit(resolve(localDir), "");
  return { files, failed };
}

// ---- baseline manifest ----

async function readManifest(manifestPath: string): Promise<any | undefined> {
  let text: string;
  try {
    text = await readFile(manifestPath, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new ValidationError(`Cannot read the manifest ${projectRelative(manifestPath)}: ${(e as NodeJS.ErrnoException).code ?? "read error"}`);
  }
  try {
    const m = JSON.parse(text);
    if (m && typeof m === "object" && (m.files === undefined || Array.isArray(m.files))) return m;
  } catch {
    // reported below
  }
  throw new ValidationError(`${projectRelative(manifestPath)} is not a ScriptRunner export manifest`);
}

/** Baseline SHA-256 per Script Root path; entries of another Script Root or without a both-sides outcome are ignored. */
export async function loadBaseline(manifestPath: string, scriptRoot: string): Promise<{ exists: boolean; entries: Map<string, string>; note?: string }> {
  const m = await readManifest(manifestPath);
  const entries = new Map<string, string>();
  if (!m) return { exists: false, entries };
  if (typeof m.scriptRoot === "string" && m.scriptRoot !== scriptRoot) {
    return { exists: true, entries, note: `The manifest belongs to another Script Root (${m.scriptRoot}); it is not used as a baseline` };
  }
  for (const f of m.files ?? []) {
    if (typeof f?.path === "string" && typeof f?.sha256 === "string" && BASELINE_OUTCOMES.has(f.outcome)) entries.set(f.path, f.sha256);
  }
  return { exists: true, entries };
}

export interface BaselineEntry {
  path: string;
  local: string;
  size: number;
  sha256: string;
  outcome: "PUSHED" | "PULLED";
  backup?: string;
}

/** Set one file's baseline; every other entry is kept as it was. */
export async function recordBaseline(manifestPath: string, scriptRoot: string, entry: BaselineEntry): Promise<void> {
  const m = (await readManifest(manifestPath)) ?? { scriptRoot, files: [] };
  if (typeof m.scriptRoot === "string" && m.scriptRoot !== scriptRoot) {
    throw new ValidationError(`the manifest belongs to another Script Root (${m.scriptRoot})`);
  }
  m.scriptRoot ??= scriptRoot;
  m.files ??= [];
  const value = { ...entry, syncedAt: new Date().toISOString() };
  const i = m.files.findIndex((f: any) => f?.path === entry.path);
  if (i >= 0) m.files[i] = value;
  else m.files.push(value);
  await atomicWrite(manifestPath, Buffer.from(JSON.stringify(m, null, 2) + "\n"));
}

/** Record a baseline; a failure is reported in the result, because the file itself was already written. */
async function tryRecord(manifestPath: string | undefined, scriptRoot: string, entry: BaselineEntry): Promise<string> {
  if (!manifestPath) return "not recorded: pass manifest or local_dir";
  try {
    await recordBaseline(manifestPath, scriptRoot, entry);
    return `recorded in ${projectRelative(manifestPath)}`;
  } catch (e) {
    return `not recorded: ${e instanceof ValidationError ? e.message : ((e as NodeJS.ErrnoException).code ?? "write error")}`;
  }
}

// ---- local and server state ----

/** The local file's SHA-256, or undefined when absent; anything but a regular file is refused. */
async function localSha(target: string): Promise<{ sha: string; bytes: Buffer } | undefined> {
  let s;
  try {
    s = await lstat(target);
  } catch {
    return undefined;
  }
  if (!s.isFile()) throw new ValidationError(`${projectRelative(target)} exists and is not a regular file`);
  const bytes = await readFile(target);
  return { sha: sha256(bytes), bytes };
}

/** `local` inside `local_dir` (default: its own folder), checked like the export's targets. */
async function localFile(args: { local: string; local_dir?: string }): Promise<{ base: string; target: string }> {
  const target = resolve(args.local);
  const base = resolve(args.local_dir ?? dirname(target));
  try {
    if (!(await stat(base)).isDirectory()) throw new Error();
  } catch {
    throw new ValidationError(`local_dir ${projectRelative(base)} is not an existing directory`);
  }
  if (!isUnder(target, base) || target === base) throw new ValidationError("local must be a file inside local_dir");
  return { base, target: await localTarget(base, posix(relative(base, target))) };
}

/** The Script Root holding `path`, and whether the file exists there yet. */
function serverTreeFor(roots: ScriptRootTree[], path: string, scriptRoot?: string): { tree: ScriptRootTree; exists: boolean } {
  const candidates = pickRoots(roots, scriptRoot);
  const asFile = candidates.filter((r) => r.entries.get(path) === true);
  if (asFile.length) return { tree: single(asFile, `'${path}'`), exists: true };
  if (candidates.some((r) => r.entries.get(path) === false || hasDescendants(r, path))) throw new ValidationError(`'${path}' is a directory, not a file`);
  const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : undefined;
  const withParent = parent ? candidates.filter((r) => r.entries.get(parent) === false || hasDescendants(r, parent)) : [];
  if (withParent.length) return { tree: single(withParent, `Folder '${parent}'`), exists: false };
  if (candidates.length === 1) return { tree: candidates[0]!, exists: false };
  throw new ValidationError(`'${path}' is new and its folder exists in no single Script Root; pass script_root`);
}

const readOrFail = (c: AtlassianClient, rootPath: string, path: string) =>
  readScriptFile(c, rootPath, path).catch((e) => {
    throw new ValidationError(`Reading '${path}' failed: ${(e as Error).message}`);
  });

// ---- dry-run views (shared by the tools and the sync's batch, so plan digests match) ----

interface PushView {
  path: string;
  scriptRoot: string;
  local: string;
  size: number;
  localSha: string;
  serverSha?: string;
  expect: string;
}

function describePush(c: AtlassianClient, v: PushView) {
  return {
    dry_run: true as const,
    product: c.product,
    summary:
      `Push ${v.local} → ${v.path} (${v.size} bytes, sha256 ${short(v.localSha)}), ` +
      `${v.serverSha ? `replaces sha256 ${short(v.serverSha)}` : "new file"} — executable code that Jira uses at once`,
    request: {
      method: "PUT",
      url: c.url(`${SR}/idea/file`, { filePath: v.path, rootPath: v.scriptRoot }),
      body: `(${v.size} bytes from ${v.local}, sha256 ${v.localSha}; not shown)`,
    },
    identity: { op: "push-scriptrunner-script", path: v.path, scriptRoot: v.scriptRoot, local: v.local, localSha256: v.localSha, expect: v.expect },
    state: { serverSha256: v.serverSha ?? ABSENT },
    note: DRY_NOTE,
  };
}

interface PullView {
  path: string;
  scriptRoot: string;
  local: string;
  size: number;
  serverSha: string;
  localSha?: string;
  expect: string;
}

function describePull(c: AtlassianClient, v: PullView) {
  return {
    dry_run: true as const,
    product: c.product,
    summary:
      `Pull ${v.path} → ${v.local} (${v.size} bytes, sha256 ${short(v.serverSha)}), ` +
      `${v.localSha ? `replaces local sha256 ${short(v.localSha)} (backup kept)` : "new local file"}`,
    request: { method: "GET", url: c.url(`${SR}/idea/file`, { filePath: v.path, rootPath: v.scriptRoot }) },
    identity: { op: "pull-scriptrunner-script", path: v.path, scriptRoot: v.scriptRoot, local: v.local, serverSha256: v.serverSha, expect: v.expect },
    state: { localSha256: v.localSha ?? ABSENT },
    note: DRY_NOTE,
  };
}

// ---- tools ----

const scriptRootArg = z.string().min(1).optional().describe("Server Script Root path, when the path exists in several roots");
const shaOrAbsent = (what: string) =>
  z.string().regex(/^([0-9a-f]{64}|absent)$/, "a lowercase hex SHA-256 or 'absent'").describe(`SHA-256 the ${what} must still have, or 'absent' when it must not exist`);
const manifestArg = z.string().min(1).optional().describe(`Baseline manifest to update (default <local_dir>/${MANIFEST_NAME} when local_dir is given)`);
const localDirArg = z.string().min(1).optional().describe("Synchronized local folder that must contain local (default: local's own folder)");

const defaultManifest = (args: { manifest?: string; local_dir?: string }) =>
  args.manifest ? resolve(args.manifest) : args.local_dir ? join(resolve(args.local_dir), MANIFEST_NAME) : undefined;

async function push(ctx: ToolContext, args: Record<string, any>) {
  const path = validateRelative(args.path, "path");
  const c = ctx.client("jira");
  await requireScriptRunnerOperation(c, WRITE_OP, WRITE_LABEL);
  const { target } = await localFile(args as any);
  const local = await localSha(target);
  if (!local) throw new ValidationError(`${projectRelative(target)} does not exist`);
  const { tree, exists } = serverTreeFor(await loadScriptRoots(c), path, args.script_root);
  const serverSha = exists ? sha256(await readOrFail(c, tree.rootPath, path)) : undefined;
  const view = describePush(c, {
    path, scriptRoot: tree.rootPath, local: projectRelative(target), size: local.bytes.length, localSha: local.sha, serverSha, expect: args.expect_server_sha256,
  });
  if (serverSha === local.sha) return alreadySatisfied(view.summary, "Jira already has this content", { path, sha256: local.sha });
  if ((serverSha ?? ABSENT) !== args.expect_server_sha256) {
    throw new ValidationError(
      `Conflict: '${path}' on Jira has sha256 ${serverSha ?? ABSENT}, expected ${args.expect_server_sha256}; it changed after the preview. Re-run the sync`,
    );
  }
  if (args.dry_run !== false) return view;

  await writeScriptFile(c, tree.rootPath, path, local.bytes).catch((e) => {
    throw new ValidationError(`Uploading '${path}' failed: ${(e as Error).message}`);
  });
  const back = sha256(await readOrFail(c, tree.rootPath, path));
  if (back !== local.sha) {
    throw new VerificationError(`${view.summary}: Jira stores sha256 ${back} after the upload, not ${local.sha}`, { path, sha256: back });
  }
  const baseline = await tryRecord(defaultManifest(args), tree.rootPath, {
    path, local: projectRelative(target), size: local.bytes.length, sha256: local.sha, outcome: "PUSHED",
  });
  const { identity: _i, state: _s, note: _n, ...shown } = view;
  return { ...shown, dry_run: false, result: { path, scriptRoot: tree.rootPath, size: local.bytes.length, sha256: local.sha, outcome: "PUSHED", baseline } };
}

async function pull(ctx: ToolContext, args: Record<string, any>) {
  const path = validateRelative(args.path, "path");
  const c = ctx.client("jira");
  await requireScriptRunnerOperation(c, READ_OP, READ_LABEL);
  const { target } = await localFile(args as any);
  const { tree } = serverTreeFor(await loadScriptRoots(c), path, args.script_root);
  if (!tree.entries.get(path)) throw new ValidationError(`No file '${path}' in the Script Root`);
  const bytes = await readOrFail(c, tree.rootPath, path);
  const serverSha = sha256(bytes);
  const current = (await localSha(target))?.sha;
  const view = describePull(c, {
    path, scriptRoot: tree.rootPath, local: projectRelative(target), size: bytes.length, serverSha, localSha: current, expect: args.expect_local_sha256,
  });
  if (current === serverSha) return alreadySatisfied(view.summary, "the local file already has this content", { path, sha256: serverSha });
  if ((current ?? ABSENT) !== args.expect_local_sha256) {
    throw new ValidationError(
      `Conflict: ${projectRelative(target)} has sha256 ${current ?? ABSENT}, expected ${args.expect_local_sha256}; it changed after the preview. Re-run the sync`,
    );
  }
  if (args.dry_run !== false) return view;

  const written = await writeLocal(target, bytes, true);
  const backup = written.backup ? projectRelative(written.backup) : undefined;
  const baseline = await tryRecord(defaultManifest(args), tree.rootPath, {
    path, local: projectRelative(target), size: bytes.length, sha256: serverSha, outcome: "PULLED", ...(backup ? { backup } : {}),
  });
  const { identity: _i, state: _s, note: _n, ...shown } = view;
  return {
    ...shown,
    dry_run: false,
    result: { path, scriptRoot: tree.rootPath, local: projectRelative(target), size: bytes.length, sha256: serverSha, outcome: "PULLED", ...(backup ? { backup } : {}), baseline },
    note: SECRETS_NOTE,
  };
}

type BatchItem = { tool: string; args: Record<string, unknown>; value: ReturnType<typeof describePush> | ReturnType<typeof describePull> };

async function sync(ctx: ToolContext, args: Record<string, any>) {
  const root = validateRelative(args.root, "root");
  const maxFiles = args.max_files ?? DEFAULT_MAX_FILES;
  const maxBytes = args.max_total_bytes ?? DEFAULT_MAX_BYTES;
  const c = ctx.client("jira");
  await requireScriptRunnerOperation(c, READ_OP, READ_LABEL);
  const localDir = resolve(args.local_dir);
  try {
    if (!(await stat(localDir)).isDirectory()) throw new Error();
  } catch {
    throw new ValidationError(`local_dir ${projectRelative(localDir)} is not an existing directory`);
  }
  const manifestPath = resolve(args.manifest ?? join(localDir, MANIFEST_NAME));
  const { tree, files: serverFiles } = selectFolder(await loadScriptRoots(c), root, args.script_root);

  // local side: paths, refusals and size before any content is read
  const walked = await walkLocal(localDir, manifestPath);
  const toServer = (rel: string) => `${root}/${rel}`;
  const localByPath = new Map([...walked.files].map(([rel, abs]) => [toServer(rel), abs]));
  const failed = new Map([...walked.failed].map(([rel, why]) => [toServer(rel), why]));
  const all = [...new Set([...serverFiles, ...localByPath.keys(), ...failed.keys()])].sort();
  if (all.length > maxFiles) {
    throw new ValidationError(`'${root}' has ${all.length} local and server files, more than max_files=${maxFiles}; sync a subfolder or raise max_files (max ${MAX_FILES_CAP})`);
  }
  let localTotal = 0;
  for (const abs of localByPath.values()) localTotal += (await stat(abs)).size;
  if (localTotal > maxBytes) {
    throw new ValidationError(`${projectRelative(localDir)} is larger than max_total_bytes=${maxBytes}; sync a subfolder or raise max_total_bytes (max ${MAX_BYTES_CAP})`);
  }

  const { downloaded, readErrors } = await downloadFiles(c, tree.rootPath, serverFiles, maxBytes, root, "Sync");
  for (const [p, why] of readErrors) failed.set(p, why);
  const baseline = await loadBaseline(manifestPath, tree.rootPath);
  const localShas = new Map<string, { sha: string; size: number }>();
  for (const [p, abs] of localByPath) {
    try {
      const bytes = await readFile(abs);
      localShas.set(p, { sha: sha256(bytes), size: bytes.length });
    } catch (e) {
      failed.set(p, (e as NodeJS.ErrnoException).code ?? "read error");
    }
  }

  const writeVerified = await isScriptRunnerOperationVerified(c, WRITE_OP);
  const common = { local_dir: projectRelative(localDir), manifest: projectRelative(manifestPath), script_root: tree.rootPath };
  const classes = new Map<string, SyncClass>();
  const batch: BatchItem[] = [];
  let withoutBaseline = 0;
  for (const p of all) {
    if (failed.has(p)) {
      classes.set(p, "FAILED");
      continue;
    }
    const L = localShas.get(p);
    const bytes = downloaded.get(p);
    const S = bytes ? sha256(bytes) : undefined;
    const B = baseline.entries.get(p);
    const cls = classify(L?.sha, S, B);
    if (cls === "IN-SYNC" && B !== L!.sha) withoutBaseline++;
    if (cls === "PUSH" && writeVerified) {
      const local = projectRelative(localByPath.get(p)!);
      const expect = S ?? ABSENT;
      batch.push({
        tool: "jira_push_scriptrunner_script",
        args: { path: p, local, ...common, expect_server_sha256: expect },
        value: describePush(c, { path: p, scriptRoot: tree.rootPath, local, size: L!.size, localSha: L!.sha, serverSha: S, expect }),
      });
    }
    if (cls === "PULL") {
      let target: string;
      try {
        target = await localTarget(localDir, p.slice(root.length + 1));
      } catch (e) {
        failed.set(p, (e as Error).message);
        classes.set(p, "FAILED");
        continue;
      }
      const local = projectRelative(target);
      const expect = L?.sha ?? ABSENT;
      batch.push({
        tool: "jira_pull_scriptrunner_script",
        args: { path: p, local, ...common, expect_local_sha256: expect },
        value: describePull(c, { path: p, scriptRoot: tree.rootPath, local, size: bytes!.length, serverSha: S!, localSha: L?.sha, expect }),
      });
    }
    classes.set(p, cls);
  }
  // pushes first, then pulls, each in path order
  batch.sort((a, b) => (a.tool === b.tool ? 0 : a.tool === "jira_push_scriptrunner_script" ? -1 : 1));

  const counts: Record<string, number> = {};
  const paths: Record<string, string[]> = {};
  for (const [p, cls] of classes) {
    counts[cls] = (counts[cls] ?? 0) + 1;
    if (cls === "IN-SYNC") continue;
    const list = (paths[cls] ??= []);
    if (list.length < PATH_LIMIT) list.push(cls === "FAILED" ? `${p} (${failed.get(p)})` : p);
  }
  const pushes = batch.filter((b) => b.tool === "jira_push_scriptrunner_script").length;
  const pulls = batch.length - pushes;
  const summary =
    `Sync ${root} ↔ ${projectRelative(localDir)}: ${pushes} to push, ${pulls} to pull, ${counts.CONFLICT ?? 0} conflicts, ` +
    `${(counts["DELETED-LOCALLY"] ?? 0) + (counts["DELETED-ON-SERVER"] ?? 0)} deletions reported, ${counts["IN-SYNC"] ?? 0} in sync`;
  const hints: string[] = [];
  if (!baseline.exists) hints.push("No baseline manifest: files that differ are CONFLICT. Run jira_export_scriptrunner_scripts into this folder first to record one");
  else if (withoutBaseline) hints.push(`${withoutBaseline} in-sync files have no baseline yet; re-run jira_export_scriptrunner_scripts into this folder to record it`);
  if (baseline.note) hints.push(baseline.note);
  if (counts.CONFLICT) hints.push("Resolve conflicts locally (make the file equal to the server's or the intended version), then sync again");
  const info = {
    scriptRoot: tree.rootPath,
    root,
    localDir: projectRelative(localDir),
    manifest: projectRelative(manifestPath),
    counts,
    paths,
    ...(hints.length ? { hint: hints.join(". ") } : {}),
    ...(counts.PUSH && !writeVerified
      ? { pushNote: `Pushing is not verified for this Jira/ScriptRunner pair (${WRITE_OP}); PUSH files are listed but not offered` }
      : {}),
  };
  if (!batch.length) return alreadySatisfied(summary, "nothing to push or pull", info);
  if (args.dry_run !== false) {
    return { dry_run: true, product: c.product, summary, ...info, batch, request: batch[0]!.value.request, note: "Nothing was changed. Each file is confirmed on its own." };
  }
  // executed directly (not through the CLI's per-file checklist): run the items in order
  const items = [];
  for (const b of batch) {
    try {
      const r: any = await (b.tool === "jira_push_scriptrunner_script" ? push : pull)(ctx, { ...b.args, dry_run: false });
      items.push({ path: b.args.path, tool: b.tool, status: r?.already_satisfied ? "already-satisfied" : "done" });
    } catch (e) {
      items.push({ path: b.args.path, tool: b.tool, status: "failed", error: (e as Error).message });
    }
  }
  return { dry_run: false, product: c.product, summary, ...info, request: batch[0]!.value.request, result: { items } };
}

export const jiraScriptSyncTools: ToolDef[] = [
  {
    name: "jira_sync_scriptrunner_scripts",
    product: "jira",
    write: true,
    description:
      "Compare a local folder with a ScriptRunner Script Root folder by SHA-256 against the baseline manifest (written by " +
      "jira_export_scriptrunner_scripts) and plan the sync: PUSH (changed or new locally), PULL (changed or new on Jira), CONFLICT " +
      "(changed on both sides, or different without a baseline), DELETED-LOCALLY / DELETED-ON-SERVER (reported only; nothing is ever " +
      "deleted). The dry run reads only. With dry_run=false every push and pull is a separate item in the user's checklist. " +
      "Paths, sizes and SHA-256 only; file content is never shown.",
    inputShape: {
      root: z.string().min(1).describe("Folder relative to the Script Root, e.g. project-a"),
      local_dir: z.string().min(1).describe("Local folder holding that folder's contents, e.g. ./project-a"),
      manifest: z.string().min(1).optional().describe(`Baseline manifest (default <local_dir>/${MANIFEST_NAME})`),
      script_root: scriptRootArg,
      max_files: z.coerce.number().int().min(1).max(MAX_FILES_CAP).optional().describe(`Default ${DEFAULT_MAX_FILES}, max ${MAX_FILES_CAP}`),
      max_total_bytes: z.coerce.number().int().min(1).max(MAX_BYTES_CAP).optional().describe(`Default ${DEFAULT_MAX_BYTES}, max ${MAX_BYTES_CAP}`),
      ...dryRunShape,
    },
    handler: sync,
  },
  {
    name: "jira_push_scriptrunner_script",
    product: "jira",
    write: true,
    description:
      "Upload one local file to the ScriptRunner Script Root (it becomes live code at once). Only when the server file still has " +
      "expect_server_sha256 ('absent' for a new file), otherwise a conflict; reads the file back and verifies its SHA-256, then " +
      "updates the baseline manifest. Usually planned by jira_sync_scriptrunner_scripts. Never deletes. File content is never shown.",
    inputShape: {
      path: z.string().min(1).describe("File path relative to the Script Root, e.g. project-a/jobs/close.groovy"),
      local: z.string().min(1).describe("Local file to upload"),
      local_dir: localDirArg,
      expect_server_sha256: shaOrAbsent("server file"),
      manifest: manifestArg,
      script_root: scriptRootArg,
      ...dryRunShape,
    },
    handler: push,
  },
  {
    name: "jira_pull_scriptrunner_script",
    product: "jira",
    write: true,
    description:
      "Replace one local file with the ScriptRunner Script Root file, only when the local file still has expect_local_sha256 " +
      "('absent' for a new local file), otherwise a conflict. Backs the old file up to <file>.bak-<timestamp> and updates the " +
      "baseline manifest. Read-only toward Jira. Usually planned by jira_sync_scriptrunner_scripts. File content is never shown.",
    inputShape: {
      path: z.string().min(1).describe("File path relative to the Script Root"),
      local: z.string().min(1).describe("Local file to write"),
      local_dir: localDirArg,
      expect_local_sha256: shaOrAbsent("local file"),
      manifest: manifestArg,
      script_root: scriptRootArg,
      ...dryRunShape,
    },
    handler: pull,
  },
];
