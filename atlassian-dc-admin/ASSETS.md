# Jira Assets (Insight / CMDB) — reference

```bash
A="node <skill dir>/scripts/atlassian-admin.mjs"
$A list assets                                  # all Assets tools; ✎ = write
$A describe assets_create_attribute             # args; never guess them
$A assets_list_schemas
$A assets_get_schema schema_id=3                # schema + object type tree "Name [id] count"
$A assets_list_attributes object_type_id=31     # attribute names, types, required, reference targets
$A assets_search aql='objectType = "Laptop" AND Owner = ivan' attributes='["Owner","Model"]'
$A assets_get_object object=ITAM-56
```

Uses the Jira configuration (`JIRA_URL`, `JIRA_PAT_TOKEN`). `ASSETS_API_BASE` overrides the REST base
(default `/rest/insight/1.0`, valid on every version; `/rest/assets/1.0` exists from Assets 10).

## Learn the structure first

`assets_get_schema` → `assets_list_attributes object_type_id=…` before writing objects. Attributes are
addressed **by name** everywhere: `attributes='{"Name":"LT-8","Owner":"ivan","Model":"ITAM-1","Tags":["a","b"]}'`.
References take object keys, users usernames, select options their text, dates `YYYY-MM-DD`; `null` clears.
Unknown names fail with the list of valid ones.

## AQL cheatsheet

`objectType = "Laptop"` · `objectSchemaId = 3` · `Key = ITAM-5` · `Name like "srv"` · `Owner = ivan` ·
`Status = Active` · `"Purchase date" < now(-365d)` · `Model.Vendor = Lenovo` (dot = attribute of a referenced object) ·
`object HAVING inboundReferences(objectType = "Laptop")` · `ORDER BY Name`. Quote names with spaces.
Check a query with `assets_validate_aql` first when unsure. Page with `page`/`limit` (total = all matches).

## Writes

Confirmation works as for every write tool (see SKILL.md: dry run → choose "each" or "all at once" → dialog), and so does the closing UI check plan for admins after changes are applied (SKILL.md, Writes step 7). Assets specifics:

- `assets_bulk_update` dry run lists every matched object; it refuses above `max_objects` (default 50).
- Prefer `assets_archive_object` (Assets 10+) over `assets_delete_object`.
- `assets_delete_schema`, `assets_delete_object_type`, `assets_delete_attribute` destroy objects or values: say "irreversible".
- Attribute changes on large types reindex many objects: do them outside working hours when asked.

For inventories across many object types, delegate to a subagent (if available) that uses `--out` and returns only conclusions.
