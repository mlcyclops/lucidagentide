// API-1 6, 7.1, 7.2, 7.4, 8.2 and 9.4 (docs/api/contract.md): the one route table both API listeners dispatch from
// (the front door on the console's fleet port, and every relay's API listener), the resource pipeline's checks 0 to 11
// of 6.2 in order (the source limiter before any JWT or DPoP work), the scrape pipeline of 6.1 for map-listed `lme_`
// tokens on a relay listener, the data class and audit representation of 6.4, the resource routes' bodies, RFC 9457
// problem answers with the 8.2 headers (`Retry-After`, `RateLimit-*`, `X-Lucid-Request-Id` = the audit `rid`), and the
// OpenAPI 3.1 document generated from the table.
//
// 9.4: every decision is in the org's audit chain before its answer leaves: an allowed call is `api.call` (with the
// bytes it releases), a refusal goes through the chain's refusal summaries, and the token pipeline's decisions
// (`api.token`, refusals) go through `token_audited`. When the append fails the request is answered 503
// `audit-unavailable` and nothing else happens. A decision that concerns no org (an unknown org) is not in any chain.

use crate::api_audit::{ApiAudit, AuditError, Repr};
use crate::api_issue::{self, Answer, ClientCert, Limit};
use crate::api_map::{ApiMapStore, SCOPES};
use crate::api_token::{self as tok, Grant, JtiCache, Profile};
use crate::codec::{b64u, hex, sha256, unb64u};
use crate::fleet_metrics::{Kind, PromType, KEYS};
use parking_lot::Mutex;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, VecDeque};
use std::net::IpAddr;
use std::sync::atomic::{AtomicUsize, Ordering};

/// 6.5 source limiter on the resource pipeline: requests per source address, listener and minute.
pub const RESOURCE_PER_MINUTE: usize = 1200;
/// 6.5 source limiter on the public and scrape pipelines.
pub const PUBLIC_PER_MINUTE: usize = api_issue::SOURCE_PER_MINUTE;
/// 6.5 client limiter: requests per client, listener and minute across all outcomes.
pub const CLIENT_PER_MINUTE: usize = 600;
/// 8.2 pagination.
pub const PAGE_DEFAULT: usize = 100;
pub const PAGE_MAX: usize = 1000;
/// 6.1 scrape pipeline: one scrape per 10 s per token (as `SCRAPE_GAP_MS`).
const SCRAPE_GAP_S: i64 = crate::fleet_export::SCRAPE_GAP_MS / 1000;
/// Scrape tokens remembered for their gap before the stale ones are swept.
const SCRAPE_KEYS: usize = 4096;
const MINUTE: i64 = 60;
const NOT_FOUND: &str = "Nothing is here.";
const AUDIT_WHY: &str = "The audit log cannot record this request now; try again later.";

// ── the route table (7.1, 7.2, 7.4) ──────────────────────────────────────────────────────────────────────────────

/// Which listener serves a route.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Side {
    /// The console's fleet port (issuer and resource I).
    FrontDoor,
    /// A relay's API listener (resource RR, local issuer L).
    Relay,
}

/// The 6.1 pipeline of a route. The scrape pipeline is the alternative a route marks with `scrape`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Pipeline {
    Public,
    Token,
    Resource,
    /// Revision 5 4.6: the browser routes of the authorization code path.
    Authorize,
}

impl Pipeline {
    pub fn as_str(self) -> &'static str {
        match self {
            Pipeline::Public => "public",
            Pipeline::Token => "token",
            Pipeline::Resource => "resource",
            Pipeline::Authorize => "authorize",
        }
    }
}

/// What a route does; the listeners dispatch on it (exhaustively), so a route they serve is a row of `ROUTES`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RouteId {
    AsMetadata,
    LocalAsMetadata,
    ResourceMetadata,
    Jwks,
    LocalJwks,
    OpenApi,
    Token,
    LocalToken,
    Revoke,
    Health,
    Capacity,
    FleetRelays,
    FleetRelay,
    Audit,
    AuditKeys,
    Metrics,
    TelemetryCatalog,
    /// Revision 4 8.1: `I/federation` documents.
    FederationDiscovery,
    FederationJwks,
    /// Revision 4 7.3: the event feed, its types and its checkpoint certificates.
    Events,
    EventTypes,
    EventKeys,
    /// Revision 4 7.3: the org's webhook public keys (public, front door only).
    WebhookKeys,
    /// Revision 4 5.1 and 5.2: the compliance routes (front door only).
    ComplianceAttendance,
    ComplianceMeetings,
    ComplianceConversations,
    ComplianceFiles,
    ComplianceRetention,
    ComplianceHolds,
    ComplianceHold,
    ComplianceHoldPlace,
    /// Revision 4 5.3.7: compliance exports (reach R1, front door only).
    ComplianceExportRequest,
    ComplianceExports,
    ComplianceExport,
    ComplianceExportSeal,
    ComplianceExportPart,
    ComplianceExportCancel,
    /// Revision 5 4.4, 4.6, 6.5: the Authorize pipeline (front door only) and the metadata of M.
    Authorize,
    SsoReturn,
    Consent,
    ConsentPost,
    McpMetadata,
    /// API-1d 6.1: the `spokes.read` inventory of spokes relays (front door, and a spokes relay's own listener).
    SpokesNodes,
    SpokesCounts,
    SpokesSeats,
    SpokesRelays,
    /// API-1d 7.1.5: the org's Agent Cards and their key set (public, front door only).
    A2aAgents,
    A2aCard,
    A2aJwks,
}

impl RouteId {
    #[cfg(test)]
    pub const ALL: [RouteId; 49] = [
        RouteId::AsMetadata,
        RouteId::LocalAsMetadata,
        RouteId::ResourceMetadata,
        RouteId::Jwks,
        RouteId::LocalJwks,
        RouteId::OpenApi,
        RouteId::Token,
        RouteId::LocalToken,
        RouteId::Revoke,
        RouteId::Health,
        RouteId::Capacity,
        RouteId::FleetRelays,
        RouteId::FleetRelay,
        RouteId::Audit,
        RouteId::AuditKeys,
        RouteId::Metrics,
        RouteId::TelemetryCatalog,
        RouteId::FederationDiscovery,
        RouteId::FederationJwks,
        RouteId::Events,
        RouteId::EventTypes,
        RouteId::EventKeys,
        RouteId::WebhookKeys,
        RouteId::ComplianceAttendance,
        RouteId::ComplianceMeetings,
        RouteId::ComplianceConversations,
        RouteId::ComplianceFiles,
        RouteId::ComplianceRetention,
        RouteId::ComplianceHolds,
        RouteId::ComplianceHold,
        RouteId::ComplianceHoldPlace,
        RouteId::ComplianceExportRequest,
        RouteId::ComplianceExports,
        RouteId::ComplianceExport,
        RouteId::ComplianceExportSeal,
        RouteId::ComplianceExportPart,
        RouteId::ComplianceExportCancel,
        RouteId::Authorize,
        RouteId::SsoReturn,
        RouteId::Consent,
        RouteId::ConsentPost,
        RouteId::McpMetadata,
        RouteId::SpokesNodes,
        RouteId::SpokesCounts,
        RouteId::SpokesSeats,
        RouteId::SpokesRelays,
        RouteId::A2aAgents,
        RouteId::A2aCard,
        RouteId::A2aJwks,
    ];
}

/// One org route (7.4): method, path pattern (`{org}` the namespace, `{id}` a relay id), pipeline, scope, reach and
/// data class (empty scope and reach outside the resource pipeline), request and response schema names.
#[derive(Debug, PartialEq, Eq)]
pub struct ApiRoute {
    pub id: RouteId,
    pub side: Side,
    pub method: &'static str,
    pub path: &'static str,
    pub pipeline: Pipeline,
    /// A map-listed `lme_` scrape token is accepted instead (6.1).
    pub scrape: bool,
    pub scope: &'static str,
    pub reach: &'static str,
    /// 6.4: the class of the data the route releases (for `v1/audit` the lowest: the `as_is` chain is `confidential`).
    pub class: &'static str,
    pub request: &'static str,
    pub response: &'static str,
    pub summary: &'static str,
}

#[allow(clippy::too_many_arguments)]
const fn r(id: RouteId, side: Side, method: &'static str, path: &'static str, pipeline: Pipeline, scope: &'static str, class: &'static str, request: &'static str, response: &'static str, summary: &'static str) -> ApiRoute {
    let reach = if scope.is_empty() { "" } else { "R0" };
    ApiRoute { id, side, method, path, pipeline, scrape: false, scope, reach, class, request, response, summary }
}

/// Revision 4 9.1: a resource route of reach R1 (the compliance export routes).
#[allow(clippy::too_many_arguments)]
const fn r1(id: RouteId, method: &'static str, path: &'static str, scope: &'static str, class: &'static str, request: &'static str, response: &'static str, summary: &'static str) -> ApiRoute {
    ApiRoute { reach: "R1", ..r(id, Side::FrontDoor, method, path, Pipeline::Resource, scope, class, request, response, summary) }
}

use Pipeline::{Public as PUB, Resource as RES, Token as TOK};
use Side::{FrontDoor as F, Relay as R};

/// Every org route of both listeners (7.1, 7.2).
pub static ROUTES: [ApiRoute; 60] = [
    r(RouteId::AsMetadata, F, "GET", "/.well-known/oauth-authorization-server/api/orgs/{org}", PUB, "", "public", "", "AuthorizationServerMetadata", "RFC 8414 metadata of the issuer I"),
    r(RouteId::ResourceMetadata, F, "GET", "/.well-known/oauth-protected-resource/api/orgs/{org}", PUB, "", "public", "", "ProtectedResourceMetadata", "RFC 9728 metadata of the resource I"),
    r(RouteId::Jwks, F, "GET", "/api/orgs/{org}/jwks.json", PUB, "", "public", "", "Jwks", "The issuer keys of the org's api map"),
    r(RouteId::OpenApi, F, "GET", "/api/orgs/{org}/v1/openapi.json", PUB, "", "public", "", "OpenApi", "This document"),
    r(RouteId::Token, F, "POST", "/api/orgs/{org}/oauth/token", TOK, "", "internal", "TokenRequest", "TokenResponse", "Client credentials and token exchange (5.2)"),
    r(RouteId::Revoke, F, "POST", "/api/orgs/{org}/oauth/revoke", TOK, "", "internal", "RevokeRequest", "Empty", "RFC 7009 revocation (5.5)"),
    r(RouteId::Health, F, "GET", "/api/orgs/{org}/v1/health", RES, "monitor.read", "internal", "", "Health", "The console and the client's relays"),
    r(RouteId::Capacity, F, "GET", "/api/orgs/{org}/v1/capacity", RES, "monitor.read", "internal", "", "Capacity", "Each relay's latest snapshot values"),
    r(RouteId::FleetRelays, F, "GET", "/api/orgs/{org}/v1/fleet/relays", RES, "fleet.read", "internal", "", "RelayList", "The client's relays"),
    r(RouteId::FleetRelay, F, "GET", "/api/orgs/{org}/v1/fleet/relays/{id}", RES, "fleet.read", "internal", "", "Relay", "One relay with its certificates"),
    r(RouteId::Audit, F, "GET", "/api/orgs/{org}/v1/audit", RES, "audit.read", "internal", "", "AuditPage", "The org's console or relay audit chain"),
    r(RouteId::AuditKeys, F, "GET", "/api/orgs/{org}/v1/audit/keys", RES, "audit.read", "internal", "", "AuditKeys", "Checkpoint certificates, current and retired"),
    r(RouteId::Metrics, F, "GET", "/api/orgs/{org}/v1/metrics", RES, "monitor.read", "internal", "", "Metrics", "The client's relays' exposition"),
    r(RouteId::TelemetryCatalog, F, "GET", "/api/orgs/{org}/v1/telemetry/catalog", RES, "monitor.read", "internal", "", "TelemetryCatalog", "The telemetry catalog and field registry (section 10)"),
    r(RouteId::Events, F, "GET", "/api/orgs/{org}/v1/events", RES, "events.subscribe", "internal", "", "EventPage", "The org's event feed (revision 4 7.3), long poll with wait"),
    r(RouteId::EventTypes, F, "GET", "/api/orgs/{org}/v1/events/types", RES, "events.subscribe", "internal", "", "EventTypes", "The event types of the registry the client may see"),
    r(RouteId::EventKeys, F, "GET", "/api/orgs/{org}/v1/events/keys", RES, "events.subscribe", "internal", "", "AuditKeys", "Checkpoint certificates of the org's event chains, current and retired"),
    r(RouteId::FederationDiscovery, F, "GET", "/api/orgs/{org}/federation/.well-known/openid-configuration", PUB, "", "public", "", "OpenIdConfiguration", "The outbound federation issuer's discovery document, when the issuer is I/federation (revision 4 8.1)"),
    r(RouteId::FederationJwks, F, "GET", "/api/orgs/{org}/federation/jwks.json", PUB, "", "public", "", "Jwks", "The outbound federation keys, when the issuer is I/federation (revision 4 8.1)"),
    r(RouteId::WebhookKeys, F, "GET", "/api/orgs/{org}/v1/webhooks/keys", PUB, "", "public", "", "WebhookKeys", "The org's webhook public keys that verify v2a signatures, dropped keys left out (revision 4 7.3, 7.4)"),
    r(RouteId::ComplianceAttendance, F, "GET", "/api/orgs/{org}/v1/compliance/attendance", RES, "compliance.metadata.read", "confidential", "", "CompliancePage", "Call attendance sessions (revision 4 5.1)"),
    r(RouteId::ComplianceMeetings, F, "GET", "/api/orgs/{org}/v1/compliance/meetings", RES, "compliance.metadata.read", "confidential", "", "CompliancePage", "Scheduled meetings, never their descriptions (revision 4 5.1)"),
    r(RouteId::ComplianceConversations, F, "GET", "/api/orgs/{org}/v1/compliance/conversations", RES, "compliance.metadata.read", "confidential", "", "CompliancePage", "A person's conversations and member intervals (revision 4 5.1)"),
    r(RouteId::ComplianceFiles, F, "GET", "/api/orgs/{org}/v1/compliance/files", RES, "compliance.metadata.read", "confidential", "", "CompliancePage", "File records of a conversation or room, never names or hashes (revision 4 5.1)"),
    r(RouteId::ComplianceRetention, F, "GET", "/api/orgs/{org}/v1/compliance/retention", RES, "compliance.metadata.read", "confidential", "", "ComplianceRetention", "Retention, archive and legal hold settings (revision 4 5.1)"),
    r(RouteId::ComplianceHolds, F, "GET", "/api/orgs/{org}/v1/compliance/holds", RES, "compliance.metadata.read", "confidential", "", "HoldList", "Holds placed through the API and the console (revision 4 5.2.4)"),
    r(RouteId::ComplianceHold, F, "GET", "/api/orgs/{org}/v1/compliance/holds/{hold}", RES, "compliance.metadata.read", "confidential", "", "Hold", "One hold (revision 4 5.2.4)"),
    r(RouteId::ComplianceHoldPlace, F, "POST", "/api/orgs/{org}/v1/compliance/holds", RES, "compliance.holds.write", "confidential", "HoldRequest", "HoldPlaced", "Place a legal hold on people (revision 4 5.2.2), with Idempotency-Key"),
    r1(RouteId::ComplianceExportRequest, "POST", "/api/orgs/{org}/v1/compliance/exports", "compliance.export.request", "confidential", "ExportRequest", "ExportAccepted", "Request a compliance export, released by two archive reviewers (revision 4 5.3.2), with Idempotency-Key"),
    r1(RouteId::ComplianceExports, "GET", "/api/orgs/{org}/v1/compliance/exports", "compliance.export.request", "confidential", "", "ExportList", "This client's export jobs, newest first (revision 4 5.3.7)"),
    r1(RouteId::ComplianceExport, "GET", "/api/orgs/{org}/v1/compliance/exports/{job}", "compliance.export.request", "confidential", "", "Export", "One export job (revision 4 5.3.7)"),
    r1(RouteId::ComplianceExportSeal, "GET", "/api/orgs/{org}/v1/compliance/exports/{job}/seal", "compliance.export.request", "confidential", "", "ExportSeal", "The seal header of a ready job (revision 4 5.3.6)"),
    r1(RouteId::ComplianceExportPart, "GET", "/api/orgs/{org}/v1/compliance/exports/{job}/parts/{n}", "compliance.export.request", "confidential", "", "ExportPart", "One ciphertext part of a ready job (revision 4 5.3.6)"),
    r1(RouteId::ComplianceExportCancel, "POST", "/api/orgs/{org}/v1/compliance/exports/{job}/cancel", "compliance.export.request", "confidential", "", "Export", "End a job that is not ready (revision 4 5.3.7)"),
    // revision 5 4.4, 4.6, 6.5
    r(RouteId::McpMetadata, F, "GET", "/.well-known/oauth-protected-resource/api/orgs/{org}/mcp", PUB, "", "public", "", "ProtectedResourceMetadata", "RFC 9728 metadata of the console MCP endpoint M"),
    r(RouteId::Authorize, F, "GET", "/api/orgs/{org}/oauth/authorize", Pipeline::Authorize, "", "internal", "", "Html", "Authorization code with PKCE through the org's single sign-on (revision 5 6.5)"),
    r(RouteId::SsoReturn, F, "POST", "/api/orgs/{org}/oauth/sso-return", Pipeline::Authorize, "", "internal", "SsoAttestation", "Html", "The single sign-on service's signed attestation (revision 5 6.5 step 3)"),
    r(RouteId::Consent, F, "GET", "/api/orgs/{org}/oauth/consent", Pipeline::Authorize, "", "internal", "", "Html", "The consent page (revision 5 6.5 step 4)"),
    r(RouteId::ConsentPost, F, "POST", "/api/orgs/{org}/oauth/consent", Pipeline::Authorize, "", "internal", "ConsentDecision", "Html", "Allow or deny (revision 5 6.5 steps 4 and 5)"),
    // API-1d 6.1 and 6.2: `internal` rows (emails only for a client whose ceiling allows people)
    r(RouteId::SpokesNodes, F, "GET", "/api/orgs/{org}/v1/spokes/nodes", RES, "spokes.read", "internal", "", "SpokesNodes", "The nodes of one spokes relay of the client (API-1d 6.1)"),
    r(RouteId::SpokesCounts, F, "GET", "/api/orgs/{org}/v1/spokes/counts", RES, "spokes.read", "internal", "", "SpokesCounts", "Node counts of every spokes relay of the client (API-1d 6.1)"),
    r(RouteId::SpokesSeats, F, "GET", "/api/orgs/{org}/v1/spokes/seats", RES, "spokes.read", "internal", "", "SpokesSeats", "License seats of one spokes relay of the client (API-1d 6.1)"),
    r(RouteId::SpokesRelays, F, "GET", "/api/orgs/{org}/v1/spokes/relays", RES, "spokes.read", "internal", "", "SpokesRelays", "Directory, CRL and license of one spokes relay of the client (API-1d 6.1)"),
    // API-1d 7.1.5: the org's signed Agent Cards (A2A 8.2 direct configuration) and the key set that verifies them
    r(RouteId::A2aAgents, F, "GET", "/api/orgs/{org}/a2a/agents", PUB, "", "public", "", "AgentList", "The org's served agents and their card URLs (API-1d 7.1.5)"),
    r(RouteId::A2aCard, F, "GET", "/api/orgs/{org}/a2a/agents/{agent}/agent-card.json", PUB, "", "public", "", "AgentCard", "One agent's signed A2A Agent Card, with ETag (API-1d 7.1)"),
    r(RouteId::A2aJwks, F, "GET", "/api/orgs/{org}/a2a/jwks.json", PUB, "", "public", "", "Jwks", "The card keys inside their window and not dropped (API-1d 7.1.4)"),
    r(RouteId::LocalAsMetadata, R, "GET", "/.well-known/oauth-authorization-server/api/orgs/{org}/local", PUB, "", "public", "", "AuthorizationServerMetadata", "RFC 8414 metadata of the local issuer L"),
    r(RouteId::ResourceMetadata, R, "GET", "/.well-known/oauth-protected-resource/api/orgs/{org}", PUB, "", "public", "", "ProtectedResourceMetadata", "RFC 9728 metadata of the resource RR"),
    r(RouteId::LocalJwks, R, "GET", "/api/orgs/{org}/local/jwks.json", PUB, "", "public", "", "Jwks", "The relay's local token keys for the org"),
    r(RouteId::LocalToken, R, "POST", "/api/orgs/{org}/local/oauth/token", TOK, "", "internal", "TokenRequest", "TokenResponse", "Relay-local tokens (5.6)"),
    r(RouteId::Health, R, "GET", "/api/orgs/{org}/v1/health", RES, "monitor.read", "internal", "", "Health", "This relay and its console link"),
    r(RouteId::Audit, R, "GET", "/api/orgs/{org}/v1/audit", RES, "audit.read", "internal", "", "AuditPage", "This relay's audit chain for the org"),
    r(RouteId::AuditKeys, R, "GET", "/api/orgs/{org}/v1/audit/keys", RES, "audit.read", "internal", "", "AuditKeys", "This relay's checkpoint certificates"),
    r(RouteId::Events, R, "GET", "/api/orgs/{org}/v1/events", RES, "events.subscribe", "internal", "", "EventPage", "This relay's event chain for the org (revision 4 7.3), long poll with wait"),
    r(RouteId::EventKeys, R, "GET", "/api/orgs/{org}/v1/events/keys", RES, "events.subscribe", "internal", "", "AuditKeys", "This relay's checkpoint certificates"),
    ApiRoute { scrape: true, ..r(RouteId::Metrics, R, "GET", "/api/orgs/{org}/v1/metrics", RES, "monitor.read", "internal", "", "Metrics", "This relay's exposition") },
    // API-1d 6.3: a spokes relay's own inventory (404 on a Meet relay)
    r(RouteId::SpokesNodes, R, "GET", "/api/orgs/{org}/v1/spokes/nodes", RES, "spokes.read", "internal", "", "SpokesNodes", "This spokes relay's nodes (API-1d 6.1)"),
    r(RouteId::SpokesCounts, R, "GET", "/api/orgs/{org}/v1/spokes/counts", RES, "spokes.read", "internal", "", "SpokesCounts", "This spokes relay's node counts (API-1d 6.1)"),
    r(RouteId::SpokesSeats, R, "GET", "/api/orgs/{org}/v1/spokes/seats", RES, "spokes.read", "internal", "", "SpokesSeats", "This spokes relay's license seats (API-1d 6.1)"),
    r(RouteId::SpokesRelays, R, "GET", "/api/orgs/{org}/v1/spokes/relays", RES, "spokes.read", "internal", "", "SpokesRelays", "This spokes relay's directory, CRL and license (API-1d 6.1)"),
];

