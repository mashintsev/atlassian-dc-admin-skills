/**
 * Version gate for tools that rely on Jira's internal or plugin REST resources.
 * Those resources are verified on specific Jira versions only; any other version
 * is refused before a request is built.
 */

import type { AtlassianClient } from "./client.js";
import { UnsupportedError } from "./errors.js";

/** Jira versions on which the internal resources used by these tools were verified. */
export const VERIFIED_JIRA_VERSIONS = [{ label: "11.3.x", pattern: /^11\.3\./ }];

const versions = new WeakMap<AtlassianClient, Promise<string>>();

/** Jira's version string from serverInfo, read once per client. */
export function jiraVersion(client: AtlassianClient): Promise<string> {
  let v = versions.get(client);
  if (!v) {
    v = client.get("/rest/api/2/serverInfo").then((info: any) => String(info?.version ?? ""));
    versions.set(client, v);
    // a failed read is not kept: a retry in the same run reads again
    v.catch(() => versions.delete(client));
  }
  return v;
}

/** Throws UnsupportedError unless Jira runs a version the feature was verified on. */
export async function requireJiraVersion(client: AtlassianClient, feature: string): Promise<string> {
  const version = await jiraVersion(client);
  if (!VERIFIED_JIRA_VERSIONS.some((v) => v.pattern.test(version))) {
    const allowed = VERIFIED_JIRA_VERSIONS.map((v) => v.label).join(", ");
    throw new UnsupportedError(
      `${feature} use internal Jira APIs verified only on Jira ${allowed}; this Jira is ${version || "of unknown version"}`,
      { observedVersion: version, verifiedVersions: allowed },
    );
  }
  return version;
}

/** JSM versions on which the internal JSM resources used by these tools were verified. */
export const VERIFIED_JSM_VERSIONS = [{ label: "11.3.x", pattern: /^11\.3\./ }];

const jsmVersions = new WeakMap<AtlassianClient, Promise<string>>();

/** The JSM app version from servicedeskapi `info`, read once per client. JSM ships apart from Jira. */
export function jsmVersion(client: AtlassianClient): Promise<string> {
  let v = jsmVersions.get(client);
  if (!v) {
    v = client.get("/rest/servicedeskapi/info").then((info: any) => String(info?.version ?? ""));
    jsmVersions.set(client, v);
    // a failed read is not kept: a retry in the same run reads again
    v.catch(() => jsmVersions.delete(client));
  }
  return v;
}

/** Throws UnsupportedError unless JSM runs a version the feature was verified on. */
export async function requireJsmVersion(client: AtlassianClient, feature: string): Promise<string> {
  const version = await jsmVersion(client);
  if (!VERIFIED_JSM_VERSIONS.some((v) => v.pattern.test(version))) {
    const allowed = VERIFIED_JSM_VERSIONS.map((v) => v.label).join(", ");
    throw new UnsupportedError(
      `${feature} use internal JSM APIs verified only on JSM ${allowed}; this JSM is ${version || "of unknown version"}`,
      { observedJsmVersion: version, verifiedJsmVersions: allowed },
    );
  }
  return version;
}
