import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { addResultToPlan, applyPlan, readPlan } from "../../src/plan.js";
import { runToolByName } from "../../src/runner.js";
import { SUPPORT_MATRIX } from "../../src/tools/jira/scriptrunner.js";
import { sha256 } from "../../src/tools/jira/scriptRoot.js";
import { classify, loadBaseline, recordBaseline, walkLocal } from "../../src/tools/jira/scriptSync.js";
import { testContext, type Call } from "./helpers.js";

const fx = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/scriptrunner/${name}.json`, import.meta.url), "utf8"));
const path = (c: Call) => new URL(c.url).pathname;
const R1 = "/var/scriptroot/scripts";
const MARKERS = ["MARKER_SOURCE", "MARKER_SECRET", "log.info", "class Helper", "token="];
const MANIFEST = "scriptrunner-export-manifest.json";
const CLOSE = "project-a/jobs/close.groovy";
const HELPER = "project-a/lib/Helper.groovy";

/**
 * Fake Jira + ScriptRunner Script Editor that keeps its files, so a PUT changes what later reads see.
 * `putFail` answers the upload with that status; `mangle` stores different bytes than were sent.
 */
function fakeSr(opts: { jira?: string; sr?: string; putFail?: number; mangle?: boolean } = {}) {
  const files = new Map<string, string>(Object.entries(fx("script-files") as Record<string, string>));
  const roots: any[] = fx("scriptroots");
  const responder = (c: Call) => {
    const p = path(c);
    const q = new URL(c.url).searchParams;
    if (p === "/rest/api/2/serverInfo") return { body: { version: opts.jira ?? "11.3.7" } };
    if (p === "/rest/plugins/1.0/com.onresolve.jira.groovy.groovyrunner-key") return { body: { key: "x", version: opts.sr ?? "10.14.0", enabled: true } };
    if (p === "/rest/scriptrunner/latest/idea/scriptroots") return { body: roots };
    if (p === "/rest/scriptrunner/latest/idea/file") {
      const rootPath = q.get("rootPath")!;
      const key = `${rootPath}|${q.get("filePath")}`;
      if (c.method === "PUT") {
        if (opts.putFail) return { status: opts.putFail, body: { errorMessages: ["echo MARKER_SOURCE_X from body"] } };
        const sent = Buffer.from(String(c.body), "base64");
        files.set(key, (opts.mangle ? Buffer.concat([sent, Buffer.from("\n")]) : sent).toString("base64"));
        roots.find((r) => r.info.rootPath === rootPath).files[q.get("filePath")!] = { isFile: true, rootPath, lastModified: 1 };
        return { status: 204, body: "" };
      }
      if (!files.has(key)) return { status: 404, body: "" };
      return { body: { content: files.get(key), isDefaultRoot: rootPath === R1, rootPath } };
    }
    return undefined;
  };
  const server = (p: string, root = R1) => Buffer.from(files.get(`${root}|${p}`)!, "base64");
  const setServer = (p: string, text: string) => files.set(`${R1}|${p}`, Buffer.from(text).toString("base64"));
  return { responder, server, setServer };
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
const tmp = () => mkdtempSync(join(tmpdir(), "sr-sync-"));
const srCalls = (calls: Call[]) => calls.filter((c) => path(c).startsWith("/rest/scriptrunner"));

/** A local folder exported from project-a with its manifest (the baseline). */
async function exported(f = fakeSr()) {
  const dir = tmp();
  const r = await run("jira_export_scriptrunner_scripts", { root: "project-a", output_dir: dir }, f.responder);
  assert.ok(r.res.ok, JSON.stringify(r.error));
  return { dir, manifest: join(dir, MANIFEST), f };
}

describe("ScriptRunner Script Root sync", () => {
  describe("write gate (2.2)", () => {
    it("allows push and sync previews on every supported major combination without changing the matrix", async () => {
      for (const jira of ["10.0.0", "10.99.99", "11.0.0", "11.3.7"]) {
        for (const sr of ["9.0.0", "9.99.99", "10.0.0", "10.14.0"]) {
          const f = fakeSr({ jira, sr });
          const { dir } = await exported(f);
          const local = join(dir, "probe.groovy");
          const bytes = Buffer.from("\ufeff// MARKER_SOURCE probe\r\n", "utf8");
          writeFileSync(local, bytes);
          const args = { path: "project-a/probe.groovy", local, expect_server_sha256: "absent" };
          const preview = await run("jira_push_scriptrunner_script", args, f.responder);
          assert.ok(preview.res.ok, `${jira} + ${sr}: ${JSON.stringify(preview.error)}`);
          onlyGets(preview.calls);
          noContent(preview.value);
          const sync = await run("jira_sync_scriptrunner_scripts", { root: "project-a", local_dir: dir }, f.responder);
          assert.ok(sync.res.ok, JSON.stringify(sync.error));
          assert.equal(sync.value.batch.filter((b: any) => b.tool === "jira_push_scriptrunner_script").length, 1);
          onlyGets(sync.calls);
          const pushed = await run("jira_push_scriptrunner_script", { ...args, dry_run: false }, f.responder);
          assert.ok(pushed.res.ok, JSON.stringify(pushed.error));
          assert.deepEqual(f.server(args.path), bytes);
          assert.equal(pushed.calls.filter((c) => c.method === "PUT").length, 1);
          noContent(pushed.value);
        }
      }
    });

    it("still refuses a push when the operation is removed from the matrix", async () => {
      const { dir } = await exported();
      const operations = SUPPORT_MATRIX.map((m) => m.operations);
      try {
        for (const entry of SUPPORT_MATRIX) entry.operations = entry.operations.filter((op) => op !== "script-root-write");
        const r = await run("jira_push_scriptrunner_script", { path: CLOSE, local: join(dir, "jobs/close.groovy"), expect_server_sha256: "absent" }, fakeSr().responder);
        assert.equal(r.error.type, "Unsupported");
        assert.equal(r.error.operation, "script-root-write");
        assert.equal(srCalls(r.calls).length, 0);
      } finally {
        SUPPORT_MATRIX.forEach((entry, i) => { entry.operations = operations[i]!; });
      }
    });
  });

  describe("local tree (3.1)", () => {
    it("lists files by POSIX path, skips the manifest, backups, temporary and dot files, and fails symbolic links", async () => {
      const dir = tmp();
      mkdirSync(join(dir, "jobs"));
      mkdirSync(join(dir, ".git"));
      writeFileSync(join(dir, "jobs", "close.groovy"), "a");
      writeFileSync(join(dir, "отчёт.groovy"), "b");
      writeFileSync(join(dir, ".git", "HEAD"), "c");
      writeFileSync(join(dir, ".hidden.groovy"), "d");
      writeFileSync(join(dir, "jobs", ".close.groovy.123.ab12cd34.tmp"), "e");
      writeFileSync(join(dir, "jobs", "close.groovy.bak-2026-10-07T10-00-00-000Z"), "f");
      writeFileSync(join(dir, MANIFEST), "{}");
      symlinkSync(join(dir, "jobs", "close.groovy"), join(dir, "link.groovy"));
      const t = await walkLocal(dir, join(dir, MANIFEST));
      assert.deepEqual([...t.files.keys()].sort(), ["jobs/close.groovy", "отчёт.groovy"]);
      assert.deepEqual([...t.failed.keys()], ["link.groovy"]);
      assert.match(t.failed.get("link.groovy")!, /symbolic link/);
    });
  });

  describe("baseline (3.2)", () => {
    it("uses written, already-satisfied, replaced, pushed and pulled entries of the same Script Root only", async () => {
      const dir = tmp();
      const m = join(dir, MANIFEST);
      assert.equal((await loadBaseline(m, R1)).entries.size, 0, "a missing manifest is an empty baseline");
      writeFileSync(m, JSON.stringify({
        scriptRoot: R1,
        files: ["WRITTEN", "ALREADY-SATISFIED", "REPLACED", "PUSHED", "PULLED", "CONFLICT", "FAILED"].map((o, i) => ({ path: `p/${o}`, sha256: String(i).repeat(64), outcome: o })),
      }));
      assert.deepEqual([...(await loadBaseline(m, R1)).entries.keys()].sort(), ["p/ALREADY-SATISFIED", "p/PULLED", "p/PUSHED", "p/REPLACED", "p/WRITTEN"]);
      const other = await loadBaseline(m, "/elsewhere");
      assert.equal(other.entries.size, 0);
      assert.match(other.note!, /another Script Root/);
    });

    it("updates one entry and keeps the others byte-identical", async () => {
      const { manifest } = await exported();
      const before = JSON.parse(readFileSync(manifest, "utf8"));
      await recordBaseline(manifest, R1, { path: CLOSE, local: "x/close.groovy", size: 3, sha256: "f".repeat(64), outcome: "PUSHED" });
      const after = JSON.parse(readFileSync(manifest, "utf8"));
      assert.equal(after.files.length, before.files.length);
      for (const [i, e] of after.files.entries()) {
        if (e.path === CLOSE) assert.equal(e.outcome, "PUSHED");
        else assert.deepEqual(e, before.files[i]);
      }
      assert.ok(after.files.find((e: any) => e.path === CLOSE).syncedAt);
      const fresh = join(tmp(), MANIFEST);
      await recordBaseline(fresh, R1, { path: "a/b.groovy", local: "b.groovy", size: 1, sha256: "e".repeat(64), outcome: "PULLED" });
      assert.deepEqual((await loadBaseline(fresh, R1)).entries.get("a/b.groovy"), "e".repeat(64));
    });
  });

  describe("classification (3.3)", () => {
    const A = "a".repeat(64), B = "b".repeat(64), C = "c".repeat(64);
    const cases: Array<[string, string | undefined, string | undefined, string | undefined, string]> = [
      ["identical", A, A, B, "IN-SYNC"],
      ["identical without baseline", A, A, undefined, "IN-SYNC"],
      ["local edit", B, A, A, "PUSH"],
      ["server edit", A, B, A, "PULL"],
      ["both edited differently", B, C, A, "CONFLICT"],
      ["both edited identically", B, B, A, "IN-SYNC"],
      ["different without baseline", A, B, undefined, "CONFLICT"],
      ["new locally", A, undefined, undefined, "PUSH"],
      ["new on the server", undefined, A, undefined, "PULL"],
      ["deleted locally", undefined, A, A, "DELETED-LOCALLY"],
      ["deleted on the server", A, undefined, A, "DELETED-ON-SERVER"],
    ];
    for (const [name, local, server, base, want] of cases) {
      it(name, () => assert.equal(classify(local, server, base), want));
    }
  });

  describe("jira_pull_scriptrunner_script (4.1)", () => {
    it("replaces a local file that still has the expected SHA-256, keeps a backup and updates the baseline; GET only", async () => {
      const { dir, manifest, f } = await exported();
      const local = join(dir, "jobs", "close.groovy");
      const oldSha = sha256(readFileSync(local));
      f.setServer(CLOSE, "// server edit MARKER_SOURCE\n");
      const args = { path: CLOSE, local, local_dir: dir, expect_local_sha256: oldSha, manifest };
      const dry = await run("jira_pull_scriptrunner_script", args, f.responder);
      assert.equal(dry.value.dry_run, true);
      assert.notEqual(sha256(readFileSync(local)), sha256(f.server(CLOSE)), "the dry run writes nothing");
      noContent(dry.value);
      const r = await run("jira_pull_scriptrunner_script", { ...args, dry_run: false }, f.responder);
      assert.ok(r.res.ok, JSON.stringify(r.error));
      assert.deepEqual(readFileSync(local), f.server(CLOSE));
      assert.equal(r.value.result.outcome, "PULLED");
      assert.ok(readdirSync(join(dir, "jobs")).some((n) => n.startsWith("close.groovy.bak-")), "backup kept");
      assert.equal((await loadBaseline(manifest, R1)).entries.get(CLOSE), sha256(f.server(CLOSE)));
      noContent(r.value);
      noContent(readFileSync(manifest, "utf8"));
      onlyGets([...dry.calls, ...r.calls]);
    });

    it("refuses as a conflict when the local file changed after the preview, and reports already-satisfied", async () => {
      const { dir, manifest, f } = await exported();
      const local = join(dir, "jobs", "close.groovy");
      const same = await run("jira_pull_scriptrunner_script", { path: CLOSE, local, local_dir: dir, expect_local_sha256: "0".repeat(64), manifest }, f.responder);
      assert.equal(same.value.already_satisfied, true);
      f.setServer(CLOSE, "server edit");
      writeFileSync(local, "local edit");
      const r = await run("jira_pull_scriptrunner_script", { path: CLOSE, local, local_dir: dir, expect_local_sha256: "0".repeat(64), manifest, dry_run: false }, f.responder);
      assert.match(r.error.message, /Conflict/);
      assert.equal(readFileSync(local, "utf8"), "local edit");
    });

    it("does not write through a symbolic link that leaves local_dir", async () => {
      const dir = tmp();
      const outside = tmp();
      symlinkSync(outside, join(dir, "jobs"));
      const r = await run("jira_pull_scriptrunner_script", { path: CLOSE, local: join(dir, "jobs", "close.groovy"), local_dir: dir, expect_local_sha256: "absent", dry_run: false }, fakeSr().responder);
      assert.match(r.error.message, /symbolic link/);
      assert.equal(readdirSync(outside).length, 0);
    });
  });

  describe("jira_push_scriptrunner_script (2.1, 4.2)", () => {
    it("describes the upload without content, then PUTs base64 bytes, reads them back and updates the baseline", async () => {
      const { dir, manifest, f } = await exported();
      const local = join(dir, "jobs", "close.groovy");
      const before = sha256(f.server(CLOSE));
      writeFileSync(local, "// local edit MARKER_SOURCE\r\nlog.info('x')\r\n");
      const args = { path: CLOSE, local, local_dir: dir, expect_server_sha256: before, manifest };
      const dry = await run("jira_push_scriptrunner_script", args, f.responder);
      assert.equal(dry.value.dry_run, true, JSON.stringify(dry.error));
      assert.equal(dry.value.request.method, "PUT");
      assert.match(dry.value.summary, /executable/);
      assert.match(dry.value.request.body, /not shown/);
      noContent(dry.value);
      onlyGets(dry.calls);
      const r = await run("jira_push_scriptrunner_script", { ...args, dry_run: false }, f.responder);
      assert.ok(r.res.ok, JSON.stringify(r.error));
      const put = r.calls.find((c) => c.method === "PUT")!;
      assert.equal(path(put), "/rest/scriptrunner/latest/idea/file");
      assert.equal(new URL(put.url).searchParams.get("filePath"), CLOSE);
      assert.equal(put.headers["Content-Type"], "application/octet-stream");
      assert.equal(put.body, readFileSync(local).toString("base64"));
      assert.deepEqual(f.server(CLOSE), readFileSync(local));
      assert.equal((await loadBaseline(manifest, R1)).entries.get(CLOSE), sha256(readFileSync(local)));
      assert.equal(r.calls.filter((c) => c.method !== "GET").length, 1, "one write, never DELETE");
      noContent(r.value);
      noContent(readFileSync(manifest, "utf8"));
    });

    it("refuses as a conflict when the server changed, and reports already-satisfied for identical content", async () => {
      const { dir, manifest, f } = await exported();
      const local = join(dir, "jobs", "close.groovy");
      const same = await run("jira_push_scriptrunner_script", { path: CLOSE, local, expect_server_sha256: "1".repeat(64), manifest }, f.responder);
      assert.equal(same.value.already_satisfied, true);
      writeFileSync(local, "local edit");
      const r = await run("jira_push_scriptrunner_script", { path: CLOSE, local, expect_server_sha256: "1".repeat(64), manifest, dry_run: false }, f.responder);
      assert.match(r.error.message, /Conflict.*1111/);
      assert.ok(!r.calls.some((c) => c.method === "PUT"));
    });

    it("creates a new file when expected absent, and refuses when it appeared meanwhile", async () => {
      const { dir, f } = await exported();
      writeFileSync(join(dir, "new.groovy"), "new MARKER_SOURCE");
      const args = { path: "project-a/new.groovy", local: join(dir, "new.groovy"), local_dir: dir, expect_server_sha256: "absent" };
      const r = await run("jira_push_scriptrunner_script", { ...args, dry_run: false }, f.responder);
      assert.ok(r.res.ok, JSON.stringify(r.error));
      assert.equal(f.server("project-a/new.groovy").toString(), "new MARKER_SOURCE");
      writeFileSync(join(dir, "new.groovy"), "newer");
      const again = await run("jira_push_scriptrunner_script", { ...args, dry_run: false }, f.responder);
      assert.match(again.error.message, /Conflict/);
    });

    it("fails verification when the read-back differs, and reports an HTTP error by status only", async () => {
      const { dir } = await exported();
      const local = join(dir, "jobs", "close.groovy");
      writeFileSync(local, "local edit");
      const mangled = fakeSr({ mangle: true });
      const v = await run("jira_push_scriptrunner_script", { path: CLOSE, local, expect_server_sha256: sha256(mangled.server(CLOSE)), dry_run: false }, mangled.responder);
      assert.equal(v.error.type, "VerificationError");
      const failing = fakeSr({ putFail: 500 });
      const e = await run("jira_push_scriptrunner_script", { path: CLOSE, local, expect_server_sha256: sha256(failing.server(CLOSE)), dry_run: false }, failing.responder);
      assert.match(e.error.message, /HTTP 500/);
      noContent(e.error);
    });
  });

  describe("jira_sync_scriptrunner_scripts (4.3)", () => {
    /** Exported folder with one local edit, one server edit, one conflict, one new local file and one local deletion. */
    async function scenario() {
      const { dir, manifest, f } = await exported();
      writeFileSync(join(dir, "jobs", "close.groovy"), "local edit");
      f.setServer(HELPER, "server edit");
      writeFileSync(join(dir, "отчёт.groovy"), "local side");
      f.setServer("project-a/отчёт.groovy", "server side");
      writeFileSync(join(dir, "new.groovy"), "new");
      const { rmSync } = await import("node:fs");
      rmSync(join(dir, "conf", "app.properties"));
      return { dir, manifest, f };
    }

    it("previews counts and paths with GETs only and writes nothing", async () => {
      const { dir, manifest, f } = await scenario();
      const before = readFileSync(manifest, "utf8");
      const r = await run("jira_sync_scriptrunner_scripts", { root: "project-a", local_dir: dir }, f.responder);
      assert.ok(r.res.ok, JSON.stringify(r.error));
      assert.equal(r.value.dry_run, true);
      assert.deepEqual(r.value.counts, { PUSH: 2, PULL: 1, CONFLICT: 1, "DELETED-LOCALLY": 1 });
      assert.deepEqual(r.value.paths.PUSH, [CLOSE, "project-a/new.groovy"]);
      assert.deepEqual(r.value.paths.CONFLICT, ["project-a/отчёт.groovy"]);
      assert.deepEqual(r.value.batch.map((b: any) => [b.tool, b.args.path]), [
        ["jira_push_scriptrunner_script", CLOSE],
        ["jira_push_scriptrunner_script", "project-a/new.groovy"],
        ["jira_pull_scriptrunner_script", HELPER],
      ]);
      assert.equal(r.value.batch[1].args.expect_server_sha256, "absent");
      assert.equal(readFileSync(manifest, "utf8"), before);
      assert.ok(!existsSync(join(dir, "conf", "app.properties")), "a local deletion is not restored");
      onlyGets(r.calls);
      noContent(r.value);
    });

    it("offers pushes in the sync checklist by default", async () => {
      const { dir, f } = await scenario();
      const r = await run("jira_sync_scriptrunner_scripts", { root: "project-a", local_dir: dir }, f.responder);
      assert.equal(r.value.counts.PUSH, 2);
      assert.equal(r.value.batch.filter((b: any) => b.tool === "jira_push_scriptrunner_script").length, 2);
      assert.equal(r.value.pushNote, undefined);
      onlyGets(r.calls);
    });

    it("is already satisfied when nothing is to push or pull, and treats differences without a baseline as conflicts", async () => {
      const { dir, f } = await exported();
      const r = await run("jira_sync_scriptrunner_scripts", { root: "project-a", local_dir: dir, dry_run: false }, f.responder);
      assert.equal(r.value.already_satisfied, true);
      const bare = tmp();
      writeFileSync(join(bare, "отчёт.groovy"), "different");
      const n = await run("jira_sync_scriptrunner_scripts", { root: "project-a", local_dir: bare }, f.responder);
      assert.deepEqual(n.value.paths.CONFLICT, ["project-a/отчёт.groovy"]);
      assert.match(n.value.hint, /export/);
    });

    it("refuses over max_files before reading content and over max_total_bytes without writing", async () => {
      const { dir, manifest, f } = await scenario();
      const before = readFileSync(manifest, "utf8");
      const r = await run("jira_sync_scriptrunner_scripts", { root: "project-a", local_dir: dir, max_files: 3 }, f.responder);
      assert.match(r.error.message, /max_files=3/);
      assert.ok(!r.calls.some((c) => path(c).endsWith("/idea/file")));
      const b = await run("jira_sync_scriptrunner_scripts", { root: "project-a", local_dir: dir, max_total_bytes: 20 }, f.responder);
      assert.match(b.error.message, /max_total_bytes=20/);
      noContent(b.error);
      assert.equal(readFileSync(manifest, "utf8"), before);
    });

    it("with dry_run=false outside the CLI runs every item in order", async () => {
      const { dir, f } = await scenario();
      const r = await run("jira_sync_scriptrunner_scripts", { root: "project-a", local_dir: dir, dry_run: false }, f.responder);
      assert.ok(r.res.ok, JSON.stringify(r.error));
      assert.deepEqual(r.value.result.items.map((i: any) => i.status), ["done", "done", "done"]);
      assert.equal(f.server(CLOSE).toString(), "local edit");
      assert.equal(readFileSync(join(dir, "lib", "Helper.groovy"), "utf8"), "server edit");
      const again = await run("jira_sync_scriptrunner_scripts", { root: "project-a", local_dir: dir }, f.responder);
      assert.deepEqual(again.value.counts, { "IN-SYNC": 3, CONFLICT: 1, "DELETED-LOCALLY": 1 }, "pushed and pulled files are in sync with their new baseline");
      assert.ok(r.calls.every((c) => c.method !== "DELETE"));
    });
  });

  describe("plan integration (4.5)", () => {
    it("records one plan item per file and applies them without drift", async () => {
      const { dir, f } = await (async () => {
        const s = await exported();
        writeFileSync(join(s.dir, "jobs", "close.groovy"), "local edit");
        s.f.setServer(HELPER, "server edit");
        return s;
      })();
      const file = join(tmp(), "plan.json");
      const args = { root: "project-a", local_dir: dir };
      const dry = await run("jira_sync_scriptrunner_scripts", args, f.responder);
      const items = addResultToPlan(file, "jira_sync_scriptrunner_scripts", args, dry.value);
      assert.deepEqual(items.map((i) => i.tool), ["jira_push_scriptrunner_script", "jira_pull_scriptrunner_script"]);
      noContent(readFileSync(file, "utf8"));
      const out = await applyPlan(testContext(f.responder).ctx, readPlan(file), undefined, file);
      assert.deepEqual(out.map((o) => o.status), ["done", "done"], JSON.stringify(out));
      const again = await applyPlan(testContext(f.responder).ctx, readPlan(file), undefined, file);
      assert.deepEqual(again.map((o) => o.status), ["skipped", "skipped"]);
    });

    it("drifts a planned push when the local file changed after planning", async () => {
      const { dir, f } = await exported();
      writeFileSync(join(dir, "jobs", "close.groovy"), "local edit");
      const file = join(tmp(), "plan.json");
      const args = { root: "project-a", local_dir: dir };
      addResultToPlan(file, "jira_sync_scriptrunner_scripts", args, (await run("jira_sync_scriptrunner_scripts", args, f.responder)).value);
      writeFileSync(join(dir, "jobs", "close.groovy"), "edited again");
      const out = await applyPlan(testContext(f.responder).ctx, readPlan(file), undefined, file);
      assert.deepEqual(out.map((o) => o.status), ["drifted"]);
      assert.notEqual(f.server(CLOSE).toString(), "edited again");
    });
  });
});

describe("CLI checklist for a sync (4.5)", () => {
  /** The fake Script Editor served over HTTP, so the real CLI can talk to it. */
  async function serve(f: ReturnType<typeof fakeSr>) {
    const { createServer } = await import("node:http");
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        const call: Call = { url: `http://x${req.url}`, method: req.method!, headers: req.headers as any, body };
        const r = f.responder(call) ?? { status: 404, body: "" };
        res.writeHead(r.status ?? 200, { "content-type": "application/json" });
        res.end(typeof r.body === "string" ? r.body : JSON.stringify(r.body));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    return { server, base: `http://127.0.0.1:${(server.address() as any).port}` };
  }

  async function cli(base: string, args: string[]) {
    const { spawn } = await import("node:child_process");
    const home = tmp();
    mkdirSync(join(home, ".config", "atlassian-dc-admin"), { recursive: true });
    // `none` is honoured only from a config file: approves every checklist item without a dialog
    writeFileSync(join(home, ".config", "atlassian-dc-admin", ".env"), "ATLASSIAN_CONFIRM_MODE=none\n");
    const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
      env: { ...process.env, HOME: home, JIRA_URL: base, JIRA_PAT_TOKEN: "t" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const status = await new Promise<number | null>((r) => child.on("close", r));
    return { status, stdout, stderr };
  }

  it("runs each checklist item on its own and reports it per file", async () => {
    const f = fakeSr();
    const { server, base } = await serve(f);
    try {
      const dir = tmp();
      const exp = await cli(base, ["jira_export_scriptrunner_scripts", "root=project-a", `output_dir=${dir}`]);
      assert.equal(exp.status, 0, exp.stderr + exp.stdout);
      f.setServer(HELPER, "server edit");
      f.setServer(CLOSE, "server edit 2");
      const r = await cli(base, ["jira_sync_scriptrunner_scripts", "root=project-a", `local_dir=${dir}`, "dry_run=false"]);
      assert.equal(r.status, 0, r.stderr + r.stdout);
      const lines = r.stdout.trim().split("\n");
      assert.equal(lines.length, 2, r.stdout);
      assert.match(lines[0]!, /^1\. DONE \| Pull project-a\/jobs\/close\.groovy/);
      assert.match(lines[1]!, /^2\. DONE \| Pull project-a\/lib\/Helper\.groovy/);
      assert.equal(readFileSync(join(dir, "lib", "Helper.groovy"), "utf8"), "server edit");
      noContent(r.stdout + r.stderr);
    } finally {
      server.close();
    }
  });
});
