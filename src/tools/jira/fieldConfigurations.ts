/**
 * Jira DC field configurations: which one applies to a project and issue type, its fields
 * (description, hidden, required) and the projects that share it; and a prepared change of
 * one field's description in one field configuration.
 *
 * Jira has no REST resource for field configuration schemes or a list of field
 * configurations. Contents come from the internal `/rest/internal/2/fieldConfiguration/{id}`
 * (paged: page, maxResults, query); the configuration in effect for a project and issue type
 * from the bundled "Where is my field" plugin, which names it; the name is mapped to an id by
 * reading ascending ids. The system default configuration is served as id -1 (with the
 * projects that use it) and under its database id, which its edit links use.
 *
 * A description is edited only in the admin form EditFieldLayoutItem.jspa, which Jira serves
 * after websudo re-authentication; a personal access token cannot pass it (verified on Jira
 * 11.3.6). The description tool therefore prepares and verifies the change, and the
 * administrator enters it in the UI.
 */

import { z } from "zod";
import type { AtlassianClient } from "../../client.js";
import { isHttpStatusError, UnsupportedError, ValidationError } from "../../errors.js";
import type { ToolDef } from "../types.js";
import { alreadySatisfied, capList, dryRunShape, fullListsShape, nameFilterShape, pageShape, serverPage } from "../util.js";
import { resolveField } from "./fieldRefs.js";
import { parseWhereIsMyField, probeField, whereIsMyField } from "./screens.js";

const CONFIG = "/rest/internal/2/fieldConfiguration";
const FIRST_ID = 10000;
/** Jira allocates entity ids in blocks of 100 (a restart starts a new block). */
const ID_BLOCK = 100;
const MAX_ID_READS = 2000;
/** Missing ids in a row that end a block (deleted configurations leave holes). */
const BLOCK_GAP = 3;
/** Empty blocks in a row that end the scan. */
const EMPTY_BLOCKS = 10;
const CONFIG_PAGE = 100;

async function readConfig(client: AtlassianClient, id: number, params: { page?: number; maxResults?: number; query?: string } = {}) {
  return client.get(`${CONFIG}/${id}`, { page: params.page ?? 1, maxResults: params.maxResults ?? CONFIG_PAGE, query: params.query || undefined });
}

const notFound = (e: unknown) => isHttpStatusError(e) && e.status === 404;

interface DefaultInfo {
  name: string;
  /** database id, as used by the edit links */
  editId?: number;
}

const defaults = new WeakMap<AtlassianClient, Promise<DefaultInfo>>();

/** The system default field configuration (id -1): its name and the id its edit links use. */
function defaultConfig(client: AtlassianClient): Promise<DefaultInfo> {
  let p = defaults.get(client);
  if (!p) {
    p = readConfig(client, -1, { maxResults: 1 }).then((d: any) => {
      const link = d?.fields?.[0]?.actions?.edit?.url as string | undefined;
      const id = link ? Number(new URL(link).searchParams.get("id")) : undefined;
      return { name: String(d?.configName ?? ""), editId: Number.isFinite(id) ? id : undefined };
    });
    defaults.set(client, p);
  }
  return p;
}

const idScans = new WeakMap<AtlassianClient, Promise<{ ids: Map<string, number>; complete: boolean }>>();

/**
 * Field configuration names → ids. Ids are read block by block: consecutive ids from each
 * block start until BLOCK_GAP are missing, then the next block, until EMPTY_BLOCKS blocks
 * in a row are empty or MAX_ID_READS reads were made.
 */
function configIds(client: AtlassianClient) {
  let p = idScans.get(client);
  if (!p) {
    p = (async () => {
      const ids = new Map<string, number>();
      let reads = 0;
      let emptyBlocks = 0;
      for (let block = FIRST_ID; emptyBlocks < EMPTY_BLOCKS && reads < MAX_ID_READS; block += ID_BLOCK) {
        let found = false;
        let missing = 0;
        for (let id = block; id < block + ID_BLOCK && missing < BLOCK_GAP && reads < MAX_ID_READS; id++) {
          reads++;
          try {
            const d: any = await readConfig(client, id, { maxResults: 1 });
            missing = 0;
            found = true;
            if (d?.configName && !ids.has(d.configName)) ids.set(String(d.configName), id);
          } catch (e) {
            if (!notFound(e)) throw e;
            missing++;
          }
        }
        emptyBlocks = found ? 0 : emptyBlocks + 1;
      }
      return { ids, complete: emptyBlocks >= EMPTY_BLOCKS };
    })();
    idScans.set(client, p);
  }
  return p;
}

