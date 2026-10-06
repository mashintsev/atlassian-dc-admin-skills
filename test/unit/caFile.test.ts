import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { rootCertificates } from "node:tls";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { tlsOptions } from "../../src/client.js";
import { loadConfig } from "../../src/config.js";

const PEM = "-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIUTEST\n-----END CERTIFICATE-----\n";

describe("<PRODUCT>_CA_FILE", () => {
  it("adds the file's certificates to the standard roots and keeps verification on", () => {
    const dir = mkdtempSync(join(tmpdir(), "ca-"));
    const file = join(dir, "root.pem");
    writeFileSync(file, PEM);
    const cfg = loadConfig("jira", { JIRA_URL: "https://jira.example.com", JIRA_PAT_TOKEN: "t", JIRA_CA_FILE: file });
    assert.equal(cfg.caFile, file);
    const opts = tlsOptions(cfg);
    assert.equal(opts.rejectUnauthorized, true);
    assert.equal(opts.ca!.length, rootCertificates.length + 1);
    assert.equal(opts.ca!.at(-1), PEM);
  });

  it("uses Node's default trust store without it, and fails clearly on a missing file", () => {
    const cfg = loadConfig("jira", { JIRA_URL: "https://jira.example.com", JIRA_PAT_TOKEN: "t" });
    assert.equal(tlsOptions(cfg).ca, undefined);
    assert.throws(() => loadConfig("jira", { JIRA_URL: "https://jira.example.com", JIRA_PAT_TOKEN: "t", JIRA_CA_FILE: "/nope/root.pem" }), /JIRA_CA_FILE.*\/nope\/root\.pem/);
  });
});
