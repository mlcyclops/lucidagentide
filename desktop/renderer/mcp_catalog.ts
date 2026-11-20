// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/mcp_catalog.ts
//
// P-SETUX.1 (ADR-0616): the "Quick connect" MCP catalog. Pure and DOM-free (the server imports it to
// normalize the managed policy list). Two sources:
//   - MCP_COMMUNITY_CATALOG: REMOTE MCP servers each vendor publishes on its OWN documentation domain,
//     checked by hand against `docsUrl` on `verifiedOn`. Look-alike and third-party community servers are
//     excluded on purpose: agents get tricked by servers named like a brand but run by someone else.
//   - normalizeOrgCatalog: the org-authorized list an admin places in managed policy (`mcpCatalog`).
// Only http/sse endpoints qualify because the LUCID MCP store (bridge.mcpUpsert) only speaks those.

export type McpCatalogCategory = "cloud" | "developer" | "productivity" | "email" | "saas" | "social" | "design" | "data" | "payments";
export type McpCatalogAuth = "oauth" | "token" | "none";
export interface McpCatalogEntry {
  /** Stable slug, e.g. "github". */
  id: string;
  /** Display name, e.g. "GitHub". */
  name: string;
  /** Legal or brand owner, e.g. "GitHub, Inc.". */
  vendor: string;
  category: McpCatalogCategory;
  /** Official REMOTE endpoint, https only. */
  url: string;
  /** The only transports the LUCID MCP store supports (bridge.mcpUpsert). */
  transport: "http" | "sse";
  auth: McpCatalogAuth;
  /** The vendor's OWN page that publishes this endpoint. */
  docsUrl: string;
  /** Registrable domains the vendor owns; the url host AND the docsUrl host must sit under one. */
  officialDomains: string[];
  /** ISO date the entry was checked against docsUrl. */
  verifiedOn: string;
  /** One short sentence. */
  note?: string;
  source: "community" | "org";
}

export const MCP_CATEGORY_LABEL: Record<McpCatalogCategory, string> = {
  cloud: "Cloud",
  developer: "Developer tools",
  productivity: "Productivity",
  email: "Email and calendar",
  saas: "Business apps",
  social: "Social media",
  design: "Design and web",
  data: "Data and AI",
  payments: "Payments",
};

const VERIFIED = "2026-11-20";

/** Meta's servers register only the MCP clients Meta lists; other clients need a Meta app ID. */
const META_NOTE = "Meta signs in only the clients it lists; other clients need a Meta app ID.";

/** Google's Workspace MCP servers are a Developer Preview and sign in only with an OAuth client you create in
 *  your own Google Cloud project (no dynamic client registration). */
const GOOGLE_WORKSPACE_NOTE = "Developer Preview: join Google's preview program and create your own Google Cloud OAuth client.";

type CommunitySeed = Omit<McpCatalogEntry, "verifiedOn" | "source">;