/// The org namespace of a request path (`/api/orgs/<org>/...`, or a `.well-known` document of one), whether or not a
/// route takes it; None outside every namespace or for a string that is no org id.
pub fn org_of(path: &str) -> Option<&str> {
    let rest = path
        .strip_prefix("/api/orgs/")
        .or_else(|| path.strip_prefix("/.well-known/oauth-authorization-server/api/orgs/"))
        .or_else(|| path.strip_prefix("/.well-known/oauth-protected-resource/api/orgs/"))?;
    let org = rest.split('/').next()?;
    let ok = (1..=32).contains(&org.len()) && org.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
    ok.then_some(org)
}

/// The route a refusal outside the table is summarized under: the method word and the namespace only, so arbitrary
/// paths and methods cannot open unbounded summary buckets.
pub fn namespace_route(method: &str, org: &str) -> String {
    let m = match method {
        "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS" => method,
        _ => "OTHER",
    };
    format!("{m} /api/orgs/{org}")
}

/// 6.5 first: `refused`, or 429 `abuse` with `Retry-After` when the source limiter's verdict `limit` refused.
pub fn charged(limit: Result<(), i64>, refused: Reply) -> Reply {
    match limit {
        Ok(()) => refused,
        Err(s) => {
            let mut r = problem(429, "abuse", "Too many requests from this address; try again later.");
            r.headers.push(("Retry-After", s.max(1).to_string()));
            r
        }
    }
}

/// A request path matched to its route.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Matched<'a> {
    pub route: &'static ApiRoute,
    pub org: &'a str,
    pub id: Option<&'a str>,
}

/// `path` against a pattern: `{org}` and `{id}` each one non-empty segment.
fn fit<'a>(pattern: &str, path: &'a str) -> Option<(&'a str, Option<&'a str>)> {
    let (mut org, mut id) = (None, None);
    let (mut p, mut s) = (pattern.split('/'), path.split('/'));
    loop {
        match (p.next(), s.next()) {
            (None, None) => break,
            (Some("{org}"), Some(x)) if !x.is_empty() => org = Some(x),
            // `{id}` a relay id, `{hold}` a hold (revision 4 5.2.4), `{job}` an export job (5.3.7), `{agent}` an agent
            // (API-1d 7.1.5): the path's one id
            (Some("{id}" | "{hold}" | "{job}" | "{agent}"), Some(x)) if !x.is_empty() => id = Some(x),
            // a part's `{n}`, read by its route from the path (`api_exports::part_of`)
            (Some("{n}"), Some(x)) if !x.is_empty() => {}
            (Some(a), Some(b)) if a == b => {}
            _ => return None,
        }
    }
    Some((org?, id))
}

/// The route of a request on one listener, the org taken from the path only (API1-R2); None (404) for anything else,
/// a known path under another method included.
pub fn route_of<'a>(side: Side, method: &str, path: &'a str) -> Option<Matched<'a>> {
    ROUTES.iter().filter(|r| r.side == side && r.method == method).find_map(|route| fit(route.path, path).map(|(org, id)| Matched { route, org, id }))
}

// ── answers (8.2) ────────────────────────────────────────────────────────────────────────────────────────────────

/// One answer of either listener.
#[derive(Clone, Debug)]
pub struct Reply {
    pub status: u16,
    pub ctype: &'static str,
    pub headers: Vec<(&'static str, String)>,
    pub body: Value,
    /// The bytes sent instead of `body`: an exposition, or `body` already serialized for its `api.call` entry.
    pub text: Option<String>,
    /// Revision 4 5.3.7: binary bytes sent instead of `text` and `body` (an export part).
    pub raw: Option<Vec<u8>>,
}

impl Reply {
    /// A JSON answer, never cached.
    pub fn json(status: u16, body: Value) -> Reply {
        Reply { status, ctype: "application/json", headers: vec![("Cache-Control", "no-store".into())], body, text: None, raw: None }
    }

    /// The body as sent.
    pub fn bytes(&self) -> Vec<u8> {
        match (&self.raw, &self.text) {
            (Some(b), _) => b.clone(),
            (None, Some(t)) => t.as_bytes().to_vec(),
            (None, None) => serde_json::to_vec(&self.body).unwrap_or_default(),
        }
    }

    /// An issuer answer (`api_issue`) as a reply.
    pub fn of_answer(a: Answer) -> Reply {
        let problem = a.headers.iter().any(|(k, v)| k.eq_ignore_ascii_case("content-type") && v == "application/problem+json");
        let headers = a.headers.into_iter().filter(|(k, _)| !k.eq_ignore_ascii_case("content-type")).collect();
        Reply { status: a.status, ctype: if problem { "application/problem+json" } else { "application/json" }, headers, body: a.body, text: None, raw: None }
    }
}

/// 8.2: a refusal under `/api/orgs/`: the console convention's `{ok, code, error}` with the RFC 9457 fields.
pub fn problem(status: u16, code: &str, detail: &str) -> Reply {
    let body = json!({
        "ok": false, "code": code, "error": detail,
        "type": format!("https://lucid.emertins.com/problems/{code}"), "title": crate::meet::reason_phrase(status), "status": status, "detail": detail,
    });
    Reply { status, ctype: "application/problem+json", headers: vec![("Cache-Control", "no-store".into())], body, text: None, raw: None }
}

/// 9.4: the append failed; nothing else happens.
pub fn audit_unavailable() -> Reply {
    problem(503, "audit-unavailable", AUDIT_WHY)
}

/// 9.4 for a refusal of a known org outside the resource pipeline (a public document's source limiter or license):
/// into the org's refusal summaries under the source address, then `reply`; 503 `audit-unavailable` when it cannot be
/// recorded (or there is no chain).
pub fn public_refused(audit: Option<&dyn AuditLog>, org: &str, route: &str, rid: &str, source: IpAddr, reply: Reply, now: i64) -> Reply {
    let Some(audit) = audit else { return audit_unavailable() };
    let code = reply.body.get("code").and_then(Value::as_str).unwrap_or("refused").to_string();
    let e = json!({"rid": rid, "action": "api.refusal", "route": route, "ip": ip_of(source), "result": "refused",
                   "check": code, "status": reply.status, "count": 1});
    let key = format!("ip:{}", crate::console_source::source_key(source));
    match audit.refusal(org, &key, &code, route, e, now) {
        Ok(()) => {
            counted(org, "", Some(&code));
            reply
        }
        Err(_) => {
            counted(org, "", Some("audit-unavailable"));
            audit_unavailable()
        }
    }
}

/// A fresh audit `rid` (22 base64url characters), also the answer's `X-Lucid-Request-Id`.
pub fn rid() -> String {
    let mut b = [0u8; 16];
    let _ = aws_lc_rs::rand::fill(&mut b);
    b64u(&b)
}

// ── what the routes read ─────────────────────────────────────────────────────────────────────────────────────────

/// The audit chains as the routes use them (`ApiAudit` in production).
pub trait AuditLog: Send + Sync {
    fn record(&self, org: &str, entry: Value, now: i64) -> Result<u64, AuditError>;
    fn refusal(&self, org: &str, key: &str, check: &str, route: &str, entry: Value, now: i64) -> Result<(), AuditError>;
    /// False below the free-space reserve: allowed calls are refused (9.4).
    fn allowed_ok(&self) -> bool;
    fn read(&self, org: &str, source: &str, repr: Repr, after: u64, limit: usize) -> Result<Value, AuditError>;
    fn keys(&self, org: &str) -> Vec<Value>;
}

impl AuditLog for ApiAudit {
    fn record(&self, org: &str, entry: Value, now: i64) -> Result<u64, AuditError> {
        ApiAudit::record(self, org, entry, now)
    }
    fn refusal(&self, org: &str, key: &str, check: &str, route: &str, entry: Value, now: i64) -> Result<(), AuditError> {
        ApiAudit::refusal(self, org, key, check, route, entry, now)
    }
    fn allowed_ok(&self) -> bool {
        ApiAudit::allowed_ok(self)
    }
    fn read(&self, org: &str, source: &str, repr: Repr, after: u64, limit: usize) -> Result<Value, AuditError> {
        ApiAudit::read(self, org, source, repr, after, limit)
    }
    fn keys(&self, org: &str) -> Vec<Value> {
        ApiAudit::keys(self, org)
    }
}

/// One relay as the routes report it.
#[derive(Clone, Debug, Default)]
pub struct RelayInfo {
    pub id: String,
    pub name: String,
    pub region: String,
    pub version: String,
    pub fips: bool,
    /// `LICENSE_STATES` word, empty when unknown.
    pub license_state: String,
    pub up: bool,
    /// One of `HEALTH_STATES`.
    pub health: String,
    pub last_contact_s: Option<i64>,
    /// The latest 9.1 snapshot `m` (filtered by `capacity`).
    pub latest: Map<String, Value>,
    /// `{"name", "days_left"}` and, where known, `serial`.
    pub certificates: Vec<Value>,
}

/// The listener's view of the fleet: the console's registry and metrics on the front door, the relay itself on a
/// relay listener.
pub trait Data {
    /// The relays the listener reports on for the org (front door: the org's relays; a relay: itself).
    fn relays(&self, org: &str, now: i64) -> Vec<RelayInfo>;
    /// The ids of `relays`, without reading their values.
    fn ids(&self, org: &str) -> Vec<String>;
    /// The exposition of the relays `ids` (same family names and labels as the console's `/metrics`).
    fn exposition(&self, org: &str, ids: &[String], now: i64) -> String;
    /// `v1/health`'s `console`: `{"version", "fips"}` on the front door; `"connected"` or `"unreachable"` on a relay.
    fn console(&self) -> Value;
    /// Revision 4 7.3: the event chains the listener serves (the console's feed on the front door, the relay's own
    /// chain on a relay); None while there are none (`v1/events` answers 503).
    fn events(&self) -> Option<std::sync::Arc<crate::api_events::EventLog>> {
        None
    }
    /// Revision 4 5.1 and 5.2: the console's compliance desk (front door only; None elsewhere, 404).
    fn compliance(&self) -> Option<std::sync::Arc<dyn crate::api_compliance::Desk>> {
        None
    }
    /// API-1d 6.1: one 6.2 view (`nodes`, `counts`, `seats`, `relays`) of the spokes relay `relay` for the org, `query`
    /// the route's query without `relay` (at most 512 bytes), `people` whether emails may be answered. The front door
    /// asks the relay with `api-spokes`; a spokes relay's listener answers its own (`api_listener::Source::spokes`).
    /// None: no such spokes relay here (404); Err: its refusal (a silent relay: 503 `relay-unreachable`).
    fn spokes(&self, _org: &str, _relay: &str, _view: &str, _query: &str, _people: bool) -> Option<Result<Value, crate::fleet_wire::Refusal>> {
        None
    }
}

/// One listener's limiter state (6.5) for the resource and scrape pipelines and its DPoP `jti` cache.
pub struct ResourceState {
    sources: Mutex<HashMap<String, VecDeque<i64>>>,
    public: Mutex<HashMap<String, VecDeque<i64>>>,
    clients: Mutex<HashMap<String, VecDeque<i64>>>,
    rate: Mutex<HashMap<String, VecDeque<i64>>>,
    daily: Mutex<HashMap<String, VecDeque<(i64, u64)>>>,
    dpop: Mutex<JtiCache>,
    scrapes: Mutex<HashMap<String, i64>>,
    /// Access tokens handed to signature validation (the source limiter keeps a flood from reaching it).
    validations: AtomicUsize,
    /// Revision 4 7.3: the long polls held on this listener, one per org and client.
    held: crate::api_events::Holds,
}

impl Default for ResourceState {
    fn default() -> ResourceState {
        ResourceState {
            sources: Mutex::default(),
            public: Mutex::default(),
            clients: Mutex::default(),
            rate: Mutex::default(),
            daily: Mutex::default(),
            dpop: Mutex::new(JtiCache::dpop()),
            scrapes: Mutex::default(),
            validations: AtomicUsize::new(0),
            held: crate::api_events::Holds::default(),
        }
    }
}

impl ResourceState {
    pub fn new() -> ResourceState {
        ResourceState::default()
    }

    /// Access tokens validated so far on this listener.
    #[cfg(test)]
    pub fn validations(&self) -> usize {
        self.validations.load(Ordering::Relaxed)
    }

    /// 6.5 source limiter of the public and scrape pipelines (120 a minute); Err is the seconds to wait.
    pub fn public_ok(&self, ip: IpAddr, now: i64) -> Result<(), i64> {
        api_issue::take(&self.public, &crate::console_source::source_key(ip), PUBLIC_PER_MINUTE, now).map(|_| ()).map_err(wait_of)
    }
}

fn wait_of(l: Limit) -> i64 {
    match l {
        Limit::Wait(s) => s,
        Limit::Full => MINUTE,
    }
}

// ── one request ──────────────────────────────────────────────────────────────────────────────────────────────────

/// The listener and org a request reaches, all from the pinned map and the listener's own state.
pub struct Site<'a> {
    pub side: Side,
    /// `console` on the front door, else this relay's fleet id (whose own chains a relay listener serves).
    pub relay: &'a str,
    /// I on the front door, RR on a relay.
    pub resource: &'a str,
    /// A relay's local issuer L and its JWKS for the org (the local profile of 5.6); None on the front door.
    pub local: Option<(&'a str, &'a [Value])>,
    /// A snapshot of the org's store (pinned map and active journal).
    pub store: &'a ApiMapStore,
    pub owner_active: &'a dyn Fn(&str) -> bool,
    /// 6.2 check 1.
    pub licensed: bool,
    pub audit: &'a dyn AuditLog,
    pub state: &'a ResourceState,
    pub data: &'a dyn Data,
    pub now: i64,
}

/// One request.
pub struct Call<'a> {
    pub org: &'a str,
    pub route: &'static ApiRoute,
    /// The path's `{id}`.
    pub id: Option<&'a str>,
    pub path: &'a str,
    pub query: &'a str,
    pub authorization: Option<&'a str>,
    pub dpop: Option<&'a str>,
    pub cert: Option<&'a ClientCert>,
    pub source: IpAddr,
    /// The audit `rid`.
    pub rid: &'a str,
}

/// Revision 4 4.5 and 5.2.2: the body of a route that takes one (a JSON object, or why it was not read:
/// `too-large`, `request`) and its `Idempotency-Key` header, as the front door read them.
#[derive(Clone, Debug, PartialEq)]
pub struct Body {
    pub json: Result<Value, &'static str>,
    pub key: Option<String>,
}

/// An internal header a route sets on an `Idempotency-Key` replay: `finish` audits it `result: "replayed"` and
/// drops it.
const REPLAYED: &str = "x-lucid-replayed";

/// `RateLimit-*` of this listener's per-minute window.
#[derive(Clone, Copy, Debug)]
struct Rate {
    limit: u64,
    remaining: u64,
    reset: i64,
}

/// A refusal before it is audited and answered.
struct No {
    status: u16,
    code: &'static str,
    why: String,
    retry: Option<i64>,
    rate: Option<Rate>,
}

fn no(status: u16, code: &'static str, why: impl Into<String>) -> No {
    No { status, code, why: why.into(), retry: None, rate: None }
}

impl No {
    fn retry(self, s: i64) -> No {
        No { retry: Some(s.max(1)), ..self }
    }
}

/// A call that passed its pipeline.
pub struct Allowed {
    /// The client id, or a scrape token's hint.
    pub client: String,
    pub grant: Option<Grant>,
    /// 6.4: the audit representation the effective ceiling selects.
    pub repr: Repr,
    pub jti: Option<String>,
    rate: Option<Rate>,
}

impl Allowed {
    /// 6.2 check 8: the client's `relays` include `relay` (`console` for the console).
    pub fn reaches(&self, relay: &str) -> bool {
        self.grant.as_ref().is_none_or(|g| g.relays.iter().any(|r| r == "*" || r == relay))
    }
}

fn route_name(call: &Call) -> String {
    format!("{} {}", call.route.method, call.route.path.replace("{org}", call.org))
}

fn ip_of(source: IpAddr) -> String {
    crate::console_source::canonical(source).to_string()
}

/// The fields every entry of a request carries.
fn entry_of(call: &Call, action: &str) -> Map<String, Value> {
    let mut e = Map::new();
    e.insert("rid".into(), json!(call.rid));
    e.insert("action".into(), json!(action));
    e.insert("route".into(), json!(route_name(call)));
    e.insert("ip".into(), json!(ip_of(call.source)));
    e
}

/// 10.1: a decision in `lucid_api_requests_total` (`client` empty until authenticated) and, refused, in
/// `lucid_api_refusals_total` by its check.
fn counted(org: &str, client: &str, refused: Option<&str>) {
    use crate::api_catalog::counters;
    match refused {
        None => counters::api_request(org, client, "ok"),
        Some(check) => {
            counters::api_request(org, client, "refused");
            counters::api_refusal(org, check);
        }
    }
}

