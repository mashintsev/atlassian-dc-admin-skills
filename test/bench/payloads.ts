/**
 * Deterministic Data Center REST payloads for the read-token benchmark: the shapes Jira, Jira Service
 * Management, Assets and Confluence return, with the waste the formatter has to remove (self links,
 * avatar URLs, expand strings, null custom fields, _links/_expandable, profile pictures). The fake
 * server honors `fields`, `maxResults`/`limit` and `expand` like the products, so a tool is measured
 * on what it actually requests. Names are abstract.
 */

import { readFileSync } from "node:fs";
import type { Call } from "../unit/helpers.js";

const J = "https://jira.example.com";
const W = "https://wiki.example.com";
const fixture = (path: string) => JSON.parse(readFileSync(new URL(`../fixtures/${path}`, import.meta.url), "utf8"));

// ---- building blocks ----

const WORDS = ["The", "service", "returns", "an", "error", "when", "the", "request", "contains", "several", "attachments", "and", "a", "long", "description", "field."];
export const lorem = (n: number) => Array.from({ length: n }, (_, i) => WORDS[i % WORDS.length]).join(" ");
const wiki = (paras: number) =>
  Array.from({ length: paras }, (_, i) => `h2. Section ${i}\n\n${lorem(60)}\n\n* item one\n* item two\n{code:java}\nSystem.out.println("x${i}");\n{code}`).join("\n\n");
const avatars = (owner: string) => Object.fromEntries(["48x48", "24x24", "16x16", "32x32"].map((s) => [s, `${J}/secure/useravatar?size=${s}&ownerId=${owner}&avatarId=10300`]));

export const user = (i: number) => ({
  self: `${J}/rest/api/2/user?username=user${i}`, key: `JIRAUSER${10000 + i}`, name: `user${i}`, emailAddress: `user${i}@example.com`,
  avatarUrls: avatars(`user${i}`), displayName: `User Number ${i}`, active: true, timeZone: "Europe/Berlin",
});
const status = {
  self: `${J}/rest/api/2/status/3`, description: "This issue is being actively worked on at the moment by the assignee.",
  iconUrl: `${J}/images/icons/statuses/inprogress.png`, name: "In Progress", id: "3",
  statusCategory: { self: `${J}/rest/api/2/statuscategory/4`, id: 4, key: "indeterminate", colorName: "yellow", name: "In Progress" },
};
const issuetype = { self: `${J}/rest/api/2/issuetype/10002`, id: "10002", description: "A task that needs to be done.", iconUrl: `${J}/secure/viewavatar?size=xsmall&avatarId=10318&avatarType=issuetype`, name: "Task", subtask: false, avatarId: 10318 };
export const project = (i: number) => ({
  expand: "description,lead,url,projectKeys", self: `${J}/rest/api/2/project/${10000 + i}`, id: String(10000 + i), key: `PRJ${i}`, name: `Project number ${i}`,
  avatarUrls: Object.fromEntries(["48x48", "24x24", "16x16", "32x32"].map((s) => [s, `${J}/secure/projectavatar?size=${s}&pid=${10000 + i}&avatarId=10324`])),
  projectCategory: { self: `${J}/rest/api/2/projectCategory/10000`, id: "10000", name: "Delivery", description: "Delivery projects" }, projectTypeKey: "software", archived: false,
});
const comment = (i: number, words = 80) => ({
  self: `${J}/rest/api/2/issue/10001/comment/${20000 + i}`, id: String(20000 + i), author: user(i % 7), body: lorem(words),
  updateAuthor: user(i % 7), created: "2026-09-01T10:00:00.000+0200", updated: "2026-09-01T10:00:00.000+0200",
});
const slaField = {
  id: "1", name: "Time to resolution", _links: { self: `${J}/rest/servicedeskapi/request/1/sla/1` },
  completedCycles: Array.from({ length: 3 }, (_, i) => ({ startTime: { epochMillis: 1780000000000 + i, friendly: "Today 10:00", iso8601: "2026-09-01T10:00:00+0200", jira: "2026-09-01T10:00:00.000+0200" }, stopTime: { epochMillis: 1780003600000, friendly: "Today 11:00", iso8601: "2026-09-01T11:00:00+0200", jira: "2026-09-01T11:00:00.000+0200" }, breached: false, goalDuration: { millis: 28800000, friendly: "8h" }, elapsedTime: { millis: 3600000, friendly: "1h" }, remainingTime: { millis: 25200000, friendly: "7h" } })),
  ongoingCycle: { startTime: { epochMillis: 1780000000000, friendly: "Today 10:00", iso8601: "2026-09-01T10:00:00+0200", jira: "2026-09-01T10:00:00.000+0200" }, breachTime: { epochMillis: 1780028800000, friendly: "Today 18:00", iso8601: "2026-09-01T18:00:00+0200", jira: "2026-09-01T18:00:00.000+0200" }, breached: false, paused: false, withinCalendarHours: true, goalDuration: { millis: 28800000, friendly: "8h" }, elapsedTime: { millis: 3600000, friendly: "1h" }, remainingTime: { millis: 25200000, friendly: "7h" } },
};