const COMMUNITY_SEED: readonly CommunitySeed[] = [
  // ── Cloud ──────────────────────────────────────────────────────────────────────────────────────
  { id: "aws-knowledge", name: "AWS Knowledge", vendor: "Amazon Web Services, Inc.", category: "cloud",
    url: "https://knowledge-mcp.global.api.aws", transport: "http", auth: "none",
    docsUrl: "https://awslabs.github.io/mcp/servers/aws-knowledge-mcp-server", officialDomains: ["api.aws", "awslabs.github.io"],
    note: "AWS docs, API references and guidance; no AWS account needed." },
  { id: "microsoft-learn", name: "Microsoft Learn", vendor: "Microsoft Corporation", category: "cloud",
    url: "https://learn.microsoft.com/api/mcp", transport: "http", auth: "none",
    docsUrl: "https://learn.microsoft.com/en-us/training/support/mcp", officialDomains: ["microsoft.com"],
    note: "Microsoft and Azure documentation; no sign-in required." },
  { id: "google-bigquery", name: "Google BigQuery", vendor: "Google LLC", category: "cloud",
    url: "https://bigquery.googleapis.com/mcp", transport: "http", auth: "token",
    docsUrl: "https://docs.cloud.google.com/mcp/configure-mcp-ai-application", officialDomains: ["google.com", "googleapis.com"],
    note: "Uses a Google Cloud access token, which expires and must be refreshed." },
  { id: "cloudflare", name: "Cloudflare", vendor: "Cloudflare, Inc.", category: "cloud",
    url: "https://mcp.cloudflare.com/mcp", transport: "http", auth: "oauth",
    docsUrl: "https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/", officialDomains: ["cloudflare.com"],
    note: "The whole Cloudflare API; a Cloudflare API token also works." },
  { id: "vercel", name: "Vercel", vendor: "Vercel Inc.", category: "cloud",
    url: "https://mcp.vercel.com", transport: "http", auth: "oauth",
    docsUrl: "https://vercel.com/docs/mcp/vercel-mcp", officialDomains: ["vercel.com"],
    note: "Projects, deployments, logs and Vercel docs." },
  { id: "netlify", name: "Netlify", vendor: "Netlify, Inc.", category: "cloud",
    url: "https://mcp.netlify.com/mcp", transport: "http", auth: "oauth",
    docsUrl: "https://docs.netlify.com/build/build-with-ai/netlify-mcp-server/", officialDomains: ["netlify.com"],
    note: "Create, build and deploy Netlify sites." },
  // ── Data and AI ────────────────────────────────────────────────────────────────────────────────
  { id: "supabase", name: "Supabase", vendor: "Supabase, Inc.", category: "data",
    url: "https://mcp.supabase.com/mcp", transport: "http", auth: "oauth",
    docsUrl: "https://supabase.com/docs/guides/getting-started/mcp", officialDomains: ["supabase.com"],
    note: "A Supabase personal access token also works." },
  { id: "huggingface", name: "Hugging Face", vendor: "Hugging Face, Inc.", category: "data",
    url: "https://huggingface.co/mcp", transport: "http", auth: "token",
    docsUrl: "https://huggingface.co/docs/hub/hf-mcp-server", officialDomains: ["huggingface.co"],
    note: "Your Hugging Face MCP settings page shows the token and tools to use." },
  // ── Developer tools ────────────────────────────────────────────────────────────────────────────
  { id: "github", name: "GitHub", vendor: "GitHub, Inc.", category: "developer",
    url: "https://api.githubcopilot.com/mcp/", transport: "http", auth: "token",
    docsUrl: "https://docs.github.com/en/copilot/how-tos/copilot-in-your-ide/customize-copilot/extend-copilot-with-tools-and-context/set-up-the-github-mcp-server",
    officialDomains: ["github.com", "githubcopilot.com"],
    note: "Paste a GitHub personal access token; GitHub OAuth works only in clients GitHub approves." },
  { id: "gitlab", name: "GitLab", vendor: "GitLab Inc.", category: "developer",
    url: "https://gitlab.com/api/v4/mcp", transport: "http", auth: "oauth",
    docsUrl: "https://docs.gitlab.com/user/gitlab_duo/model_context_protocol/mcp_server/", officialDomains: ["gitlab.com"],
    note: "Self-managed GitLab uses /api/v4/mcp on your own host." },
  { id: "linear", name: "Linear", vendor: "Linear Orbit, Inc.", category: "developer",
    url: "https://mcp.linear.app/mcp", transport: "http", auth: "oauth",
    docsUrl: "https://linear.app/docs/mcp", officialDomains: ["linear.app"],
    note: "A Linear API key also works as the token." },
  { id: "sentry", name: "Sentry", vendor: "Functional Software, Inc. (Sentry)", category: "developer",
    url: "https://mcp.sentry.dev/mcp", transport: "http", auth: "oauth",
    docsUrl: "https://docs.sentry.io/product/sentry-mcp/", officialDomains: ["sentry.dev", "sentry.io"],
    note: "Append /<org>/<project> to scope it to one project." },
  // ── Productivity ───────────────────────────────────────────────────────────────────────────────
  { id: "atlassian", name: "Atlassian (Jira, Confluence)", vendor: "Atlassian Corporation", category: "productivity",
    url: "https://mcp.atlassian.com/v2/mcp", transport: "http", auth: "oauth",
    docsUrl: "https://support.atlassian.com/atlassian-rovo-mcp-server/docs/getting-started-with-the-atlassian-remote-mcp-server/",
    officialDomains: ["atlassian.com"] },
  { id: "notion", name: "Notion", vendor: "Notion Labs, Inc.", category: "productivity",
    url: "https://mcp.notion.com/mcp", transport: "http", auth: "oauth",
    docsUrl: "https://developers.notion.com/docs/get-started-with-mcp", officialDomains: ["notion.com"],
    note: "Business and Enterprise owners can issue an MCP token instead." },
  { id: "asana", name: "Asana", vendor: "Asana, Inc.", category: "productivity",
    url: "https://mcp.asana.com/v2/mcp", transport: "http", auth: "oauth",
    docsUrl: "https://developers.asana.com/docs/using-asanas-mcp-server", officialDomains: ["asana.com"] },
  // ── Email and calendar (ADR-0638) ──────────────────────────────────────────────────────────────
  { id: "gmail", name: "Gmail", vendor: "Google LLC", category: "email",
    url: "https://gmailmcp.googleapis.com/mcp/v1", transport: "http", auth: "oauth",
    docsUrl: "https://developers.google.com/workspace/gmail/api/guides/configure-mcp-server", officialDomains: ["google.com", "googleapis.com"],
    note: GOOGLE_WORKSPACE_NOTE },
  { id: "google-calendar", name: "Google Calendar", vendor: "Google LLC", category: "email",
    url: "https://calendarmcp.googleapis.com/mcp/v1", transport: "http", auth: "oauth",
    docsUrl: "https://developers.google.com/workspace/calendar/api/guides/configure-mcp-server", officialDomains: ["google.com", "googleapis.com"],
    note: GOOGLE_WORKSPACE_NOTE },
  { id: "microsoft-365", name: "Microsoft 365 (Outlook mail, calendar)", vendor: "Microsoft Corporation", category: "email",
    url: "https://workiq.svc.cloud.microsoft/mcp", transport: "http", auth: "oauth",
    docsUrl: "https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/work-iq/mcp/quickstart/github-copilot-cli",
    officialDomains: ["microsoft.com", "cloud.microsoft"],
    note: "Work IQ MCP: work or school accounts only, and a tenant admin must enable Work IQ first." },
  { id: "fastmail", name: "Fastmail", vendor: "Fastmail Pty Ltd", category: "email",
    url: "https://api.fastmail.com/mcp", transport: "http", auth: "oauth",
    docsUrl: "https://www.fastmail.help/hc/en-us/articles/15869557281295-Connecting-AI-tools-via-Fastmail-s-MCP-server",
    officialDomains: ["fastmail.com", "fastmail.help"],
    note: "Mail, contacts and calendars; pick read, write or send access at sign-in." },
  { id: "superhuman-mail", name: "Superhuman Mail", vendor: "Superhuman Platform Inc.", category: "email",
    url: "https://mcp.mail.superhuman.com/mcp", transport: "http", auth: "oauth",
    docsUrl: "https://help.superhuman.com/hc/en-us/articles/46005696690317-Superhuman-Mail-MCP-Server", officialDomains: ["superhuman.com"],
    note: "Business plan or higher; covers the Gmail and Outlook inboxes on your seat." },
  { id: "nylas", name: "Nylas (email, calendar, contacts)", vendor: "Nylas, Inc.", category: "email",
    url: "https://mcp.us.nylas.com", transport: "http", auth: "oauth",
    docsUrl: "https://developer.nylas.com/docs/dev-guide/mcp/", officialDomains: ["nylas.com"],
    note: "EU data uses https://mcp.eu.nylas.com; a Nylas API key also works as the token." },
  { id: "calendly", name: "Calendly", vendor: "Calendly LLC", category: "email",
    url: "https://mcp.calendly.com", transport: "http", auth: "oauth",
    docsUrl: "https://developer.calendly.com/calendly-mcp-server", officialDomains: ["calendly.com"],
    note: "OAuth sign-in only; Calendly personal access tokens are not accepted." },
  { id: "cal-com", name: "Cal.com", vendor: "Cal.com, Inc.", category: "email",
    url: "https://mcp.cal.com/mcp", transport: "http", auth: "oauth",
    docsUrl: "https://cal.com/docs/mcp-server", officialDomains: ["cal.com"],
    note: "Add ?toolsets=bookings,availability to the URL to limit the tools." },
  // ── Business apps ──────────────────────────────────────────────────────────────────────────────
  { id: "intercom", name: "Intercom", vendor: "Intercom, Inc.", category: "saas",
    url: "https://mcp.intercom.com/mcp", transport: "http", auth: "oauth",
    docsUrl: "https://developers.intercom.com/docs/guides/mcp", officialDomains: ["intercom.com"],
    note: "EU workspaces use https://mcp.eu.intercom.com/mcp instead." },
  // ── Payments ───────────────────────────────────────────────────────────────────────────────────
  { id: "stripe", name: "Stripe", vendor: "Stripe, Inc.", category: "payments",
    url: "https://mcp.stripe.com", transport: "http", auth: "oauth",
    docsUrl: "https://docs.stripe.com/mcp", officialDomains: ["stripe.com"],
    note: "A Stripe agent API key also works as the token." },
  { id: "paypal", name: "PayPal", vendor: "PayPal, Inc.", category: "payments",
    url: "https://mcp.paypal.com/http", transport: "http", auth: "token",
    docsUrl: "https://developer.paypal.com/tools/mcp-server/", officialDomains: ["paypal.com"],
    note: "Uses a PayPal access token; the sandbox is https://mcp.sandbox.paypal.com/http." },
  { id: "square", name: "Square", vendor: "Block, Inc.", category: "payments",
    url: "https://mcp.squareup.com/mcp", transport: "http", auth: "oauth",
    docsUrl: "https://developer.squareup.com/docs/mcp", officialDomains: ["squareup.com"] },
  // ── Design and web ─────────────────────────────────────────────────────────────────────────────
  { id: "figma", name: "Figma", vendor: "Figma, Inc.", category: "design",
    url: "https://mcp.figma.com/mcp", transport: "http", auth: "oauth",
    docsUrl: "https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/", officialDomains: ["figma.com"],
    note: "Figma signs in only the clients on its supported list." },
  { id: "webflow", name: "Webflow", vendor: "Webflow, Inc.", category: "design",
    url: "https://mcp.webflow.com/mcp", transport: "http", auth: "oauth",
    docsUrl: "https://developers.webflow.com/mcp/v1.0.0/reference/getting-started", officialDomains: ["webflow.com"] },
  { id: "wix", name: "Wix", vendor: "Wix.com Ltd.", category: "design",
    url: "https://mcp.wix.com/mcp", transport: "http", auth: "oauth",
    docsUrl: "https://dev.wix.com/docs/sdk/articles/use-the-wix-mcp/about-the-wix-mcp", officialDomains: ["wix.com"] },
  // ── Social media ───────────────────────────────────────────────────────────────────────────────
  { id: "x", name: "X", vendor: "X Corp.", category: "social",
    url: "https://api.x.com/mcp", transport: "http", auth: "token",
    docsUrl: "https://docs.x.com/tools/mcp", officialDomains: ["x.com"],
    note: "An app-only Bearer token gives read-only access." },
  { id: "meta-ads", name: "Meta Ads (Facebook, Instagram)", vendor: "Meta Platforms, Inc.", category: "social",
    url: "https://mcp.facebook.com/ads", transport: "http", auth: "oauth",
    docsUrl: "https://developers.facebook.com/documentation/ads-commerce/ads-ai-connectors/ads-mcp-server/ads-mcp-server-overview",
    officialDomains: ["facebook.com"], note: META_NOTE },
  { id: "whatsapp-business", name: "WhatsApp Business", vendor: "Meta Platforms, Inc.", category: "social",
    url: "https://mcp.facebook.com/whatsapp_business_tools", transport: "http", auth: "oauth",
    docsUrl: "https://developers.facebook.com/documentation/mcp/whatsapp-business-tools-mcp",
    officialDomains: ["facebook.com"], note: META_NOTE },
  { id: "buffer", name: "Buffer", vendor: "Buffer, Inc.", category: "social",
    url: "https://mcp.buffer.com/mcp", transport: "http", auth: "oauth",
    docsUrl: "https://developers.buffer.com/guides/integrations/mcp.html", officialDomains: ["buffer.com"],
    note: "Schedule and manage posts across your connected social channels." },
];

