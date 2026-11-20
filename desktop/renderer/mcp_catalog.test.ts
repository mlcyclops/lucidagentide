// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/mcp_catalog.test.ts: P-SETUX.1 (ADR-0616). The community catalog lists only vendor-
// published remote endpoints, the official-host check rejects look-alikes, the org list is normalized as
// untrusted JSON, and configuredFor matches regardless of case and trailing slash.

import { describe, expect, test } from "bun:test";
import {
  catalogEntryIsOfficial, configuredFor, MCP_CATEGORY_LABEL, MCP_COMMUNITY_CATALOG, MCP_OAUTH_HINT, normalizeOrgCatalog,
  type McpCatalogEntry,
} from "./mcp_catalog.ts";

const BASE: McpCatalogEntry = {
  id: "github", name: "GitHub", vendor: "GitHub, Inc.", category: "developer",
  url: "https://api.github.com/mcp", transport: "http", auth: "token",
  docsUrl: "https://docs.github.com/mcp", officialDomains: ["github.com"], verifiedOn: "2026-11-20", source: "community",
};

describe("MCP_COMMUNITY_CATALOG", () => {
  test("every entry is official, https, on a known category, with an official docs page", () => {
    expect(MCP_COMMUNITY_CATALOG.length).toBeGreaterThan(0);
    for (const e of MCP_COMMUNITY_CATALOG) {
      expect(catalogEntryIsOfficial(e)).toBe(true);
      expect(new URL(e.url).protocol).toBe("https:");
      expect(new URL(e.docsUrl).protocol).toBe("https:");
      const docsHost = new URL(e.docsUrl).hostname;
      expect(e.officialDomains.some((d) => docsHost === d || docsHost.endsWith(`.${d}`))).toBe(true);
      expect(Object.hasOwn(MCP_CATEGORY_LABEL, e.category)).toBe(true);
      expect(e.transport === "http" || e.transport === "sse").toBe(true);
      expect(e.source).toBe("community");
      expect(e.verifiedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  test("ids are unique slugs", () => {
    const ids = MCP_COMMUNITY_CATALOG.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  test("no em dash in any catalog text or the OAuth hint", () => {
    const text = JSON.stringify(MCP_COMMUNITY_CATALOG) + MCP_OAUTH_HINT + JSON.stringify(MCP_CATEGORY_LABEL);
    expect(text.includes("\u2014")).toBe(false);
  });

  test("the OAuth hint names the omp slash command", () => {
    expect(MCP_OAUTH_HINT).toContain("/mcp reauth");
  });
});

describe("catalogEntryIsOfficial rejects look-alikes", () => {
  test("the base entry passes (subdomains of an official domain)", () => {
    expect(catalogEntryIsOfficial(BASE)).toBe(true);
  });

  test("a different registrable domain that only contains the brand", () => {
    expect(catalogEntryIsOfficial({ ...BASE, url: "https://github-mcp.com/mcp" })).toBe(false);
    expect(catalogEntryIsOfficial({ ...BASE, url: "https://mygithub.com/mcp" })).toBe(false);
  });

  test("the official domain used as a subdomain of another domain", () => {
    expect(catalogEntryIsOfficial({ ...BASE, url: "https://mcp.github.com.evil.io/mcp" })).toBe(false);
    expect(catalogEntryIsOfficial({ ...BASE, docsUrl: "https://docs.github.com.evil.io/mcp" })).toBe(false);
  });

  test("http scheme, credentials in the URL, garbage", () => {
    expect(catalogEntryIsOfficial({ ...BASE, url: "http://api.github.com/mcp" })).toBe(false);
    expect(catalogEntryIsOfficial({ ...BASE, docsUrl: "http://docs.github.com/mcp" })).toBe(false);
    expect(catalogEntryIsOfficial({ ...BASE, url: "https://github.com@evil.io/mcp" })).toBe(false);
    expect(catalogEntryIsOfficial({ ...BASE, url: "not a url" })).toBe(false);
  });

  test("punycode and homoglyph hosts are not the official domain", () => {
    expect(catalogEntryIsOfficial({ ...BASE, url: "https://xn--gthub-n4a.com/mcp" })).toBe(false);
    expect(catalogEntryIsOfficial({ ...BASE, url: "https://mcp.xn--gthub-n4a.com/mcp" })).toBe(false);
    expect(catalogEntryIsOfficial({ ...BASE, url: "https://g\u0456thub.com/mcp" })).toBe(false); // Cyrillic i
  });

  test("a bare TLD in officialDomains never vouches for a host", () => {
    expect(catalogEntryIsOfficial({ ...BASE, url: "https://evil.com/mcp", docsUrl: "https://evil.com/docs", officialDomains: ["com"] })).toBe(false);
  });
});

describe("normalizeOrgCatalog (untrusted managed JSON)", () => {
  test("non-array input is empty", () => {
    expect(normalizeOrgCatalog(undefined)).toEqual([]);
    expect(normalizeOrgCatalog(null)).toEqual([]);
    expect(normalizeOrgCatalog({ name: "x", url: "https://x.example.com" })).toEqual([]);
    expect(normalizeOrgCatalog("https://x.example.com")).toEqual([]);
  });

  test("drops non-objects, missing name or url, non-https and credential URLs", () => {
    const out = normalizeOrgCatalog([
      null, 7, "str", ["https://a.example.com"],
      { url: "https://no-name.example.com" },
      { name: "No url" },
      { name: "Plain http", url: "http://intranet.example.com/mcp" },
      { name: "Creds", url: "https://user:pw@mcp.example.com/mcp" },
      { name: "Bad", url: "::::" },
      { name: "Good", url: "https://mcp.corp.example.com/mcp" },
    ]);
    expect(out.map((e) => e.name)).toEqual(["Good"]);
  });

  test("fills defaults and marks source org", () => {
    const [e] = normalizeOrgCatalog([{ name: "Corp Tools", url: "https://mcp.corp.example.com/mcp" }]);
    expect(e).toEqual({
      id: "corp-tools", name: "Corp Tools", vendor: "Corp Tools", category: "saas",
      url: "https://mcp.corp.example.com/mcp", transport: "http", auth: "oauth", docsUrl: "",
      officialDomains: ["mcp.corp.example.com"], verifiedOn: "", source: "org",
    });
  });

  test("keeps valid optional fields and rejects invalid ones", () => {
    const [ok] = normalizeOrgCatalog([{ id: "Corp Wiki", name: "Wiki", url: "https://wiki.example.com/sse", transport: "sse", auth: "token", category: "productivity", docsUrl: "https://wiki.example.com/docs", note: "Internal wiki.", verifiedOn: "2026-11-01" }]);
    expect(ok).toMatchObject({ id: "corp-wiki", transport: "sse", auth: "token", category: "productivity", docsUrl: "https://wiki.example.com/docs", note: "Internal wiki.", verifiedOn: "2026-11-01" });
    const [bad] = normalizeOrgCatalog([{ name: "Wiki", url: "https://wiki.example.com", transport: "stdio", auth: "magic", category: "weird", docsUrl: "http://wiki.example.com/docs", verifiedOn: "yesterday" }]);
    expect(bad).toMatchObject({ transport: "http", auth: "oauth", category: "saas", docsUrl: "", verifiedOn: "" });
    expect(bad.note).toBeUndefined();
    const [proto] = normalizeOrgCatalog([{ name: "P", url: "https://p.example.com", category: "toString", auth: "constructor" }]);
    expect(proto).toMatchObject({ category: "saas", auth: "oauth" });
  });

  test("caps string lengths and rejects an over-long url", () => {
    const [e] = normalizeOrgCatalog([{ name: "n".repeat(500), vendor: "v".repeat(500), note: "x".repeat(1000), url: "https://ok.example.com" }]);
    expect(e.name.length).toBe(80);
    expect(e.vendor.length).toBe(120);
    expect(e.note!.length).toBe(200);
    expect(e.id.length).toBeLessThanOrEqual(64);
    expect(normalizeOrgCatalog([{ name: "Long", url: `https://ok.example.com/${"a".repeat(3000)}` }])).toEqual([]);
  });

  test("duplicate ids keep the first entry; the list is capped", () => {
    const out = normalizeOrgCatalog([
      { name: "A", id: "same", url: "https://a.example.com" },
      { name: "B", id: "same", url: "https://b.example.com" },
    ]);
    expect(out.map((e) => e.name)).toEqual(["A"]);
    const many = Array.from({ length: 500 }, (_, i) => ({ name: `S${i}`, url: `https://s${i}.example.com` }));
    expect(normalizeOrgCatalog(many).length).toBe(200);
  });
});

describe("configuredFor", () => {
  const entry = { ...BASE, url: "https://mcp.Example.com/mcp/" };
  test("matches across trailing slash and scheme/host case", () => {
    const servers = [{ id: "1", url: "https://other.example.com/mcp" }, { id: "2", url: "HTTPS://MCP.EXAMPLE.COM/mcp" }];
    expect(configuredFor(entry, servers)?.id).toBe("2");
    expect(configuredFor({ ...BASE, url: "https://mcp.stripe.com" }, [{ url: "https://mcp.stripe.com/" }])).toBeDefined();
  });

  test("a different path or host does not match", () => {
    expect(configuredFor(entry, [{ url: "https://mcp.example.com/sse" }])).toBeUndefined();
    expect(configuredFor(entry, [{ url: "https://mcp.example.org/mcp" }])).toBeUndefined();
    expect(configuredFor(entry, [])).toBeUndefined();
  });
});
