/**
 * Apps (plugins) via the Universal Plugin Manager REST API — same on Jira and Confluence.
 *
 * The inventory is adapted from mcp-atlassian-for-admins (src/tools/plugins.ts, MIT).
 * UPM only speaks its own vnd.atl media types: Accept application/json gets a 406,
 * and PUT must be sent as application/vnd.atl.plugins.plugin+json (checked against UPM 8.0.25).
 */

import { z } from "zod";
import { boundedAll, seg, type AtlassianClient } from "../../client.js";
import { isHttpStatusError } from "../../errors.js";
import type { ToolDef } from "../types.js";
import { boolArg, contains, dryRunShape, guardedWrite, pageShape, paginate } from "../util.js";

const UPM = "/rest/plugins/1.0";
const UPM_ACCEPT = "*/*";
const PLUGIN_JSON = "application/vnd.atl.plugins.plugin+json";

export const productShape = {
  product: z.enum(["jira", "confluence"]).describe("Which instance to query"),
};

async function pluginLicense(client: AtlassianClient, key: string): Promise<any | null> {
  // Plugins without a license answer 404, some bundled apps even 500: treat any HTTP error as "no license".
  try {
    return await client.get(`${UPM}/${seg(key)}-key/license`, undefined, UPM_ACCEPT);
  } catch (e) {
    if (isHttpStatusError(e)) return null;
    throw e;
  }
}

function compactPlugin(p: any, license: any): Record<string, unknown> {
  return {
    key: p.key,
    name: p.name,
    version: p.version,
    enabled: p.enabled ?? null,
    userInstalled: p.userInstalled ?? null,
    vendor: p.vendor?.name ?? null,
    license:
      license === undefined
        ? undefined
        : license
          ? {
              valid: license.valid ?? null,
              licenseType: license.licenseType ?? null,
              evaluation: license.evaluation ?? null,
              maintenanceExpiryDate: license.maintenanceExpiryDate ?? null,
              supportEntitlementNumber: license.supportEntitlementNumber ?? null,
            }
          : null,
  };
}

export const pluginTools: ToolDef[] = [
  {
    name: "atlassian_list_plugins",
    product: "both",
    description:
      "Installed apps: key, name, version, enabled, vendor. Marketplace/admin-installed only by default " +
      "(include_system=true adds bundled plugins); with_licenses=true adds license validity, type and maintenance expiry.",
    inputShape: {
      ...productShape,
      include_system: boolArg.optional(),
      with_licenses: boolArg.optional(),
      name_contains: z.string().optional().describe("Matches plugin name or key"),
      ...pageShape(100),
    },
    async handler({ client }, args) {
      const c = client(args.product);
      const data = await c.get(`${UPM}/`, undefined, UPM_ACCEPT);
      const all: any[] = data?.plugins ?? [];
      const filtered = all
        .filter((p) => args.include_system || p.userInstalled === true)
        .filter((p) => contains(p.name, args.name_contains) || contains(p.key, args.name_contains));
      const page = paginate(filtered, args, 100);
      const licenses = args.with_licenses
        ? await boundedAll(page.items.map((p) => () => pluginLicense(c, p.key)))
        : page.items.map(() => undefined);
      return { ...page, items: page.items.map((p, i) => compactPlugin(p, licenses[i])) };
    },
  },
  {
    name: "atlassian_get_plugin",
    product: "both",
    description: "One app with its modules (enabled state per module) and license.",
    inputShape: { ...productShape, plugin_key: z.string() },
    async handler({ client }, args) {
      const c = client(args.product);
      const [plugin, license] = await Promise.all([
        c.get(`${UPM}/${seg(args.plugin_key)}-key`, undefined, UPM_ACCEPT),
        pluginLicense(c, args.plugin_key),
      ]);
      return {
        ...compactPlugin(plugin, license),
        description: String(plugin?.description ?? "").slice(0, 500),
        modules: (plugin?.modules ?? []).map((m: any) => ({ key: m.key, name: m.name, enabled: m.enabled })),
      };
    },
  },
  {
    name: "atlassian_set_plugin_enabled",
    unverifiable: "not checked: the app's current state is not compared",
    product: "both",
    write: true,
    description: "Enable or disable an app. Disabling a system plugin can break the instance.",
    inputShape: { ...productShape, plugin_key: z.string(), enabled: boolArg, ...dryRunShape },
    async handler({ client }, args) {
      return guardedWrite(client(args.product), args, {
        method: "PUT",
        path: `${UPM}/${seg(args.plugin_key)}-key`,
        json: { enabled: args.enabled },
        contentType: PLUGIN_JSON,
        summary: `${args.enabled ? "Enable" : "Disable"} app ${args.plugin_key} on ${args.product}`,
      });
    },
  },
  {
    name: "atlassian_get_safe_mode",
    product: "both",
    description: "Whether UPM safe mode (all user-installed apps disabled) is on.",
    inputShape: { ...productShape },
    async handler({ client }, args) {
      return client(args.product).get(`${UPM}/safe-mode`, undefined, UPM_ACCEPT);
    },
  },
];
