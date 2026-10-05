import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  jiraWikiToMarkdown,
  markdownToJiraWiki,
  markdownToStorage,
  normalizeJiraCodeLanguage,
  storageToMarkdown,
} from "../../src/markup.js";

describe("markdownToJiraWiki", () => {
  it("converts headings, emphasis, links and images", () => {
    assert.equal(markdownToJiraWiki("# Title\n## Sub"), "h1. Title\nh2. Sub");
    assert.equal(markdownToJiraWiki("**bold** and *it*"), "*bold* and _it_");
    assert.equal(markdownToJiraWiki("see [docs](https://x.io/a_b_c)"), "see [docs|https://x.io/a_b_c]");
    assert.equal(markdownToJiraWiki("![](shot.png) ![logo](https://x.io/l.png)"), "!shot.png! !https://x.io/l.png|alt=logo!");
    assert.equal(markdownToJiraWiki("<https://x.io>"), "[https://x.io]");
    assert.equal(markdownToJiraWiki("~~gone~~"), "-gone-");
  });

  it("keeps setext rule lines as horizontal rules", () => {
    assert.equal(markdownToJiraWiki("Title\n===\n\n----\n"), "h1. Title\n\n----\n");
  });

  it("escapes intraword underscores so Jira does not italicise identifiers", () => {
    assert.equal(markdownToJiraWiki("set customfield_10101 and snake_case_name"), "set customfield\\_10101 and snake\\_case\\_name");
  });

  it("converts nested bulleted and numbered lists", () => {
    assert.equal(markdownToJiraWiki("- a\n  - b\n    - c"), "* a\n** b\n*** c");
    assert.equal(markdownToJiraWiki("1. one\n  2. two"), "# one\n## two");
  });

  it("protects code blocks and inline code, normalising languages", () => {
    const md = "```ts\nconst a = { b: 1 }; // *not bold*\n```\nuse `x_y_z` here";
    assert.equal(markdownToJiraWiki(md), "{code:javascript}\nconst a = { b: 1 }; // *not bold*\n{code}\nuse {{x_y_z}} here");
    assert.equal(markdownToJiraWiki("```\nplain\n```"), "{code}\nplain\n{code}");
    assert.equal(normalizeJiraCodeLanguage("Kotlin"), "java");
    assert.equal(normalizeJiraCodeLanguage("brainfuck"), null);
    assert.equal(normalizeJiraCodeLanguage("python"), "python");
  });

  it("converts tables with trimmed cells", () => {
    assert.equal(markdownToJiraWiki("| A | B |\n|---|:-:|\n| 1 | 2 |\n| 3 | 4 |"), "||A||B||\n|1|2|\n|3|4|");
  });
});

describe("jiraWikiToMarkdown", () => {
  it("converts headings, emphasis, lists and links", () => {
    assert.equal(jiraWikiToMarkdown("h2. Plan\n*bold* _it_"), "## Plan\n**bold** *it*");
    assert.equal(jiraWikiToMarkdown("* a\n** b\n# one\n## two"), "- a\n  - b\n1. one\n  1. two");
    assert.equal(jiraWikiToMarkdown("[docs|https://x.io] and [https://y.io]"), "[docs](https://x.io) and https://y.io");
    assert.equal(jiraWikiToMarkdown("!shot.png! !a.png|alt=Logo!"), "![](shot.png) ![Logo](a.png)");
  });

  it("protects code and noformat blocks", () => {
    assert.equal(jiraWikiToMarkdown("{code:java}\nint *a* = {1};\n{code}"), "```java\n\nint *a* = {1};\n\n```");
    assert.equal(jiraWikiToMarkdown("{noformat}x_y_z{noformat} and {{a*b*c}}"), "```\nx_y_z\n``` and `a*b*c`");
  });

  it("handles DC mentions, accountid mentions and smart links", () => {
    assert.equal(jiraWikiToMarkdown("ping [~ivan.m] please"), "ping @ivan.m please");
    assert.equal(jiraWikiToMarkdown("[~accountid:abc123]"), "User:abc123");
    assert.equal(
      jiraWikiToMarkdown("[x|https://jira.example.com/browse/FDP-12?focus=1|smart-link]"),
      "[FDP-12](https://jira.example.com/browse/FDP-12)",
    );
  });

  it("converts tables, quotes and panels", () => {
    assert.equal(jiraWikiToMarkdown("||A||B||\n|1|2|"), "|A|B|\n|---|---|\n|1|2|");
    assert.equal(jiraWikiToMarkdown("{quote}one\ntwo{quote}"), "> one\n> two");
    assert.equal(jiraWikiToMarkdown("{panel:title=Note}body{panel}"), "**Note**\nbody");
  });

  it("does not mangle plain text with plus, minus and tildes", () => {
    assert.equal(jiraWikiToMarkdown("C++ and C++ work; a-b-c; ~/path and ~/x"), "C++ and C++ work; a-b-c; ~/path and ~/x");
    assert.equal(jiraWikiToMarkdown("-removed- +added+"), "~~removed~~ added");
  });

  it("returns empty string for empty input", () => {
    assert.equal(jiraWikiToMarkdown(""), "");
    assert.equal(markdownToJiraWiki(""), "");
  });
});

