/**
 * ScriptRunner Script Root files: copy one file or a folder to local disk, byte for byte.
 *
 * Uses the Script Editor's own read resources (internal, allowed by the Jira/ScriptRunner support matrix):
 * `GET idea/scriptroots` (an array, per root: `{info: {rootPath, defaultRoot}, files: {relativePath:
 * {isFile, rootPath, lastModified}}}`, no sizes) and `GET idea/file?filePath=&rootPath=`
 * (`{content: base64, isDefaultRoot, rootPath}`; 404 for a missing file, 400 for a directory). The same file URL also saves
 * (PUT) and deletes (DELETE) files, so this module only ever calls `client.get`.
 *
 * Source never leaves the tool except into the local files the caller named: results, errors and
 * the manifest carry paths, sizes, SHA-256 and outcomes only. Scripts are never run.
 */

import { createHash, randomBytes } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { AtlassianClient } from "../../client.js";
import { isHttpStatusError, ValidationError } from "../../errors.js";
import type { ToolDef } from "../types.js";
import { boolArg } from "../util.js";
import { requireScriptRunnerOperation } from "./scriptrunner.js";

const SR = "/rest/scriptrunner/latest";
const OPERATION = "script-root-read";
const LABEL = "Reading ScriptRunner Script Root files";
export const DEFAULT_MAX_FILES = 500;
export const MAX_FILES_CAP = 5000;
export const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
export const MAX_BYTES_CAP = 200 * 1024 * 1024;
export const MANIFEST_NAME = "scriptrunner-export-manifest.json";
export const SECRETS_NOTE = "Restored scripts may contain credentials, SQL and internal URLs: review them before committing or sharing.";

export type Outcome = "WRITTEN" | "ALREADY-SATISFIED" | "CONFLICT" | "REPLACED" | "FAILED";

export interface ScriptRootTree {
  rootPath: string;
  defaultRoot: boolean;
  /** relative path → is a file (false: directory) */
  entries: Map<string, boolean>;
}

/** A file read failed; the message never carries the response body. */
export class ScriptReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScriptReadError";
  }
}

// ---- server reads (GET only) ----

export async function loadScriptRoots(client: AtlassianClient): Promise<ScriptRootTree[]> {
  const data = await client.get(`${SR}/idea/scriptroots`, { showDirectories: true, groovyFilesOnly: false });
  // a bare array on Jira 11.3.7 + ScriptRunner 10.14.0 (the editor's fetch helper wraps it as `result`)
  const roots: any[] = Array.isArray(data) ? data : Array.isArray(data?.result) ? data.result : [];
  if (!roots.length) throw new ValidationError("ScriptRunner reported no Script Root");
  return roots.map((r) => {
    if (typeof r?.info?.rootPath !== "string" || typeof r?.files !== "object" || r.files === null) {
      throw new ValidationError("ScriptRunner's Script Root tree has an unexpected shape; refusing to read files");
    }
    const entries = new Map<string, boolean>();
    for (const [rel, meta] of Object.entries<any>(r.files)) entries.set(rel, Boolean(meta?.isFile));
    return { rootPath: r.info.rootPath, defaultRoot: Boolean(r.info.defaultRoot), entries };
  });
}

/** One file's bytes. Errors name the HTTP status only (the body could echo content). */
export async function readScriptFile(client: AtlassianClient, rootPath: string, relativePath: string): Promise<Buffer> {
  let data: any;
  try {
    data = await client.get(`${SR}/idea/file`, { filePath: relativePath, rootPath });
  } catch (e) {
    if (isHttpStatusError(e)) throw new ScriptReadError(`HTTP ${e.status}`);
    throw new ScriptReadError((e as Error)?.name || "read error");
  }
  const b64 = data?.content ?? data?.result?.content;
  if (typeof b64 !== "string" || !/^[A-Za-z0-9+/\r\n]*={0,2}\s*$/.test(b64)) throw new ScriptReadError("unexpected response shape");
  return Buffer.from(b64, "base64");
}

/**
 * Download `files` into memory, sequentially. Jira reports no sizes, so this happens before anything is
 * written: past `maxBytes` it refuses, and the caller writes nothing at all. Failed reads are collected.
 */
export async function downloadFiles(client: AtlassianClient, rootPath: string, files: string[], maxBytes: number, root: string, verb: string) {
  const downloaded = new Map<string, Buffer>();
  const readErrors = new Map<string, string>();
  let total = 0;
  for (const path of files) {
    try {
      const bytes = await readScriptFile(client, rootPath, path);
      total += bytes.length;
      if (total > maxBytes) {
        throw new ValidationError(
          `'${root}' is larger than max_total_bytes=${maxBytes} (passed after ${downloaded.size + 1} of ${files.length} files); ` +
            `nothing was written. ${verb} a subfolder or raise max_total_bytes (max ${MAX_BYTES_CAP})`,
        );
      }
      downloaded.set(path, bytes);
    } catch (e) {
      if (!(e instanceof ScriptReadError)) throw e;
      readErrors.set(path, e.message);
    }
  }
  return { downloaded, readErrors, total };
}