export function issue(i: number, opts: { comments?: number; customFields?: number; descParas?: number; sla?: boolean } = {}) {
  const custom: Record<string, unknown> = {};
  for (let c = 0; c < (opts.customFields ?? 60); c++) {
    custom[`customfield_${10000 + c}`] = c % 6 === 0 ? { self: `${J}/rest/api/2/customFieldOption/${c}`, value: `Option ${c}`, id: String(c) } : c % 5 === 0 ? `value ${c}` : null;
  }
  if (opts.sla) {
    custom.customfield_10900 = slaField;
    custom.customfield_10901 = { _links: { jiraRest: `${J}/rest/api/2/issuetype/10002`, self: `${J}/rest/servicedeskapi/servicedesk/3/requesttype/12` }, id: "12", name: "Get IT help", description: lorem(20), helpText: lorem(15), issueTypeId: "10002", serviceDeskId: "3", groupIds: ["1"], icon: { id: "10500", _links: { iconUrls: avatars("rt") } } };
  }
  return {
    expand: "operations,versionedRepresentations,editmeta,changelog,renderedFields", id: String(10000 + i), self: `${J}/rest/api/2/issue/${10000 + i}`, key: `PRJ1-${i}`,
    fields: {
      summary: `Issue number ${i}: fix the error on the request page`, issuetype, project: project(1), status,
      priority: { self: `${J}/rest/api/2/priority/3`, iconUrl: `${J}/images/icons/priorities/major.svg`, name: "Major", id: "3" },
      assignee: user(i % 9), reporter: user((i + 1) % 9), creator: user((i + 2) % 9),
      created: "2026-08-01T10:00:00.000+0200", updated: "2026-09-20T10:00:00.000+0200",
      labels: ["backend", "customer"], components: [{ self: `${J}/rest/api/2/component/10100`, id: "10100", name: "API" }],
      fixVersions: [{ self: `${J}/rest/api/2/version/10200`, id: "10200", name: "1.4", archived: false, released: false }],
      description: wiki(opts.descParas ?? 3), resolution: null, resolutiondate: null, duedate: null, environment: null,
      timespent: null, timeestimate: null, aggregatetimespent: null,
      watches: { self: `${J}/rest/api/2/issue/PRJ1-${i}/watchers`, watchCount: 2, isWatching: false },
      votes: { self: `${J}/rest/api/2/issue/PRJ1-${i}/votes`, votes: 0, hasVoted: false },
      comment: { comments: Array.from({ length: opts.comments ?? 0 }, (_, c) => comment(c)), maxResults: opts.comments ?? 0, total: opts.comments ?? 0, startAt: 0 },
      worklog: { startAt: 0, maxResults: 20, total: 0, worklogs: [] }, attachment: [], issuelinks: [], subtasks: [], lastViewed: null, workratio: -1,
      ...custom,
    },
  };
}

/** Jira returns only the requested fields (all of them for *all or no list). */
export function onlyFields(iss: any, q: URLSearchParams) {
  const want = q.get("fields");
  if (!want || want.split(",").some((f) => f === "*all" || f === "*navigable")) return iss;
  const keep = new Set(want.split(","));
  return { ...iss, fields: Object.fromEntries(Object.entries(iss.fields).filter(([k]) => keep.has(k))) };
}

