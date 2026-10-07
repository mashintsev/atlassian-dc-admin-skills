import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const doc = (name: string) => readFileSync(new URL(`../../atlassian-dc-admin/${name}`, import.meta.url), "utf8");

function skill() {
  const text = doc("SKILL.md");
  const [, frontmatter, body] = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text)!;
  const description = /^description: (.*)$/m.exec(frontmatter!)![1]!;
  return { description, body: body! };
}

describe("skill documents (reduce-agent-context 1.1, 1.2)", () => {
  it("keeps the frontmatter description at most 500 characters, naming the products", () => {
    const { description } = skill();
    assert.ok(description.length <= 500, `description is ${description.length} characters`);
    for (const word of ["Jira", "Confluence", "Service Management", "ScriptRunner", "Assets", "TRIGGER"]) assert.ok(description.includes(word), word);
  });
});

describe("SKILL.md body (reduce-agent-context 1.2)", () => {
  it("stays within 6,000 characters and keeps the confirmation rules", () => {
    const { body } = skill();
    assert.ok(body.length <= 6000, `body is ${body.length} characters`);
    for (const phrase of ["dry_run=false", "apply", "Exit 12", "Exit 13", "UI check plan", "Never try to bypass the confirmation", "REFERENCE.md"]) {
      assert.ok(body.includes(phrase), phrase);
    }
  });

  it("states the Codex notes and the exit-code table once, in REFERENCE.md", () => {
    const ref = doc("REFERENCE.md");
    assert.match(ref, /## Codex\n/);
    assert.match(ref, /## Exit codes\n/);
    assert.ok(!/## Codex\n/.test(skill().body) && !/## Exit codes\n/.test(skill().body));
  });
});

describe("REFERENCE.md tool index (reduce-agent-context 2.1)", async () => {
  const { ALL_TOOLS } = await import("../../src/tools/index.js");
  const index = () => /<!-- tools:start -->([\s\S]*)<!-- tools:end -->/.exec(doc("REFERENCE.md"))![1]!;

  it("lists every registered tool exactly once and points to describe", () => {
    const text = index();
    for (const t of ALL_TOOLS) {
      const count = text.split(new RegExp(`\\b${t.name}\\b`)).length - 1;
      assert.equal(count, 1, `${t.name} appears ${count} times`);
    }
    assert.match(text, /describe <tool>/);
    assert.ok(!/\| Arguments \|/.test(text), "no per-tool argument tables");
  });
});

describe("REFERENCE.md hand-written sections (reduce-agent-context 2.2)", () => {
  it("stays within 40,000 characters, separates the two kinds of drafts and has no stale argument-parsing note", () => {
    const ref = doc("REFERENCE.md");
    assert.ok(ref.length <= 40000, `REFERENCE.md is ${ref.length} characters`);
    assert.match(ref, /Two kinds of drafts/);
    assert.ok(!/parsed as JSON\s+when possible/.test(ref), "stale note about argument parsing");
    assert.ok(!/drifts if someone changes the scheme before `apply`/.test(ref), "stale issue type scheme note");
  });
});

describe("response guard default (reduce-agent-context 3.1)", () => {
  it("is 25,000 characters and stays configurable", async () => {
    const { maxResponseChars } = await import("../../src/json.js");
    const before = process.env.ATLASSIAN_MAX_RESPONSE_CHARS;
    try {
      delete process.env.ATLASSIAN_MAX_RESPONSE_CHARS;
      assert.equal(maxResponseChars(), 25_000);
      process.env.ATLASSIAN_MAX_RESPONSE_CHARS = "40000";
      assert.equal(maxResponseChars(), 40_000);
    } finally {
      if (before === undefined) delete process.env.ATLASSIAN_MAX_RESPONSE_CHARS;
      else process.env.ATLASSIAN_MAX_RESPONSE_CHARS = before;
    }
  });
});