describe("markdownToStorage", () => {
  it("renders code as a code macro with CDATA", () => {
    const s = markdownToStorage("```js\nif (a < b && c) { return ']]>'; }\n```");
    assert.equal(
      s,
      '<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">js</ac:parameter><ac:plain-text-body><![CDATA[if (a < b && c) { return \']]]]><![CDATA[>\'; }]]></ac:plain-text-body></ac:structured-macro>',
    );
  });

  it("maps bare-filename images to attachments and URLs to ri:url", () => {
    assert.equal(
      markdownToStorage("![diagram](arch%20v2.png) ![](https://x.io/a.png)"),
      '<p><ac:image ac:alt="diagram"><ri:attachment ri:filename="arch v2.png" /></ac:image> <ac:image><ri:url ri:value="https://x.io/a.png" /></ac:image></p>',
    );
  });

  it("renders task lists as ac:task-list and keeps mixed lists as text", () => {
    assert.equal(
      markdownToStorage("- [ ] write docs\n- [x] **ship**"),
      "<ac:task-list><ac:task><ac:task-status>incomplete</ac:task-status><ac:task-body>write docs</ac:task-body></ac:task>" +
        "<ac:task><ac:task-status>complete</ac:task-status><ac:task-body><strong>ship</strong></ac:task-body></ac:task></ac:task-list>",
    );
    assert.match(markdownToStorage("- [ ] task\n- plain"), /<ul>\s*<li>\[ \] task<\/li>\s*<li>plain<\/li>\s*<\/ul>/);
  });

  it("produces well-formed XHTML for breaks, rules, tables and escaped text", () => {
    const s = markdownToStorage("a  \nb\n\n---\n\n| A | B |\n|---|---|\n| 1 & 2 | <x> |\n\nraw <br> and <img src=\"a.png\">");
    assert.match(s, /a<br \/>b/);
    assert.match(s, /<hr \/>/);
    assert.match(s, /<table>[\s\S]*<th>A<\/th>[\s\S]*<td>1 &amp; 2<\/td>/);
    assert.match(s, /raw <br \/> and <img src="a.png" \/>/);
    assert.doesNotMatch(s, /<(br|hr|img)(\s[^>]*)?(?<!\/)>/);
  });

  it("renders headings, nested lists and links", () => {
    const s = markdownToStorage("## Plan\n\n- a\n  - b\n\n[docs](https://x.io?a=1&b=2)");
    assert.match(s, /<h2>Plan<\/h2>/);
    assert.match(s, /<ul>\s*<li>a<ul>\s*<li>b<\/li>/);
    assert.match(s, /<a href="https:\/\/x\.io\?a=1&amp;b=2">docs<\/a>/);
  });
});