// ---- paths ----

/** A relative POSIX path inside the Script Root, normalized; refuses anything that could leave it. */
export function validateRelative(value: string, label: string): string {
  const v = String(value ?? "");
  if (!v.trim()) throw new ValidationError(`${label} is empty`);
  if (v.includes("\0")) throw new ValidationError(`${label} contains a NUL character`);
  if (v.includes("\\")) throw new ValidationError(`${label} must use '/' separators`);
  if (v.startsWith("/") || /^[A-Za-z]:/.test(v)) throw new ValidationError(`${label} must be relative to the Script Root, not absolute`);
  const segments = v.replace(/\/+$/, "").split("/");
  for (const s of segments) {
    if (s === "..") throw new ValidationError(`${label} must not contain '..'`);
    if (s === "." || s === "") throw new ValidationError(`${label} must not contain empty or '.' segments`);
  }
  return segments.join("/");
}

export const isUnder = (child: string, parent: string) => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

/** Portable path relative to the project/current working directory for manifests. */
export const projectRelative = (path: string): string => relative(process.cwd(), path).split(sep).join("/") || ".";

/** The deepest existing ancestor of `p`, resolved through symbolic links. */
async function realAncestor(p: string): Promise<string> {
  for (let cur = p; ; cur = dirname(cur)) {
    try {
      return await realpath(cur);
    } catch {
      if (dirname(cur) === cur) return cur;
    }
  }
}

/** Local path of a server file under output_dir; refuses names or symbolic links that would leave it. */
export async function localTarget(outputDir: string, relative: string): Promise<string> {
  const rel = validateRelative(relative, "server path");
  const base = resolve(outputDir);
  const target = resolve(base, ...rel.split("/"));
  if (!isUnder(target, base)) throw new ValidationError("server path leaves output_dir");
  const realBase = await realpath(base);
  if (!isUnder(await realAncestor(dirname(target)), realBase)) throw new ValidationError("a symbolic link would redirect the write outside output_dir");
  return target;
}

/** Create one registry directory without following an existing link outside output_dir. */
async function ensureLocalDirectory(outputDir: string, relative: string): Promise<{ target: string; outcome: "CREATED" | "ALREADY-SATISFIED" }> {
  const target = await localTarget(outputDir, relative);
  let existing: Awaited<ReturnType<typeof lstat>> | undefined;
  try {
    existing = await lstat(target);
  } catch {
    existing = undefined;
  }
  if (existing && !existing.isDirectory()) throw new ValidationError("the local directory path exists and is not a directory");
  const outcome = existing ? "ALREADY-SATISFIED" : "CREATED";
  if (!existing) await mkdir(target, { recursive: true });
  const realBase = await realpath(resolve(outputDir));
  if (!isUnder(await realpath(target), realBase)) throw new ValidationError("a symbolic link would redirect the directory outside output_dir");
  return { target, outcome };
}

// ---- local writes ----

export const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

export async function atomicWrite(target: string, bytes: Buffer): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  const tmp = join(dirname(target), `.${basename(target)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  try {
    await writeFile(tmp, bytes, { flag: "wx" });
    await rename(tmp, target);
  } catch (e) {
    await unlink(tmp).catch(() => undefined);
    throw e;
  }
}

/** Write unless an identical file exists; a different file is a conflict, or with overwrite backed up and replaced. */
export async function writeLocal(target: string, bytes: Buffer, overwrite: boolean): Promise<{ outcome: Outcome; backup?: string }> {
  let existing: Awaited<ReturnType<typeof lstat>> | undefined;
  try {
    existing = await lstat(target);
  } catch {
    existing = undefined;
  }
  if (!existing) {
    await atomicWrite(target, bytes);
    return { outcome: "WRITTEN" };
  }
  if (!existing.isFile()) throw new ValidationError("the local path exists and is not a regular file");
  if (sha256(await readFile(target)) === sha256(bytes)) return { outcome: "ALREADY-SATISFIED" };
  if (!overwrite) return { outcome: "CONFLICT" };
  const backup = `${target}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  await copyFile(target, backup, constants.COPYFILE_EXCL);
  await atomicWrite(target, bytes);
  return { outcome: "REPLACED", backup };
}

// ---- selection ----