export const changelog = (n: number) => ({
  startAt: 0, maxResults: n, total: n,
  histories: Array.from({ length: n }, (_, h) => ({
    id: String(h), author: user(h % 5), created: "2026-09-01T10:00:00.000+0200",
    items: [
      { field: "description", fieldtype: "jira", from: null, fromString: wiki(2), to: null, toString: wiki(2) },
      { field: "status", fieldtype: "jira", from: "1", fromString: "Open", to: "3", toString: "In Progress" },
    ],
  })),
});

const field = (i: number) => ({ id: `customfield_${10000 + i}`, name: `Custom field ${i}`, custom: true, orderable: true, navigable: true, searchable: true, clauseNames: [`cf[${10000 + i}]`, `Custom field ${i}`], schema: { type: "option", custom: "com.atlassian.jira.plugin.system.customfieldtypes:select", customId: 10000 + i } });
const customField = (i: number) => ({
  id: `customfield_${10000 + i}`, self: `${J}/rest/api/2/customFields/${10000 + i}`, numericId: 10000 + i, name: `Custom field ${i}`, description: lorem(20),
  type: "Select List (single choice)", searcherKey: "com.atlassian.jira.plugin.system.customfieldtypes:multiselectsearcher", projectIds: [], issueTypeIds: [],
  isAllProjects: true, isLocked: false, isManaged: false, isTrusted: true, projectsCount: 0, screensCount: 3, lastValueUpdate: 1780000000000, issuesWithValue: i * 7,
});
const plugin = (i: number) => ({
  enabled: true, name: `Vendor App ${i}`, version: `1.${i}.0`, userInstalled: i % 3 === 0, optional: true, static: false, unloadable: false, description: lorem(30), key: `com.vendor.app${i}`,
  usesLicensing: i % 3 === 0, remotable: false, vendor: { name: "Vendor Ltd", marketplaceLink: "https://marketplace.atlassian.com/vendors/1", link: "https://vendor.example.com" }, applicationKey: "jira", applicationPluginType: "primary",
  links: { self: `/rest/plugins/1.0/com.vendor.app${i}-key`, "plugin-summary": `/rest/plugins/1.0/com.vendor.app${i}-key/summary`, modify: `/rest/plugins/1.0/com.vendor.app${i}-key`, "plugin-icon": `/rest/plugins/servlet/upm/plugin-icon/com.vendor.app${i}`, manage: `/plugins/servlet/upm#manage/com.vendor.app${i}` },
});
const auditEvent = (i: number) => ({
  author: { name: `user${i % 5}`, type: "user", id: `JIRAUSER${10000 + (i % 5)}`, uri: `${J}/secure/ViewProfile.jspa?name=user${i % 5}`, avatarUri: `${J}/secure/useravatar?ownerId=user${i % 5}` },
  type: { categoryId: "user.management", category: "User management", actionId: "jira.auditing.user.updated", action: "User updated", level: "BASE", area: "USER_MANAGEMENT" },
  affectedObjects: [{ name: `user${i}`, type: "USER", uri: `${J}/secure/ViewProfile.jspa?name=user${i}`, id: `JIRAUSER${i}` }],
  changedValues: i % 10 === 0
    ? [{ key: "Workflow", from: `<workflow>${"<step id='1'/>".repeat(800)}</workflow>`, to: `<workflow>${"<step id='2'/>".repeat(800)}</workflow>` }]
    : [{ key: "Email", from: `old${i}@example.com`, to: `new${i}@example.com` }, { key: "Full name", from: "Old Name", to: "New Name" }],
  source: "10.0.0.1", system: J, node: "node1", method: "Browser", timestamp: "2026-09-01T10:00:00.000Z",
  attributes: [{ nameI18nKey: "atlassian.audit.event.attribute.useragent", name: "User agent", value: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36" }],
});

const storage = (sections: number) => Array.from({ length: sections }, (_, i) =>
  `<h2>Section ${i}</h2><p>${lorem(70)}</p>` +
  `<ac:structured-macro ac:name="info" ac:schema-version="1" ac:macro-id="a${i}"><ac:rich-text-body><p>${lorem(20)}</p></ac:rich-text-body></ac:structured-macro>` +
  `<table class="wrapped"><colgroup><col /><col /></colgroup><tbody><tr><th>Key</th><th>Value</th></tr>${Array.from({ length: 6 }, (_, r) => `<tr><td>row ${r}</td><td><ac:link><ri:user ri:userkey="8a7f80${r}" /></ac:link></td></tr>`).join("")}</tbody></table>` +
  `<ac:image ac:height="250"><ri:attachment ri:filename="diagram-${i}.png" /></ac:image>`).join("");
const cuser = (i: number) => ({ type: "known", username: `user${i}`, userKey: `8a7f808a${i}`, profilePicture: { path: "/images/icons/profilepics/default.svg", width: 48, height: 48, isDefault: true }, displayName: `User Number ${i}`, _links: { self: `${W}/rest/api/user?key=8a7f808a${i}` }, _expandable: { status: "" } });
const space = (i: number) => ({
  id: 100 + i, key: `SP${i}`, name: `Space number ${i}`, icon: { path: "/images/logo/default-space-logo-256.png", width: 48, height: 48, isDefault: false },
  description: { plain: { value: lorem(25), representation: "plain" } }, type: "global", status: "current",
  _links: { webui: `/display/SP${i}`, self: `${W}/rest/api/space/SP${i}` },
  _expandable: { metadata: "", operations: "", lookAndFeel: "", permissions: "", homepage: `/rest/api/content/${1000 + i}`, settings: "", theme: "", history: "" },
});
export const content = (i: number, sections = 0) => ({
  id: String(5000 + i), type: "page", status: "current", title: `Page number ${i} about the request process`,
  space: { id: 101, key: "SP1", name: "Space number 1", type: "global", status: "current", _links: { webui: "/display/SP1", self: `${W}/rest/api/space/SP1` }, _expandable: { metadata: "", icon: "", description: "", homepage: "/rest/api/content/1001" } },
  history: { latest: true, createdBy: cuser(1), createdDate: "2026-01-01T10:00:00.000+01:00", _links: { self: `${W}/rest/api/content/${5000 + i}/history` }, _expandable: { lastUpdated: "", previousVersion: "", contributors: "", nextVersion: "" } },
  version: { by: cuser(2), when: "2026-09-01T10:00:00.000+02:00", message: "", number: 7, minorEdit: false, hidden: false, _links: { self: `${W}/rest/experimental/content/${5000 + i}/version/7` }, _expandable: { content: `/rest/api/content/${5000 + i}` } },
  ancestors: [1, 2, 3].map((a) => ({ id: String(900 + a), type: "page", status: "current", title: `Ancestor ${a}`, _links: { webui: `/pages/viewpage.action?pageId=${900 + a}`, self: `${W}/rest/api/content/${900 + a}` }, _expandable: { children: "", history: "", space: "" } })),
  ...(sections ? { body: { storage: { value: storage(sections), representation: "storage", _expandable: { content: "" } }, _expandable: { view: "", export_view: "", styled_view: "", anonymous_export_view: "" } } } : {}),
  extensions: { position: "none" },
  _links: { webui: `/pages/viewpage.action?pageId=${5000 + i}`, edit: `/pages/resumedraft.action?draftId=${5000 + i}`, tinyui: "/x/AbCd", collection: "/rest/api/content", base: W, context: "", self: `${W}/rest/api/content/${5000 + i}` },
  _expandable: { container: "/rest/api/space/SP1", metadata: "", operations: "", children: `/rest/api/content/${5000 + i}/child`, restrictions: "", descendants: "" },
});

/** An Assets object with `attrs` attributes; every fifth one is a long text area. */
const assetsObject = (i: number, attrs: number) => ({
  id: 3000 + i, label: `Laptop ${i}`, objectKey: `ITSM-${3000 + i}`,
  avatar: { url16: `${J}/rest/insight/1.0/objecttype/23/icon.png?size=16`, url48: `${J}/rest/insight/1.0/objecttype/23/icon.png?size=48`, url72: `${J}/rest/insight/1.0/objecttype/23/icon.png?size=72`, url144: `${J}/rest/insight/1.0/objecttype/23/icon.png?size=144`, url288: `${J}/rest/insight/1.0/objecttype/23/icon.png?size=288`, objectId: 3000 + i },
  objectType: { id: 23, name: "Laptop", type: 0, icon: { id: 1, name: "Laptop", url16: `${J}/x16`, url48: `${J}/x48` }, position: 0, created: "2026-01-01T10:00:00.000Z", updated: "2026-01-01T10:00:00.000Z", objectCount: 0, objectSchemaId: 3, inherited: false, abstractObjectType: false, parentObjectTypeInherited: false },
  created: "2026-01-01T10:00:00.000Z", updated: "2026-09-01T10:00:00.000Z", hasAvatar: false, timestamp: 1780000000000,
  attributes: Array.from({ length: attrs }, (_, a) => ({
    id: 90000 + i * 100 + a, objectTypeAttributeId: 500 + a, objectId: 3000 + i,
    objectAttributeValues: [{ value: a % 5 === 0 ? lorem(120) : `Value ${a}`, displayValue: a % 5 === 0 ? lorem(120) : `Value ${a}`, searchValue: `Value ${a}`, referencedType: false }],
  })),
  _links: { self: `${J}/secure/insight/assets/ITSM-${3000 + i}` }, name: `Laptop ${i}`,
});

// ---- the fake server ----

type Route = [RegExp, (c: Call, q: URLSearchParams) => unknown];
const num = (q: URLSearchParams, key: string, dflt: number) => Number(q.get(key) ?? dflt);

/** Projects for scans and the shared workflow. */
const SHARED_PROJECTS = 1200;

const ROUTES: Route[] = [
  [/^\/rest\/api\/2\/serverInfo$/, () => ({ version: "10.3.8", versionNumbers: [10, 3, 8], deploymentType: "Server", buildNumber: 100000, serverTitle: "Jira" })],
  [/^\/rest\/api\/2\/search$/, (_c, q) => ({ expand: "schema,names", startAt: 0, maxResults: num(q, "maxResults", 50), total: 1234, issues: Array.from({ length: num(q, "maxResults", 50) }, (_, i) => onlyFields(issue(i), q)) })],
  [/^\/rest\/api\/2\/issue\/[^/]+\/comment$/, (_c, q) => ({ startAt: 0, maxResults: num(q, "maxResults", 50), total: 80, comments: Array.from({ length: num(q, "maxResults", 50) }, (_, i) => comment(i, 150)) })],
  [/^\/rest\/api\/2\/issue\/[^/]+$/, (_c, q) => ({ ...onlyFields(issue(1, { comments: 30, descParas: 8 }), q), ...(q.get("expand")?.includes("changelog") ? { changelog: changelog(20) } : {}) })],
  [/^\/rest\/api\/2\/project$/, () => Array.from({ length: 800 }, (_, i) => project(i))],
  [/^\/rest\/api\/2\/project\/[^/]+$/, () => ({ ...project(1), issueTypes: [issuetype] })],
  [/^\/rest\/api\/2\/field$/, () => Array.from({ length: 900 }, (_, i) => field(i))],
  [/^\/rest\/api\/2\/customFields$/, (_c, q) => ({ maxResults: num(q, "maxResults", 50), startAt: 1, total: 900, isLast: false, values: Array.from({ length: num(q, "maxResults", 50) }, (_, i) => customField(i)) })],
  [/^\/rest\/api\/2\/user\/search$/, (_c, q) => Array.from({ length: num(q, "maxResults", 50) }, (_, i) => user(i))],
  [/^\/rest\/api\/2\/group\/member$/, (_c, q) => ({ self: `${J}/rest/api/2/group/member`, maxResults: num(q, "maxResults", 50), startAt: num(q, "startAt", 0), total: 600, isLast: false, values: Array.from({ length: num(q, "maxResults", 50) }, (_, i) => user(i)) })],
  [/^\/rest\/api\/2\/issuetype$/, () => Array.from({ length: 40 }, (_, i) => ({ ...issuetype, id: String(10000 + i), name: `Type ${i}` }))],
  [/^\/rest\/api\/2\/workflow$/, () => Array.from({ length: 300 }, (_, i) => ({ name: `Workflow ${i}`, description: lorem(15), lastModifiedDate: "01/Sep/26 10:00 AM", lastModifiedUser: "User Number 1", lastModifiedUserName: "user1", steps: 6, default: false }))],
  [/^\/rest\/api\/2\/workflow\/transitions\/\d+\/properties$/, () => []],
  [/^\/rest\/projectconfig\/1\/issuetype\/[^/]+\/[^/]+\/workflow$/, () => ({
    ...fixture("jira11/projectconfig-issuetype-workflow.json"),
    sharedWithProjects: Array.from({ length: SHARED_PROJECTS }, (_, i) => ({ id: 10000 + i, key: `PRJ${i}`, name: `Project number ${i}`, archived: false })),
    totalProjectsCount: SHARED_PROJECTS,
  })],
  [/^\/rest\/workflowDesigner\/1\.0\/workflows$/, () => fixture("jira11/workflow-designer.json")],
  [/^\/rest\/workflowDesigner\/1\.0\/statusCategories$/, () => fixture("jira11/workflow-status-categories.json")],
  [/^\/rest\/plugins\/1\.0\/$/, () => ({ plugins: Array.from({ length: 400 }, (_, i) => plugin(i)), links: {} })],
  [/^\/rest\/auditing\/1\.0\/events$/, (_c, q) => ({ entities: Array.from({ length: num(q, "limit", 200) }, (_, i) => auditEvent(i)), pagingInfo: { nextPageCursor: "abc", size: num(q, "limit", 200), limit: num(q, "limit", 200) } })],
  [/^\/rest\/servicedeskapi\/servicedesk\/\d+\/queue\/\d+\/issue$/, (_c, q) => ({ size: num(q, "limit", 50), start: 0, limit: num(q, "limit", 50), isLastPage: false, values: Array.from({ length: num(q, "limit", 50) }, (_, i) => issue(i, { customFields: 0, sla: true })) })],
  [/^\/rest\/insight\/1\.0\/aql\/objects$/, (_c, q) => ({
    objectEntries: Array.from({ length: num(q, "resultPerPage", 25) }, (_, i) => assetsObject(i, 60)),
    objectTypeAttributes: Array.from({ length: 60 }, (_, a) => ({ id: 500 + a, name: `Attribute ${a}`, label: a === 0, type: 0, defaultType: { id: a % 5 === 0 ? 9 : 0, name: a % 5 === 0 ? "Textarea" : "Text" }, editable: true, system: false, sortable: true, summable: false, indexed: true, minimumCardinality: 0, maximumCardinality: 1, removable: true, hidden: false, includeChildObjectTypes: false, uniqueAttribute: false, options: "", position: a })),
    totalFilterCount: 4000, pageSize: 160, pageNumber: 1, toIndex: 25, fromIndex: 1,
  })],
  [/^\/rest\/api\/search$/, (_c, q) => ({
    results: Array.from({ length: num(q, "limit", 25) }, (_, i) => ({ content: content(i), title: `Page number ${i}`, excerpt: lorem(40), url: `/x/${i}`, resultGlobalContainer: { title: "Space number 1", displayUrl: "/display/SP1" }, entityType: "content", lastModified: "2026-09-01T10:00:00.000+02:00", score: 0 })),
    start: 0, limit: num(q, "limit", 25), size: num(q, "limit", 25), totalSize: 900, _links: { base: W },
  })],
  [/^\/rest\/api\/content\/\d+\/child\/page$/, (_c, q) => ({ results: Array.from({ length: num(q, "limit", 25) }, (_, i) => content(i)), start: 0, limit: num(q, "limit", 25), size: num(q, "limit", 25), _links: { base: W } })],
  // page 5999 is a long runbook; every other page has 12 sections
  [/^\/rest\/api\/content\/\d+$/, (c) => content(1, c.url.includes("/5999") ? 80 : 12)],
  [/^\/rest\/api\/space$/, (_c, q) => ({ results: Array.from({ length: num(q, "limit", 25) }, (_, i) => space(i)), start: 0, limit: num(q, "limit", 25), size: num(q, "limit", 25), _links: { base: W, next: "/rest/api/space?start=25" } })],
];

/** The fake server; `onBody` sees every answered body (the benchmark counts raw tokens with it). */
export function benchResponder(onBody?: (body: unknown) => void) {
  const unrouted = new Set<string>();
  const responder = (c: Call) => {
    const u = new URL(c.url);
    const route = ROUTES.find(([re]) => re.test(u.pathname));
    if (!route) {
      unrouted.add(u.pathname);
      return undefined;
    }
    const body = route[1](c, u.searchParams);
    onBody?.(body);
    return { body };
  };
  return { responder, unrouted };
}