/** Projects that use a field configuration; the default one lists them under id -1. */
async function sharedWith(client: AtlassianClient, id: number, isDefault: boolean): Promise<string[]> {
  const d: any = await client.get(`${CONFIG}/${isDefault ? -1 : id}/projects`);
  return (d?.associatedProjects ?? []).map((p: any) => p.key).sort();
}

async function identify(client: AtlassianClient, id: number) {
  const [d, def] = await Promise.all([readConfig(client, id, { maxResults: 1 }), defaultConfig(client)]);
  const name = String((d as any)?.configName ?? "");
  const isDefault = id === -1 || name === def.name;
  return { id: isDefault && def.editId !== undefined ? def.editId : id, name, isDefault };
}

function fieldItem(f: any) {
  return { id: f.id, name: f.name, description: f.description ?? "", hidden: !!f.hidden, required: !!f.required };
}

/** Page number (1-based) and in-page skip for an offset on a page-number endpoint. */
function pageFor(offset: number, limit: number) {
  return { page: Math.floor(offset / limit) + 1, skip: offset % limit };
}

async function fieldsPage(client: AtlassianClient, id: number, isDefault: boolean, args: { offset?: number; limit?: number; name_contains?: string }) {
  const offset = args.offset ?? 0;
  const limit = args.limit ?? 50;
  const { page, skip } = pageFor(offset, limit);
  const d: any = await readConfig(client, isDefault ? -1 : id, { page, maxResults: limit, query: args.name_contains });
  return serverPage((d?.fields ?? []).slice(skip).map(fieldItem), offset, limit, d?.total);
}