export function pickRoots(roots: ScriptRootTree[], scriptRoot: string | undefined): ScriptRootTree[] {
  if (scriptRoot === undefined) return roots;
  const hit = roots.filter((r) => r.rootPath === scriptRoot);
  if (!hit.length) throw new ValidationError(`No Script Root '${scriptRoot}'; roots: ${roots.map((r) => r.rootPath).join(", ")}`);
  return hit;
}

export const hasDescendants = (r: ScriptRootTree, dir: string) => [...r.entries.keys()].some((k) => k.startsWith(`${dir}/`));

export function single<T extends ScriptRootTree>(matches: T[], what: string): T {
  if (matches.length > 1) {
    throw new ValidationError(`${what} exists in several Script Roots (${matches.map((r) => r.rootPath).join(", ")}); pass script_root`);
  }
  return matches[0]!;
}

export function findFile(roots: ScriptRootTree[], path: string, scriptRoot?: string): ScriptRootTree {
  const candidates = pickRoots(roots, scriptRoot);
  const asFile = candidates.filter((r) => r.entries.get(path) === true);
  if (asFile.length) return single(asFile, `'${path}'`);
  if (candidates.some((r) => r.entries.get(path) === false || hasDescendants(r, path))) throw new ValidationError(`'${path}' is a directory, not a file`);
  throw new ValidationError(`No file '${path}' in the Script Root`);
}

export function selectFolder(
  roots: ScriptRootTree[],
  root: string,
  scriptRoot?: string,
): { tree: ScriptRootTree; files: string[]; directories: string[] } {
  const candidates = pickRoots(roots, scriptRoot);
  if (candidates.some((r) => r.entries.get(root) === true)) throw new ValidationError(`'${root}' is a file; use jira_get_scriptrunner_script`);
  const withFolder = candidates.filter((r) => r.entries.get(root) === false || hasDescendants(r, root));
  if (!withFolder.length) throw new ValidationError(`No folder '${root}' in the Script Root`);
  const tree = single(withFolder, `Folder '${root}'`);
  const files = [...tree.entries].filter(([k, isFile]) => isFile && k.startsWith(`${root}/`)).map(([k]) => k).sort();
  const directories = [...tree.entries]
    .filter(([k, isFile]) => !isFile && k.startsWith(`${root}/`))
    .map(([k]) => k)
    .sort();
  return { tree, files, directories };
}

// ---- tools ----

const scriptRootArg = z.string().min(1).optional().describe("Server Script Root path, when the path exists in several roots");