describe("storageToMarkdown", () => {
  it("reads code macros including CDATA and self-closing parameters", () => {
    const storage =
      '<p>Intro</p><ac:structured-macro ac:name="code"><ac:parameter ac:name="language">python</ac:parameter>' +
      "<ac:plain-text-body><![CDATA[def f(x):\n    return {x: x < 1}]]></ac:plain-text-body></ac:structured-macro><p>After</p>";
    assert.equal(storageToMarkdown(storage), "Intro\n\n```python\ndef f(x):\n    return {x: x < 1}\n```\n\nAfter");
  });

  it("reads panels as labelled blockquotes", () => {
    const storage = '<ac:structured-macro ac:name="warning"><ac:rich-text-body><p>Careful <strong>now</strong></p></ac:rich-text-body></ac:structured-macro>';
    assert.equal(storageToMarkdown(storage), "> **Warning:**\n>\n> Careful **now**");
    const titled = '<ac:structured-macro ac:name="info"><ac:parameter ac:name="title">Heads up</ac:parameter><ac:rich-text-body><p>x</p></ac:rich-text-body></ac:structured-macro>';
    assert.equal(storageToMarkdown(titled), "> **Heads up:**\n>\n> x");
  });

  it("reads images, links, users and jira macros", () => {
    const storage =
      '<p><ac:image ac:alt="d"><ri:attachment ri:filename="a b.png"/></ac:image> <ac:image><ri:url ri:value="https://x.io/i.png"/></ac:image></p>' +
      '<p><ac:link><ri:page ri:content-title="Runbook"/></ac:link>, <ac:link><ri:page ri:content-title="X"/><ac:plain-text-link-body><![CDATA[the guide]]></ac:plain-text-link-body></ac:link>, ' +
      '<ac:link><ri:user ri:username="ivan"/></ac:link> and <ac:structured-macro ac:name="jira"><ac:parameter ac:name="key">FDP-1</ac:parameter></ac:structured-macro></p>';
    assert.equal(
      storageToMarkdown(storage, { baseUrl: "https://wiki.example.com/", pageId: "123" }),
      "![d](https://wiki.example.com/download/attachments/123/a%20b.png) ![](https://x.io/i.png)\n\nRunbook, the guide, @ivan and [JIRA:FDP-1]",
    );
    assert.equal(storageToMarkdown('<ac:image><ri:attachment ri:filename="a.png"/></ac:image>'), "![](a.png)");
  });

  it("reads task lists and tables", () => {
    const storage =
      "<ac:task-list><ac:task><ac:task-id>1</ac:task-id><ac:task-status>complete</ac:task-status><ac:task-body>done</ac:task-body></ac:task>" +
      "<ac:task><ac:task-status>incomplete</ac:task-status><ac:task-body>todo <strong>soon</strong></ac:task-body></ac:task></ac:task-list>" +
      "<table><tbody><tr><th>A</th><th>B</th></tr><tr><td><p>1 | x</p></td><td>2</td></tr></tbody></table>";
    assert.equal(storageToMarkdown(storage), "- [x] done\n- [ ] todo **soon**\n\n| A | B |\n| --- | --- |\n| 1 \\| x | 2 |");
  });

  it("drops unknown macros to their body text", () => {
    assert.equal(
      storageToMarkdown('<ac:structured-macro ac:name="expand"><ac:parameter ac:name="title">More</ac:parameter><ac:rich-text-body><p>hidden</p></ac:rich-text-body></ac:structured-macro><ac:structured-macro ac:name="toc"/>'),
      "hidden",
    );
  });

  it("round-trips Markdown through storage", () => {
    const md = "## Plan\n\n- [ ] one\n- [x] two\n\n```js\nconst x = { a: 1 };\n```\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n![](a.png)";
    assert.equal(storageToMarkdown(markdownToStorage(md)), md);
  });

  it("returns empty string for empty input", () => {
    assert.equal(storageToMarkdown(""), "");
    assert.equal(markdownToStorage(""), "");
  });
});
