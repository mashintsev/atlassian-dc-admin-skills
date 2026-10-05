/**
 * Markup conversion between Markdown and the Data Center formats.
 *
 * Jira wiki markup: a port of JiraPreprocessor.markdown_to_jira / jira_to_markdown /
 * clean_jira_text from sooperset/mcp-atlassian (preprocessing/jira.py, MIT).
 * Confluence storage: Markdown is rendered with `marked` and post-processed the way
 * mcp-atlassian's ConfluencePreprocessor does it (code macro, attachment images,
 * task lists); storage is read back to Markdown with `turndown` plus rules for the
 * ac:/ri: elements.
 */

import { Marked, type Tokens } from "marked";
import TurndownService from "turndown";

// =============================================================================
// Placeholder helpers (base.py _extract_blocks / _restore_blocks)
// =============================================================================

function extractBlocks(
  text: string,
  pattern: RegExp,
  transform: (m: RegExpExecArray) => string,
  storage: string[],
  prefix: string,
): string {
  const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  return text.replace(re, (...args) => {
    const groups = args.slice(0, -2).filter((a) => typeof a === "string" || a === undefined) as string[];
    const m = Object.assign([...groups], { index: 0, input: text }) as unknown as RegExpExecArray;
    const placeholder = `\x00${prefix}${storage.length}\x00`;
    storage.push(transform(m));
    return placeholder;
  });
}

function restoreBlocks(text: string, storage: string[], prefix: string): string {
  // highest index first, so placeholder 1 never matches inside placeholder 10
  for (let i = storage.length - 1; i >= 0; i--) text = text.split(`\x00${prefix}${i}\x00`).join(storage[i]);
  return text;
}

// =============================================================================
// Jira wiki markup
// =============================================================================

const ISSUE_KEY = "[A-Z][A-Z0-9_]+-\\d+(?:-\\d+)*";

/** Source-code formatter tags the Jira Server/DC wiki renderer accepts directly. */
const VALID_JIRA_LANGUAGES = new Set([
  "actionscript", "ada", "applescript", "bash", "c", "c#", "c++", "cpp", "css", "erlang", "go", "groovy",
  "haskell", "html", "java", "javascript", "js", "json", "lua", "none", "nyan", "objc", "perl", "php",
  "python", "r", "rainbow", "ruby", "scala", "sh", "sql", "swift", "visualbasic", "xml", "yaml",
]);

/** Unsupported languages mapped to the closest Jira formatter; unmapped ones become plain {code}. */
const LANGUAGE_MAPPING: Record<string, string> = {
  actionscript3: "actionscript", csharp: "c#", cs: "c#", erl: "erlang", "objective-c": "objc",
  py: "python", rb: "ruby", vb: "visualbasic", yml: "yaml",
  diff: "none", patch: "none", less: "css", sass: "css", powershell: "bash", ps1: "bash",
  dockerfile: "bash", docker: "bash", typescript: "javascript", ts: "javascript", tsx: "javascript",
  jsx: "javascript", kotlin: "java", kt: "java", makefile: "bash", make: "bash", cmake: "bash",
};

export function normalizeJiraCodeLanguage(lang?: string | null): string | null {
  if (!lang) return null;
  const l = lang.toLowerCase();
  if (VALID_JIRA_LANGUAGES.has(l)) return l;
  return LANGUAGE_MAPPING[l] ?? null;
}