export const jiraScriptRootTools: ToolDef[] = [
  {
    name: "jira_get_scriptrunner_script",
    product: "jira",
    description:
      "Copy one ScriptRunner Script Root file (path relative to the Script Root) to the local file `out`, byte for byte. " +
      "Returns only path, size, SHA-256 and outcome (WRITTEN, ALREADY-SATISFIED, CONFLICT); the content is never shown. " +
      "Read-only toward Jira.",
    inputShape: {
      path: z.string().min(1).describe("File path relative to the Script Root, e.g. project-a/jobs/close.groovy"),
      out: z.string().min(1).describe("Local file to write (required)"),
      script_root: scriptRootArg,
    },
    async handler({ client }, args) {
      const path = validateRelative(args.path, "path");
      const c = client("jira");
      await requireScriptRunnerOperation(c, OPERATION, LABEL);
      const tree = findFile(await loadScriptRoots(c), path, args.script_root);
      const bytes = await readScriptFile(c, tree.rootPath, path).catch((e) => {
        throw new ValidationError(`Reading '${path}' failed: ${(e as Error).message}`);
      });
      const out = resolve(args.out);
      const { outcome } = await writeLocal(out, bytes, false);
      return {
        path,
        scriptRoot: tree.rootPath,
        out,
        size: bytes.length,
        sha256: sha256(bytes),
        outcome,
        ...(outcome === "CONFLICT" ? { hint: "The local file differs and was kept; use jira_export_scriptrunner_scripts overwrite=true to replace it with a backup" } : {}),
        note: SECRETS_NOTE,
      };
    },
  },
  {
    name: "jira_export_scriptrunner_scripts",
    product: "jira",
    description:
      "Restore a ScriptRunner Script Root folder to a local directory: every file under `root`, with its nested folders, " +
      "including empty registry folders, byte for byte. Existing identical files → ALREADY-SATISFIED; different ones → CONFLICT (kept) unless overwrite=true, " +
      "which backs them up first. Writes a manifest (path, size, SHA-256, outcome); content is never shown. Read-only toward Jira.",
    inputShape: {
      root: z.string().min(1).describe("Folder relative to the Script Root, e.g. project-a"),
      output_dir: z.string().min(1).describe("Local directory; the folder's contents are recreated inside it"),
      overwrite: boolArg.optional().describe("Default false. true replaces differing local files after a .bak-<timestamp> backup"),
      manifest: z.string().min(1).optional().describe(`Manifest file (default <output_dir>/${MANIFEST_NAME})`),
      script_root: scriptRootArg,
      max_files: z.coerce.number().int().min(1).max(MAX_FILES_CAP).optional().describe(`Default ${DEFAULT_MAX_FILES}, max ${MAX_FILES_CAP}`),
      max_total_bytes: z.coerce.number().int().min(1).max(MAX_BYTES_CAP).optional()
        .describe(`Default ${DEFAULT_MAX_BYTES}, max ${MAX_BYTES_CAP}. Over it, the export writes nothing`),
    },
    async handler({ client }, args) {
      const root = validateRelative(args.root, "root");
      const maxFiles = args.max_files ?? DEFAULT_MAX_FILES;
      const maxBytes = args.max_total_bytes ?? DEFAULT_MAX_BYTES;
      const c = client("jira");
      await requireScriptRunnerOperation(c, OPERATION, LABEL);
      const { tree, files, directories } = selectFolder(await loadScriptRoots(c), root, args.script_root);
      if (files.length > maxFiles) {
        throw new ValidationError(`'${root}' has ${files.length} files, more than max_files=${maxFiles}; export a subfolder or raise max_files (max ${MAX_FILES_CAP})`);
      }
      const outputDir = resolve(args.output_dir);
      const { downloaded, readErrors, total } = await downloadFiles(c, tree.rootPath, files, maxBytes, root, "Export");
      await mkdir(outputDir, { recursive: true });
      const directoryEntries: Array<Record<string, unknown>> = [];
      for (const path of directories) {
        const entry: Record<string, unknown> = { path };
        directoryEntries.push(entry);
        try {
          const { target, outcome } = await ensureLocalDirectory(outputDir, path.slice(root.length + 1));
          Object.assign(entry, { local: projectRelative(target), outcome });
        } catch (e) {
          const err = e as NodeJS.ErrnoException;
          Object.assign(entry, { outcome: "FAILED", error: e instanceof ValidationError ? err.message : (err.code ?? err.name) });
        }
      }
      const entries: Array<Record<string, unknown>> = [];
      for (const path of files) {
        const entry: Record<string, unknown> = { path };
        entries.push(entry);
        const bytes = downloaded.get(path);
        if (!bytes) {
          Object.assign(entry, { outcome: "FAILED", error: readErrors.get(path) });
          continue;
        }
        try {
          const local = await localTarget(outputDir, path.slice(root.length + 1));
          entry.local = projectRelative(local);
          const written = await writeLocal(local, bytes, Boolean(args.overwrite));
          if (written.backup) written.backup = projectRelative(written.backup);
          Object.assign(entry, { size: bytes.length, sha256: sha256(bytes), ...written });
        } catch (e) {
          // own messages only: path checks or the file system error code
          const err = e as NodeJS.ErrnoException;
          Object.assign(entry, { outcome: "FAILED", error: e instanceof ValidationError ? err.message : (err.code ?? err.name) });
        }
      }
      const counts: Record<string, number> = {};
      for (const e of entries) counts[String(e.outcome)] = (counts[String(e.outcome)] ?? 0) + 1;
      const directoryCounts: Record<string, number> = {};
      for (const e of directoryEntries) directoryCounts[String(e.outcome)] = (directoryCounts[String(e.outcome)] ?? 0) + 1;
      const manifestPath = resolve(args.manifest ?? join(outputDir, MANIFEST_NAME));
      const manifest = {
        exportedAt: new Date().toISOString(),
        scriptRoot: tree.rootPath,
        root,
        outputDir: projectRelative(outputDir),
        overwrite: Boolean(args.overwrite),
        limits: { maxFiles, maxTotalBytes: maxBytes },
        counts,
        directoryCounts,
        directories: directoryEntries,
        files: entries,
      };
      await atomicWrite(manifestPath, Buffer.from(JSON.stringify(manifest, null, 2) + "\n"));
      const pick = (o: string) => entries.filter((e) => e.outcome === o).map((e) => (o === "FAILED" ? `${e.path} (${e.error})` : String(e.path)));
      return {
        root,
        scriptRoot: tree.rootPath,
        outputDir,
        manifest: manifestPath,
        directories: directories.length,
        directoryCounts,
        files: files.length,
        bytes: total,
        counts,
        conflicts: pick("CONFLICT").slice(0, 20),
        failed: pick("FAILED").slice(0, 20),
        note: SECRETS_NOTE,
      };
    },
  },
];
