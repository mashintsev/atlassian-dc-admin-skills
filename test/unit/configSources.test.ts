import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { configSources, findProjectConfig, loadConfig, productSource, productValues, PROJECT_CONFIG_FILE } from "../../src/config.js";

function layout() {
  const root = mkdtempSync(join(tmpdir(), "cfg-"));
  const home = join(root, "home");
  const project = join(root, "work", "projectA");
  const sub = join(project, "src", "deep");
  const skillDir = join(root, "skill");
  for (const d of [join(home, ".config", "atlassian-dc-admin"), sub, skillDir]) mkdirSync(d, { recursive: true });
  writeFileSync(join(home, ".config", "atlassian-dc-admin", ".env"), "JIRA_URL=https://global.jira\nJIRA_PAT_TOKEN=global-token\nCONFLUENCE_URL=https://global.wiki\nCONFLUENCE_PAT_TOKEN=g\nATLASSIAN_CONFIRM_MODE=none\n");
  return { root, home, project, sub, skillDir };
}

describe("per-project configuration", () => {
  it("finds the project file from a subdirectory and prefers it over the global file", () => {
    const l = layout();
    writeFileSync(join(l.project, PROJECT_CONFIG_FILE), "JIRA_URL=https://project.jira\nJIRA_PAT_TOKEN=project-token\nASSETS_API_BASE=/rest/assets/1.0\n");
    const opts = { cwd: l.sub, env: {}, home: l.home, skillDir: l.skillDir };
    assert.equal(findProjectConfig(l.sub), join(l.project, PROJECT_CONFIG_FILE));
    assert.equal(productSource("jira", opts)?.path, join(l.project, PROJECT_CONFIG_FILE));
    const cfg = loadConfig("jira", productValues("jira", opts));
    assert.equal(cfg.baseUrl, "https://project.jira");
    assert.equal(cfg.headers.Authorization, "Bearer project-token");
    assert.equal(productValues("jira", opts).ASSETS_API_BASE, "/rest/assets/1.0");
    // Confluence is not in the project file: it falls back to the global one, independently
    assert.equal(productSource("confluence", opts)?.path, join(l.home, ".config", "atlassian-dc-admin", ".env"));
  });

  it("never mixes a product's settings across sources", () => {
    const l = layout();
    // project points at its own Jira but forgot the token: the global token must NOT be sent there
    writeFileSync(join(l.project, PROJECT_CONFIG_FILE), "JIRA_URL=https://project.jira\n");
    const opts = { cwd: l.project, env: {}, home: l.home, skillDir: l.skillDir };
    assert.throws(() => loadConfig("jira", productValues("jira", opts)), /JIRA_PAT_TOKEN/);
  });

  it("the environment wins as a whole when it defines the URL", () => {
    const l = layout();
    writeFileSync(join(l.project, PROJECT_CONFIG_FILE), "JIRA_URL=https://project.jira\nJIRA_PAT_TOKEN=p\n");
    const opts = { cwd: l.project, env: { JIRA_URL: "https://env.jira", JIRA_PAT_TOKEN: "e" }, home: l.home, skillDir: l.skillDir };
    assert.equal(productSource("jira", opts)?.label, "environment");
    assert.equal(loadConfig("jira", productValues("jira", opts)).baseUrl, "https://env.jira");
  });

  it("marks only the skill and ~/.config files as trusted", () => {
    const l = layout();
    writeFileSync(join(l.project, PROJECT_CONFIG_FILE), "ATLASSIAN_CONFIRM_MODE=none\nJIRA_URL=https://p\n");
    const sources = configSources({ cwd: l.project, env: {}, home: l.home, skillDir: l.skillDir });
    const byPath = Object.fromEntries(sources.filter((s) => s.path).map((s) => [s.path!, s.trusted]));
    assert.equal(byPath[join(l.project, PROJECT_CONFIG_FILE)], false);
    assert.equal(byPath[join(l.home, ".config", "atlassian-dc-admin", ".env")], true);
  });
});