/** Markdown → Jira wiki markup (Jira Server/DC renderer). */
export function markdownToJiraWiki(md: string): string {
  if (!md) return "";
  const codeBlocks: string[] = [];
  const inlineCodes: string[] = [];

  let out = extractBlocks(
    md,
    /```([\w#+.-]*)\n([\s\S]+?)```/,
    (m) => {
      const lang = normalizeJiraCodeLanguage(m[1]);
      return `{code${lang ? `:${lang}` : ""}}\n${m[2]}{code}`;
    },
    codeBlocks,
    "CODEBLOCK",
  );
  out = extractBlocks(out, /`([^`]+)`/, (m) => `{{${m[1]}}}`, inlineCodes, "INLINECODE");

  // Setext headings: the underline needs text above it, so `\n\n----` stays a horizontal rule.
  out = out.replace(/^(?=[^\n]*\S)(.*?)\n([=-])+$/gm, (_m, text, ch) => `h${ch === "=" ? 1 : 2}. ${text}`);
  // ATX headings need a space after #, which tells them apart from Jira numbered lists.
  out = out.replace(/^(#+) (.*)$/gm, (_m, hashes: string, text) => `h${hashes.length}. ${text}`);

  // Protect link/image targets and autolinks from the emphasis rewrite below.
  const urlTargets: string[] = [];
  const storeUrl = (target: string) => {
    const ph = `\x00MARKDOWNURL${urlTargets.length}\x00`;
    urlTargets.push(target);
    return ph;
  };
  out = out.replace(/(!?\[[^\]\n]*\]\()([^)]+)(\))/g, (_m, a, target, c) => a + storeUrl(target) + c);
  out = out.replace(/<((?:[A-Za-z][A-Za-z0-9+.-]*:[^>\s]+|[^<>\s@]+@[^<>\s@]+))>/g, (_m, target) => `<${storeUrl(target)}>`);

  out = out
    .split("\n")
    .map((line) => {
      // Jira italicises any _word_ span, so escape intraword underscores (snake_case, customfield_10101).
      line = line.replace(/(?<=[^\W_])_+(?=[^\W_])/g, (m) => "\\_".repeat(m.length));
      if (/^[*_]+\s/.test(line)) return line; // list item, not emphasis
      return line.replace(/([*_]+)(.*?)\1/g, (_m, delim: string, inner) => {
        const mark = delim.length === 1 ? "_" : "*";
        return mark + inner + mark;
      });
    })
    .join("\n");
  out = restoreBlocks(out, urlTargets, "MARKDOWNURL");

  // Lists: two spaces of indentation per level.
  out = out.replace(/^(\s+)?[-+*] (.*)$/gm, (_m, ind: string | undefined, text) => `${"*".repeat(Math.floor((ind?.length ?? 0) / 2) + 1)} ${text}`);
  out = out.replace(/^(\s+)?\d+\. (.*)$/gm, (_m, ind: string | undefined, text) => `${"#".repeat(Math.floor((ind?.length ?? 0) / 2) + 1)} ${text}`);

  const tagMap: Record<string, string> = { cite: "??", del: "-", ins: "+", sup: "^", sub: "~" };
  for (const [tag, rep] of Object.entries(tagMap)) {
    out = out.replace(new RegExp(`<${tag}>(.*?)<\\/${tag}>`, "g"), `${rep}$1${rep}`);
  }
  out = out.replace(/<span style="color:(#[^"]+)">([\s\S]*?)<\/span>/g, "{color:$1}$2{color}");
  out = out.replace(/~~(.*?)~~/g, "-$1-");

  out = out.replace(/!\[\]\(([^)\n\s]+)\)/g, "!$1!");
  out = out.replace(/!\[([^\]\n]+)\]\(([^)\n\s]+)\)/g, "!$2|alt=$1!");
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "[$1|$2]");
  out = out.replace(/<([^>]+)>/g, "[$1]");

  // Tables: header row + separator + data rows; cells trimmed.
  const lines = out.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (i < lines.length - 1 && /^\|[-\s|:]+\|$/.test(lines[i + 1]) && /^\|.*\|$/.test(lines[i])) {
      const header = lines[i].split("|").slice(1, -1).map((c) => c.trim());
      lines[i] = `||${header.join("||")}||`;
      lines.splice(i + 1, 1);
      while (i + 1 < lines.length && /^\|.*\|$/.test(lines[i + 1])) {
        const cells = lines[i + 1].split("|").slice(1, -1).map((c) => c.trim());
        lines[i + 1] = `|${cells.join("|")}|`;
        i++;
      }
    }
  }
  out = lines.join("\n");

  out = restoreBlocks(out, codeBlocks, "CODEBLOCK");
  out = restoreBlocks(out, inlineCodes, "INLINECODE");
  return out;
}

function convertPanel(params: string | undefined, content: string): string {
  const title = params?.match(/title=([^|}]+)/)?.[1]?.trim();
  const body = content.trim();
  return title ? `\n**${title}**\n${body}\n` : `\n${body}\n`;
}

/** Jira list marker run (`**`, `#`, `*#`) → indented Markdown list item. */
function jiraListToMarkdown(bullets: string, content: string): string {
  const indent = " ".repeat((bullets.length - 1) * 2);
  return `${indent}${bullets.endsWith("#") ? "1." : "-"} ${content}`;
}