export const MCP_COMMUNITY_CATALOG: readonly McpCatalogEntry[] = Object.freeze(
  COMMUNITY_SEED.map((s) => Object.freeze({ ...s, verifiedOn: VERIFIED, source: "community" as const })),
);

/** Verified against omp: an ACP-declared http/sse server that fails to connect is reported with
 *  "/mcp reauth <name>", and that slash command opens the vendor's OAuth page in the browser. */
export const MCP_OAUTH_HINT =
  "To sign in to an OAuth server, type /mcp reauth followed by the server name in chat; omp opens the vendor's sign-in page in your browser.";

/** Lowercased hostname of an https URL without a trailing dot; null for anything else (other schemes,
 *  credentials in the URL, unparsable input). */
function httpsHost(raw: string): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== "https:" || u.username || u.password) return null;
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  return host || null;
}

/** host equals `domain` or is a subdomain of it. A domain must have a dot (no bare TLDs). */
function hostUnder(host: string, domain: string): boolean {
  const d = domain.trim().toLowerCase().replace(/^\.+|\.+$/g, "");
  if (!d.includes(".")) return false;
  return host === d || host.endsWith(`.${d}`);
}

/** true when url host and docsUrl host are each equal to or a subdomain of one of officialDomains, and url is https. */
export function catalogEntryIsOfficial(e: McpCatalogEntry): boolean {
  const urlHost = httpsHost(e.url);
  const docsHost = httpsHost(e.docsUrl);
  if (!urlHost || !docsHost || !Array.isArray(e.officialDomains)) return false;
  const under = (h: string) => e.officialDomains.some((d) => typeof d === "string" && hostUnder(h, d));
  return under(urlHost) && under(docsHost);
}