fn rate_headers(r: &mut Reply, rate: Option<Rate>) {
    if let Some(x) = rate {
        r.headers.push(("RateLimit-Limit", x.limit.to_string()));
        r.headers.push(("RateLimit-Remaining", x.remaining.to_string()));
        r.headers.push(("RateLimit-Reset", x.reset.to_string()));
    }
}

/// 9.4: the refusal into the org's refusal summaries (key: the client once identified, else the source address),
/// then its answer; 503 `audit-unavailable` when it cannot be recorded.
fn refuse(site: &Site, call: &Call, who: Option<(&str, Option<&str>)>, n: No) -> Reply {
    refuse_with(site, call, who, n, &Map::new())
}

/// `refuse` with `extra` fields in the entry (revision 5 12.2 `tool` and `person` of an MCP call).
fn refuse_with(site: &Site, call: &Call, who: Option<(&str, Option<&str>)>, n: No, extra: &Map<String, Value>) -> Reply {
    let route = route_name(call);
    let mut e = entry_of(call, "api.refusal");
    e.extend(extra.iter().map(|(k, v)| (k.clone(), v.clone())));
    e.insert("result".into(), json!("refused"));
    e.insert("check".into(), json!(n.code));
    e.insert("status".into(), json!(n.status));
    e.insert("count".into(), json!(1));
    if !call.route.scope.is_empty() {
        e.insert("scope".into(), json!(call.route.scope));
    }
    if let Some((client, jti)) = who {
        e.insert("client".into(), json!(client));
        if let Some(j) = jti {
            e.insert("jti".into(), json!(j));
        }
    }
    let key = who.map_or_else(|| format!("ip:{}", crate::console_source::source_key(call.source)), |(c, _)| c.to_string());
    if site.audit.refusal(call.org, &key, n.code, &route, Value::Object(e), site.now).is_err() {
        counted(call.org, who.map_or("", |(c, _)| c), Some("audit-unavailable"));
        return audit_unavailable();
    }
    counted(call.org, who.map_or("", |(c, _)| c), Some(n.code));
    let mut r = problem(n.status, n.code, &n.why);
    if let Some(s) = n.retry {
        r.headers.push(("Retry-After", s.to_string()));
    }
    if n.status == 401 {
        // RFC 6750 and RFC 9449
        let error = if call.authorization.is_some() { ", error=\"invalid_token\"" } else { "" };
        r.headers.push(("WWW-Authenticate", format!("Bearer realm=\"{}\"{error}", site.resource)));
        r.headers.push(("WWW-Authenticate", format!("DPoP realm=\"{}\", algs=\"ES256\"{error}", site.resource)));
    }
    rate_headers(&mut r, n.rate);
    r
}

/// The token of an `Authorization: DPoP <token>` or `Bearer <token>` header.
fn access_token(header: Option<&str>) -> Option<&str> {
    let (scheme, rest) = header?.trim().split_once(' ')?;
    let token = rest.trim();
    ((scheme.eq_ignore_ascii_case("DPoP") || scheme.eq_ignore_ascii_case("Bearer")) && !token.is_empty()).then_some(token)
}

/// 6.2 check 3: the status and code of a validation refusal (5.4).
fn token_refusal(code: &str) -> (u16, &'static str) {
    match code {
        "map-expired" => (401, "map-expired"),
        "api-off" => (403, "api-off"),
        "expired" => (401, "expired"),
        "map-behind" => (401, "map-behind"),
        "suspended" => (403, "suspended"),
        "owner" => (403, "owner"),
        // revision 5 6.6: a delegated token's person under `delegation.denied` or `person_revoke`
        "person" => (403, "person"),
        "abuse" => (429, "abuse"),
        _ => (401, "token"),
    }
}

/// A query parameter (the first), as sent.
fn param<'q>(query: &'q str, k: &str) -> Option<&'q str> {
    query.split('&').filter_map(|p| p.split_once('=')).find(|(a, _)| *a == k).map(|(_, v)| v)
}

/// 8.2 `limit`: 1 to 1000, default 100.
fn limit_of(query: &str) -> Result<usize, No> {
    match param(query, "limit") {
        None => Ok(PAGE_DEFAULT),
        Some(l) => l.parse::<usize>().ok().filter(|n| (1..=PAGE_MAX).contains(n)).ok_or_else(|| no(400, "bad-request", "limit must be a number from 1 to 1000.")),
    }
}

/// The audit source a `v1/audit` request names: a relay listener's own id; on the front door `console` (the default),
/// `source=relay&relay=<id>`, or (revision 5 12.1) `source=connector&connector=<k_id>`.
fn audit_source(site: &Site, call: &Call) -> Result<String, No> {
    if site.side == Side::Relay {
        return Ok(site.relay.to_string());
    }
    match (param(call.query, "source").unwrap_or("console"), param(call.query, "relay"), param(call.query, "connector")) {
        ("console", None, None) => Ok("console".into()),
        ("relay", Some(id), None) if relay_id_ok(id) => Ok(id.to_string()),
        ("connector", None, Some(id)) if crate::connector::connector_id_ok(id) => Ok(id.to_string()),
        _ => Err(no(400, "bad-request", "source must be console, relay with relay=<id>, or connector with connector=<id>.")),
    }
}