/** Jira mentions and smart links (clean_jira_text steps that need no network). */
function processMentionsAndSmartLinks(text: string, baseUrl = ""): string {
  text = text.replace(/\[~accountid:(.*?)\]/g, (_m, id) => `User:${id}`);
  // DC mentions are [~username]; keep them readable instead of letting the link rule strip brackets.
  text = text.replace(/\[~([^\]|\s]+)\]/g, (_m, user) => `@${user}`);
  return text.replace(/\[(.*?)\|(.*?)\|smart-link\]/g, (_m, linkText: string, url: string) => {
    const issue = new RegExp(`browse/(${ISSUE_KEY})(?=$|[/?#])`).exec(url);
    if (issue) return `[${issue[1]}](${baseUrl ? `${baseUrl}/browse/${issue[1]}` : url.split("?")[0]})`;
    const page = /wiki\/spaces\/.+?\/pages\/\d+\/(.+?)(?:\?|$)/.exec(url);
    if (page) {
      const title = page[1].replace(/\+/g, " ").replace(new RegExp(`^${ISSUE_KEY}\\s+`), "");
      return `[${title}](${url})`;
    }
    return `[${linkText}](${url.split("?")[0]})`;
  });
}

/** Jira wiki markup → Markdown (for reading descriptions, comments, worklogs). */
export function jiraWikiToMarkdown(wiki: string): string {
  if (!wiki) return "";
  let out = processMentionsAndSmartLinks(wiki);

  // Code, noformat and inline code are protected from every later rule.
  const codeBlocks: string[] = [];
  const inlineCodes: string[] = [];
  out = extractBlocks(out, /\{code(?::([a-z]+))?\}([\s\S]*?)\{code\}/m, (m) => `\`\`\`${m[1] ?? ""}\n${m[2]}\n\`\`\``, codeBlocks, "CODEBLOCK");
  out = extractBlocks(out, /\{noformat\}([\s\S]*?)\{noformat\}/, (m) => `\`\`\`\n${m[1]}\n\`\`\``, codeBlocks, "CODEBLOCK");
  out = extractBlocks(out, /\{\{([^}]+)\}\}/, (m) => `\`${m[1]}\``, inlineCodes, "INLINECODE");

  out = out.replace(/^bq\.(.*?)$/gm, "> $1\n");
  // Lists before emphasis, so leading asterisks are not paired with bold delimiters.
  out = out.replace(/^((?:#|-|\+|\*)+) (.*)$/gm, (_m, bullets: string, content: string) => jiraListToMarkdown(bullets, content));
  // Bold / italic; backslash-escaped delimiters are literal.
  out = out.replace(/(?<!\\)([*_])(.*?)(?<!\\)\1/g, (_m, d: string, inner: string) => (d === "*" ? `**${inner}**` : `*${inner}*`));
  out = out.replace(/^h([0-6])\.(.*)$/gm, (_m, n: string, text: string) => "#".repeat(Number(n)) + text);

  // Inline effects. Jira only applies them when the marker hugs non-space text, so require
  // that here too (the upstream regexes also rewrote things like "C++ and C++").
  out = out.replace(/\?\?([^?]+(?:\?[^?]+)*)\?\?/g, "*$1*");
  out = out.replace(/(?<![\w+])\+(\S(?:[^+\n]*\S)?)\+(?![\w+])/g, "$1");
  out = out.replace(/(?<![\w^])\^(\S(?:[^^\n]*\S)?)\^(?![\w^])/g, "<sup>$1</sup>");
  out = out.replace(/(?<![\w~])~(\S(?:[^~\n]*\S)?)~(?![\w~])/g, "<sub>$1</sub>");
  out = out.replace(/(?<![\w-])-(\S(?:[^-\n]*\S)?)-(?![\w-])/g, "~~$1~~");

  out = out.replace(/\{quote\}([\s\S]*)\{quote\}/m, (_m, inner: string) => inner.split("\n").map((l) => `> ${l}`).join("\n"));
  out = out.replace(/\{panel(?::([^}]*))?\}([\s\S]*?)\{panel\}/gm, (_m, params, content) => convertPanel(params, content));
  out = out.replace(/\{(info|note|warning|tip)(?::[^}]*)?\}([\s\S]*?)\{\1\}/gm, (_m, kind: string, content: string) =>
    `\n> **${kind[0].toUpperCase()}${kind.slice(1)}:** ${content.trim().split("\n").join("\n> ")}\n`);

  out = out.replace(/!([^|\n\s]+)\|([^\n!]*)alt=([^\n!,]+?)(,([^\n!]*))?!/g, "![$3]($1)");
  out = out.replace(/!([^|\n\s]+)\|([^\n!]*)!/g, "![]($1)");
  out = out.replace(/!([^\n\s!]+)!/g, "![]($1)");

  out = out.replace(/\[([^|\]]+)\|(.+?)\]/g, "[$1]($2)");
  out = out.replace(/\[([^[\]\n]+)\]([^(]|$)/gm, "$1$2");
  out = out.replace(/\{color:[^}]+\}([\s\S]*?)\{color\}/gm, "$1");

  // Tables: header || → |, plus a separator row.
  const lines = out.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes("||")) {
      lines[i] = lines[i].split("||").join("|");
      const cells = (lines[i].match(/\|/g)?.length ?? 0) - 1;
      if (cells > 0) {
        lines.splice(i + 1, 0, `|${"---|".repeat(cells)}`);
        i++;
      }
    }
  }
  out = lines.join("\n");

  out = restoreBlocks(out, codeBlocks, "CODEBLOCK");
  out = restoreBlocks(out, inlineCodes, "INLINECODE");
  return out.trim();
}