/** The field configuration item of one field (searched by its name). */
async function configItem(client: AtlassianClient, id: number, fieldId: string, fieldName: string) {
  for (let page = 1; page <= 20; page++) {
    const d: any = await readConfig(client, id, { page, maxResults: CONFIG_PAGE, query: fieldName });
    const item = (d?.fields ?? []).find((f: any) => f.id === fieldId);
    if (item) return { config: d, item };
    if ((d?.fields ?? []).length < CONFIG_PAGE) break;
  }
  return undefined;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export const jiraFieldConfigurationTools: ToolDef[] = [
  {
    name: "jira_get_field_configuration",
    aliases: { issue_type_id: "issue_type" },
    product: "jira",
    description:
      "The field configuration a project uses (per issue type, or field_configuration_id): its fields with description, " +
      "hidden/visible and required/optional (paged, name_contains), and the projects that share it. Without issue_type, " +
      "issue types are grouped by configuration (fields only when there is one). Field configuration schemes are not " +
      "readable through REST. Internal and plugin APIs, verified on Jira 11.3.",
    inputShape: {
      project_key: z.string().min(1),
      issue_type: z.coerce.string().optional().describe("Issue type id or exact name"),
      field_configuration_id: z.coerce.number().int().optional(),
      ...nameFilterShape,
      ...pageShape(50),
      ...fullListsShape,
    },
    async handler({ client }, args) {
      const c = client("jira");
      const result = (configurations: unknown[], hint?: string) => ({
        project: args.project_key,
        fieldConfigurationScheme: null,
        fieldConfigurationSchemeNote: "Field configuration schemes are not readable over REST.",
        configurations,
        hint,
      });
      // the projects sharing a configuration: the default one is shared by every project without a scheme
      const shared = async (id: number, isDefault: boolean) => {
        const out: Record<string, unknown> = {};
        capList(out, "sharedWith", await sharedWith(c, id, isDefault), args.full_lists);
        return out;
      };

      if (args.field_configuration_id !== undefined) {
        const cfg = await identify(c, args.field_configuration_id);
        return result([{
          ...cfg, default: cfg.isDefault, isDefault: undefined,
          ...(await shared(cfg.id, cfg.isDefault)),
          fields: await fieldsPage(c, cfg.id, cfg.isDefault, args),
        }]);
      }

      const project: any = await c.get(`/rest/api/2/project/${encodeURIComponent(args.project_key)}`);
      const want = args.issue_type?.toLowerCase();
      const types: any[] = (project?.issueTypes ?? []).filter((t: any) => !want || String(t.id) === args.issue_type || String(t.name).toLowerCase() === want);
      if (!types.length) throw new ValidationError(`Project ${args.project_key} has no issue type ${args.issue_type}`);
      const probe = await probeField(c);
      const groups = new Map<string, string[]>();
      const failed: string[] = [];
      for (const t of types) {
        let name: string | undefined;
        if (probe) {
          try {
            name = parseWhereIsMyField(await whereIsMyField(c, probe, args.project_key, String(t.id), 0)).fieldConfiguration;
          } catch (e) {
            if (!isHttpStatusError(e)) throw e;
          }
        }
        if (name) groups.set(name, [...(groups.get(name) ?? []), t.name]);
        else failed.push(t.name);
      }

      const def = await defaultConfig(c);
      const configurations: any[] = [];
      for (const [name, issueTypes] of groups) {
        const isDefault = name === def.name;
        const scan = isDefault ? undefined : await configIds(c);
        const id = isDefault ? (def.editId ?? -1) : scan!.ids.get(name);
        if (id === undefined) {
          const how = scan!.complete ? "all ids were read" : `the id scan stopped at its limit of ${MAX_ID_READS} reads`;
          configurations.push({ id: null, name, issueTypes, unresolved: `no field configuration id found for '${name}' (${how}); pass field_configuration_id` });
          continue;
        }
        configurations.push({ id, name, default: isDefault, issueTypes, ...(await shared(id, isDefault)) });
      }
      if (failed.length) {
        configurations.push({ id: null, name: null, issueTypes: failed, unresolved: "the bundled 'Where is my field' plugin did not name a field configuration; pass field_configuration_id" });
      }
      const resolved = configurations.filter((x) => x.id !== null);
      if (configurations.length === 1 && resolved.length === 1) {
        resolved[0].fields = await fieldsPage(c, resolved[0].id, resolved[0].default, args);
        return result(configurations);
      }
      return result(configurations, configurations.length > 1
        ? "Issue types use different field configurations: pass issue_type or field_configuration_id for the fields"
        : undefined);
    },
  },
  {
    name: "jira_update_field_description",
    aliases: { field_id: "field" },
    product: "jira",
    write: true,
    description:
      "Prepare a change of one field's description in one field configuration (never the field's global name or " +
      "description): the dry run shows old and new value, the projects sharing the configuration and the edit link. Jira " +
      "serves that form only after websudo re-authentication, which a token cannot pass, so the change is entered in the " +
      "UI; running the tool again verifies it (already-satisfied).",
    inputShape: {
      field_configuration_id: z.coerce.number().int(),
      field: z.coerce.string().min(1).describe("customfield_N, a system field id, or the exact field name"),
      description: z.string(),
      ...dryRunShape,
    },
    async handler({ client }, args) {
      const c = client("jira");
      const field = await resolveField(c, args.field);
      const cfg = await identify(c, args.field_configuration_id);
      const found = await configItem(c, cfg.isDefault ? -1 : cfg.id, field.id!, field.name ?? field.id!);
      if (!found) throw new ValidationError(`${field.name} (${field.id}) is not in field configuration ${cfg.name} (${cfg.id})`);
      const before = String(found.item.description ?? "");
      const editUrl = String(found.item.actions?.edit?.url ?? "");
      const summary = `Description of ${field.name} in field configuration '${cfg.name}' (${cfg.id})`;
      if (before === args.description) return alreadySatisfied(summary, "the stored description already matches");
      const projects = await sharedWith(c, cfg.id, cfg.isDefault);
      const reason = "Jira serves the field configuration edit form only after websudo re-authentication, which a personal access token cannot pass";
      if (args.dry_run === false) {
        throw new UnsupportedError(`${summary} cannot be changed through the API: ${reason}. Enter it at ${editUrl}`, { editUrl, description: args.description });
      }
      return {
        dry_run: true,
        product: c.product,
        summary: `${summary}: "${before}" → "${args.description}" (enter manually)`,
        request: { method: "MANUAL", url: editUrl, body: { description: args.description } },
        manual: { reason, editUrl },
        before,
        after: args.description,
        sharedWith: projects,
        warning: projects.length > 1 ? `Field configuration is shared by ${plural(projects.length, "project")} (${projects.join(", ")}); the description changes for all of them` : undefined,
        identity: { op: "field-description", config: cfg.id, field: field.ref, description: args.description },
        state: before,
        note: "Nothing is sent. Enter the description at the edit link, then run the tool again to verify.",
      };
    },
  },
];