/// `r_` and 16 lowercase hex digits.
fn relay_id_ok(id: &str) -> bool {
    id.len() == 18 && id.starts_with("r_") && id[2..].bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// 6.2 check 8's resource: the relay (or `console`) a call is about; None for a list, filtered later. A connector's
/// chain is held by the console, so reading it is about `console` (revision 5 12.1).
fn target_of(site: &Site, call: &Call) -> Option<String> {
    if site.side == Side::Relay {
        return Some(site.relay.to_string());
    }
    match call.route.id {
        RouteId::FleetRelay => call.id.map(str::to_string),
        RouteId::Audit => audit_source(site, call).ok().map(|s| if crate::connector::connector_id_ok(&s) { "console".to_string() } else { s }),
        // API-1d 6.1: the one spokes relay a view is about (`counts` lists every one the client reaches)
        RouteId::SpokesNodes | RouteId::SpokesSeats | RouteId::SpokesRelays => param(call.query, "relay").filter(|r| relay_id_ok(r)).map(str::to_string),
        _ => None,
    }
}

/// 6.1 for `GET I/v1/openapi.json` (public): the org is known (the caller), then the source limiter.
fn openapi_answer(site: &Site, call: &Call) -> Reply {
    if let Err(s) = site.state.public_ok(call.source, site.now) {
        return refuse(site, call, None, no(429, "abuse", "Too many requests from this address; try again later.").retry(s));
    }
    let mut r = Reply::json(200, openapi(site.side, call.org, site.resource));
    r.headers = vec![("Cache-Control", "max-age=300".into())];
    r
}

/// Every route of `ROUTES` the listener hands here (the OpenAPI document and the resource routes), with its
/// `X-Lucid-Request-Id`. The issuer routes stay with the listeners (`token_audited`). Each call is one span for the
/// org's `traces` destinations (API-1 11, `api_export::api_span`; nothing without a console engine).
pub fn answer(site: &Site, call: &Call) -> Reply {
    answer_with(site, call, None)
}

/// `answer` for a route that takes a body (revision 4 5.2.2 `POST v1/compliance/holds`).
pub fn answer_with(site: &Site, call: &Call, body: Option<&Body>) -> Reply {
    let start_ms = crate::codec::now_ms();
    let mut r = match (call.route.pipeline, call.route.id) {
        (Pipeline::Public, RouteId::OpenApi) => openapi_answer(site, call),
        (Pipeline::Resource, _) => resource_answer(site, call, body),
        _ => problem(404, "not-found", NOT_FOUND),
    };
    r.headers.push(("X-Lucid-Request-Id", call.rid.to_string()));
    crate::api_export::api_span(&crate::api_export::SpanCall {
        org: call.org,
        method: call.route.method,
        route: call.route.path,
        status: r.status,
        rid: call.rid,
        relay: if site.side == Side::Relay { site.relay } else { "console" },
        start_ms,
        end_ms: crate::codec::now_ms(),
    });
    r
}

fn resource_answer(site: &Site, call: &Call, body: Option<&Body>) -> Reply {
    let target = target_of(site, call);
    let ok = match authorize(site, call, target.as_deref()) {
        Ok(a) => a,
        Err(r) => return r,
    };
    match serve(site, call, &ok, body) {
        Ok(reply) => finish(site, call, &ok, target.as_deref(), reply),
        Err(n) => refuse(site, call, Some((ok.client.as_str(), ok.jti.as_deref())), No { rate: ok.rate, ..n }),
    }
}

/// Revision 4 6.3: the relay's `api-check` runs checks 0 to 11 for a SCIM request on a route row of its own
/// (`api_scim`, never in `ROUTES`), about this relay (check 8); refusals are audited before they are answered.
pub(crate) fn scim_authorize(site: &Site, call: &Call) -> Result<Allowed, Reply> {
    authorize(site, call, Some(site.relay))
}

/// 6.2 checks 0 to 11 in order (or the 6.1 scrape pipeline for a map-listed `lme_` token where the route allows it);
/// every refusal is audited before it is answered.
fn authorize(site: &Site, call: &Call, target: Option<&str>) -> Result<Allowed, Reply> {
    let scrape = charge(site, call)?;
    checks(site, call, target, scrape, None)
}

/// 6.2 check 0, before any JWT or DPoP work: the source limiter (the scrape pipeline's for a map-listed `lme_`
/// token where the route allows it); Ok says whether the scrape pipeline applies.
fn charge(site: &Site, call: &Call) -> Result<bool, Reply> {
    let scrape = call.route.scrape && crate::fleet_export::bearer(call.authorization).is_some();
    let charged = if scrape {
        site.state.public_ok(call.source, site.now)
    } else {
        api_issue::take(&site.state.sources, &crate::console_source::source_key(call.source), RESOURCE_PER_MINUTE, site.now).map(|_| ()).map_err(wait_of)
    };
    match charged {
        Ok(()) => Ok(scrape),
        Err(s) => Err(refuse(site, call, None, no(429, "abuse", "Too many requests from this address; try again later.").retry(s))),
    }
}

/// 6.2 checks 1 to 11 after `charge`. `policy`: the org's current verified policy, given only for M (revision 5
/// 4.4), the one front door resource a delegated token may name.
fn checks(site: &Site, call: &Call, target: Option<&str>, scrape: bool, policy: Option<&crate::meet_org_policy::Obj>) -> Result<Allowed, Reply> {
    let (org, now) = (call.org, site.now);
    // 1
    if !site.licensed {
        return Err(refuse(site, call, None, no(403, "license", "This server is not serving under a license right now.")));
    }
    // 2
    if let Some(code) = api_issue::closed(site.store, org, now) {
        let status = if matches!(code, "map-expired" | "journal-unknown") { 401 } else { 403 };
        return Err(refuse(site, call, None, no(status, code, api_issue::closed_why(code))));
    }
    if scrape {
        return scrape_pipeline(site, call);
    }
    // 3 and 4 (5.4 steps 2 to 7; the client's standing is step 5)
    let Some(token) = access_token(call.authorization) else {
        return Err(refuse(site, call, None, no(401, "token", "The request carries no access token.")));
    };
    let claimed = tok::parse_jws(token).map(|j| (j.claims.get("iss").and_then(Value::as_str).map(str::to_string), j.claims.get("client_id").and_then(Value::as_str).map(str::to_string)));
    let (iss, claimed_client) = claimed.unwrap_or((None, None));
    let profile = match site.local {
        Some((l, jwks)) if iss.as_deref() == Some(l) => Some(Profile::Local { issuer: l, jwks }),
        _ => Profile::console(site.store, org),
    };
    let Some(profile) = profile else {
        return Err(refuse(site, call, None, no(401, "token", "The organization's api map names no issuer.")));
    };
    // the origin of I, RR or M (revision 5: M = I/mcp)
    let origin = site.resource.split_once(&format!("/api/orgs/{org}")).map_or(site.resource, |(o, _)| o);
    let htu = format!("{origin}{}", call.path);
    let dpop = call.dpop.map(|p| (p, call.route.method, htu.as_str()));
    site.state.validations.fetch_add(1, Ordering::Relaxed);
    // check 4's owner: an active person, and not in this relay's own owner-inactive record (revision 4 6.7)
    let owner_ok = |p: &str| (site.owner_active)(p) && !crate::api_scim::owner_inactive(org, p);
    // no org policy for I and RR: they are never a delegated token's resource (M, C or CM, revision 5 4.4), so one is
    // refused; M passes the console's verified policy
    let verdict = tok::validate_access_token(token, &profile, site.resource, now, site.store, org, policy, &owner_ok, call.cert.map(|c| c.sha256_b64u.as_str()), dpop, &mut site.state.dpop.lock());
    let grant = match verdict {
        Ok(g) => g,
        Err(e) => {
            let (status, code) = token_refusal(e.code);
            // the signature verified before the client's standing was judged
            let who = claimed_client.as_deref().filter(|_| matches!(code, "suspended" | "owner")).map(|c| (c, None));
            return Err(refuse(site, call, who, no(status, code, api_issue::sentence(&e.message))));
        }
    };
    let client = grant.client.clone();
    let who = Some((client.as_str(), Some(grant.jti.as_str())));
    // 5
    if let Err(l) = api_issue::take(&site.state.clients, &format!("{org} {client}"), CLIENT_PER_MINUTE, now) {
        return Err(refuse(site, call, who, no(429, "abuse", "This client sent too many requests; try again later.").retry(wait_of(l))));
    }
    // 6
    if !grant.scopes.iter().any(|s| s == call.route.scope) {
        return Err(refuse(site, call, who, no(403, "scope", format!("This route needs the {} scope.", call.route.scope))));
    }
    // 7
    if grant.reach != call.route.reach {
        return Err(refuse(site, call, who, no(403, "reach", "This route is outside the client's reach.")));
    }
    // 8
    let reaches = |r: &str| grant.relays.iter().any(|x| x == "*" || x == r);
    if target.is_some_and(|t| !reaches(t)) {
        return Err(refuse(site, call, who, no(404, "not-found", NOT_FOUND)));
    }
    // 9
    let rank = tok::rank(&grant.ceiling).unwrap_or(0);
    if rank < tok::rank(call.route.class).unwrap_or(0) || rank == 0 {
        return Err(refuse(site, call, who, no(403, "ceiling", "The data of this route is above the client's ceiling.")));
    }
    let repr = if rank >= 2 { Repr::AsIs } else { Repr::Pseudonymized };
    // 10
    let Some(c) = tok::find_client(site.store, org, &client) else {
        return Err(refuse(site, call, who, no(403, "suspended", "That client is not registered.")));
    };
    // the map's networks and every `client_limit`'s (2.5)
    if !tok::source_allowed(c, site.store.active(org), &client, call.source) {
        return Err(refuse(site, call, who, no(403, "network", "This client may not call from that address.")));
    }
    if c.get("hours").is_some_and(|h| !api_issue::inside_hours(h, now)) {
        return Err(refuse(site, call, who, no(403, "hours", "This client may not call at this time.")));
    }
    if c.get("mtls_required").and_then(Value::as_bool) == Some(true) {
        let creds = tok::usable_credentials(c, site.store.active(org));
        if !call.cert.is_some_and(|x| x.authenticates(c, org, &creds)) {
            return Err(refuse(site, call, who, no(403, "mtls", "This client must present its certificate.")));
        }
    }
    // 11
    // lowered by every `client_limit` (2.5)
    let per = |k: &str| tok::rate_of(c, site.store.active(org), &client, k);
    let (per_minute, per_day) = (per("per_minute_each"), per("per_day_each"));
    let key = format!("{org} {client}");
    let rate = match api_issue::take(&site.state.rate, &key, usize::try_from(per_minute).unwrap_or(usize::MAX), now) {
        Ok((used, reset)) => Rate { limit: per_minute, remaining: per_minute.saturating_sub(used as u64), reset },
        Err(l) => {
            let s = wait_of(l);
            let n = No { rate: Some(Rate { limit: per_minute, remaining: 0, reset: s }), ..no(429, "rate", "This client is over its rate; see Retry-After.").retry(s) };
            return Err(refuse(site, call, who, n));
        }
    };
    if let Err(l) = api_issue::take_daily(&site.state.daily, &key, per_day, now) {
        let n = No { rate: Some(rate), ..no(429, "rate", "This client is over its daily rate; see Retry-After.").retry(wait_of(l)) };
        return Err(refuse(site, call, who, n));
    }
    Ok(Allowed { client, jti: Some(grant.jti.clone()), grant: Some(grant), repr, rate: Some(rate) })
}

/// 6.1 scrape pipeline after the source limiter, license and map: the SHA-256 of the token is a `scrape_tokens`
/// entry not under `scrape_deny` (`token`), unexpired (`expired`), naming this relay (404), one scrape per 10 s per
/// token (`rate`). No OAuth client checks.
fn scrape_pipeline(site: &Site, call: &Call) -> Result<Allowed, Reply> {
    let (org, now) = (call.org, site.now);
    let token = crate::fleet_export::bearer(call.authorization).unwrap_or_default();
    let hash = hex(&sha256(token.as_bytes()));
    let denied = site.store.active(org).iter().any(|e| e.action == "scrape_deny" && e.target.as_str() == Some(hash.as_str()));
    let listed = site.store.scrape_tokens(org).iter().filter_map(Value::as_object).find(|t| {
        t.get("sha256").and_then(Value::as_str).is_some_and(|h| aws_lc_rs::constant_time::verify_slices_are_equal(h.to_ascii_lowercase().as_bytes(), hash.as_bytes()).is_ok())
    });
    let Some(entry) = listed.filter(|_| !denied) else {
        return Err(refuse(site, call, None, no(401, "token", "That scrape token is not listed for this organization.")));
    };
    let hint = entry.get("hint").and_then(Value::as_str).unwrap_or("lme_").to_string();
    let who = Some((hint.as_str(), None));
    if entry.get("expires").and_then(Value::as_i64).is_none_or(|e| e <= now) {
        return Err(refuse(site, call, who, no(401, "expired", "That scrape token has expired.")));
    }
    if !tok::names(entry, "relays").any(|r| r == "*" || r == site.relay) {
        return Err(refuse(site, call, who, no(404, "not-found", NOT_FOUND)));
    }
    let key = format!("{org} {hash}");
    let wait = {
        let mut last = site.state.scrapes.lock();
        let wait = last.get(&key).map(|at| SCRAPE_GAP_S - (now - at)).filter(|w| *w > 0);
        if wait.is_none() {
            if last.len() >= SCRAPE_KEYS {
                last.retain(|_, at| now - *at < SCRAPE_GAP_S);
            }
            last.insert(key, now);
        }
        wait
    };
    if let Some(w) = wait {
        return Err(refuse(site, call, who, no(429, "rate", "One scrape per 10 seconds per token.").retry(w)));
    }
    Ok(Allowed { client: hint, grant: None, repr: Repr::Pseudonymized, jti: None, rate: None })
}

/// 9.4: the allowed call (with the bytes it releases) is appended before the answer leaves; 503 otherwise.
fn finish(site: &Site, call: &Call, ok: &Allowed, target: Option<&str>, reply: Reply) -> Reply {
    finish_with(site, call, ok, target, reply, &Map::new())
}

/// `finish` with `extra` fields in the entry (revision 5 12.2 `tool` and `person` of an MCP call).
fn finish_with(site: &Site, call: &Call, ok: &Allowed, target: Option<&str>, mut reply: Reply, extra: &Map<String, Value>) -> Reply {
    if !site.audit.allowed_ok() {
        counted(call.org, &ok.client, Some("audit-unavailable"));
        return audit_unavailable();
    }
    // an export part's bytes are counted as they are; anything else is its text
    let text = match (&reply.raw, reply.text.take()) {
        (Some(_), _) => String::new(),
        (None, Some(t)) => t,
        (None, None) => serde_json::to_string(&reply.body).unwrap_or_default(),
    };
    let bytes_out = reply.raw.as_ref().map_or(text.len(), Vec::len);
    // revision 4 4.5: an `Idempotency-Key` replay is audited as such
    let replayed = reply.headers.iter().any(|(k, _)| *k == REPLAYED);
    reply.headers.retain(|(k, _)| *k != REPLAYED);
    let mut e = entry_of(call, "api.call");
    e.extend(extra.iter().map(|(k, v)| (k.clone(), v.clone())));
    e.insert("client".into(), json!(ok.client));
    e.insert("scope".into(), json!(call.route.scope));
    e.insert("resource".into(), json!(target.unwrap_or(site.relay)));
    e.insert("result".into(), json!(if replayed { "replayed" } else { "ok" }));
    e.insert("check".into(), json!("none"));
    e.insert("status".into(), json!(reply.status));
    e.insert("bytes_out".into(), json!(bytes_out));
    e.insert("count".into(), json!(1));
    if let Some(j) = &ok.jti {
        e.insert("jti".into(), json!(j));
    }
    if site.audit.record(call.org, Value::Object(e), site.now).is_err() {
        counted(call.org, &ok.client, Some("audit-unavailable"));
        return audit_unavailable();
    }
    counted(call.org, &ok.client, None);
    if reply.raw.is_none() {
        reply.text = Some(text);
    }
    rate_headers(&mut reply, ok.rate);
    reply
}

// ── the resource routes ──────────────────────────────────────────────────────────────────────────────────────────

/// 7.1 `v1/capacity`: the snapshot keys of `KEYS` (the "now" values, not the license codes), exact names, nulls left
/// out.
pub fn capacity(latest: &Map<String, Value>) -> Map<String, Value> {
    KEYS.iter()
        .filter(|k| k.kind == Kind::Now && k.prom != PromType::Stateset)
        .filter_map(|k| latest.get(k.key).filter(|v| v.is_number()).map(|v| (k.key.to_string(), v.clone())))
        .collect()
}

fn summary(r: &RelayInfo) -> Value {
    json!({"id": r.id, "name": r.name, "region": r.region, "version": r.version, "fips": r.fips, "license_state": r.license_state, "up": r.up})
}

fn serve(site: &Site, call: &Call, ok: &Allowed, body: Option<&Body>) -> Result<Reply, No> {
    let (org, now) = (call.org, site.now);
    let mine = || {
        let mut v: Vec<RelayInfo> = site.data.relays(org, now).into_iter().filter(|r| ok.reaches(&r.id)).collect();
        v.sort_by(|a, b| a.id.cmp(&b.id));
        v
    };
    match call.route.id {
        RouteId::Health => {
            let relays: Vec<Value> = mine()
                .iter()
                .map(|r| {
                    let mut v = json!({"id": r.id, "health": r.health});
                    if let Some(s) = r.last_contact_s {
                        v["last_contact_s"] = json!(s);
                    }
                    v
                })
                .collect();
            let mut body = json!({"ok": true, "console": site.data.console(), "relays": relays});
            if site.side == Side::Relay {
                body["mode"] = json!(crate::api_failover::mode(org));
            }
            Ok(Reply::json(200, body))
        }
        RouteId::Capacity => {
            let relays: Vec<Value> = mine()
                .iter()
                .map(|r| {
                    let mut m = capacity(&r.latest);
                    m.insert("id".into(), json!(r.id));
                    Value::Object(m)
                })
                .collect();
            Ok(Reply::json(200, json!({ "relays": relays })))
        }
        RouteId::FleetRelays => {
            let limit = limit_of(call.query)?;
            let after = match param(call.query, "after") {
                None => None,
                Some(c) => Some(unb64u(c).and_then(|b| String::from_utf8(b).ok()).ok_or_else(|| no(400, "bad-request", "after is not a cursor of this list."))?),
            };
            let mut rows: Vec<RelayInfo> = mine().into_iter().filter(|r| after.as_ref().is_none_or(|a| r.id.as_str() > a.as_str())).collect();
            let more = rows.len() > limit;
            rows.truncate(limit);
            let mut body = json!({ "relays": rows.iter().map(summary).collect::<Vec<_>>() });
            if let (true, Some(last)) = (more, rows.last()) {
                body["next"] = json!(b64u(last.id.as_bytes()));
            }
            Ok(Reply::json(200, body))
        }
        RouteId::FleetRelay => {
            let id = call.id.unwrap_or_default();
            let r = mine().into_iter().find(|r| r.id == id).ok_or_else(|| no(404, "not-found", NOT_FOUND))?;
            let mut body = summary(&r);
            body["health"] = json!(r.health);
            body["certificates"] = json!(r.certificates);
            Ok(Reply::json(200, body))
        }
        RouteId::Audit => {
            let source = audit_source(site, call)?;
            let limit = limit_of(call.query)?;
            let after = match param(call.query, "after") {
                None => 0,
                Some(c) => crate::api_audit::parse_cursor(c, org, &source, ok.repr).ok_or_else(|| no(400, "bad-request", "after is not a cursor of this chain."))?,
            };
            match site.audit.read(org, &source, ok.repr, after, limit) {
                Ok(page) => Ok(Reply::json(200, page)),
                Err(e) if e.code == "bad-request" => Err(no(400, "bad-request", api_issue::sentence(&e.message))),
                Err(_) => Err(no(503, "audit-unavailable", AUDIT_WHY)),
            }
        }
        RouteId::AuditKeys => Ok(Reply::json(200, json!({ "keys": site.audit.keys(org) }))),
        RouteId::Metrics => {
            let mut ids: Vec<String> = site.data.ids(org).into_iter().filter(|id| ok.reaches(id)).collect();
            ids.sort();
            let text = site.data.exposition(org, &ids, now);
            Ok(Reply { status: 200, ctype: crate::fleet_export::CONTENT_TYPE, headers: vec![("Cache-Control", "no-store".into())], body: Value::Null, text: Some(text), raw: None })
        }
        RouteId::TelemetryCatalog => Ok(Reply::json(200, crate::api_catalog::catalog().json().clone())),
        RouteId::Events | RouteId::EventTypes => events_answer(site, call, ok),
        RouteId::EventKeys => {
            let events = site.data.events().ok_or_else(|| no(503, "audit-unavailable", AUDIT_WHY))?;
            Ok(Reply::json(200, json!({ "keys": events.keys(org) })))
        }
        RouteId::ComplianceAttendance
        | RouteId::ComplianceMeetings
        | RouteId::ComplianceConversations
        | RouteId::ComplianceFiles
        | RouteId::ComplianceRetention
        | RouteId::ComplianceHolds
        | RouteId::ComplianceHold
        | RouteId::ComplianceHoldPlace
        | RouteId::ComplianceExportRequest
        | RouteId::ComplianceExports
        | RouteId::ComplianceExport
        | RouteId::ComplianceExportSeal
        | RouteId::ComplianceExportPart
        | RouteId::ComplianceExportCancel => compliance_answer(site, call, ok, body),
        RouteId::SpokesNodes | RouteId::SpokesCounts | RouteId::SpokesSeats | RouteId::SpokesRelays => spokes_answer(site, call, ok),
        _ => Err(no(404, "not-found", NOT_FOUND)),
    }
}

/// API-1d 6.1: the most of a route's query string forwarded to a spokes relay (`api-spokes` `query`).
pub const SPOKES_QUERY_MAX: usize = 512;
/// API-1d 6.1: how long a client waits before asking a silent spokes relay again.
const SPOKES_RETRY_S: i64 = 30;

/// API-1d 6.2: a node row, seat or uncounted entry keeps no `email` for a client whose ceiling does not allow people
/// (the relay already leaves them out; this holds the line at the listener too).
fn without_emails(v: &mut Value) {
    match v {
        Value::Object(o) => {
            o.remove("email");
            o.values_mut().for_each(without_emails);
        }
        Value::Array(a) => a.iter_mut().for_each(without_emails),
        _ => {}
    }
}

/// API-1d 6.1: a spokes relay's refusal as the route's (a relay that does not answer, or answers with anything but
/// `not-found` or `bad-request`, is `relay-unreachable` with `Retry-After: 30`).
fn spokes_refusal(r: crate::fleet_wire::Refusal) -> No {
    match r.code.as_str() {
        "not-found" => no(404, "not-found", NOT_FOUND),
        "bad-request" => no(400, "bad-request", api_issue::sentence(&r.error)),
        _ => no(503, "relay-unreachable", "That spokes relay is not answering now; try again later.").retry(SPOKES_RETRY_S),
    }
}

/// API-1d 6.1 and 6.2: `v1/spokes/{nodes,counts,seats,relays}`. The relay (`relay=`, required on the front door for
/// every view but `counts`) must be in the client's `relays` (check 8, already passed for the one named) and in the
/// pinned map's `spokes.relays`, else 404. `people` is the effective ceiling at or above `confidential`; without it no
/// `email` is answered and `q` never matches one. `counts` asks every spokes relay the client reaches and answers
/// `{"relays": [{"relay", "counts"} or {"relay", "error": "relay-unreachable"}]}`, 503 when none answered.
fn spokes_answer(site: &Site, call: &Call, ok: &Allowed) -> Result<Reply, No> {
    let (org, id) = (call.org, call.route.id);
    let grant = ok.grant.as_ref().ok_or_else(|| no(403, "scope", "This route needs an access token."))?;
    let people = tok::rank(&grant.ceiling).unwrap_or(0) >= tok::rank("confidential").unwrap_or(usize::MAX);
    let bound: Vec<String> = site
        .store
        .get(org, "")
        .and_then(|m| m.map().get("spokes").and_then(|s| s.get("relays")).and_then(Value::as_array).cloned())
        .into_iter()
        .flatten()
        .filter_map(|r| r.as_str().map(str::to_string))
        .collect();
    let served = |r: &str| bound.iter().any(|b| b == r) && ok.reaches(r);
    // the query the relay reads: everything but `relay`
    let query: String = call.query.split('&').filter(|p| !p.is_empty() && p.split_once('=').map_or(*p, |(k, _)| k) != "relay").collect::<Vec<_>>().join("&");
    if query.len() > SPOKES_QUERY_MAX {
        return Err(no(400, "bad-request", "The query is longer than 512 bytes."));
    }
    let view = match id {
        RouteId::SpokesNodes => "nodes",
        RouteId::SpokesCounts => "counts",
        RouteId::SpokesSeats => "seats",
        _ => "relays",
    };
    let named = param(call.query, "relay");
    let ask = |relay: &str| site.data.spokes(org, relay, view, &query, people);
    if id == RouteId::SpokesCounts {
        let relays: Vec<String> = match site.side {
            Side::Relay => vec![site.relay.to_string()],
            Side::FrontDoor => bound.clone(),
        };
        let mut rows = Vec::new();
        let mut answered = false;
        for relay in relays.iter().map(String::as_str).filter(|r| served(*r) && named.is_none_or(|n| n == *r)) {
            match ask(relay) {
                None => continue,
                Some(Ok(counts)) => {
                    answered = true;
                    rows.push(json!({ "relay": relay, "counts": counts }));
                }
                Some(Err(_)) => rows.push(json!({ "relay": relay, "error": "relay-unreachable" })),
            }
        }
        if !answered && !rows.is_empty() {
            return Err(spokes_refusal(crate::fleet_wire::Refusal::new(503, "relay-unreachable", "")));
        }
        return Ok(Reply::json(200, json!({ "relays": rows })));
    }
    let relay = match (site.side, named) {
        (Side::Relay, None) => site.relay,
        (Side::Relay, Some(r)) if r == site.relay => site.relay,
        (Side::Relay, Some(_)) => return Err(no(404, "not-found", NOT_FOUND)),
        (Side::FrontDoor, Some(r)) if relay_id_ok(r) => r,
        (Side::FrontDoor, _) => return Err(no(400, "bad-request", "relay must be the id of a spokes relay (r_ and 16 hex).")),
    };
    if !served(relay) {
        return Err(no(404, "not-found", NOT_FOUND));
    }
    match ask(relay) {
        None => Err(no(404, "not-found", NOT_FOUND)),
        Some(Err(r)) => Err(spokes_refusal(r)),
        Some(Ok(mut body)) => {
            if !people {
                without_emails(&mut body);
            }
            Ok(Reply::json(200, body))
        }
    }
}

/// Revision 4 5.1 and 5.2: the compliance routes on the front door (`api_compliance`).
fn compliance_answer(site: &Site, call: &Call, ok: &Allowed, body: Option<&Body>) -> Result<Reply, No> {
    let desk = site.data.compliance().filter(|_| site.side == Side::FrontDoor).ok_or_else(|| no(404, "not-found", NOT_FOUND))?;
    let reach = ok.grant.as_ref().map(|g| g.relays.clone()).unwrap_or_default();
    let route_name = route_name(call);
    let req = crate::api_compliance::Req {
        org: call.org,
        route: call.route.id,
        route_name: &route_name,
        id: call.id,
        // revision 4 5.3.7: a part route's `{n}`, its path's last segment
        n: (call.route.id == RouteId::ComplianceExportPart).then(|| call.path.rsplit('/').next().unwrap_or_default()),
        query: call.query,
        client: &ok.client,
        reach: &reach,
        entry: tok::find_client(site.store, call.org, &ok.client),
        body,
        rid: call.rid,
        now: site.now,
    };
    match crate::api_compliance::serve(&*desk, &req) {
        // revision 4 5.3.7: an export part, `application/octet-stream` with its `ETag`
        Ok(crate::api_compliance::Answer { status, bytes: Some(b), etag, .. }) => {
            let mut headers = vec![("Cache-Control", "no-store".to_string())];
            if let Some(t) = etag {
                headers.push(("ETag", t));
            }
            Ok(Reply { status, ctype: "application/octet-stream", headers, body: Value::Null, text: None, raw: Some(b) })
        }
        Ok(a) => {
            let mut r = Reply::json(a.status, a.body);
            if a.replayed {
                r.headers.push((REPLAYED, "true".into()));
            }
            Ok(r)
        }
        Err(x) => {
            let n = no(x.status, x.code, x.why);
            Err(match x.retry {
                Some(s) => n.retry(s),
                None => n,
            })
        }
    }
}

/// Revision 4 7.3 `v1/events` and `v1/events/types`: what the client's grant effectively holds selects the types
/// (scopes), sources (relays, `console` for the console's events) and classes (ceiling, in the representation 6.4
/// selects); a long poll is held at most once per org and client on this listener (429 `abuse` for a second).
fn events_answer(site: &Site, call: &Call, ok: &Allowed) -> Result<Reply, No> {
    use crate::api_events::{EventLog, FeedError, FeedQuery, Viewer};
    let events = site.data.events().ok_or_else(|| no(503, "audit-unavailable", AUDIT_WHY))?;
    let grant = ok.grant.as_ref().ok_or_else(|| no(403, "scope", "This route needs an access token."))?;
    let ceiling = crate::api_catalog::Ceiling::of(&grant.ceiling).ok_or_else(|| no(403, "ceiling", "The client's ceiling is not readable."))?;
    let reaches = |r: &str| ok.reaches(r);
    let q = FeedQuery::parse(call.query).map_err(|why| no(400, "bad-request", why))?;
    let viewer = Viewer { scopes: &grant.scopes, reaches: &reaches, ceiling, repr: ok.repr, types: q.types.clone() };
    if call.route.id == RouteId::EventTypes {
        return Ok(Reply::json(200, json!({ "types": EventLog::types(&viewer) })));
    }
    let _held = match q.wait {
        0 => None,
        _ => Some(site.state.held.hold(format!("{} {}", call.org, ok.client)).ok_or_else(|| no(429, "abuse", "This client already waits on the event feed here.").retry(1))?),
    };
    match events.page(call.org, &q, &viewer) {
        Ok(page) => Ok(Reply::json(200, page)),
        Err(FeedError::Cursor) => Err(no(400, "cursor", "after is not a cursor of this feed.")),
        Err(FeedError::Gone) => Err(no(410, "cursor-gone", "That cursor is older than the event retention; start again without after.")),
        Err(FeedError::Unavailable) => Err(no(503, "audit-unavailable", AUDIT_WHY)),
    }
}

// ── the chains' clock (9.3, 9.4) ─────────────────────────────────────────────────────────────────────────────────

/// How often the chains close minute buckets, write checkpoints and apply retention.
pub const TICK_EVERY: std::time::Duration = std::time::Duration::from_secs(10);

/// `ApiAudit::tick` every 10 s on its own thread, for the life of the process, whenever `audit` yields the chains (a
/// relay's open once it is enrolled); each recovery or torn-tail note goes to `note` (the security log).
pub fn spawn_ticker(name: &str, audit: Box<dyn Fn() -> Option<std::sync::Arc<ApiAudit>> + Send>, note: Box<dyn Fn(&str) + Send>) -> Result<(), String> {
    std::thread::Builder::new()
        .name(name.into())
        .spawn(move || loop {
            std::thread::sleep(TICK_EVERY);
            if let Some(a) = audit() {
                a.tick(crate::meet_json::now() as i64);
                for n in a.take_notes() {
                    note(&n);
                }
            }
        })
        .map(|_| ())
        .map_err(|e| e.to_string())
}

// ── the token pipeline's audit (6.1, 9.4) ────────────────────────────────────────────────────────────────────────

/// 9.4 for the token pipeline: the issuer's decision (`Answer.event`) is appended to the org's chain before the answer
/// is released: `api.token` with the client, scope, audience, `jti`, `exp`, `cnf` kind and authentication (a token
/// exchange's subject as `act`); a refusal through the refusal summaries; a revocation that journaled nothing as
/// `api.token` on the revocation route (one that journaled was audited inside its journal call). An audit failure
/// answers 503 `audit-unavailable` and releases no token.
pub fn token_audited(audit: &dyn AuditLog, org: &str, route: &str, rid: &str, source: IpAddr, a: Answer, now: i64) -> Answer {
    let Some((name, ev)) = a.event.clone() else { return a };
    let s = |k: &str| ev.get(k).and_then(Value::as_str);
    let mut e = Map::new();
    e.insert("rid".into(), json!(rid));
    e.insert("route".into(), json!(route));
    e.insert("ip".into(), json!(ip_of(source)));
    let put = |e: &mut Map<String, Value>, to: &str, v: Option<&Value>| {
        if let Some(v) = v.filter(|v| v.is_string() || v.is_i64() || v.is_u64()) {
            e.insert(to.into(), v.clone());
        }
    };
    let done = match name {
        "api.token" => {
            e.insert("action".into(), json!("api.token"));
            e.insert("result".into(), json!("ok"));
            for k in ["client", "scope", "aud", "jti", "exp", "cnf", "auth", "map_seq"] {
                put(&mut e, k, ev.get(k));
            }
            put(&mut e, "act", ev.get("subject_sub"));
            audit.record(org, Value::Object(e), now).map(|_| ())
        }
        // revision 5 12.2: a delegated token, with its person, grant, EMA IdP and actor
        "api.delegated" => {
            e.insert("action".into(), json!("api.delegated"));
            e.insert("result".into(), json!("ok"));
            for k in ["client", "person", "grant", "idp", "jti", "scope", "resource", "aud", "exp", "cnf", "auth", "map_seq", "auth_time", "actor", "actor_profile", "family"] {
                put(&mut e, k, ev.get(k));
            }
            audit.record(org, Value::Object(e), now).map(|_| ())
        }
        "api.revoke" if ev.get("jti").is_some() => Ok(()),
        "api.revoke" => {
            e.insert("action".into(), json!("api.token"));
            e.insert("result".into(), json!("ok"));
            put(&mut e, "client", ev.get("client"));
            audit.record(org, Value::Object(e), now).map(|_| ())
        }
        _ => {
            let code = s("code").unwrap_or("request").to_string();
            e.insert("action".into(), json!("api.refusal"));
            e.insert("result".into(), json!("refused"));
            e.insert("check".into(), json!(code));
            e.insert("status".into(), json!(a.status));
            e.insert("count".into(), json!(1));
            put(&mut e, "client", ev.get("client"));
            // revision 4 4.1: the failed `entra_wif` step (`entra_wif.<step>`) as the entry's `code`
            put(&mut e, "code", ev.get("step"));
            let key = s("client").map_or_else(|| format!("ip:{}", crate::console_source::source_key(source)), str::to_string);
            audit.refusal(org, &key, &code, route, Value::Object(e), now)
        }
    };
    // 10.1, once the decision is in the chain: a client named by a refused request is not yet authenticated
    let client = s("client").unwrap_or_default();
    match (&done, name) {
        (Ok(()), "api.token") => {
            counted(org, client, None);
            let issuer = if route.contains("/local/") { "relay" } else { "console" };
            crate::api_catalog::counters::api_token_issued(org, client, issuer);
        }
        (Ok(()), "api.revoke" | "api.delegated") => counted(org, client, None),
        (Ok(()), _) => counted(org, "", Some(s("code").unwrap_or("request"))),
        (Err(_), _) => counted(org, "", Some("audit-unavailable")),
    }
    match done {
        Ok(()) => a,
        Err(_) => {
            let mut r = api_issue::refusal(org, source, None, "audit-unavailable", AUDIT_WHY, None);
            r.event = None;
            r
        }
    }
}

// ── the console MCP on this pipeline (revision 5 8.2, 9.1; slice 1c5) ──────────────────────────────────────────

/// 8.2 step 1: the source limiter of an MCP request (`call.route` an MCP row of `console_mcp`, never a scrape row).
pub(crate) fn mcp_charge(site: &Site, call: &Call) -> Result<(), Reply> {
    charge(site, call).map(|_| ())
}

/// 8.2 step 4: checks 1 to 11 for the scope of `call.route` (the MCP row of the tool, or of a scope the token holds
/// for a list), before the body is read. `policy`: the org's current verified policy (delegated tokens at M).
pub(crate) fn mcp_checks(site: &Site, call: &Call, policy: Option<&crate::meet_org_policy::Obj>) -> Result<Allowed, Reply> {
    checks(site, call, None, false, policy)
}

/// An MCP decision refused after the source limiter (a header, body or tool check), in the org's refusal summaries
/// with `extra` (`tool`, `person`) before its answer; the caller shapes the answer (a JSON-RPC error or a tool
/// error) when the Reply is not 503 `audit-unavailable`.
pub(crate) fn mcp_refuse(site: &Site, call: &Call, ok: Option<&Allowed>, status: u16, code: &'static str, why: &str, extra: &Map<String, Value>) -> Reply {
    let who = ok.map(|a| (a.client.as_str(), a.jti.as_deref()));
    refuse_with(site, call, who, no(status, code, why), extra)
}

/// 8.2 step 6: the one route handler of a tool (`call.route` its row of `ROUTES`): check 8 for the relay the call
/// names, then the route. Err is the route's refusal (status, code, sentence) for a tool error.
pub(crate) fn mcp_serve(site: &Site, call: &Call, ok: &Allowed) -> Result<(Reply, Option<String>), (u16, &'static str, String)> {
    let target = target_of(site, call);
    if target.as_deref().is_some_and(|t| !ok.reaches(t)) {
        return Err((404, "not-found", NOT_FOUND.to_string()));
    }
    match serve(site, call, ok, None) {
        Ok(r) => Ok((r, target)),
        Err(n) => Err((n.status, n.code, n.why)),
    }
}

/// 9.4 for an MCP call: one `api.call` entry (route M, `extra` with `tool`) before the answer `reply`.
pub(crate) fn mcp_finish(site: &Site, call: &Call, ok: &Allowed, target: Option<&str>, reply: Reply, extra: &Map<String, Value>) -> Reply {
    finish_with(site, call, ok, target, reply, extra)
}

// ── OpenAPI (7.4) ────────────────────────────────────────────────────────────────────────────────────────────────

fn page_params(audit: bool, front: bool) -> Vec<Value> {
    let mut p = vec![
        json!({"name": "after", "in": "query", "required": false, "schema": {"type": "string"}, "description": "The opaque cursor of the previous page's next."}),
        json!({"name": "limit", "in": "query", "required": false, "schema": {"type": "integer", "minimum": 1, "maximum": PAGE_MAX, "default": PAGE_DEFAULT}}),
    ];
    if audit && front {
        p.push(json!({"name": "source", "in": "query", "required": false, "schema": {"enum": ["console", "relay"], "default": "console"}}));
        p.push(json!({"name": "relay", "in": "query", "required": false, "schema": {"type": "string", "pattern": "^r_[0-9a-f]{16}$"}}));
    }
    p
}

/// Revision 4 5.1 and 5.2: the parameters of the compliance routes.
fn compliance_params(id: RouteId) -> Vec<Value> {
    let q = |name: &str, required: bool, schema: Value, description: &str| json!({"name": name, "in": "query", "required": required, "schema": schema, "description": description});
    let principal = || json!({"type": "string", "maxLength": 320});
    let window = || {
        vec![
            q("from", false, json!({"type": "integer"}), "Unix seconds; default 30 days before to."),
            q("to", false, json!({"type": "integer"}), "Unix seconds; default now; to - from is at most 400 days."),
        ]
    };
    let page = || {
        vec![
            q("after", false, json!({"type": "string"}), "The opaque cursor of the previous page's next."),
            q("limit", false, json!({"type": "integer", "minimum": 1, "maximum": 500, "default": 100}), "Items per page."),
        ]
    };
    let mut out = Vec::new();
    match id {
        RouteId::ComplianceAttendance => {
            out.extend(window());
            out.extend(page());
            out.push(q("person", false, principal(), "Sessions this principal took part in."));
            out.push(q("room", false, json!({"type": "string"}), "One room."));
        }
        RouteId::ComplianceMeetings => {
            out.extend(window());
            out.extend(page());
            out.push(q("organizer", false, principal(), "Meetings this principal organizes."));
            out.push(q("person", false, principal(), "Meetings this principal organizes or attends."));
        }
        RouteId::ComplianceConversations => {
            out.extend(window());
            out.extend(page());
            out.push(q("person", true, principal(), "Conversations this principal is or was a member of."));
        }
        RouteId::ComplianceFiles => {
            out.extend(window());
            out.extend(page());
            out.push(q("cid", false, json!({"type": "string"}), "A conversation (ch:<id> or dm:<64 hex>); one of cid or room."));
            out.push(q("room", false, json!({"type": "string"}), "A room; one of cid or room."));
        }
        RouteId::ComplianceHolds => out.extend(page()),
        RouteId::ComplianceHold => out.push(json!({"name": "hold", "in": "path", "required": true, "schema": {"type": "string"}, "description": "h_ and 16 hex (an API hold), or a console hold's 16 hex."})),
        RouteId::ComplianceHoldPlace | RouteId::ComplianceExportRequest => out.push(json!({"name": "Idempotency-Key", "in": "header", "required": true, "schema": {"type": "string"},
                                                        "description": "A Structured Field String of 16 to 64 of [A-Za-z0-9_-] (draft-ietf-httpapi-idempotency-key-header-09)."})),
        // revision 4 5.3.7
        RouteId::ComplianceExports => out.extend(page()),
        RouteId::ComplianceExport | RouteId::ComplianceExportSeal | RouteId::ComplianceExportPart | RouteId::ComplianceExportCancel => {
            out.push(json!({"name": "job", "in": "path", "required": true, "schema": {"type": "string", "pattern": "^j_[0-9a-f]{16}$"}, "description": "The export job."}));
            if id == RouteId::ComplianceExportPart {
                out.push(json!({"name": "n", "in": "path", "required": true, "schema": {"type": "integer", "minimum": 0, "maximum": 12799}, "description": "The part, from 0."}));
            }
        }
        _ => {}
    }
    out
}

/// API-1d 6.1: the parameters of the `spokes.read` routes (`relay` required on the front door but for `counts`).
fn spokes_params(id: RouteId, side: Side) -> Vec<Value> {
    let q = |name: &str, required: bool, schema: Value, description: &str| json!({"name": name, "in": "query", "required": required, "schema": schema, "description": description});
    let relay = |required: bool| q("relay", required, json!({"type": "string", "pattern": "^r_[0-9a-f]{16}$"}), "A spokes relay of the client and of the map's spokes.relays.");
    let mut out = Vec::new();
    match id {
        RouteId::SpokesNodes => {
            out.push(relay(side == Side::FrontDoor));
            out.push(q("role", false, json!({"enum": ["hub", "spoke"]}), "Only nodes of this role."));
            out.push(q("state", false, json!({"enum": ["ok", "silent", "expiring", "expired", "revoked", "blocked"]}), "Only nodes in this state."));
            out.push(q("q", false, json!({"type": "string", "minLength": 1, "maxLength": 100}), "Matches node ids and labels; emails only for a client whose ceiling allows people."));
            out.push(q("limit", false, json!({"type": "integer", "minimum": 1, "maximum": 500, "default": 100}), "Nodes per page."));
            out.push(q("after", false, json!({"type": "string", "pattern": "^n_[0-9a-f]{32}$"}), "The node id the previous page ended with."));
        }
        RouteId::SpokesSeats | RouteId::SpokesRelays => out.push(relay(side == Side::FrontDoor)),
        RouteId::SpokesCounts => out.push(relay(false)),
        _ => {}
    }
    out
}

/// 7.4: the OpenAPI 3.1 document of the listener's org routes, generated from `ROUTES` (server: the listener's
/// origin, paths with the org filled in).
pub fn openapi(side: Side, org: &str, resource: &str) -> Value {
    let origin = resource.strip_suffix(&format!("/api/orgs/{org}")).unwrap_or(resource);
    let mut paths = Map::new();
    for r in ROUTES.iter().filter(|r| r.side == side) {
        let mut op = Map::new();
        op.insert("operationId".into(), json!(format!("{:?}", r.id)));
        op.insert("summary".into(), json!(r.summary));
        op.insert("x-lucid-pipeline".into(), json!(r.pipeline.as_str()));
        op.insert("x-lucid-class".into(), json!(r.class));
        if r.scope.is_empty() {
            op.insert("security".into(), json!([]));
        } else {
            let mut security = vec![json!({ "oauth": [r.scope] })];
            if r.scrape {
                security.push(json!({ "scrape": [] }));
                op.insert("x-lucid-scrape".into(), json!(true));
            }
            op.insert("security".into(), json!(security));
            op.insert("x-lucid-scope".into(), json!(r.scope));
            op.insert("x-lucid-reach".into(), json!(r.reach));
        }
        // revision 5 8.3: the console MCP tool that calls this route (1a 7.4's `tool` column)
        if let Some(tool) = crate::console_mcp::tool_of(side, r.id) {
            op.insert("x-mcp-tool".into(), json!(tool));
        }
        let mut params = Vec::new();
        if r.path.contains("{id}") {
            params.push(json!({"name": "id", "in": "path", "required": true, "schema": {"type": "string", "pattern": "^r_[0-9a-f]{16}$"}}));
        }
        if r.path.contains("{agent}") {
            params.push(json!({"name": "agent", "in": "path", "required": true, "schema": {"type": "string", "pattern": "^a_[0-9a-f]{16}$"}}));
        }
        if matches!(r.id, RouteId::FleetRelays | RouteId::Audit | RouteId::Events) {
            params.extend(page_params(r.id == RouteId::Audit, side == Side::FrontDoor));
        }
        if r.id == RouteId::Events {
            params.push(json!({"name": "wait", "in": "query", "required": false, "schema": {"type": "integer", "minimum": 0, "maximum": crate::api_events::WAIT_MAX, "default": 0},
                               "description": "Seconds to hold the request when nothing is new (long poll); one held request per client."}));
            params.push(json!({"name": "types", "in": "query", "required": false, "schema": {"type": "string"}, "description": "Event types of the registry, separated by commas."}));
            params.push(json!({"name": "stubs", "in": "query", "required": false, "schema": {"type": "boolean", "default": true}, "description": "false leaves out the stubs of entries the client may not see."}));
        }
        params.extend(compliance_params(r.id));
        params.extend(spokes_params(r.id, side));
        if !params.is_empty() {
            op.insert("parameters".into(), json!(params));
        }
        if !r.request.is_empty() {
            // revision 4: the compliance POST routes take JSON
            let form = if matches!(r.request, "HoldRequest" | "ExportRequest") { "application/json" } else { "application/x-www-form-urlencoded" };
            op.insert("requestBody".into(), json!({"required": true, "content": {form: {"schema": {"$ref": format!("#/components/schemas/{}", r.request)}}}}));
        }
        let ctype = match r.id {
            RouteId::Metrics => crate::fleet_export::CONTENT_TYPE,
            RouteId::ComplianceExportPart => "application/octet-stream",
            RouteId::Authorize | RouteId::SsoReturn | RouteId::Consent | RouteId::ConsentPost => "text/html",
            _ => "application/json",
        };
        let status = if matches!(r.id, RouteId::ComplianceHoldPlace | RouteId::ComplianceExportRequest) { "202" } else { "200" };
        op.insert(
            "responses".into(),
            json!({
                status: {"description": "OK", "content": {ctype: {"schema": {"$ref": format!("#/components/schemas/{}", r.response)}}}},
                "default": {"description": "A refusal (RFC 9457)", "content": {"application/problem+json": {"schema": {"$ref": "#/components/schemas/Problem"}}}},
            }),
        );
        let item = paths.entry(r.path.replace("{org}", org)).or_insert_with(|| json!({}));
        if let Some(o) = item.as_object_mut() {
            o.insert(r.method.to_ascii_lowercase(), Value::Object(op));
        }
    }
    let scopes: Map<String, Value> = SCOPES.iter().map(|s| (s.to_string(), json!(format!("API-1 6.3 {s}")))).collect();
    let mut schemes = json!({"oauth": {"type": "oauth2", "flows": {"clientCredentials": {"tokenUrl": format!("{resource}/oauth/token"), "scopes": scopes}}}});
    if side == Side::Relay {
        schemes["oauth"]["flows"]["clientCredentials"]["tokenUrl"] = json!(format!("{resource}/local/oauth/token"));
        schemes["scrape"] = json!({"type": "http", "scheme": "bearer", "description": "A scrape token (lme_) listed in the org's api map"});
    }
    json!({
        "openapi": "3.1.0",
        "info": {"title": format!("Lucid enterprise API ({org})"), "version": "1"},
        "servers": [{"url": origin}],
        "paths": paths,
        "components": {"securitySchemes": schemes, "schemas": schemas()},
    })
}

/// The schemas the routes name (7.4).
pub fn schemas() -> Map<String, Value> {
    let string = json!({"type": "string"});
    let number = json!({"type": "number"});
    let capacity: Map<String, Value> = std::iter::once(("id".to_string(), string.clone()))
        .chain(KEYS.iter().filter(|k| k.kind == Kind::Now && k.prom != PromType::Stateset).map(|k| (k.key.to_string(), number.clone())))
        .collect();
    let summary = json!({"type": "object", "required": ["id", "name", "region", "version", "fips", "license_state", "up"],
        "properties": {"id": string, "name": string, "region": string, "version": string, "fips": {"type": "boolean"},
                       "license_state": string, "up": {"type": "boolean"}}});
    let mut relay = summary.clone();
    relay["required"].as_array_mut().into_iter().for_each(|a| a.extend([json!("health"), json!("certificates")]));
    relay["properties"]["health"] = json!({"enum": crate::fleet_export::HEALTH_STATES});
    relay["properties"]["certificates"] = json!({"type": "array", "items": {"type": "object", "required": ["name", "days_left"],
        "properties": {"name": string, "days_left": {"type": "integer"}, "serial": string}}});
    let mut v = json!({
        "Problem": {"type": "object", "required": ["ok", "code", "error", "type", "title", "status", "detail"],
            "properties": {"ok": {"const": false}, "code": string, "error": string, "type": {"type": "string", "format": "uri"},
                           "title": string, "status": {"type": "integer"}, "detail": string}},
        "AuthorizationServerMetadata": {"type": "object", "required": ["issuer", "token_endpoint", "jwks_uri"],
            "properties": {"issuer": string, "token_endpoint": string, "revocation_endpoint": string, "jwks_uri": string,
                           "grant_types_supported": {"type": "array", "items": string}}},
        "ProtectedResourceMetadata": {"type": "object", "required": ["resource", "authorization_servers"],
            "properties": {"resource": string, "authorization_servers": {"type": "array", "items": string},
                           "scopes_supported": {"type": "array", "items": string}, "bearer_methods_supported": {"type": "array", "items": string}}},
        "Jwks": {"type": "object", "required": ["keys"], "properties": {"keys": {"type": "array", "items": {"type": "object"}}}},
        "OpenIdConfiguration": {"type": "object", "required": ["issuer", "jwks_uri", "response_types_supported", "subject_types_supported", "id_token_signing_alg_values_supported"],
            "properties": {"issuer": string, "jwks_uri": string, "response_types_supported": {"type": "array", "items": string},
                           "subject_types_supported": {"type": "array", "items": string}, "id_token_signing_alg_values_supported": {"type": "array", "items": string}}},
        "OpenApi": {"type": "object", "required": ["openapi", "info", "paths"]},
        "TokenRequest": {"type": "object", "required": ["grant_type"],
            "properties": {"grant_type": {"enum": ["client_credentials", "urn:ietf:params:oauth:grant-type:token-exchange"]},
                           "scope": string, "resource": string, "client_id": string, "client_assertion_type": string,
                           "client_assertion": string, "subject_token": string, "subject_token_type": string}},
        "TokenResponse": {"type": "object", "required": ["access_token", "token_type", "expires_in", "scope"],
            "properties": {"access_token": string, "token_type": {"enum": ["DPoP", "Bearer"]}, "expires_in": {"type": "integer"},
                           "scope": string, "issued_token_type": string}},
        "RevokeRequest": {"type": "object", "required": ["token"], "properties": {"token": string, "token_type_hint": string}},
        "Empty": {"type": "object", "maxProperties": 0},
        "Health": {"type": "object", "required": ["ok", "console", "relays"],
            "properties": {"ok": {"const": true}, "console": {}, "mode": {"enum": ["normal", "failover"]},
                           "relays": {"type": "array", "items": {"type": "object", "required": ["id", "health"],
                               "properties": {"id": string, "health": {"enum": crate::fleet_export::HEALTH_STATES}, "last_contact_s": {"type": "integer"}}}}}},
        "Capacity": {"type": "object", "required": ["relays"],
            "properties": {"relays": {"type": "array", "items": {"type": "object", "required": ["id"], "properties": capacity}}}},
        "RelaySummary": summary,
        "RelayList": {"type": "object", "required": ["relays"],
            "properties": {"relays": {"type": "array", "items": {"$ref": "#/components/schemas/RelaySummary"}}, "next": string}},
        "Relay": relay,
        "AuditPage": {"type": "object", "required": ["entries", "repr", "chain"],
            "properties": {"entries": {"type": "array", "items": {"type": "object"}}, "next": string,
                           "repr": {"enum": crate::api_map::IDENTITIES},
                           "chain": {"type": "object", "required": ["source", "head_seq", "head_hash"],
                               "properties": {"source": string, "head_seq": {"type": "integer"}, "head_hash": string}}}},
        "AuditKeys": {"type": "object", "required": ["keys"], "properties": {"keys": {"type": "array", "items": {"type": "object"}}}},
        "Metrics": {"type": "string", "contentMediaType": crate::fleet_export::CONTENT_TYPE},
    });
    // revision 4 5.1 and 5.2
    let relays_list = json!({"type": "array", "items": {"type": "string"}});
    v["CompliancePage"] = json!({"type": "object", "required": ["items"],
        "properties": {"items": {"type": "array", "items": {"type": "object", "required": ["relay"], "properties": {"relay": {"type": "string"}, "owner": {"const": "outside"}}}},
                       "partial": relays_list, "next": {"type": "string"}, "kept_days": {"type": "object", "additionalProperties": {"type": "integer"}}}});
    v["ComplianceRetention"] = json!({"type": "object", "required": ["policy_seq", "retention", "archive", "legal_holds", "holds_active"],
        "properties": {"policy_seq": {"type": "integer"}, "retention": {"type": "object", "additionalProperties": {"type": "number"}},
                       "archive": {"type": "object", "required": ["present", "reviewers"], "properties": {"present": {"type": "boolean"}, "reviewers": {"type": "integer"}}},
                       "legal_holds": {"type": "object", "additionalProperties": {"type": "boolean"}}, "holds_active": {"type": "integer"}, "partial": relays_list}});
    let states = json!({"type": "object", "additionalProperties": {"enum": ["placed", "pending", "off", "released"]}});
    let archive = json!({"enum": ["waiting", "placed", "declined", "failed", "none"]});
    v["Hold"] = json!({"type": "object", "required": ["hold", "on", "count", "principals", "reason", "placed_at", "by", "relays"],
        "properties": {"hold": {"type": "string"}, "on": {"const": "people"}, "count": {"type": "integer"}, "principals": {"type": "array", "items": {"type": "string"}},
                       "reason": {"type": "string"}, "matter": {"type": "string"}, "placed_at": {"type": "integer"}, "released_at": {"type": "integer"},
                       "by": {"type": "object", "properties": {"client": {"type": "string"}, "owner": {"type": "string"}, "admin": {"type": "string"}}},
                       "relays": states, "archive": archive}});
    v["HoldList"] = json!({"type": "object", "required": ["holds"],
        "properties": {"holds": {"type": "array", "items": {"$ref": "#/components/schemas/Hold"}}, "next": {"type": "string"}, "partial": relays_list}});
    v["HoldRequest"] = json!({"type": "object", "required": ["on", "principals", "reason"], "additionalProperties": false,
        "properties": {"on": {"const": "people"}, "principals": {"type": "array", "minItems": 1, "maxItems": 200, "uniqueItems": true, "items": {"type": "string"}},
                       "reason": {"type": "string", "minLength": 1, "maxLength": 500}, "matter": {"type": "string", "minLength": 1, "maxLength": 128},
                       "reviewer": {"type": "string"}}});
    v["HoldPlaced"] = json!({"type": "object", "required": ["hold", "state", "relays"],
        "properties": {"hold": {"type": "string"}, "relays": states, "notice": {"type": "string"},
                       "state": {"type": "object", "required": ["relay", "archive"], "properties": {"relay": {"enum": ["placed", "pending"]}, "archive": archive}}}});
    // revision 4 5.3
    let export_scope = json!({"type": "object", "required": ["from", "to", "kinds"], "additionalProperties": false,
        "properties": {"people": {"type": "array", "maxItems": 200, "uniqueItems": true, "items": {"type": "string"}},
                       "cids": {"type": "array", "maxItems": 200, "uniqueItems": true, "items": {"type": "string"}},
                       "from": {"type": "integer"}, "to": {"type": "integer"},
                       "kinds": {"type": "array", "minItems": 1, "uniqueItems": true, "items": {"enum": ["chat", "file", "ai"]}},
                       "query": {"type": "string", "maxLength": 256}}});
    let export_states = json!({"enum": ["waiting", "released", "building", "transferring", "ready", "expired", "canceled", "refused", "failed"]});
    v["ExportRequest"] = json!({"type": "object", "required": ["matter", "reason", "scope", "reviewers"], "additionalProperties": false,
        "properties": {"matter": {"type": "string", "minLength": 1, "maxLength": 128}, "reason": {"type": "string", "minLength": 1, "maxLength": 500},
                       "scope": export_scope, "reviewers": {"type": "array", "minItems": 2, "maxItems": 5, "uniqueItems": true, "items": {"type": "string"}}}});
    v["ExportAccepted"] = json!({"type": "object", "required": ["job", "state", "reviewers_needed", "expires_waiting"],
        "properties": {"job": {"type": "string"}, "state": {"const": "waiting"}, "reviewers_needed": {"const": 2}, "expires_waiting": {"type": "integer"}}});
    v["Export"] = json!({"type": "object", "required": ["job", "state", "matter", "requested_at", "releases", "reviewers"],
        "properties": {"job": {"type": "string"}, "state": export_states, "matter": {"type": "string"}, "requested_at": {"type": "integer"},
                       "releases": {"type": "integer"}, "reviewers": {"type": "array", "items": {"type": "string"}},
                       "preview": {"type": "object", "description": "After release only (revision 4 5.3.3)",
                                   "properties": {"messages": {"type": "integer"}, "files": {"type": "integer"}, "ai": {"type": "integer"}, "bytes": {"type": "integer"}, "over_limit": {"type": "boolean"}}},
                       "parts": {"type": "integer"}, "zip_bytes": {"type": "integer"}, "expires": {"type": "integer"}, "code": {"type": "string"}}});
    v["ExportList"] = json!({"type": "object", "required": ["jobs"],
        "properties": {"jobs": {"type": "array", "items": {"$ref": "#/components/schemas/Export"}}, "next": {"type": "string"}}});
    v["ExportSeal"] = json!({"type": "object", "description": "The archive-signed seal header (revision 4 5.3.6)",
        "required": ["v", "org", "job", "client", "made", "parts", "part_bytes", "zip_bytes", "zip_sha256", "part_sha256", "wrap", "recipient", "release", "excluded_ceiling", "cert", "sig"]});
    v["ExportPart"] = json!({"type": "string", "contentMediaType": "application/octet-stream", "description": "One AES-256-GCM part with its tag (revision 4 5.3.6)"});
    v["TelemetryCatalog"] = json!({"type": "object", "required": ["version", "resource_attributes", "families", "records"],
        "properties": {"version": {"const": crate::api_catalog::VERSION}, "resource_attributes": {"type": "array", "items": {"type": "object"}},
                       "families": {"type": "array", "items": {"type": "object"}}, "records": {"type": "array", "items": {"type": "object"}}}});
    // revision 4 7.2, 7.3
    let event = json!({"type": "object", "description": "A CloudEvents 1.0 event (revision 4 7.2)",
        "required": ["specversion", "id", "source", "type", "time", "lucidorg", "lucidseq", "lucidchain", "lucidprev", "lucidhash"]});
    let stub = json!({"type": "object", "description": "A chain entry the client may not see (revision 4 7.3)",
        "required": ["lucidseq", "lucidchain", "lucidprev", "lucidhash", "stub"], "properties": {"stub": {"const": true}}});
    v["EventPage"] = json!({"type": "object", "required": ["events", "next", "repr"],
        "properties": {"events": {"type": "array", "items": {"oneOf": [event, stub]}}, "next": {"type": "string"}, "repr": {"enum": crate::api_map::IDENTITIES}}});
    v["EventTypes"] = json!({"type": "object", "required": ["types"], "properties": {"types": {"type": "array", "items": {"type": "object"}}}});
    // revision 4 7.3, 7.4
    v["WebhookKeys"] = json!({"type": "object", "required": ["keys"], "properties": {"keys": {"type": "array", "items": {"type": "object", "required": ["kid", "public", "nbf", "exp"],
        "properties": {"kid": {"type": "string"}, "public": {"type": "string", "pattern": "^whpk_"}, "nbf": {"type": "integer"}, "exp": {"type": "integer"}}}}}});
    // revision 5 6.5: the Authorize pipeline's browser pages and forms
    v["Html"] = json!({"type": "string", "contentMediaType": "text/html", "description": "A page, or a redirect (302 or 303 with Location)"});
    v["SsoAttestation"] = json!({"type": "object", "required": ["att"], "properties": {"att": {"type": "string", "description": "base64url of {att, sig, cert_pem} (revision 5 6.5 step 2)"}}});
    v["ConsentDecision"] = json!({"type": "object", "required": ["req", "csrf", "decision"],
        "properties": {"req": {"type": "string"}, "csrf": {"type": "string"}, "decision": {"enum": ["allow", "deny"]}}});
    // API-1d 6.1 (`email` only for a client whose ceiling allows people)
    let int = json!({"type": "integer"});
    v["SpokesNodes"] = json!({"type": "object", "required": ["nodes"],
        "properties": {"nodes": {"type": "array", "items": {"type": "object", "required": ["node", "role", "state"],
            "properties": {"node": {"type": "string"}, "role": {"enum": ["hub", "spoke"]}, "label": {"type": "string"}, "email": {"type": "string"},
                           "serial": {"type": "string"}, "exp": int, "lastSeenAt": int, "lastPollAt": int, "revoked": {"type": "boolean"},
                           "blocked": {"type": "boolean"}, "state": {"type": "string"}, "mailbox": int, "service": {"type": "boolean"}}}},
                       "next": {"type": "string"}}});
    v["SpokesCounts"] = json!({"type": "object", "required": ["relays"],
        "properties": {"relays": {"type": "array", "items": {"type": "object", "required": ["relay"],
            "properties": {"relay": {"type": "string"}, "counts": {"type": "object"}, "error": {"const": "relay-unreachable"}}}}}});
    v["SpokesSeats"] = json!({"type": "object", "required": ["users", "used", "seats", "uncounted"],
        "properties": {"users": int, "used": int,
                       "seats": {"type": "array", "items": {"type": "object", "properties": {"user": {"type": "string"}, "email": {"type": "string"}, "since": int, "certificates": int, "exp": int}}},
                       "uncounted": {"type": "array", "items": {"type": "object", "properties": {"node": {"type": "string"}, "email": {"type": "string"}, "at": int}}}}});
    v["SpokesRelays"] = json!({"type": "object", "required": ["state", "daysLeft", "edition"],
        "properties": {"directory": {"type": "object"}, "crl": {"type": "object"}, "state": {"type": "string"}, "daysLeft": int, "edition": {"type": "string"}}});
    // API-1d 7.1.5 (the card is the A2A 1.0 AgentCard object, signed per A2A 8.4)
    v["AgentList"] = json!({"type": "object", "required": ["agents"],
        "properties": {"agents": {"type": "array", "items": {"type": "object", "required": ["id", "name", "card"],
            "properties": {"id": {"type": "string"}, "name": {"type": "string"}, "card": {"type": "string", "format": "uri"}}}}}});
    v["AgentCard"] = json!({"type": "object", "description": "An A2A 1.0 AgentCard with its signatures (A2A 4.4.1, 8.4)",
        "required": ["name", "description", "supportedInterfaces", "version", "capabilities", "defaultInputModes", "defaultOutputModes", "skills", "signatures"],
        "properties": {"signatures": {"type": "array", "minItems": 1, "items": {"type": "object", "required": ["protected", "signature"],
            "properties": {"protected": {"type": "string"}, "signature": {"type": "string"}}}}}});
    if let Some(grants) = v.pointer_mut("/TokenRequest/properties/grant_type/enum").and_then(Value::as_array_mut) {
        grants.extend([json!(crate::api_delegated::GRANT_CODE), json!(crate::api_delegated::GRANT_REFRESH), json!(crate::api_delegated::GRANT_JWT_BEARER)]);
    }
    match v {
        Value::Object(m) => m,
        _ => Map::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api_audit::{CheckpointSigner, PseudonymKeys};
    use crate::api_map::{VerifiedApiMap, CEILINGS};
    use crate::api_token::Cnf;
    use aws_lc_rs::signature::{EcdsaKeyPair, ECDSA_P256_SHA256_FIXED_SIGNING};
    use std::path::{Path, PathBuf};
    use std::sync::Arc;

    const NOW: i64 = 1_795_000_000;
    const ORG: &str = "acme";
    const I: &str = "https://console.acme.example:7443/api/orgs/acme";
    const ORIGIN: &str = "https://relay1.acme.example:9443";
    const RR: &str = "https://relay1.acme.example:9443/api/orgs/acme";
    const R1: &str = "r_00000000000000a1";
    const R2: &str = "r_00000000000000b2";
    const CLIENT: &str = "c_5f1a2b3c4d5e6f70";
    const MAP_EXPIRES: i64 = NOW + 30 * 86_400;
    const IP: [u8; 4] = [10, 40, 0, 7];

    struct NoSigner;
    impl CheckpointSigner for NoSigner {
        fn kid(&self, _: &str) -> Option<String> {
            None
        }
        fn sign(&self, _: &str, _: &[u8]) -> Option<Vec<u8>> {
            None
        }
        fn certs(&self, _: &str) -> Vec<Value> {
            Vec::new()
        }
    }

    struct Keys;
    impl PseudonymKeys for Keys {
        fn current(&self, _: &str) -> Option<(u32, Vec<u8>)> {
            Some((1, vec![9; 32]))
        }
    }

    /// An audit log that cannot append.
    struct Broken;
    impl AuditLog for Broken {
        fn record(&self, _: &str, _: Value, _: i64) -> Result<u64, AuditError> {
            Err(AuditError { code: "audit-unavailable", message: "disk".into() })
        }
        fn refusal(&self, _: &str, _: &str, _: &str, _: &str, _: Value, _: i64) -> Result<(), AuditError> {
            Err(AuditError { code: "audit-unavailable", message: "disk".into() })
        }
        fn allowed_ok(&self) -> bool {
            true
        }
        fn read(&self, _: &str, _: &str, _: Repr, _: u64, _: usize) -> Result<Value, AuditError> {
            Err(AuditError { code: "audit-unavailable", message: "disk".into() })
        }
        fn keys(&self, _: &str) -> Vec<Value> {
            Vec::new()
        }
    }

    struct Tmp(PathBuf);
    impl Tmp {
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn tmp() -> Tmp {
        let d = std::env::temp_dir().join(format!("lucid-api-resource-{}", rid()));
        std::fs::create_dir_all(&d).unwrap();
        Tmp(d)
    }

    struct Fleet;
    impl Data for Fleet {
        fn relays(&self, _: &str, _: i64) -> Vec<RelayInfo> {
            [R1, R2]
                .iter()
                .map(|id| RelayInfo {
                    id: id.to_string(),
                    name: format!("relay {id}"),
                    health: "ok".into(),
                    latest: json!({"calls_active": 3, "cpu_host": 12.5, "messages": 40, "license_state": 1, "lanes_total": null}).as_object().unwrap().clone(),
                    ..RelayInfo::default()
                })
                .collect()
        }
        fn ids(&self, _: &str) -> Vec<String> {
            vec![R1.to_string(), R2.to_string()]
        }
        fn exposition(&self, _: &str, ids: &[String], _: i64) -> String {
            ids.iter().map(|id| format!("lucid_relay_up{{relay=\"{id}\"}} 1\n")).collect()
        }
        fn console(&self) -> Value {
            json!({"version": "test", "fips": false})
        }
    }

    fn client() -> Value {
        json!({"id": CLIENT, "name": "monitor", "principal": "monitor@apps.acme.example", "kind": "monitoring",
               "owner": "ann@acme.example", "reach": "R0", "scopes": ["monitor.read", "fleet.read", "audit.read"], "ceiling": "internal",
               "relays": ["*"], "networks": [], "mtls_required": false,
               "rate": {"per_minute_each": 6000, "per_day_each": 10_000_000},
               "credentials": [], "created": NOW - 86_400, "expires": NOW + 300 * 86_400, "state": "active"})
    }

    fn scrape_token(n: u8) -> String {
        format!("lme_{}", b64u(&[n; 32]))
    }

    struct Env {
        key: EcdsaKeyPair,
        store: ApiMapStore,
        audit: ApiAudit,
        /// Answer with `Broken` instead of `audit`.
        broken: bool,
        state: ResourceState,
        licensed: bool,
        owner: bool,
        _dir: Tmp,
    }

    impl Env {
        fn with(c: Value, scrape_relays: Value) -> Env {
            let key = EcdsaKeyPair::generate(&ECDSA_P256_SHA256_FIXED_SIGNING).unwrap();
            let jwks = vec![api_issue::ec_public_jwk(&key, "k1")];
            let scrape = json!([{"sha256": hex(&sha256(scrape_token(1).as_bytes())), "hint": "lme_AQEB", "label": "prometheus-dc1",
                                 "relays": scrape_relays, "expires": NOW + 86_400}]);
            let map = json!({"v": 1, "org": ORG, "seq": 1, "issued": NOW - 60, "expires": MAP_EXPIRES,
                             "issuer": {"url": I, "jwks": jwks}, "relay_origins": {R1: ORIGIN}, "clients": [c], "scrape_tokens": scrape});
            let hash = crate::api_map::api_map_hash(&map);
            let wire = json!({ "map": map }).as_object().unwrap().clone();
            let mut store = ApiMapStore::load(None);
            store.pin(VerifiedApiMap { wire, org: ORG.into(), seq: 1, expires: MAP_EXPIRES, hash, signer: "root".into() }).unwrap();
            let dir = tmp();
            let audit = ApiAudit::open(Some(dir.path()), "console", Arc::new(NoSigner), Arc::new(Keys), NOW);
            Env { key, store, audit, broken: false, state: ResourceState::new(), licensed: true, owner: true, _dir: dir }
        }

        fn log(&self) -> &dyn AuditLog {
            if self.broken {
                &Broken
            } else {
                &self.audit
            }
        }

        fn new(c: Value) -> Env {
            Env::with(c, json!(["*"]))
        }

        fn mint(&self, scopes: &[&str], reach: &str, ceiling: &str, map_seq: i64, aud: &str, iat: i64, exp: i64) -> String {
            let scopes: Vec<String> = scopes.iter().map(|s| s.to_string()).collect();
            let t = tok::mint_access_token(&self.key, "k1", I, aud, CLIENT, ORG, &scopes, reach, ceiling, map_seq, &Cnf::None, iat, exp).unwrap();
            format!("Bearer {}", t.token)
        }

        fn token(&self, scopes: &[&str]) -> String {
            self.mint(scopes, "R0", "confidential", 1, I, NOW, NOW + 600)
        }

        fn at(&self, side: Side, path: &str, query: &str, auth: Option<&str>, ip: IpAddr, now: i64) -> Reply {
            let m = route_of(side, "GET", path).expect("a table route");
            let owner = |_: &str| self.owner;
            let (relay, resource, local) = match side {
                Side::FrontDoor => ("console", I, None),
                Side::Relay => (R1, RR, Some((format!("{RR}/local"), Vec::new()))),
            };
            let local_ref = local.as_ref().map(|(l, k): &(String, Vec<Value>)| (l.as_str(), k.as_slice()));
            let site = Site { side, relay, resource, local: local_ref, store: &self.store, owner_active: &owner, licensed: self.licensed, audit: self.log(), state: &self.state, data: &Fleet, now };
            let id = rid();
            let call = Call { org: m.org, route: m.route, id: m.id, path, query, authorization: auth, dpop: None, cert: None, source: ip, rid: &id };
            answer(&site, &call)
        }

        fn get(&self, path: &str, auth: Option<&str>) -> Reply {
            self.at(Side::FrontDoor, path, "", auth, IpAddr::from(IP), NOW)
        }

        fn entries(&self, repr: Repr) -> Vec<Value> {
            self.audit.read(ORG, "console", repr, 0, 1000).map(|p| p["entries"].as_array().cloned().unwrap_or_default()).unwrap_or_default()
        }
    }

    fn code(r: &Reply) -> (u16, String) {
        (r.status, r.body["code"].as_str().unwrap_or("ok").to_string())
    }

    fn header<'r>(r: &'r Reply, k: &str) -> Option<&'r str> {
        r.headers.iter().find(|(n, _)| n.eq_ignore_ascii_case(k)).map(|(_, v)| v.as_str())
    }

    const HEALTH: &str = "/api/orgs/acme/v1/health";
    const RELAYS: &str = "/api/orgs/acme/v1/fleet/relays";

    #[test]
    fn an_allowed_call_carries_rate_and_request_id_headers_and_is_audited() {
        let env = Env::new(client());
        let r = env.get(HEALTH, Some(&env.token(&["monitor.read"])));
        assert_eq!(r.status, 200, "{}", r.body);
        assert_eq!(r.body["relays"].as_array().map(Vec::len), Some(2));
        let rid = header(&r, "X-Lucid-Request-Id").unwrap().to_string();
        assert_eq!(rid.len(), 22);
        assert_eq!(header(&r, "RateLimit-Limit"), Some("6000"));
        assert_eq!(header(&r, "RateLimit-Remaining"), Some("5999"));
        assert!(header(&r, "RateLimit-Reset").is_some());
        let calls: Vec<Value> = env.entries(Repr::AsIs).into_iter().filter(|e| e["action"] == "api.call").collect();
        assert_eq!(calls.len(), 1);
        assert_eq!((calls[0]["rid"].as_str(), calls[0]["client"].as_str(), calls[0]["check"].as_str()), (Some(rid.as_str()), Some(CLIENT), Some("none")));
        assert_eq!(calls[0]["bytes_out"].as_u64(), r.text.as_ref().map(|t| t.len() as u64));
    }

    #[test]
    fn each_resource_check_fails_alone_with_its_code() {
        let with = |f: &dyn Fn(&mut Value)| {
            let mut c = client();
            f(&mut c);
            Env::new(c)
        };
        let ok = Env::new(client());
        let t = ok.token(&["monitor.read", "fleet.read", "audit.read"]);
        assert_eq!(code(&ok.get(HEALTH, Some(&t))).0, 200);
        // 1
        let mut unlicensed = Env::new(client());
        unlicensed.licensed = false;
        assert_eq!(code(&unlicensed.get(HEALTH, Some(&unlicensed.token(&["monitor.read"])))), (403, "license".into()));
        // 2
        let late = ok.at(Side::FrontDoor, HEALTH, "", Some(&t), IpAddr::from(IP), MAP_EXPIRES);
        assert_eq!(code(&late), (401, "map-expired".into()));
        // 3
        let none = ok.get(HEALTH, None);
        assert_eq!(code(&none), (401, "token".into()));
        assert_eq!(none.headers.iter().filter(|(k, _)| *k == "WWW-Authenticate").count(), 2);
        assert_eq!(code(&ok.get(HEALTH, Some("Bearer not.a.token"))), (401, "token".into()));
        assert_eq!(code(&ok.get(HEALTH, Some(&ok.mint(&["monitor.read"], "R0", "internal", 1, RR, NOW, NOW + 600)))), (401, "token".into()), "aud");
        assert_eq!(code(&ok.get(HEALTH, Some(&ok.mint(&["monitor.read"], "R0", "internal", 1, I, NOW - 700, NOW - 100)))), (401, "expired".into()));
        assert_eq!(code(&ok.get(HEALTH, Some(&ok.mint(&["monitor.read"], "R0", "internal", 2, I, NOW, NOW + 600)))), (401, "map-behind".into()));
        // 4
        let suspended = with(&|c: &mut Value| c["state"] = json!("suspended"));
        assert_eq!(code(&suspended.get(HEALTH, Some(&suspended.token(&["monitor.read"])))), (403, "suspended".into()));
        let mut orphan = Env::new(client());
        orphan.owner = false;
        assert_eq!(code(&orphan.get(HEALTH, Some(&orphan.token(&["monitor.read"])))), (403, "owner".into()));
        // 6
        assert_eq!(code(&ok.get(RELAYS, Some(&ok.token(&["monitor.read"])))), (403, "scope".into()));
        // 7
        let r1 = with(&|c: &mut Value| c["reach"] = json!("R1"));
        assert_eq!(code(&r1.get(HEALTH, Some(&r1.mint(&["monitor.read"], "R1", "internal", 1, I, NOW, NOW + 600)))), (403, "reach".into()));
        // 8
        let narrow = with(&|c: &mut Value| c["relays"] = json!([R2]));
        let tn = narrow.token(&["fleet.read"]);
        assert_eq!(code(&narrow.get(&format!("{RELAYS}/{R1}"), Some(&tn))), (404, "not-found".into()));
        assert_eq!(code(&narrow.get(&format!("{RELAYS}/{R2}"), Some(&tn))).0, 200);
        // 9
        let public = with(&|c: &mut Value| c["ceiling"] = json!("public"));
        assert_eq!(code(&public.get(HEALTH, Some(&public.mint(&["monitor.read"], "R0", "public", 1, I, NOW, NOW + 600)))), (403, "ceiling".into()));
        // 10
        let fenced = with(&|c: &mut Value| c["networks"] = json!(["10.99.0.0/16"]));
        assert_eq!(code(&fenced.get(HEALTH, Some(&fenced.token(&["monitor.read"])))), (403, "network".into()));
        let night = with(&|c: &mut Value| c["hours"] = json!({"tz": "UTC", "from": "00:00", "to": "00:01", "days": [1, 2, 3, 4, 5, 6, 7]}));
        assert_eq!(code(&night.get(HEALTH, Some(&night.token(&["monitor.read"])))), (403, "hours".into()));
        let mtls = with(&|c: &mut Value| c["mtls_required"] = json!(true));
        assert_eq!(code(&mtls.get(HEALTH, Some(&mtls.token(&["monitor.read"])))), (403, "mtls".into()));
        // 11
        let slow = with(&|c: &mut Value| c["rate"] = json!({"per_minute_each": 1, "per_day_each": 100}));
        let ts = slow.token(&["monitor.read"]);
        assert_eq!(code(&slow.get(HEALTH, Some(&ts))).0, 200);
        let r = slow.get(HEALTH, Some(&ts));
        assert_eq!(code(&r), (429, "rate".into()));
        assert!(header(&r, "Retry-After").is_some());
        assert_eq!(header(&r, "RateLimit-Remaining"), Some("0"));
        // every refusal is an RFC 9457 problem with the request id
        assert_eq!(r.ctype, "application/problem+json");
        assert_eq!(r.body["type"], "https://lucid.emertins.com/problems/rate");
        assert!(header(&r, "X-Lucid-Request-Id").is_some());
    }

    /// 2.5 `client_limit` (slice 1a6): a journaled limit narrows a live grant at once: its networks refuse a source
    /// the map still allows, its relays hide another relay, its rate is the lower one.
    #[test]
    fn a_client_limit_narrows_networks_relays_and_rate() {
        let mut env = Env::new(client());
        let t = env.token(&["monitor.read", "fleet.read"]);
        let limit = json!({"client": CLIENT, "relays": [R2], "networks": ["10.99.0.0/16"], "rate": {"per_minute_each": 1}});
        env.store.apply_tighten(ORG, &json!({"id": "t_acme_000001", "tseq": 1, "ts": NOW - 5, "action": "client_limit", "target": limit})).unwrap();
        assert_eq!(code(&env.get(HEALTH, Some(&t))), (403, "network".into()), "10.40.0.7 is outside the limit's networks");
        let inside = IpAddr::from([10, 99, 0, 7]);
        assert_eq!(code(&env.at(Side::FrontDoor, &format!("{RELAYS}/{R1}"), "", Some(&t), inside, NOW)), (404, "not-found".into()));
        assert_eq!(code(&env.at(Side::FrontDoor, &format!("{RELAYS}/{R2}"), "", Some(&t), inside, NOW)).0, 200);
        assert_eq!(code(&env.at(Side::FrontDoor, HEALTH, "", Some(&t), inside, NOW)), (429, "rate".into()), "one a minute, already used");
    }

    #[test]
    fn the_source_limiter_runs_before_any_token_cryptography() {
        let env = Env::new(client());
        let ip = IpAddr::from(IP);
        for _ in 0..RESOURCE_PER_MINUTE {
            assert_eq!(code(&env.at(Side::FrontDoor, HEALTH, "", Some("Bearer garbage.garbage.garbage"), ip, NOW)), (401, "token".into()));
        }
        assert_eq!(env.state.validations(), RESOURCE_PER_MINUTE);
        let good = env.token(&["monitor.read"]);
        for auth in ["Bearer garbage.garbage.garbage", good.as_str()] {
            for _ in 0..100 {
                let r = env.at(Side::FrontDoor, HEALTH, "", Some(auth), ip, NOW + 30);
                assert_eq!(code(&r), (429, "abuse".into()));
                assert!(header(&r, "Retry-After").is_some());
            }
        }
        assert_eq!(env.state.validations(), RESOURCE_PER_MINUTE, "nothing past the limiter reached validation");
        // another address is not limited
        assert_eq!(env.at(Side::FrontDoor, HEALTH, "", Some(&good), IpAddr::from([10, 40, 0, 8]), NOW + 30).status, 200);
    }

    #[test]
    fn the_client_limiter_charges_600_a_minute_before_the_semantic_checks() {
        let env = Env::new(client());
        let t = env.token(&["monitor.read"]);
        for i in 0..CLIENT_PER_MINUTE {
            let ip = IpAddr::from([10, 50, (i >> 8) as u8, i as u8]);
            assert_eq!(code(&env.at(Side::FrontDoor, RELAYS, "", Some(&t), ip, NOW)), (403, "scope".into()));
        }
        let r = env.at(Side::FrontDoor, RELAYS, "", Some(&t), IpAddr::from([10, 51, 0, 1]), NOW);
        assert_eq!(code(&r), (429, "abuse".into()));
    }

    #[test]
    fn ten_thousand_wrong_scope_requests_leave_at_most_eleven_entries_per_check() {
        let env = Env::new(client());
        let t = env.token(&["monitor.read"]);
        let mut seen: HashMap<String, u64> = HashMap::new();
        for i in 0..10_000u32 {
            // ten addresses of 1000 requests each: under the source limiter
            let ip = IpAddr::from([10, 60, 0, (i / 1000) as u8]);
            let (_, c) = code(&env.at(Side::FrontDoor, RELAYS, "", Some(&t), ip, NOW));
            *seen.entry(c).or_default() += 1;
        }
        assert_eq!(seen.get("scope"), Some(&(CLIENT_PER_MINUTE as u64)));
        assert_eq!(seen.get("abuse"), Some(&(10_000 - CLIENT_PER_MINUTE as u64)));
        // the minute ends: its summaries are appended
        env.audit.tick(NOW + 120);
        let entries = env.entries(Repr::AsIs);
        let refusals: Vec<&Value> = entries.iter().filter(|e| e["action"].as_str().is_some_and(|a| a.starts_with("api.refusal"))).collect();
        for check in ["scope", "abuse"] {
            let of: Vec<&&Value> = refusals.iter().filter(|e| e["check"] == check).collect();
            assert!(of.len() <= 11, "{check}: {} entries", of.len());
            let counted: u64 = of.iter().map(|e| e["count"].as_u64().unwrap_or(1)).sum();
            assert_eq!(counted, seen[check], "{check}: the exact count is kept");
        }
        assert!(refusals.iter().all(|e| e["check"] == "scope" || e["check"] == "abuse"));
    }

    #[test]
    fn an_internal_ceiling_client_reads_the_pseudonymized_chain() {
        let internal = Env::new(client());
        let t = internal.mint(&["monitor.read", "audit.read"], "R0", "internal", 1, I, NOW, NOW + 600);
        assert_eq!(internal.get(HEALTH, Some(&t)).status, 200);
        let r = internal.get("/api/orgs/acme/v1/audit", Some(&t));
        assert_eq!(r.status, 200, "{}", r.body);
        assert_eq!(r.body["repr"], "pseudonymized");
        assert!(!r.bytes().windows(9).any(|w| w == b"10.40.0.7"), "no raw address in the pseudonymized chain");
        let mut c = client();
        c["ceiling"] = json!("confidential");
        let confidential = Env::new(c);
        let t = confidential.mint(&["monitor.read", "audit.read"], "R0", "confidential", 1, I, NOW, NOW + 600);
        assert_eq!(confidential.get(HEALTH, Some(&t)).status, 200);
        let r = confidential.get("/api/orgs/acme/v1/audit", Some(&t));
        assert_eq!(r.body["repr"], "as_is");
        // a cursor of another chain is refused
        let bad = confidential.at(Side::FrontDoor, "/api/orgs/acme/v1/audit", "after=nope", Some(&t), IpAddr::from(IP), NOW);
        assert_eq!(code(&bad), (400, "bad-request".into()));
    }

    /// Revision 5 12.1: `source=connector&connector=<k_id>` reads the connector's chain the console received, and check
    /// 8 judges it as `console` (the chain's holder).
    #[test]
    fn a_connector_chain_is_read_by_its_id() {
        let mut c = client();
        c["relays"] = json!(["console"]);
        let env = Env::new(c);
        let k = "k_7a1b2c3d4e5f6a7b";
        let connector = ApiAudit::open(None, k, Arc::new(NoSigner), Arc::new(Keys), NOW);
        connector.record(ORG, json!({"action": "connector.stale.on", "result": "ok", "age_s": 61}), NOW).unwrap();
        for repr in Repr::ALL {
            env.audit.ingest(ORG, k, repr, 1, 1, &connector.since(ORG, repr, 0, 10)).unwrap();
        }
        let t = env.token(&["audit.read"]);
        let r = env.at(Side::FrontDoor, "/api/orgs/acme/v1/audit", &format!("source=connector&connector={k}"), Some(&t), IpAddr::from(IP), NOW);
        assert_eq!(r.status, 200, "{}", r.body);
        assert_eq!(r.body["chain"]["source"], k);
        assert_eq!((r.body["entries"][0]["source"].as_str(), r.body["entries"][0]["connector"].as_str()), (Some("connector"), Some(k)));
        let calls: Vec<Value> = env.entries(Repr::AsIs).into_iter().filter(|e| e["action"] == "api.call").collect();
        assert_eq!(calls.last().map(|e| e["resource"].clone()), Some(json!("console")));
        for query in ["source=connector&connector=r_00000000000000aa", "source=connector", "source=relay&connector=k_7a1b2c3d4e5f6a7b"] {
            let bad = env.at(Side::FrontDoor, "/api/orgs/acme/v1/audit", query, Some(&t), IpAddr::from(IP), NOW);
            assert_eq!(code(&bad), (400, "bad-request".into()), "{query}");
        }
    }

    #[test]
    fn an_audit_failure_answers_503_and_no_data() {
        let mut env = Env::new(client());
        env.broken = true;
        let r = env.get(HEALTH, Some(&env.token(&["monitor.read"])));
        assert_eq!(code(&r), (503, "audit-unavailable".into()));
        assert!(r.body.get("relays").is_none() && r.text.is_none());
        assert_eq!(code(&env.get(HEALTH, None)), (503, "audit-unavailable".into()), "a refusal it cannot record either");
        // the token pipeline: no token leaves
        let a = Answer { status: 200, body: json!({"access_token": "secret"}), headers: Vec::new(), event: Some(("api.token", json!({"client": CLIENT, "jti": "j"}))) };
        let out = token_audited(&Broken, ORG, "POST /api/orgs/acme/oauth/token", "rid", IpAddr::from(IP), a, NOW);
        assert_eq!((out.status, out.body["code"].as_str()), (503, Some("audit-unavailable")));
        assert!(out.body.get("access_token").is_none());
    }

    #[test]
    fn token_decisions_are_in_the_chain_before_release() {
        let env = Env::new(client());
        let a = Answer { status: 200, body: json!({"access_token": "t"}), headers: Vec::new(),
                         event: Some(("api.token", json!({"client": CLIENT, "scope": "monitor.read", "aud": I, "jti": "j1", "exp": NOW + 600, "cnf": "jkt", "auth": "private_key_jwt", "source": "10.40.0.7", "map_seq": 1}))) };
        assert_eq!(token_audited(&env.audit, ORG, "POST /api/orgs/acme/oauth/token", "r1", IpAddr::from(IP), a, NOW).status, 200);
        let refused = api_issue::refusal(ORG, IpAddr::from(IP), Some(CLIENT), "scope", "No.", None);
        assert_eq!(token_audited(&env.audit, ORG, "POST /api/orgs/acme/oauth/token", "r2", IpAddr::from(IP), refused, NOW).status, 400);
        let entries = env.entries(Repr::AsIs);
        let tokens: Vec<&Value> = entries.iter().filter(|e| e["action"] == "api.token").collect();
        assert_eq!((tokens.len(), tokens[0]["jti"].as_str(), tokens[0]["cnf"].as_str(), tokens[0]["exp"].as_i64()), (1, Some("j1"), Some("jkt"), Some(NOW + 600)));
        assert!(entries.iter().any(|e| e["action"] == "api.refusal" && e["check"] == "scope" && e["client"] == CLIENT));
    }

    #[test]
    fn a_map_scrape_token_reads_relay_metrics_and_a_console_only_token_does_not() {
        let env = Env::new(client());
        let path = "/api/orgs/acme/v1/metrics";
        let listed = format!("Bearer {}", scrape_token(1));
        let r = env.at(Side::Relay, path, "", Some(&listed), IpAddr::from(IP), NOW);
        assert_eq!(r.status, 200, "{}", r.body);
        assert_eq!(r.ctype, crate::fleet_export::CONTENT_TYPE);
        assert!(r.text.as_deref().is_some_and(|t| t.contains("lucid_relay_up")));
        assert_eq!(code(&env.at(Side::Relay, path, "", Some(&listed), IpAddr::from(IP), NOW + 5)), (429, "rate".into()), "one scrape per 10 s");
        assert_eq!(env.at(Side::Relay, path, "", Some(&listed), IpAddr::from(IP), NOW + 10).status, 200);
        // a console-only token (not in the map) is not a scrape token here, nor an access token
        let console_only = format!("Bearer {}", scrape_token(2));
        assert_eq!(code(&env.at(Side::Relay, path, "", Some(&console_only), IpAddr::from(IP), NOW + 20)), (401, "token".into()));
        // a token listed for other relays
        let other = Env::with(client(), json!([R2]));
        assert_eq!(code(&other.at(Side::Relay, path, "", Some(&listed), IpAddr::from(IP), NOW)), (404, "not-found".into()));
        // the front door has no scrape pipeline on its v1/metrics
        assert_eq!(code(&env.at(Side::FrontDoor, path, "", Some(&listed), IpAddr::from(IP), NOW + 30)), (401, "token".into()));
    }

    #[test]
    fn a_relay_listener_accepts_its_resource_and_refuses_the_console_audience() {
        let env = Env::new(client());
        let for_relay = env.mint(&["monitor.read"], "R0", "internal", 1, RR, NOW, NOW + 600);
        let r = env.at(Side::Relay, HEALTH, "", Some(&for_relay), IpAddr::from(IP), NOW);
        assert_eq!(r.status, 200, "{}", r.body);
        assert_eq!(r.body["mode"], "normal");
        assert_eq!(r.body["relays"].as_array().map(Vec::len), Some(2), "the fake data source answers both; a relay's own source has one");
        let for_console = env.mint(&["monitor.read"], "R0", "internal", 1, I, NOW, NOW + 600);
        assert_eq!(code(&env.at(Side::Relay, HEALTH, "", Some(&for_console), IpAddr::from(IP), NOW)), (401, "token".into()));
    }

    #[test]
    fn capacity_lists_the_snapshot_keys_with_their_exact_names() {
        let env = Env::new(client());
        let r = env.get("/api/orgs/acme/v1/capacity", Some(&env.token(&["monitor.read"])));
        assert_eq!(r.status, 200, "{}", r.body);
        let first = r.body["relays"][0].as_object().unwrap();
        assert_eq!(first.get("calls_active"), Some(&json!(3)));
        assert_eq!(first.get("cpu_host"), Some(&json!(12.5)));
        assert!(first.get("messages").is_none() && first.get("license_state").is_none() && first.get("lanes_total").is_none());
    }

    #[test]
    fn the_telemetry_catalog_route_answers_the_catalog_and_counts_each_decision() {
        let env = Env::new(client());
        let path = "/api/orgs/acme/v1/telemetry/catalog";
        let r = env.get(path, Some(&env.token(&["monitor.read"])));
        assert_eq!(r.status, 200, "{}", r.body);
        assert_eq!(&r.body, crate::api_catalog::catalog().json());
        assert_eq!(code(&env.get(path, Some(&env.token(&["fleet.read"])))), (403, "scope".into()));
        assert!(route_of(Side::Relay, "GET", path).is_none(), "front door only");
        // 10.1 (other tests of this org count too, so at least)
        let rows = crate::api_catalog::counters::rows(Some(ORG), NOW);
        let n = |prom: &str, labels: &[(&str, &str)]| {
            rows.iter().find(|r| r.prom == prom && r.labels.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect::<Vec<_>>() == labels).map_or(0.0, |r| r.value)
        };
        assert!(n("lucid_api_requests_total", &[("client", CLIENT), ("result", "ok")]) >= 1.0);
        assert!(n("lucid_api_requests_total", &[("client", CLIENT), ("result", "refused")]) >= 1.0);
        assert!(n("lucid_api_refusals_total", &[("check", "scope")]) >= 1.0);
    }

    #[test]
    fn openapi_lists_every_dispatched_route_with_its_pipeline_scope_reach_and_class() {
        let schemas = schemas();
        for id in RouteId::ALL {
            assert!(ROUTES.iter().any(|r| r.id == id), "{id:?} is dispatched but not in the table");
        }
        for r in &ROUTES {
            let concrete = r.path.replace("{org}", ORG).replace("{id}", R1);
            let m = route_of(r.side, r.method, &concrete).unwrap_or_else(|| panic!("{} {}", r.method, r.path));
            assert!(std::ptr::eq(m.route, r), "{} {} dispatches to its own row", r.method, r.path);
            assert!(CEILINGS.contains(&r.class), "{:?} class", r.id);
            if r.pipeline == Pipeline::Resource {
                // revision 4 3.1: R1 only for compliance.export.request, on the front door
                let reach_ok = r.reach == "R0" || (r.reach == "R1" && r.scope == "compliance.export.request" && r.side == Side::FrontDoor);
                assert!(SCOPES.contains(&r.scope) && reach_ok, "{:?} scope and reach", r.id);
            } else {
                assert!(r.scope.is_empty() && r.reach.is_empty(), "{:?}", r.id);
            }
            for name in [r.request, r.response].into_iter().filter(|n| !n.is_empty()) {
                assert!(schemas.contains_key(name), "{:?} schema {name}", r.id);
            }
        }
        for side in [Side::FrontDoor, Side::Relay] {
            let resource = if side == Side::FrontDoor { I } else { RR };
            let doc = openapi(side, ORG, resource);
            assert_eq!(doc["openapi"], "3.1.0");
            for r in ROUTES.iter().filter(|r| r.side == side) {
                let op = &doc["paths"][r.path.replace("{org}", ORG)][r.method.to_ascii_lowercase()];
                assert_eq!(op["x-lucid-pipeline"], r.pipeline.as_str(), "{:?}", r.id);
                assert_eq!(op["x-lucid-class"], r.class);
                if r.pipeline == Pipeline::Resource {
                    assert_eq!((op["x-lucid-scope"].as_str(), op["x-lucid-reach"].as_str()), (Some(r.scope), Some(r.reach)));
                }
            }
        }
        // the public pipeline serves it on the front door
        let env = Env::new(client());
        let r = env.get("/api/orgs/acme/v1/openapi.json", None);
        assert_eq!(r.status, 200);
        assert_eq!(r.body["servers"][0]["url"], "https://console.acme.example:7443");
        assert!(route_of(Side::Relay, "GET", "/api/orgs/acme/v1/openapi.json").is_none());
        assert!(route_of(Side::FrontDoor, "POST", HEALTH).is_none());
        assert!(route_of(Side::FrontDoor, "GET", "/api/orgs//v1/health").is_none());
    }

    /// The test fleet with the console's event chains.
    struct FleetEvents(Arc<crate::api_events::EventLog>);
    impl Data for FleetEvents {
        fn relays(&self, org: &str, now: i64) -> Vec<RelayInfo> {
            Fleet.relays(org, now)
        }
        fn ids(&self, org: &str) -> Vec<String> {
            Fleet.ids(org)
        }
        fn exposition(&self, org: &str, ids: &[String], now: i64) -> String {
            Fleet.exposition(org, ids, now)
        }
        fn console(&self) -> Value {
            Fleet.console()
        }
        fn events(&self) -> Option<Arc<crate::api_events::EventLog>> {
            Some(self.0.clone())
        }
    }

    #[test]
    fn the_event_feed_needs_its_scope_and_selects_by_the_grant() {
        let mut c = client();
        c["scopes"] = json!(["monitor.read", "fleet.read", "audit.read", "events.subscribe"]);
        let env = Env::new(c);
        let dir = tmp();
        let log = Arc::new(crate::api_events::EventLog::open(Some(dir.path()), "console", Arc::new(NoSigner), Arc::new(Keys), NOW));
        log.emit(ORG, "relay.connected", json!({"relay": R1, "version": "1"}), NOW).unwrap();
        log.emit(ORG, "api.disabled", Value::Null, NOW).unwrap();
        let data = FleetEvents(log);
        let get = |path: &str, query: &str, auth: &str| {
            let m = route_of(Side::FrontDoor, "GET", path).expect("a table route");
            let owner = |_: &str| true;
            let site = Site { side: Side::FrontDoor, relay: "console", resource: I, local: None, store: &env.store, owner_active: &owner, licensed: true, audit: &env.audit, state: &env.state, data: &data, now: NOW };
            let id = rid();
            let call = Call { org: m.org, route: m.route, id: m.id, path, query, authorization: Some(auth), dpop: None, cert: None, source: IpAddr::from(IP), rid: &id };
            answer(&site, &call)
        };
        let t = env.mint(&["events.subscribe", "fleet.read"], "R0", "internal", 1, I, NOW, NOW + 600);
        let r = get("/api/orgs/acme/v1/events", "", &t);
        assert_eq!(r.status, 200, "{}", r.body);
        let events = r.body["events"].as_array().unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0]["type"], "com.emertins.lucid.relay.connected");
        assert_eq!(events[1]["stub"], true, "api.disabled needs audit.read");
        assert_eq!(r.body["repr"], "pseudonymized");
        assert!(r.body["next"].is_string());
        // the scope, the types the client may see, a foreign cursor, the keys
        let without = env.mint(&["fleet.read"], "R0", "internal", 1, I, NOW, NOW + 600);
        assert_eq!(code(&get("/api/orgs/acme/v1/events", "", &without)), (403, "scope".into()));
        let types = get("/api/orgs/acme/v1/events/types", "", &t);
        let names: Vec<&str> = types.body["types"].as_array().unwrap().iter().filter_map(|t| t["name"].as_str()).collect();
        assert!(names.contains(&"relay.connected") && names.contains(&"checkpoint") && !names.contains(&"api.disabled"), "{names:?}");
        assert_eq!(code(&get("/api/orgs/acme/v1/events", "after=nope", &t)), (400, "cursor".into()));
        assert_eq!(code(&get("/api/orgs/acme/v1/events", "types=nothing", &t)), (400, "bad-request".into()));
        assert_eq!(get("/api/orgs/acme/v1/events/keys", "", &t).status, 200);
        // one held long poll per client on this listener
        let held = env.state.held.hold(format!("{ORG} {CLIENT}"));
        assert!(held.is_some());
        assert_eq!(code(&get("/api/orgs/acme/v1/events", "wait=1", &t)), (429, "abuse".into()));
        drop(held);
        // every decision is audited
        assert!(env.entries(Repr::AsIs).iter().any(|e| e["action"] == "api.call" && e["route"] == "GET /api/orgs/acme/v1/events"));
    }

    #[test]
    fn a_request_outside_the_table_still_names_its_namespace() {
        for (path, org) in [
            ("/api/orgs/acme/v1/nothing/here", Some("acme")),
            ("/api/orgs/acme", Some("acme")),
            ("/.well-known/oauth-protected-resource/api/orgs/acme/extra", Some("acme")),
            ("/.well-known/oauth-authorization-server/api/orgs/acme/local", Some("acme")),
            ("/api/orgs//v1/health", None),
            ("/api/orgs/ACME/v1/health", None),
            ("/fleet/v1/trust", None),
            ("/", None),
        ] {
            assert_eq!(org_of(path), org, "{path}");
        }
        assert_eq!(namespace_route("DELETE", ORG), "DELETE /api/orgs/acme");
        assert_eq!(namespace_route("BREW", ORG), "OTHER /api/orgs/acme", "a method word outside HTTP's own opens no bucket of its own");
        let r = charged(Err(0), problem(404, "not-found", NOT_FOUND));
        assert_eq!((r.status, r.body["code"].as_str(), header(&r, "Retry-After")), (429, Some("abuse"), Some("1")));
        assert_eq!(charged(Ok(()), problem(404, "not-found", NOT_FOUND)).status, 404);
    }

    /// API-1d 6.1: spokes relays as the front door reaches them: R1 answers (with emails, which the listener must drop
    /// for a client without people), R2 is silent. Each ask is kept as (relay, view, query, people).
    #[derive(Default)]
    struct SpokesFleet(Mutex<Vec<(String, String, String, bool)>>);
    impl Data for SpokesFleet {
        fn relays(&self, org: &str, now: i64) -> Vec<RelayInfo> {
            Fleet.relays(org, now)
        }
        fn ids(&self, org: &str) -> Vec<String> {
            Fleet.ids(org)
        }
        fn exposition(&self, org: &str, ids: &[String], now: i64) -> String {
            Fleet.exposition(org, ids, now)
        }
        fn console(&self) -> Value {
            Fleet.console()
        }
        fn spokes(&self, _org: &str, relay: &str, view: &str, query: &str, people: bool) -> Option<Result<Value, crate::fleet_wire::Refusal>> {
            self.0.lock().push((relay.to_string(), view.to_string(), query.to_string(), people));
            match relay {
                R1 => {
                    // as the relay's `node_filter`: `q` matches an email only with people
                    let q = query.split('&').find_map(|p| p.strip_prefix("q=")).unwrap_or("");
                    let rows: Vec<Value> = [json!({"node": "n_0000000000000000000000000000000a", "role": "hub", "label": "Build hub", "email": "ann@acme.example", "state": "ok", "mailbox": 0, "service": false})]
                        .into_iter()
                        .filter(|r| q.is_empty() || r["label"].as_str().unwrap().contains(q) || (people && r["email"].as_str().unwrap().contains(q)))
                        .collect();
                    Some(Ok(match view {
                        "nodes" => json!({ "nodes": rows }),
                        "counts" => json!({"hubs": 1, "spokes": 2, "online": 3}),
                        "seats" => json!({"users": 5, "used": 1, "seats": [{"user": "u_1", "email": "ann@acme.example", "since": 1, "certificates": 1, "exp": 2}], "uncounted": [{"node": "n_1", "email": "bo@acme.example", "at": 3}]}),
                        _ => json!({"state": "ok", "daysLeft": 40, "edition": "enterprise"}),
                    }))
                }
                R2 => Some(Err(crate::fleet_wire::Refusal::new(503, "relay-unreachable", "The relay did not answer."))),
                _ => None,
            }
        }
    }

    const R3: &str = "r_00000000000000c3";

    /// An env whose pinned map (seq 2) binds R1, R2 and R3 is not bound; the client holds `spokes.read`.
    fn spokes_env(ceiling: &str, relays: Value) -> Env {
        let mut c = client();
        c["scopes"] = json!(["monitor.read", "spokes.read"]);
        c["ceiling"] = json!(ceiling);
        c["relays"] = relays;
        let mut env = Env::new(c);
        let mut map = Value::Object(env.store.get(ORG, "").unwrap().map().clone());
        map["seq"] = json!(2);
        map["spokes"] = json!({"root": "n_0f1e2d3c4b5a69788796a5b4c3d2e1f0", "root_spki": "ab".repeat(32), "relays": [R1, R2]});
        let hash = crate::api_map::api_map_hash(&map);
        let wire = json!({ "map": map }).as_object().unwrap().clone();
        env.store.pin(VerifiedApiMap { wire, org: ORG.into(), seq: 2, expires: MAP_EXPIRES, hash, signer: "root".into() }).unwrap();
        env
    }

    fn spokes_get(env: &Env, data: &dyn Data, side: Side, path: &str, query: &str, auth: &str) -> Reply {
        let m = route_of(side, "GET", path).expect("a table route");
        let owner = |_: &str| true;
        let (relay, resource, local) = match side {
            Side::FrontDoor => ("console", I, None),
            Side::Relay => (R1, RR, Some((format!("{RR}/local"), Vec::new()))),
        };
        let local_ref = local.as_ref().map(|(l, k): &(String, Vec<Value>)| (l.as_str(), k.as_slice()));
        let site = Site { side, relay, resource, local: local_ref, store: &env.store, owner_active: &owner, licensed: true, audit: &env.audit, state: &env.state, data, now: NOW };
        let id = rid();
        let call = Call { org: m.org, route: m.route, id: m.id, path, query, authorization: Some(auth), dpop: None, cert: None, source: IpAddr::from(IP), rid: &id };
        answer(&site, &call)
    }

    #[test]
    fn spokes_read_serves_bound_relays_of_the_client_without_emails_for_internal_clients() {
        const NODES: &str = "/api/orgs/acme/v1/spokes/nodes";
        let env = spokes_env("internal", json!(["*"]));
        let data = SpokesFleet::default();
        let t = env.mint(&["spokes.read"], "R0", "internal", 2, I, NOW, NOW + 600);
        // an internal client: rows without email, the relay told people = false, `relay` not forwarded
        let r = spokes_get(&env, &data, Side::FrontDoor, NODES, &format!("relay={R1}&role=hub&q=Build"), &t);
        assert_eq!(r.status, 200, "{}", r.body);
        assert_eq!(r.body["nodes"].as_array().unwrap().len(), 1);
        assert!(!r.body.to_string().contains("email"), "{}", r.body);
        assert_eq!(data.0.lock().last().cloned().unwrap(), (R1.to_string(), "nodes".to_string(), "role=hub&q=Build".to_string(), false));
        // q never matches an email for it
        let r = spokes_get(&env, &data, Side::FrontDoor, NODES, &format!("relay={R1}&q=acme.example"), &t);
        assert_eq!(r.body["nodes"], json!([]));
        // seats keep no email either
        let seats = spokes_get(&env, &data, Side::FrontDoor, "/api/orgs/acme/v1/spokes/seats", &format!("relay={R1}"), &t);
        assert_eq!(seats.status, 200);
        assert!(!seats.body.to_string().contains("@acme.example"), "{}", seats.body);
        // a relay outside the map's spokes.relays, a missing relay, a silent relay
        assert_eq!(code(&spokes_get(&env, &data, Side::FrontDoor, NODES, &format!("relay={R3}"), &t)), (404, "not-found".into()));
        assert_eq!(code(&spokes_get(&env, &data, Side::FrontDoor, NODES, "", &t)), (400, "bad-request".into()));
        let silent = spokes_get(&env, &data, Side::FrontDoor, "/api/orgs/acme/v1/spokes/relays", &format!("relay={R2}"), &t);
        assert_eq!((code(&silent), header(&silent, "Retry-After")), ((503, "relay-unreachable".into()), Some("30")));
        // counts: every bound relay of the client, a silent one marked
        let counts = spokes_get(&env, &data, Side::FrontDoor, "/api/orgs/acme/v1/spokes/counts", "", &t);
        assert_eq!(counts.status, 200, "{}", counts.body);
        assert_eq!(counts.body["relays"], json!([{"relay": R1, "counts": {"hubs": 1, "spokes": 2, "online": 3}}, {"relay": R2, "error": "relay-unreachable"}]));
        // the scope is needed; a public ceiling is refused
        let other = env.mint(&["monitor.read"], "R0", "internal", 2, I, NOW, NOW + 600);
        assert_eq!(code(&spokes_get(&env, &data, Side::FrontDoor, NODES, &format!("relay={R1}"), &other)), (403, "scope".into()));
        let public = env.mint(&["spokes.read"], "R0", "public", 2, I, NOW, NOW + 600);
        assert_eq!(code(&spokes_get(&env, &data, Side::FrontDoor, NODES, &format!("relay={R1}"), &public)), (403, "ceiling".into()));
        // every decision is audited
        assert!(env.entries(Repr::AsIs).iter().any(|e| e["action"] == "api.call" && e["route"] == "GET /api/orgs/acme/v1/spokes/nodes" && e["resource"] == R1));
    }

    #[test]
    fn spokes_read_is_404_for_a_relay_outside_the_clients_relays_and_shows_emails_only_with_people() {
        const NODES: &str = "/api/orgs/acme/v1/spokes/nodes";
        let data = SpokesFleet::default();
        // check 8: R1 is bound but not the client's
        let env = spokes_env("confidential", json!([R2]));
        let t = env.mint(&["spokes.read"], "R0", "confidential", 2, I, NOW, NOW + 600);
        assert_eq!(code(&spokes_get(&env, &data, Side::FrontDoor, NODES, &format!("relay={R1}"), &t)), (404, "not-found".into()));
        // counts asks only the client's R2, which is silent, so none answered: 503, and R1 was never asked
        data.0.lock().clear();
        let counts = spokes_get(&env, &data, Side::FrontDoor, "/api/orgs/acme/v1/spokes/counts", "", &t);
        assert_eq!(code(&counts), (503, "relay-unreachable".into()));
        assert_eq!(data.0.lock().iter().map(|(r, ..)| r.as_str()).collect::<Vec<_>>(), [R2]);
        // a confidential client sees emails and q matches them
        let env = spokes_env("confidential", json!(["*"]));
        let t = env.mint(&["spokes.read"], "R0", "confidential", 2, I, NOW, NOW + 600);
        let r = spokes_get(&env, &data, Side::FrontDoor, NODES, &format!("relay={R1}&q=acme.example"), &t);
        assert_eq!(r.status, 200, "{}", r.body);
        assert_eq!(r.body["nodes"][0]["email"], "ann@acme.example");
        assert!(data.0.lock().last().unwrap().3, "people");
        // the relay listener answers its own views (no relay parameter, or its own id; any other is 404)
        let rt = env.mint(&["spokes.read"], "R0", "confidential", 2, RR, NOW, NOW + 600);
        assert_eq!(spokes_get(&env, &data, Side::Relay, NODES, "", &rt).status, 200);
        assert_eq!(code(&spokes_get(&env, &data, Side::Relay, NODES, &format!("relay={R2}"), &rt)), (404, "not-found".into()));
        let counts = spokes_get(&env, &data, Side::Relay, "/api/orgs/acme/v1/spokes/counts", "", &rt);
        assert_eq!(counts.body["relays"], json!([{"relay": R1, "counts": {"hubs": 1, "spokes": 2, "online": 3}}]));
        // a Meet relay's listener (no spokes source) answers 404
        assert_eq!(code(&spokes_get(&env, &Fleet, Side::Relay, "/api/orgs/acme/v1/spokes/seats", "", &rt)), (404, "not-found".into()));
    }
}