// =============================================================================
// Confluence storage format
// =============================================================================

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function cdata(s: string): string {
  return `<![CDATA[${s.split("]]>").join("]]]]><![CDATA[>")}]]>`;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** A bare filename (no scheme, no leading slash, no data: URL) refers to a page attachment. */
function isAttachmentSource(src: string): boolean {
  return !!src && !/^[a-z][a-z0-9+.-]*:/i.test(src) && !src.startsWith("/") && !src.startsWith("#") && !src.startsWith("//");
}

/** Storage-format renderer: XHTML void tags, code macro, ac:image, ac:task-list. */
const storageMarked = new Marked({
  gfm: true,
  renderer: {
    code({ text, lang }: Tokens.Code) {
      const language = (lang ?? "").trim().split(/\s+/)[0];
      const param = language ? `<ac:parameter ac:name="language">${escapeXml(language)}</ac:parameter>` : "";
      return `<ac:structured-macro ac:name="code">${param}<ac:plain-text-body>${cdata(text)}</ac:plain-text-body></ac:structured-macro>\n`;
    },
    image({ href, title, text }: Tokens.Image) {
      const alt = text ? ` ac:alt="${escapeXml(text)}"` : "";
      const t = title ? ` ac:title="${escapeXml(title)}"` : "";
      const target = isAttachmentSource(href)
        ? `<ri:attachment ri:filename="${escapeXml(safeDecode(href))}" />`
        : `<ri:url ri:value="${escapeXml(href)}" />`;
      return `<ac:image${alt}${t}>${target}</ac:image>`;
    },
    br() {
      return "<br />";
    },
    hr() {
      return "<hr />\n";
    },
    checkbox({ checked }: Tokens.Checkbox) {
      // Only reached for lists that mix task and plain items: keep the marker as text.
      return checked ? "[x] " : "[ ] ";
    },
    list(token: Tokens.List) {
      if (token.ordered || token.items.length === 0 || !token.items.every((i) => i.task)) return false;
      const tasks = token.items.map((item) => {
        const tokens = item.tokens.flatMap((t: any) =>
          t.type === "checkbox" ? [] : t.tokens && (t.type === "text" || t.type === "paragraph")
            ? [{ ...t, tokens: t.tokens.filter((x: any) => x.type !== "checkbox") }]
            : [t],
        );
        const body = this.parser.parse(tokens).trim().replace(/^<p>([\s\S]*)<\/p>$/, "$1");
        return `<ac:task><ac:task-status>${item.checked ? "complete" : "incomplete"}</ac:task-status><ac:task-body>${body}</ac:task-body></ac:task>`;
      });
      return `<ac:task-list>${tasks.join("")}</ac:task-list>\n`;
    },
  },
});

/** Markdown → Confluence storage format (XHTML with ac:/ri: elements). */
export function markdownToStorage(md: string): string {
  if (!md) return "";
  const html = storageMarked.parse(md, { async: false }) as string;
  // Raw <img>/<br>/<hr> written inline in the Markdown must be well-formed XML as well
  // (outside CDATA: code bodies are kept byte for byte).
  return html
    .split(/(<!\[CDATA\[[\s\S]*?\]\]>)/)
    .map((part) => (part.startsWith("<![CDATA[") ? part : part.replace(/<(br|hr|img)(\s[^<>]*?)?\s*(?<!\/)>/gi, (_m, tag, attrs = "") => `<${tag}${attrs} />`)))
    .join("")
    .trim();
}

export interface StorageToMarkdownOptions {
  /** Instance base URL, used to build attachment download links for images. */
  baseUrl?: string;
  /** Page id, used to build attachment download links for images. */
  pageId?: string;
}

const PANEL_MACROS = new Set(["info", "note", "warning", "tip", "panel"]);

function macroName(node: any): string {
  return String(node.getAttribute?.("ac:name") ?? "").toLowerCase();
}

function childByName(node: any, name: string): any | undefined {
  return Array.from(node.childNodes ?? []).find((c: any) => c.nodeName === name);
}

function macroParam(node: any, name: string): string | undefined {
  for (const c of Array.from(node.childNodes ?? []) as any[]) {
    if (c.nodeName === "AC:PARAMETER" && String(c.getAttribute("ac:name")).toLowerCase() === name) return c.textContent;
  }
  return undefined;
}

function cellText(cell: any, td: TurndownService): string {
  return td.turndown(cell.innerHTML ?? "").replace(/\n+/g, " ").replace(/\|/g, "\\|").trim();
}

type Rule = { filter: (n: any) => boolean; replacement: (content: string, node: any) => string };

function buildTurndown(opts: StorageToMarkdownOptions, codeBodies: string[]): TurndownService {
  // Turndown drops elements without text (ac:image, an ac:link to a page, ri:user) through its
  // blank rule before any custom rule runs, so those rules are also consulted for blank nodes.
  const blankAware: Rule[] = [];
  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    emDelimiter: "*",
    blankReplacement: (content: string, node: any) => {
      for (let i = blankAware.length - 1; i >= 0; i--) {
        if (blankAware[i].filter(node)) return blankAware[i].replacement(content, node);
      }
      // keep what the children produced (e.g. a paragraph holding only an ac:image)
      return node.isBlock ? `\n\n${content}\n\n` : content;
    },
  });
  const addRule = (key: string, rule: Rule) => {
    blankAware.push(rule);
    td.addRule(key, rule as any);
  };

  // turndown tries the most recently added rule first, so the catch-all macro rules come first.
  // Any other macro: keep its body text, drop parameters.
  addRule("otherMacro", {
    filter: (n: any) => n.nodeName === "AC:STRUCTURED-MACRO" || n.nodeName === "AC:MACRO",
    replacement: (_c: string, n: any) => {
      const rich = childByName(n, "AC:RICH-TEXT-BODY");
      if (rich) return `\n\n${td.turndown(rich.innerHTML ?? "")}\n\n`;
      const plain = childByName(n, "AC:PLAIN-TEXT-BODY");
      const text = plain?.textContent?.replace(/@@PTB(\d+)@@/g, (_m: string, i: string) => codeBodies[Number(i)] ?? "");
      return text ? `\n\n${text}\n\n` : "";
    },
  });
  addRule("macroParameter", { filter: (n: any) => n.nodeName === "AC:PARAMETER", replacement: () => "" });

  addRule("codeMacro", {
    filter: (n: any) => n.nodeName === "AC:STRUCTURED-MACRO" && ["code", "noformat"].includes(macroName(n)),
    replacement: (_c: string, n: any) => {
      const lang = macroParam(n, "language") ?? "";
      const raw = childByName(n, "AC:PLAIN-TEXT-BODY")?.textContent ?? "";
      const body = raw.replace(/@@PTB(\d+)@@/g, (_m: string, i: string) => codeBodies[Number(i)] ?? "");
      return `\n\n\`\`\`${lang}\n${body.replace(/\n$/, "")}\n\`\`\`\n\n`;
    },
  });

  addRule("panelMacro", {
    filter: (n: any) => n.nodeName === "AC:STRUCTURED-MACRO" && PANEL_MACROS.has(macroName(n)),
    replacement: (_c: string, n: any) => {
      const kind = macroName(n);
      const title = macroParam(n, "title");
      const label = title ? title : kind === "panel" ? "" : kind[0].toUpperCase() + kind.slice(1);
      const body = td.turndown(childByName(n, "AC:RICH-TEXT-BODY")?.innerHTML ?? "").trim();
      const quoted = body.split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n");
      return `\n\n${label ? `> **${label}:**\n>\n` : ""}${quoted}\n\n`;
    },
  });

  addRule("jiraMacro", {
    filter: (n: any) => n.nodeName === "AC:STRUCTURED-MACRO" && macroName(n) === "jira",
    replacement: (_c: string, n: any) => {
      const key = macroParam(n, "key");
      return key ? `[JIRA:${key}]` : `[JIRA:${macroParam(n, "jqlquery") ?? ""}]`;
    },
  });

  addRule("image", {
    filter: (n: any) => n.nodeName === "AC:IMAGE",
    replacement: (_c: string, n: any) => {
      const alt = n.getAttribute("ac:alt") ?? "";
      const att = childByName(n, "RI:ATTACHMENT");
      const url = childByName(n, "RI:URL");
      let src = "";
      if (att) {
        const file = att.getAttribute("ri:filename") ?? "";
        src = opts.baseUrl && opts.pageId
          ? `${opts.baseUrl.replace(/\/+$/, "")}/download/attachments/${opts.pageId}/${encodeURIComponent(file)}`
          : file;
      } else if (url) {
        src = url.getAttribute("ri:value") ?? "";
      }
      return src ? `![${alt}](${src})` : "";
    },
  });

  addRule("link", {
    filter: (n: any) => n.nodeName === "AC:LINK",
    replacement: (_c: string, n: any) => {
      const page = childByName(n, "RI:PAGE");
      const user = childByName(n, "RI:USER");
      const att = childByName(n, "RI:ATTACHMENT");
      const body = (childByName(n, "AC:PLAIN-TEXT-LINK-BODY") ?? childByName(n, "AC:LINK-BODY"))?.textContent?.trim();
      if (user) return `@${user.getAttribute("ri:username") ?? user.getAttribute("ri:userkey") ?? ""}`;
      if (page) return body || page.getAttribute("ri:content-title") || "";
      if (att) return body || att.getAttribute("ri:filename") || "";
      return body ?? "";
    },
  });
  addRule("bareUser", {
    filter: (n: any) => n.nodeName === "RI:USER",
    replacement: (_c: string, n: any) => `@${n.getAttribute("ri:username") ?? n.getAttribute("ri:userkey") ?? ""}`,
  });

  addRule("taskList", {
    filter: (n: any) => n.nodeName === "AC:TASK-LIST",
    replacement: (_c: string, n: any) => {
      const items = (Array.from(n.childNodes) as any[]).filter((c) => c.nodeName === "AC:TASK").map((task) => {
        const done = String(childByName(task, "AC:TASK-STATUS")?.textContent ?? "").trim() === "complete";
        const body = td.turndown(childByName(task, "AC:TASK-BODY")?.innerHTML ?? "").replace(/\n+/g, " ").trim();
        return `- [${done ? "x" : " "}] ${body}`;
      });
      return `\n\n${items.join("\n")}\n\n`;
    },
  });

  td.addRule("table", {
    filter: "table",
    replacement: (_c: string, n: any) => {
      const rows = (Array.from(n.querySelectorAll("tr")) as any[]).map((tr) =>
        (Array.from(tr.childNodes) as any[]).filter((c) => c.nodeName === "TH" || c.nodeName === "TD").map((c) => cellText(c, td)),
      );
      if (rows.length === 0) return "";
      const width = Math.max(...rows.map((r) => r.length));
      const pad = (r: string[]) => [...r, ...Array(width - r.length).fill("")];
      const [head, ...body] = rows.map(pad);
      return `\n\n| ${head.join(" | ")} |\n|${" --- |".repeat(width)}\n${body.map((r) => `| ${r.join(" | ")} |`).join("\n")}\n\n`.replace(/\n\n\n$/, "\n\n");
    },
  });

  return td;
}

