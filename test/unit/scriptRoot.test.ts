import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { runToolByName } from "../../src/runner.js";
import { SUPPORT_MATRIX } from "../../src/tools/jira/scriptrunner.js";
import { validateRelative } from "../../src/tools/jira/scriptRoot.js";
import { testContext, type Call } from "./helpers.js";

const fx = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/scriptrunner/${name}.json`, import.meta.url), "utf8"));
const path = (c: Call) => new URL(c.url).pathname;
const R1 = "/var/scriptroot/scripts";
const R2 = "/var/scriptroot/extra";
const FILES: Record<string, string> = fx("script-files");
const bytesOf = (root: string, p: string) => Buffer.from(FILES[`${root}|${p}`]!, "base64");
const MARKERS = ["MARKER_SOURCE", "MARKER_SECRET", "log.info", "class Helper", "token="];

/** Fake Jira + ScriptRunner Script Editor; `fail` answers an error for the listed paths. */
function fakeSr(opts: { jira?: string; sr?: string; fail?: Record<string, number> } = {}) {
  const responder = (c: Call) => {
    const p = path(c);
    const q = new URL(c.url).searchParams;
    if (p === "/rest/api/2/serverInfo") return { body: { version: opts.jira ?? "11.3.7" } };
    if (p === "/rest/plugins/1.0/com.onresolve.jira.groovy.groovyrunner-key") return { body: { key: "x", version: opts.sr ?? "10.14.0", enabled: true } };
    if (p === "/rest/scriptrunner/latest/idea/scriptroots") return { body: fx("scriptroots") };
    if (p === "/rest/scriptrunner/latest/idea/file") {
      const key = `${q.get("rootPath")}|${q.get("filePath")}`;
      const status = opts.fail?.[q.get("filePath")!];
      if (status) return { status, body: { errorMessages: ["echo MARKER_SOURCE_X from body"] } };
      if (!(key in FILES)) return { status: 404, body: "" };
      return { body: { content: FILES[key], isDefaultRoot: q.get("rootPath") === R1, rootPath: q.get("rootPath") } };
    }
    return undefined;
  };
  return { responder };
}

async function run(name: string, args: Record<string, unknown>, responder: (c: Call) => any) {
  const { ctx, calls } = testContext(responder);
  const res = await runToolByName(name, args, ctx);
  return { res, value: res.ok ? (res.value as any) : undefined, error: res.ok ? undefined : (res as any).error, calls };
}

const noContent = (v: unknown) => {
  const text = typeof v === "string" ? v : JSON.stringify(v);
  for (const m of MARKERS) assert.ok(!text.includes(m), `leaks '${m}': ${text.slice(0, 300)}`);
};
const onlyGets = (calls: Call[]) => assert.deepEqual([...new Set(calls.map((c) => c.method))], ["GET"]);
const tmp = () => mkdtempSync(join(tmpdir(), "sr-export-"));

describe("Script Root export", () => {
  it("allows Script Root export for all supported major combinations", async () => {
    for (const jira of ["10.0.0", "10.99.99", "11.0.0", "11.99.99"]) {
      for (const sr of ["9.0.0", "9.99.99", "10.0.0", "10.99.99"]) {
        const r = await run("jira_export_scriptrunner_scripts", { root: "project-a", output_dir: tmp() }, fakeSr({ jira, sr }).responder);
        assert.ok(r.res.ok, `${jira} + ${sr}: ${JSON.stringify(r.error)}`);
        onlyGets(r.calls);
      }
    }
  });

  describe("gate (1.3)", () => {
    it("refuses unsupported majors and an allowed pair without the operation before any ScriptRunner request", async () => {
      const other = await run("jira_export_scriptrunner_scripts", { root: "project-a", output_dir: tmp() }, fakeSr({ sr: "11.0.0" }).responder);
      assert.equal(other.error.type, "Unsupported");
      assert.ok(!other.calls.some((c) => path(c).startsWith("/rest/scriptrunner")));
      const entry = SUPPORT_MATRIX[0]!;
      const ops = entry.operations.splice(0);
      try {
        const r = await run("jira_get_scriptrunner_script", { path: "project-a/jobs/close.groovy", out: join(tmp(), "a") }, fakeSr().responder);
        assert.equal(r.error.type, "Unsupported");
        assert.match(r.error.message, /not verified/);
        assert.ok(!r.calls.some((c) => path(c).startsWith("/rest/scriptrunner")));
      } finally {
        entry.operations.push(...ops);
      }
    });
  });

  describe("path safety (2.2)", () => {
    it("refuses absolute paths, '..', '.', empty segments, NUL and backslashes", () => {
      for (const bad of ["/opt/scripts/a.groovy", "../etc/passwd", "project-a/../../x.groovy", "project-a/./a", "a//b", "a\0b", "a\\b", "C:/x"]) {
        assert.throws(() => validateRelative(bad, "path"), /must|empty|NUL/, bad);
      }
      assert.equal(validateRelative("project-a/jobs/", "root"), "project-a/jobs");
    });

    it("refuses traversal before any request to Jira, and directories by name", async () => {
      const r = await run("jira_get_scriptrunner_script", { path: "../etc/passwd", out: join(tmp(), "x") }, fakeSr().responder);
      assert.equal(r.error.type, "ValidationError");
      assert.equal(r.calls.length, 0);
      const dir = await run("jira_get_scriptrunner_script", { path: "project-a/jobs", out: join(tmp(), "x") }, fakeSr().responder);
      assert.match(dir.error.message, /'project-a\/jobs' is a directory/);
    });

    it("does not follow a local symbolic link out of output_dir", async () => {
      const out = tmp();
      const outside = tmp();
      symlinkSync(outside, join(out, "jobs"));
      const r = await run("jira_export_scriptrunner_scripts", { root: "project-a", output_dir: out }, fakeSr().responder);
      assert.ok(r.res.ok, JSON.stringify(r.error));
      assert.equal(readdirSync(outside).length, 0, "nothing written through the link");
      const m = JSON.parse(readFileSync(r.value.manifest, "utf8"));
      assert.equal(m.files.find((f: any) => f.path === "project-a/jobs/close.groovy").outcome, "FAILED");
    });
  });

  describe("jira_get_scriptrunner_script (3.1)", () => {
    it("writes one file byte for byte and shows metadata only", async () => {
      const out = join(tmp(), "project-a", "lib", "Helper.groovy");
      const r = await run("jira_get_scriptrunner_script", { path: "project-a/lib/Helper.groovy", out }, fakeSr().responder);
      assert.ok(r.res.ok, JSON.stringify(r.error));
      assert.deepEqual(readFileSync(out), bytesOf(R1, "project-a/lib/Helper.groovy"));
      assert.ok(readFileSync(out).includes(Buffer.from("\r\n")), "CRLF kept");
      assert.deepEqual(Object.keys(r.value).sort(), ["note", "out", "outcome", "path", "scriptRoot", "sha256", "size"]);
      assert.equal(r.value.outcome, "WRITTEN");
      noContent(r.value);
      onlyGets(r.calls);
      assert.equal((await run("jira_get_scriptrunner_script", { path: "project-a/lib/Helper.groovy", out }, fakeSr().responder)).value.outcome, "ALREADY-SATISFIED");
      writeFileSync(out, "local edit");
      const conflict = await run("jira_get_scriptrunner_script", { path: "project-a/lib/Helper.groovy", out }, fakeSr().responder);
      assert.equal(conflict.value.outcome, "CONFLICT");
      assert.equal(readFileSync(out, "utf8"), "local edit");
    });

    it("reports a failed read with the status only, never the response body", async () => {
      const r = await run("jira_get_scriptrunner_script", { path: "project-a/jobs/close.groovy", out: join(tmp(), "a") }, fakeSr({ fail: { "project-a/jobs/close.groovy": 500 } }).responder);
      assert.match(r.error.message, /HTTP 500/);
      noContent(r.error);
    });

    it("asks for script_root when a path exists in several roots", async () => {
      const r = await run("jira_export_scriptrunner_scripts", { root: "shared", output_dir: tmp(), script_root: R1 }, fakeSr().responder);
      assert.match(r.error.message, /No folder 'shared'/);
      const ok = await run("jira_export_scriptrunner_scripts", { root: "shared", output_dir: tmp() }, fakeSr().responder);
      assert.equal(ok.value.scriptRoot, R2);
    });
  });

  describe("jira_export_scriptrunner_scripts (3.2)", () => {
    it("restores a folder with nested paths, Unicode names, BOM and CRLF, then re-runs as already satisfied", async () => {
      const out = tmp();
      const r = await run("jira_export_scriptrunner_scripts", { root: "project-a", output_dir: out }, fakeSr().responder);
      assert.ok(r.res.ok, JSON.stringify(r.error));
      assert.deepEqual(r.value.counts, { WRITTEN: 4 });
      for (const p of ["project-a/jobs/close.groovy", "project-a/lib/Helper.groovy", "project-a/отчёт.groovy", "project-a/conf/app.properties"]) {
        assert.deepEqual(readFileSync(join(out, p.slice("project-a/".length))), bytesOf(R1, p), p);
      }
      assert.ok(!readdirSync(out).includes("x.groovy"), "files outside root are not exported");
      assert.deepEqual(readdirSync(join(out, "empty")), [], "empty registry directory is restored");
      const manifest = readFileSync(r.value.manifest, "utf8");
      noContent(manifest);
      noContent(r.value);
      onlyGets(r.calls);
      const m = JSON.parse(manifest);
      assert.deepEqual(Object.keys(m.files[0]).sort(), ["local", "outcome", "path", "sha256", "size"]);
      assert.equal(isAbsolute(m.outputDir), false, "manifest outputDir is project-relative");
      assert.deepEqual(m.directories.find((d: any) => d.path === "project-a/empty"), {
        path: "project-a/empty",
        local: join(m.outputDir, "empty").split("\\").join("/"),
        outcome: "CREATED",
      });
      assert.ok(m.files.every((f: any) => !isAbsolute(f.local)), "manifest local paths are project-relative");
      assert.equal(resolve(m.outputDir), out);
      assert.ok(m.files.every((f: any) => resolve(f.local).startsWith(out)), "relative local paths resolve to exported files");
      const again = await run("jira_export_scriptrunner_scripts", { root: "project-a", output_dir: out }, fakeSr().responder);
      assert.deepEqual(again.value.counts, { "ALREADY-SATISFIED": 4 });
    });

    it("keeps a differing local file as CONFLICT, and with overwrite backs it up before replacing", async () => {
      const out = tmp();
      mkdirSync(join(out, "jobs"));
      writeFileSync(join(out, "jobs", "close.groovy"), "local version");
      const r = await run("jira_export_scriptrunner_scripts", { root: "project-a", output_dir: out }, fakeSr().responder);
      assert.deepEqual(r.value.counts, { CONFLICT: 1, WRITTEN: 3 });
      assert.deepEqual(r.value.conflicts, ["project-a/jobs/close.groovy"]);
      assert.equal(readFileSync(join(out, "jobs", "close.groovy"), "utf8"), "local version");
      const o = await run("jira_export_scriptrunner_scripts", { root: "project-a", output_dir: out, overwrite: true }, fakeSr().responder);
      assert.deepEqual(o.value.counts, { REPLACED: 1, "ALREADY-SATISFIED": 3 });
      const entry = JSON.parse(readFileSync(o.value.manifest, "utf8")).files.find((f: any) => f.outcome === "REPLACED");
      assert.equal(isAbsolute(entry.backup), false, "manifest backup path is project-relative");
      assert.equal(readFileSync(entry.backup, "utf8"), "local version");
      assert.deepEqual(readFileSync(join(out, "jobs", "close.groovy")), bytesOf(R1, "project-a/jobs/close.groovy"));
    });

    it("refuses before reading content over the file limit, and writes nothing over the byte limit", async () => {
      const r = await run("jira_export_scriptrunner_scripts", { root: "project-a", output_dir: tmp(), max_files: 3 }, fakeSr().responder);
      assert.match(r.error.message, /4 files, more than max_files=3/);
      assert.ok(!r.calls.some((c) => path(c).endsWith("/idea/file")));
      const out = join(tmp(), "dest");
      const b = await run("jira_export_scriptrunner_scripts", { root: "project-a", output_dir: out, max_total_bytes: 40 }, fakeSr().responder);
      assert.match(b.error.message, /larger than max_total_bytes=40.*nothing was written/);
      noContent(b.error);
      assert.ok(!existsSync(out), "nothing written, not even the output directory or a manifest");
    });

    it("marks a file FAILED with the HTTP status only and exports the rest", async () => {
      const r = await run("jira_export_scriptrunner_scripts", { root: "project-a", output_dir: tmp() }, fakeSr({ fail: { "project-a/conf/app.properties": 403 } }).responder);
      assert.deepEqual(r.value.counts, { FAILED: 1, WRITTEN: 3 });
      assert.deepEqual(r.value.failed, ["project-a/conf/app.properties (HTTP 403)"]);
      noContent(r.value);
      noContent(readFileSync(r.value.manifest, "utf8"));
    });
  });
});
