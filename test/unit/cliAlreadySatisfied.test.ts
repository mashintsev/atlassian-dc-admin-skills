import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

/** Minimal Jira: screen 10433 with one tab that holds only Summary. */
function fakeJira(): Server {
  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const json = (body: unknown) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.method !== "GET") { res.writeHead(500); res.end("{}"); return; } // nothing may be changed
    switch (url.pathname) {
      case "/rest/api/2/field": return json([{ id: "summary", name: "Summary" }, { id: "components", name: "Component/s" }]);
      case "/rest/api/2/screens": return json({ total: 2, screens: [{ id: 10433, name: "DEMO: View Screen" }, { id: 10434, name: "DEMO: Edit Screen" }] });
      case "/rest/api/2/screens/10433/tabs": return json([{ id: 10633, name: "Main" }]);
      case "/rest/api/2/screens/10433/tabs/10633/fields": return json([{ id: "summary", name: "Summary" }]);
      case "/rest/api/2/screens/10434/tabs": return json([{ id: 10634, name: "Main" }]);
      case "/rest/api/2/screens/10434/tabs/10634/fields": return json([{ id: "summary", name: "Summary" }, { id: "components", name: "Component/s" }]);
      case "/rest/api/2/project": return json([]);
      case "/rest/api/2/customFields": return json({ values: [], total: 0 });
      default: res.writeHead(404); res.end("{}");
    }
  });
}

let server: Server;
let base = "";
before(async () => {
  server = fakeJira();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(() => server.close());

function cli(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const home = mkdtempSync(join(tmpdir(), "cli-home-"));
  const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    // tty mode without a terminal: any confirmation attempt would fail with exit 13
    env: { ...process.env, HOME: home, JIRA_URL: base, JIRA_PAT_TOKEN: "t", ATLASSIAN_CONFIRM_MODE: "tty" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  return new Promise((r) => child.on("close", (status) => r({ status, stdout, stderr })));
}

const removeComponents = ["jira_remove_screen_field", "screen_id=10433", "tab_id=10633", "field_id=components"];

describe("CLI and already-satisfied writes", () => {
  it("executes nothing and asks for no confirmation with dry_run=false", async () => {
    const r = await cli([...removeComponents, "dry_run=false"]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /^ALREADY-SATISFIED \| Remove Component\/s from DEMO: View Screen \/ Main/);
  });

  it("does not add the change to a plan", async () => {
    const plan = join(mkdtempSync(join(tmpdir(), "plan-")), "p.json");
    const r = await cli([...removeComponents, `--plan=${plan}`]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /not planned .*already satisfied/);
    assert.equal(existsSync(plan), false);
  });

  it("plans each placement of jira_add_field_to_screens as its own item and skips placed ones", async () => {
    const plan = join(mkdtempSync(join(tmpdir(), "plan-")), "p.json");
    const placements = JSON.stringify([{ screen_id: 10433, tab_id: 10633 }, { screen_id: 10434, tab_id: 10634 }]);
    const r = await cli(["jira_add_field_to_screens", "field_id=components", `placements=${placements}`, `--plan=${plan}`]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const items = JSON.parse(readFileSync(plan, "utf8")).items;
    assert.equal(items.length, 1);
    assert.equal(items[0].tool, "jira_add_screen_field");
    assert.deepEqual(items[0].args, { screen_id: 10433, tab_id: 10633, field: "components" });
  });
});