/**
 * The HTML parser behind turndown does not know XML: expand self-closing ac:/ri: elements
 * (otherwise they swallow their following siblings) and turn CDATA into escaped text.
 * Plain-text macro bodies (code) are lifted out as placeholders, because turndown collapses
 * whitespace in every element except <pre>.
 */
function prepareStorage(storage: string, codeBodies: string[]): string {
  return storage
    .replace(/(<ac:plain-text-body>)\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*(<\/ac:plain-text-body>)/g, (_m, open: string, body: string, close: string) => {
      codeBodies.push(body);
      return `${open}@@PTB${codeBodies.length - 1}@@${close}`;
    })
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_m, body: string) => escapeXml(body))
    .replace(/<((?:ac|ri):[\w-]+)(\s[^<>]*?)?\s*\/>/g, (_m, tag: string, attrs = "") => `<${tag}${attrs}></${tag}>`)
    // Text-less elements get an invisible marker so turndown's whitespace collapsing keeps the
    // spaces around them; tidy() removes it again.
    .replace(/<(ac:image|ac:link|ri:user)(\s[^<>]*)?>/g, `$&${ZWSP}`);
}

const ZWSP = "\u200b";

/** Remove whitespace-only lines and extra blank lines outside fenced code. */
function tidy(md: string): string {
  return md
    .split(ZWSP)
    .join("")
    .split(/(^```[^\n]*\n[\s\S]*?^```$)/m)
    .map((part) => (part.startsWith("```") ? part : part.replace(/^[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n")))
    .join("")
    .trim();
}

/** Confluence storage format → Markdown (for reading pages and comments). */
export function storageToMarkdown(storage: string, opts: StorageToMarkdownOptions = {}): string {
  if (!storage) return "";
  const codeBodies: string[] = [];
  const prepared = prepareStorage(storage, codeBodies);
  return tidy(buildTurndown(opts, codeBodies).turndown(prepared));
}