/** scheme + host lowercased (the URL parser does both), path kept, trailing slashes dropped. */
function normalizeUrl(raw: string): string {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return raw.trim().toLowerCase().replace(/\/+$/, ""); }
  const host = u.host.replace(/\.$/, "");
  return `${u.protocol}//${host}${u.pathname.replace(/\/+$/, "")}${u.search}`;
}

/** Normalized comparison (scheme+host lowercased, trailing slash dropped). Returns the configured server matching e.url, if any. */
export function configuredFor<T extends { url: string }>(e: McpCatalogEntry, servers: readonly T[]): T | undefined {
  const want = normalizeUrl(e.url);
  return servers.find((s) => typeof s?.url === "string" && normalizeUrl(s.url) === want);
}

const MAX_ORG_ENTRIES = 200;
const MAX_URL = 2048;
const AUTHS: Record<McpCatalogAuth, true> = { oauth: true, token: true, none: true };

/** A trimmed string capped at `max` characters, or "" when not a string. */
function capped(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

function slug(v: string): string {
  return v.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}

/** Validates the managed-policy list (untrusted JSON): keeps only well-formed https entries, sets source:"org", fills defaults. */
export function normalizeOrgCatalog(raw: unknown): McpCatalogEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: McpCatalogEntry[] = [];
  const ids = new Set<string>();
  for (const item of raw.slice(0, MAX_ORG_ENTRIES)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const r = item as Record<string, unknown>;
    const name = capped(r.name, 80);
    const url = typeof r.url === "string" ? r.url.trim() : "";
    if (!name || !url || url.length > MAX_URL) continue;
    const host = httpsHost(url);
    if (!host) continue;
    const id = slug(capped(r.id, 64)) || slug(name) || slug(host);
    if (!id || ids.has(id)) continue;
    ids.add(id);
    const docsRaw = typeof r.docsUrl === "string" ? r.docsUrl.trim() : "";
    const docsUrl = docsRaw.length <= MAX_URL && httpsHost(docsRaw) ? docsRaw : "";
    const category = typeof r.category === "string" && Object.hasOwn(MCP_CATEGORY_LABEL, r.category) ? (r.category as McpCatalogCategory) : "saas";
    const auth = typeof r.auth === "string" && Object.hasOwn(AUTHS, r.auth) ? (r.auth as McpCatalogAuth) : "oauth";
    const verified = capped(r.verifiedOn, 10);
    const note = capped(r.note, 200);
    out.push({
      id,
      name,
      vendor: capped(r.vendor, 120) || name,
      category,
      url,
      transport: r.transport === "sse" ? "sse" : "http",
      auth,
      docsUrl,
      officialDomains: [host],
      verifiedOn: /^\d{4}-\d{2}-\d{2}$/.test(verified) ? verified : "",
      ...(note ? { note } : {}),
      source: "org",
    });
  }
  return out;
}
