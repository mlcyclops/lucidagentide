// Contract API-1 revision 5 (phase 1c), sections 8.1 to 8.5 (slice 1c5): the MCP engine both Streamable HTTP servers
// share, the console MCP at M = `I/mcp` (`console_mcp`) and the connector MCP at CM = `C/mcp` (`connector_mcp`).
// Checked against the MCP 2026-07-28 specification at its primary source (modelcontextprotocol.io, 2026-11-23):
// `basic/transports/streamable-http` (POST only, 405 for GET and DELETE, `Origin` 403, `MCP-Protocol-Version`,
// `Mcp-Method` on every request and `Mcp-Name` on `tools/call`, `resources/read` and `prompts/get`, the `=?base64?..?=`
// sentinel, `HeaderMismatch` -32020 with 400, an unknown method 404 with -32601, a notification 202 or an error
// status), `basic/index` (`_meta` `io.modelcontextprotocol/protocolVersion` and `clientCapabilities` required, else
// -32602 with 400; every result carries `resultType`; `serverInfo` in result `_meta`), `basic/versioning`
// (`UnsupportedProtocolVersionError` -32022 with `data.supported` and `data.requested`), `server/discover`,
// `basic/patterns/mrtr` (`InputRequiredResult`, `inputRequests`, `requestState` integrity, principal, expiry and
// request binding) and the schema (`CacheableResult` `ttlMs` and `cacheScope`, `ElicitRequestURLParams`,
// `ElicitRequestFormParams`, `ToolAnnotations`, `CallToolResult`).
//
// Only 2026-07-28 is served (decision O8). No sessions, no SSE: every answer is one JSON object. The order of 8.2 is
// the callers': the source limiter, then `head` (this file), then the token checks with the scope `head` selected,
// then `body` (this file) on at most `BODY_MAX` bytes, then the tool.
//
// Prompt injection (9.3): tool output reaches a model, so every result's text is a fenced block (`prompt_fence`) and
// its content strings are fenced in `structuredContent` too; nothing in a result is ever run as an instruction here.

use crate::api_resource::Reply;
use crate::codec::{b64_decode_lenient, b64u, hex, sha256, unb64u};
use crate::connector_seal::SecretKey;
use aws_lc_rs::aead;
use serde_json::{json, Map, Value};

/// The one protocol version served (O8).
pub const PROTOCOL: &str = "2026-07-28";
/// 8.1: the largest request body read.
pub const BODY_MAX: usize = 64 * 1024;
/// 8.1: the largest result sent; larger tool output is cut at an item boundary.
pub const RESULT_MAX: usize = 1 << 20;
/// How long a client may cache a listing (`ttlMs`).
pub const LIST_TTL_MS: i64 = 300_000;
/// 8.4: the AAD of a sealed `requestState`.
pub const STATE_AAD: &[u8] = b"lucid-mcp-state-v1";
/// 8.4: the key of the approval in `inputRequests`.
pub const APPROVAL_INPUT: &str = "lucid_approval";
/// 8.4: what an approval elicitation says.
pub const APPROVAL_MESSAGE: &str = "Approve this post on your Lucid device (Meeting Hub or iPhone).";

pub const PARSE_ERROR: i64 = -32700;
pub const INVALID_REQUEST: i64 = -32600;
pub const METHOD_NOT_FOUND: i64 = -32601;
pub const INVALID_PARAMS: i64 = -32602;
pub const HEADER_MISMATCH: i64 = -32020;
pub const UNSUPPORTED_VERSION: i64 = -32022;

const META_VERSION: &str = "io.modelcontextprotocol/protocolVersion";
const META_CAPS: &str = "io.modelcontextprotocol/clientCapabilities";
/// `clientInfo` is self-reported and never used for a decision (base protocol, `_meta`); the tests send it.
#[cfg(test)]
const META_CLIENT: &str = "io.modelcontextprotocol/clientInfo";
const META_SERVER: &str = "io.modelcontextprotocol/serverInfo";
const NONCE_LEN: usize = 12;

// ── methods ─────────────────────────────────────────────────────────────────────────────────────────────────────

/// The methods these servers answer (8.1); anything else is -32601 (`subscriptions/listen` included).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Method {
    Discover,
    ToolsList,
    ToolsCall,
    ResourcesList,
    TemplatesList,
    ResourcesRead,
}

impl Method {
    pub fn of(s: &str) -> Option<Method> {
        Some(match s {
            "server/discover" => Method::Discover,
            "tools/list" => Method::ToolsList,
            "tools/call" => Method::ToolsCall,
            "resources/list" => Method::ResourcesList,
            "resources/templates/list" => Method::TemplatesList,
            "resources/read" => Method::ResourcesRead,
            _ => return None,
        })
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Method::Discover => "server/discover",
            Method::ToolsList => "tools/list",
            Method::ToolsCall => "tools/call",
            Method::ResourcesList => "resources/list",
            Method::TemplatesList => "resources/templates/list",
            Method::ResourcesRead => "resources/read",
        }
    }

    /// The request names one tool or resource (`Mcp-Name` required).
    pub fn named(self) -> bool {
        matches!(self, Method::ToolsCall | Method::ResourcesRead)
    }
}

// ── faults ──────────────────────────────────────────────────────────────────────────────────────────────────────

/// A protocol refusal: the HTTP status, the JSON-RPC error and the audit `check` it is recorded under.
#[derive(Clone, Debug, PartialEq)]
pub struct Fault {
    pub status: u16,
    pub code: i64,
    pub message: String,
    pub data: Option<Value>,
    pub check: &'static str,
}

impl Fault {
    fn new(status: u16, code: i64, message: impl Into<String>, check: &'static str) -> Fault {
        Fault { status, code, message: message.into(), data: None, check }
    }

    /// 400 `HeaderMismatch`: a required header missing, malformed, or not what the body says.
    pub fn header(message: impl Into<String>) -> Fault {
        Fault::new(400, HEADER_MISMATCH, message, "mcp-header")
    }

    /// 400 `UnsupportedProtocolVersionError` (O8).
    pub fn version(requested: &str) -> Fault {
        Fault { data: Some(json!({"supported": [PROTOCOL], "requested": requested})), ..Fault::new(400, UNSUPPORTED_VERSION, "Unsupported protocol version", "mcp-version") }
    }

    /// 404 -32601: a method these servers do not implement.
    pub fn method(method: &str) -> Fault {
        Fault::new(404, METHOD_NOT_FOUND, format!("Method not found: {}", printable(method, 64)), "mcp-method")
    }

    /// -32602 with `status` (400 for a malformed request, 200 for an unknown name or state).
    pub fn params(status: u16, message: impl Into<String>) -> Fault {
        Fault::new(status, INVALID_PARAMS, message, "mcp-params")
    }

    /// 400 -32600: not a single JSON-RPC request.
    pub fn request(message: impl Into<String>) -> Fault {
        Fault::new(400, INVALID_REQUEST, message, "mcp-request")
    }

    /// 400 -32700: not JSON.
    pub fn parse() -> Fault {
        Fault::new(400, PARSE_ERROR, "The request body is not JSON.", "mcp-request")
    }

    /// 413: a body over `BODY_MAX`.
    pub fn too_large() -> Fault {
        Fault::new(413, INVALID_REQUEST, "The request body is larger than 64 KiB.", "too-large")
    }

    /// 403: an `Origin` that is not the endpoint's own (DNS rebinding).
    pub fn origin() -> Fault {
        Fault::new(403, INVALID_REQUEST, "Requests from that origin are not accepted.", "origin")
    }

    /// 405: GET, DELETE or anything but POST.
    pub fn http_method() -> Fault {
        Fault::new(405, INVALID_REQUEST, "This MCP endpoint takes POST only.", "mcp-method")
    }

    /// The JSON-RPC error answer (`id` null when the request's could not be read).
    pub fn reply(&self, id: Option<&Value>) -> Reply {
        let mut error = json!({"code": self.code, "message": self.message});
        if let Some(d) = &self.data {
            error["data"] = d.clone();
        }
        let mut body = json!({"jsonrpc": "2.0", "error": error});
        if let Some(id) = id {
            body["id"] = id.clone();
        }
        let mut r = Reply::json(self.status, body);
        if self.status == 405 {
            r.headers.push(("Allow", "POST".into()));
        }
        r
    }
}

/// At most `max` characters of `s`, control characters dropped (for messages that echo a header).
fn printable(s: &str, max: usize) -> String {
    s.chars().filter(|c| !c.is_control()).take(max).collect()
}

// ── 8.1 and 8.2 step 2: the request line and headers ────────────────────────────────────────────────────────────

/// What the MCP pipeline reads of a request before its body, as sent.
#[derive(Clone, Debug, Default)]
pub struct Head {
    /// The HTTP method.
    pub http: String,
    pub path: String,
    pub authorization: Option<String>,
    pub dpop: Option<String>,
    /// `MCP-Protocol-Version`.
    pub protocol: Option<String>,
    /// `Mcp-Method`.
    pub method: Option<String>,
    /// `Mcp-Name`, as sent (possibly the base64 sentinel).
    pub name: Option<String>,
    pub origin: Option<String>,
}

impl Head {
    /// The headers of a request (any case), as the listeners read them.
    pub fn of(http: &str, path: &str, header: &dyn Fn(&str) -> Option<String>) -> Head {
        Head {
            http: http.to_string(),
            path: path.to_string(),
            authorization: header("authorization"),
            dpop: header("dpop"),
            protocol: header("mcp-protocol-version"),
            method: header("mcp-method"),
            name: header("mcp-name"),
            origin: header("origin"),
        }
    }
}

/// What the headers ask for: the method and, for `tools/call` and `resources/read`, the decoded name.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Want {
    pub method: Method,
    pub name: Option<String>,
}

/// RFC 9110 field value characters: visible ASCII, space and tab.
fn header_safe(s: &str) -> bool {
    s.bytes().all(|b| (0x20..=0x7e).contains(&b) || b == b'\t')
}

/// Streamable HTTP "Value Encoding": `=?base64?<standard base64 of UTF-8>?=`, else the value as sent.
pub fn decode_name(v: &str) -> Option<String> {
    if !header_safe(v) {
        return None;
    }
    match v.strip_prefix("=?base64?").and_then(|r| r.strip_suffix("?=")) {
        Some(b) => {
            let body = b.trim_end_matches('=');
            let ok = b.len() % 4 == 0 && b.len() - body.len() <= 2 && body.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'+' || c == b'/');
            if !ok {
                return None;
            }
            String::from_utf8(b64_decode_lenient(body)).ok()
        }
        None => Some(v.to_string()),
    }
}

/// The org of an MCP endpoint path `/api/orgs/<org>/mcp` (M on the front door, CM on a connector), any method:
/// the endpoint answers anything but POST with 405.
pub fn endpoint_org(path: &str) -> Option<&str> {
    let org = crate::api_resource::org_of(path)?;
    (path.strip_prefix("/api/orgs/")?.strip_prefix(org)? == "/mcp").then_some(org)
}

/// The origin of an absolute `http` or `https` URL (an `Origin` header, or the endpoint's resource URL): the scheme
/// and host lowercased and the effective port (443 for `https`, 80 for `http` when none is given). None for anything
/// else (`null`, another scheme, userinfo, an empty host or a bad port).
pub fn origin_parts(url: &str) -> Option<(String, String, u16)> {
    let (scheme, rest) = url.trim().split_once("://")?;
    let scheme = scheme.to_ascii_lowercase();
    let default = match scheme.as_str() {
        "https" => 443,
        "http" => 80,
        _ => return None,
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    if authority.contains('@') {
        return None;
    }
    let (host, port) = match authority.strip_prefix('[') {
        Some(v6) => {
            let (h, after) = v6.split_once(']')?;
            let port = match after {
                "" => None,
                p => Some(p.strip_prefix(':')?),
            };
            (format!("[{}]", h.to_ascii_lowercase()), port)
        }
        None => match authority.rsplit_once(':') {
            Some((h, p)) => (h.to_ascii_lowercase(), Some(p)),
            None => (authority.to_ascii_lowercase(), None),
        },
    };
    if host.is_empty() || host == "[]" {
        return None;
    }
    let port = match port {
        None => default,
        Some(p) if !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()) => p.parse::<u16>().ok()?,
        Some(_) => return None,
    };
    Some((scheme, host, port))
}

/// Two URLs have the same origin (scheme, host and effective port).
pub fn same_origin(a: &str, b: &str) -> bool {
    matches!((origin_parts(a), origin_parts(b)), (Some(x), Some(y)) if x == y)
}

/// 8.1 and 8.2 step 2 in order: POST only (405), an `Origin` whose scheme, host or effective port differs from the
/// endpoint `own` (its resource URL), or that does not parse, 403; `MCP-Protocol-Version` present (-32020) and
/// 2026-07-28 (-32022), `Mcp-Method` present and served (-32601 with 404), and `Mcp-Name` present and well formed
/// where the method names something (-32020).
pub fn check_head(head: &Head, own: &str) -> Result<Want, Fault> {
    if head.http != "POST" {
        return Err(Fault::http_method());
    }
    if let Some(o) = head.origin.as_deref() {
        if !same_origin(o, own) {
            return Err(Fault::origin());
        }
    }
    let version = head.protocol.as_deref().map(str::trim).ok_or_else(|| Fault::header("The MCP-Protocol-Version header is missing."))?;
    if !header_safe(version) {
        return Err(Fault::header("The MCP-Protocol-Version header is malformed."));
    }
    if version != PROTOCOL {
        return Err(Fault::version(version));
    }
    let m = head.method.as_deref().map(str::trim).ok_or_else(|| Fault::header("The Mcp-Method header is missing."))?;
    if m.is_empty() || !header_safe(m) {
        return Err(Fault::header("The Mcp-Method header is malformed."));
    }
    let method = Method::of(m).ok_or_else(|| Fault::method(m))?;
    let name = if method.named() {
        let raw = head.name.as_deref().ok_or_else(|| Fault::header("The Mcp-Name header is missing."))?;
        let n = decode_name(raw.trim()).filter(|n| !n.is_empty()).ok_or_else(|| Fault::header("The Mcp-Name header is malformed."))?;
        Some(n)
    } else {
        None
    };
    Ok(Want { method, name })
}

// ── 8.2 step 5: the body ────────────────────────────────────────────────────────────────────────────────────────

/// One JSON-RPC request whose body matches its headers.
#[derive(Clone, Debug, PartialEq)]
pub struct Rpc {
    pub id: Value,
    pub method: Method,
    /// The tool name or resource URI (equal to `Mcp-Name`).
    pub name: Option<String>,
    /// `tools/call` `arguments` (empty when absent).
    pub arguments: Map<String, Value>,
    /// `_meta` `clientCapabilities` of this request.
    pub caps: Value,
    /// MRTR `requestState` echoed by a retry.
    pub state: Option<String>,
    /// A list method's `cursor`.
    pub cursor: Option<String>,
}

/// 8.2 step 5: the body (at most `BODY_MAX` bytes, as read) is one JSON-RPC request with an id, the method of
/// `Mcp-Method`, `params._meta` with the protocol version of the header and the client capabilities, and
/// `params.name` (or `params.uri`) equal to `Mcp-Name`. Err carries the request id once it could be read.
pub fn parse_body(raw: Result<&[u8], &'static str>, want: &Want) -> Result<Rpc, (Fault, Option<Value>)> {
    let raw = match raw {
        Ok(b) => b,
        Err("too-large") => return Err((Fault::too_large(), None)),
        Err(_) => return Err((Fault::request("The request body could not be read."), None)),
    };
    let v: Value = serde_json::from_slice(raw).map_err(|_| (Fault::parse(), None))?;
    let o = v.as_object().ok_or_else(|| (Fault::request("The body must be one JSON-RPC request object."), None))?;
    if o.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return Err((Fault::request("jsonrpc must be \"2.0\"."), None));
    }
    let id = match o.get("id") {
        None => return Err((Fault::request("This server takes requests only, not notifications."), None)),
        Some(id @ Value::String(_)) => id.clone(),
        Some(id @ Value::Number(n)) if n.is_i64() || n.is_u64() => id.clone(),
        Some(_) => return Err((Fault::request("The request id must be a string or an integer."), None)),
    };
    let fail = |f: Fault| (f, Some(id.clone()));
    let method = o.get("method").and_then(Value::as_str).ok_or_else(|| fail(Fault::request("The request has no method.")))?;
    if method != want.method.as_str() {
        return Err(fail(Fault::header("The Mcp-Method header does not match the body's method.")));
    }
    let params = match o.get("params") {
        Some(Value::Object(p)) => p.clone(),
        None => Map::new(),
        Some(_) => return Err(fail(Fault::params(400, "params must be an object."))),
    };
    let meta = params.get("_meta").and_then(Value::as_object).ok_or_else(|| fail(Fault::params(400, "params._meta is required.")))?;
    let version = meta.get(META_VERSION).and_then(Value::as_str).ok_or_else(|| fail(Fault::params(400, "params._meta must carry the protocol version.")))?;
    if version != PROTOCOL {
        return Err(fail(Fault::header("The MCP-Protocol-Version header does not match the body's protocol version.")));
    }
    let caps = meta.get(META_CAPS).filter(|c| c.is_object()).cloned().ok_or_else(|| fail(Fault::params(400, "params._meta must carry the client capabilities.")))?;
    let name = match want.method {
        Method::ToolsCall => Some(params.get("name").and_then(Value::as_str).unwrap_or_default().to_string()),
        Method::ResourcesRead => Some(params.get("uri").and_then(Value::as_str).unwrap_or_default().to_string()),
        _ => None,
    };
    if name != want.name {
        return Err(fail(Fault::header("The Mcp-Name header does not match the body.")));
    }
    let arguments = match params.get("arguments") {
        None | Some(Value::Null) => Map::new(),
        Some(Value::Object(a)) => a.clone(),
        Some(_) => return Err(fail(Fault::params(400, "arguments must be an object."))),
    };
    let text = |k: &str| -> Result<Option<String>, (Fault, Option<Value>)> {
        match params.get(k) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::String(s)) => Ok(Some(s.clone())),
            Some(_) => Err(fail(Fault::params(400, format!("{k} must be a string.")))),
        }
    };
    let state = text("requestState")?;
    let cursor = text("cursor")?;
    Ok(Rpc { id, method: want.method, name, arguments, caps, state, cursor })
}

// ── results ─────────────────────────────────────────────────────────────────────────────────────────────────────

/// `io.modelcontextprotocol/serverInfo` of `server`.
fn server_meta(server: &str) -> Value {
    json!({META_SERVER: {"name": server, "version": env!("CARGO_PKG_VERSION")}})
}

/// The JSON-RPC result answer: `resultType` `complete` unless the result says otherwise, `serverInfo` in `_meta`.
pub fn ok(id: &Value, mut result: Value, server: &str) -> Reply {
    if let Some(o) = result.as_object_mut() {
        o.entry("resultType").or_insert_with(|| json!("complete"));
        o.insert("_meta".into(), server_meta(server));
    }
    Reply::json(200, json!({"jsonrpc": "2.0", "id": id, "result": result}))
}

/// `server/discover`: the one version, tools and resources, the instructions (8.1).
pub fn discover(instructions: &str) -> Value {
    json!({"supportedVersions": [PROTOCOL], "capabilities": {"tools": {}, "resources": {}}, "instructions": instructions,
           "ttlMs": LIST_TTL_MS, "cacheScope": "private"})
}

/// A list result: `key` the items, with `ttlMs` and `cacheScope` `private` (the list depends on the token).
pub fn listing(key: &str, items: Vec<Value>, next: Option<String>) -> Value {
    let mut v = json!({key: items, "ttlMs": LIST_TTL_MS, "cacheScope": "private"});
    if let Some(n) = next {
        v["nextCursor"] = json!(n);
    }
    v
}

/// One `tools/list` entry (8.3): read tools are read-only and closed-world; write tools are additive, not
/// idempotent and closed-world (hints only; the server enforces).
pub fn tool_entry(name: &str, title: &str, description: &str, write: bool, input: Value, output: Value) -> Value {
    let annotations = if write {
        json!({"title": title, "readOnlyHint": false, "destructiveHint": false, "idempotentHint": false, "openWorldHint": false})
    } else {
        json!({"title": title, "readOnlyHint": true, "openWorldHint": false})
    };
    json!({"name": name, "title": title, "description": description, "inputSchema": input, "outputSchema": output, "annotations": annotations})
}

/// Revision 5 13.1 `lucid_mcp_requests_total`: one decided request at `server` (`console` or `connector`), `kind`
/// `read` for a tool call or resource read (`write` when `write`, the named tool posts), `list` for discovery, the
/// lists and a method these servers do not answer; `result` `ok` for a JSON-RPC result that is not a tool error,
/// `refused` for anything else.
pub fn count(org: &str, server: &str, method: Option<Method>, write: bool, status: u16, body: &Value) {
    let kind = match method {
        Some(Method::ToolsCall) if write => "write",
        Some(m) if m.named() => "read",
        _ => "list",
    };
    let ok = status == 200 && body.get("result").is_some_and(|r| r.get("isError") != Some(&Value::Bool(true)));
    crate::api_catalog::counters::mcp_request(org, server, kind, if ok { "ok" } else { "refused" });
}

/// A tool error result (8.5): the sentence, never a hint of what exists.
pub fn tool_error(sentence: &str) -> Value {
    json!({"content": [{"type": "text", "text": sentence}], "isError": true})
}

/// A tool result: `structured` as `structuredContent` and, for the model, the same JSON as one fenced text block
/// (`label`, `source`). The list at `list` is cut at an item boundary to keep the result under `RESULT_MAX`, with
/// `"truncated": true` added to `structuredContent`.
pub fn tool_result(mut structured: Value, list: Option<&str>, label: &str, source: &str) -> Value {
    let build = |s: &Value| json!({"content": [{"type": "text", "text": crate::prompt_fence::fenced(label, &s.to_string(), Some(source), false)}], "structuredContent": s});
    let mut out = build(&structured);
    if serde_json::to_vec(&out).map_or(0, |b| b.len()) <= RESULT_MAX {
        return out;
    }
    let Some(key) = list else { return tool_error("The result is larger than 1 MiB; ask for less.") };
    let Some(items) = structured.get(key).and_then(Value::as_array).cloned() else { return tool_error("The result is larger than 1 MiB; ask for less.") };
    structured[key] = json!([]);
    structured["truncated"] = json!(true);
    let base = serde_json::to_vec(&build(&structured)).map_or(RESULT_MAX, |b| b.len());
    // the text repeats the JSON (escaped once more), so each item costs about three times its length
    let mut budget = RESULT_MAX.saturating_sub(base);
    let mut keep = 0usize;
    for it in &items {
        let cost = it.to_string().len() * 3 + 8;
        if cost > budget {
            break;
        }
        budget -= cost;
        keep += 1;
    }
    loop {
        structured[key] = json!(items[..keep]);
        out = build(&structured);
        if keep == 0 || serde_json::to_vec(&out).map_or(0, |b| b.len()) <= RESULT_MAX {
            return out;
        }
        keep -= 1;
    }
}

/// 8.4: `input_required`, with the approval elicitation when the client can show one.
pub fn input_required(request: Option<Value>, state: String) -> Value {
    let mut v = json!({"resultType": "input_required", "requestState": state});
    if let Some(r) = request {
        v["inputRequests"] = json!({APPROVAL_INPUT: r});
    }
    v
}

/// 8.4: the approval elicitation the request's capabilities allow: `url` mode with `elicitation.url`, `form` mode
/// (an empty object schema) with `elicitation` (an empty object means form), none without (MRTR server rule 7).
pub fn approval_request(caps: &Value, url: &str) -> Option<Value> {
    let e = caps.get("elicitation").filter(|e| e.is_object())?;
    if e.get("url").is_some_and(Value::is_object) {
        return Some(json!({"method": "elicitation/create", "params": {"mode": "url", "message": APPROVAL_MESSAGE, "url": url}}));
    }
    let form = e.get("form").is_some_and(Value::is_object) || e.as_object().is_some_and(|o| o.is_empty());
    form.then(|| json!({"method": "elicitation/create", "params": {"mode": "form", "message": APPROVAL_MESSAGE, "requestedSchema": {"type": "object", "properties": {}}}}))
}

/// Standard base64 with padding (`BlobResourceContents.blob`).
pub fn b64(data: &[u8]) -> String {
    let mut s = b64u(data).replace('-', "+").replace('_', "/");
    while s.len() % 4 != 0 {
        s.push('=');
    }
    s
}

// ── 8.4: requestState ───────────────────────────────────────────────────────────────────────────────────────────

/// What a sealed `requestState` binds (MRTR server requirements 4 and 5).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct State {
    /// The approval id (32 hex).
    pub approval: String,
    pub client: String,
    /// The token's `sub` (the person of a delegated token, else the client).
    pub sub: String,
    pub tool: String,
    /// Hex SHA-256 of the arguments' canonical JSON (`args_sha256`).
    pub args_sha256: String,
    /// Seconds.
    pub exp: i64,
}

impl State {
    /// Canonical JSON (keys sorted).
    pub fn canonical(&self) -> String {
        canonical(&json!({"v": 1, "approval": self.approval, "client": self.client, "sub": self.sub, "tool": self.tool, "args_sha256": self.args_sha256, "exp": self.exp}))
    }

    /// The state still applies to this retry: same client, `sub`, tool and arguments, before `exp`.
    pub fn fits(&self, client: &str, sub: &str, tool: &str, args_sha256: &str, now_s: i64) -> bool {
        self.client == client && self.sub == sub && self.tool == tool && self.args_sha256 == args_sha256 && now_s < self.exp
    }
}

/// JSON with every object's keys sorted by code point, no spaces.
pub fn canonical(v: &Value) -> String {
    fn sorted(v: &Value) -> Value {
        match v {
            Value::Object(o) => {
                let mut keys: Vec<&String> = o.keys().collect();
                keys.sort();
                let mut m = Map::new();
                for k in keys {
                    m.insert(k.clone(), sorted(&o[k]));
                }
                Value::Object(m)
            }
            Value::Array(a) => Value::Array(a.iter().map(sorted).collect()),
            x => x.clone(),
        }
    }
    sorted(v).to_string()
}

/// `args_sha256`: hex SHA-256 of the arguments' canonical JSON.
pub fn args_sha256(args: &Map<String, Value>) -> String {
    hex(&sha256(canonical(&Value::Object(args.clone())).as_bytes()))
}

/// b64u(nonce || AES-256-GCM(canonical state) || tag) under `key`, AAD `STATE_AAD`, with the given nonce.
pub fn seal_state_with(key: &SecretKey, nonce: [u8; NONCE_LEN], s: &State) -> Option<String> {
    let k = aead::LessSafeKey::new(aead::UnboundKey::new(&aead::AES_256_GCM, key.bytes()).ok()?);
    let mut buf = s.canonical().into_bytes();
    let tag = k.seal_in_place_separate_tag(aead::Nonce::assume_unique_for_key(nonce), aead::Aad::from(STATE_AAD), &mut buf).ok()?;
    let mut out = nonce.to_vec();
    out.extend_from_slice(&buf);
    out.extend_from_slice(tag.as_ref());
    Some(b64u(&out))
}

/// `seal_state_with` under a random nonce.
pub fn seal_state(key: &SecretKey, s: &State) -> Option<String> {
    let mut nonce = [0u8; NONCE_LEN];
    aws_lc_rs::rand::fill(&mut nonce).ok()?;
    seal_state_with(key, nonce, s)
}

/// The state a `requestState` seals under `key`, or None when it does not authenticate or is not a v1 state
/// (treated as attacker-controlled input, MRTR server requirement 4).
pub fn open_state(key: &SecretKey, text: &str) -> Option<State> {
    if text.len() > 4096 {
        return None;
    }
    let raw = unb64u(text)?;
    let plain = crate::connector_seal::gcm_open(key, STATE_AAD, &raw)?;
    let v: Value = serde_json::from_slice(&plain).ok()?;
    let o = v.as_object()?;
    if o.len() != 7 || o.get("v").and_then(Value::as_i64) != Some(1) {
        return None;
    }
    let s = |k: &str| o.get(k).and_then(Value::as_str).map(str::to_string);
    Some(State { approval: s("approval")?, client: s("client")?, sub: s("sub")?, tool: s("tool")?, args_sha256: s("args_sha256")?, exp: o.get("exp").and_then(Value::as_i64)? })
}

// ── tool arguments ──────────────────────────────────────────────────────────────────────────────────────────────

/// A tool's argument check failed: the sentence for the tool error.
pub type ArgError = String;

/// The arguments hold only `allowed` keys.
pub fn only(args: &Map<String, Value>, allowed: &[&str]) -> Result<(), ArgError> {
    match args.keys().find(|k| !allowed.contains(&k.as_str())) {
        Some(k) => Err(format!("{} is not an argument of this tool.", printable(k, 64))),
        None => Ok(()),
    }
}

/// An optional string argument of 1 to `max` characters.
pub fn opt_str(args: &Map<String, Value>, k: &str, max: usize) -> Result<Option<String>, ArgError> {
    match args.get(k) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) if (1..=max).contains(&s.chars().count()) => Ok(Some(s.clone())),
        Some(_) => Err(format!("{k} must be a string of 1 to {max} characters.")),
    }
}

/// A required string argument of 1 to `max` characters.
pub fn req_str(args: &Map<String, Value>, k: &str, max: usize) -> Result<String, ArgError> {
    opt_str(args, k, max)?.ok_or_else(|| format!("{k} is required."))
}

/// An optional integer argument from `min` to `max`.
pub fn opt_int(args: &Map<String, Value>, k: &str, min: i64, max: i64) -> Result<Option<i64>, ArgError> {
    match args.get(k) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => v.as_i64().filter(|n| (min..=max).contains(n)).map(Some).ok_or_else(|| format!("{k} must be an integer from {min} to {max}.")),
    }
}

/// An optional cursor: a message id (string) or a time in ms (integer), as the route's query value.
pub fn opt_cursor(args: &Map<String, Value>, k: &str) -> Result<Option<String>, ArgError> {
    match args.get(k) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) if (1..=128).contains(&s.len()) => Ok(Some(s.clone())),
        Some(v) if v.as_i64().is_some() => Ok(v.as_i64().map(|n| n.to_string())),
        Some(_) => Err(format!("{k} must be a message id or a time in ms.")),
    }
}

/// `application/x-www-form-urlencoded` of one value (RFC 3986 unreserved kept).
pub fn form_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// A query string of the pairs present.
pub fn query_of(pairs: &[(&str, Option<String>)]) -> String {
    pairs.iter().filter_map(|(k, v)| v.as_ref().map(|v| format!("{k}={}", form_escape(v)))).collect::<Vec<_>>().join("&")
}

/// An input schema of `properties` with `required`, nothing else allowed.
pub fn object_schema(properties: Value, required: &[&str]) -> Value {
    json!({"type": "object", "properties": properties, "required": required, "additionalProperties": false})
}

#[cfg(test)]
mod tests {
    use super::*;

    fn head(method: Option<&str>, name: Option<&str>) -> Head {
        Head {
            http: "POST".into(),
            path: "/api/orgs/acme/mcp".into(),
            protocol: Some(PROTOCOL.into()),
            method: method.map(str::to_string),
            name: name.map(str::to_string),
            ..Head::default()
        }
    }

    fn body(method: &str, params: Value) -> Vec<u8> {
        json!({"jsonrpc": "2.0", "id": 7, "method": method, "params": params}).to_string().into_bytes()
    }

    fn meta() -> Value {
        json!({META_VERSION: PROTOCOL, META_CAPS: {}, META_CLIENT: {"name": "test", "version": "1"}})
    }

    const OWN: &str = "https://console.acme.test:9443";

    /// r5 13.1: `count` labels a request by kind (read, write, list) and result (ok, refused).
    #[test]
    fn requests_are_counted_by_kind_and_result() {
        use crate::api_catalog::counters;
        let org = "mcp-count-test";
        let id = json!(1);
        let done = ok(&id, json!({"content": []}), "s");
        count(org, "connector", Some(Method::ToolsCall), true, done.status, &done.body);
        count(org, "connector", Some(Method::ToolsCall), false, 200, &ok(&id, tool_error("no"), "s").body);
        count(org, "connector", Some(Method::ResourcesRead), true, done.status, &done.body);
        count(org, "console", Some(Method::ToolsList), false, done.status, &done.body);
        count(org, "console", None, false, 404, &Fault::method("x").reply(Some(&id)).body);
        let got = |labels: [&str; 3]| {
            counters::rows(Some(org), 0).into_iter().find(|r| r.prom == "lucid_mcp_requests_total" && r.labels.iter().map(|(_, v)| v.as_str()).eq(labels)).map(|r| r.value)
        };
        assert_eq!(got(["connector", "write", "ok"]), Some(1.0));
        assert_eq!(got(["connector", "read", "refused"]), Some(1.0), "a tool error is refused");
        assert_eq!(got(["connector", "read", "ok"]), Some(1.0), "a resource read never writes");
        assert_eq!(got(["console", "list", "ok"]), Some(1.0));
        assert_eq!(got(["console", "list", "refused"]), Some(1.0));
    }

    #[test]
    fn headers_are_checked_before_anything_else() {
        let want = check_head(&head(Some("tools/call"), Some("lucid_health")), OWN).unwrap();
        assert_eq!(want, Want { method: Method::ToolsCall, name: Some("lucid_health".into()) });
        assert_eq!(check_head(&head(None, None), OWN).unwrap_err().code, HEADER_MISMATCH);
        assert_eq!(check_head(&head(Some("tools/call"), None), OWN).unwrap_err().code, HEADER_MISMATCH, "Mcp-Name is required for tools/call");
        assert_eq!(check_head(&head(Some("tools/list"), None), OWN).unwrap().method, Method::ToolsList);
        let mut h = head(Some("tools/list"), None);
        h.protocol = Some("2025-11-25".into());
        let f = check_head(&h, OWN).unwrap_err();
        assert_eq!((f.status, f.code, f.data.clone()), (400, UNSUPPORTED_VERSION, Some(json!({"supported": [PROTOCOL], "requested": "2025-11-25"}))));
        h.protocol = None;
        assert_eq!(check_head(&h, OWN).unwrap_err().code, HEADER_MISMATCH);
        let f = check_head(&head(Some("subscriptions/listen"), None), OWN).unwrap_err();
        assert_eq!((f.status, f.code), (404, METHOD_NOT_FOUND));
        let mut get = head(Some("tools/list"), None);
        get.http = "GET".into();
        let f = check_head(&get, OWN).unwrap_err();
        assert_eq!(f.status, 405);
        assert!(f.reply(None).headers.iter().any(|(k, v)| *k == "Allow" && v == "POST"));
        let mut o = head(Some("tools/list"), None);
        o.origin = Some("https://evil.example".into());
        assert_eq!(check_head(&o, OWN).unwrap_err().status, 403);
        o.origin = Some("HTTPS://Console.Acme.Test:9443".into());
        assert!(check_head(&o, OWN).is_ok(), "the endpoint's own origin, any case");
    }

    /// Review W5a 4: origins compare by scheme, lowercase host and effective port, both sides parsed.
    #[test]
    fn origins_compare_scheme_host_and_effective_port() {
        assert!(same_origin("https://x.example:443", "https://x.example"));
        assert!(same_origin("HTTPS://X.Example", "https://x.example/api/orgs/acme/mcp"));
        assert!(same_origin("http://x.example", "http://x.example:80"));
        assert!(same_origin("https://[::1]:8443", "https://[::1]:8443/api/orgs/acme/mcp"));
        assert!(!same_origin("http://x.example", "https://x.example"), "another scheme");
        assert!(!same_origin("https://x.example:444", "https://x.example"), "another port");
        assert!(!same_origin("https://x.example.evil", "https://x.example"));
        assert!(!same_origin("null", "https://x.example"));
        assert!(!same_origin("https://a@x.example", "https://x.example"), "userinfo");
        assert!(!same_origin("https://x.example:", "https://x.example"), "an empty port");
        assert!(!same_origin("https://x.example:99999", "https://x.example:99999"), "no such port");
        assert!(!same_origin("https://x.example", ""), "an endpoint without a resource matches nothing");
        let own = "https://connector.acme.test/api/orgs/acme/mcp";
        let mut h = head(Some("tools/list"), None);
        h.origin = Some("https://connector.acme.test:443".into());
        assert!(check_head(&h, own).is_ok());
        h.origin = Some("https://connector.acme.test:8443".into());
        assert_eq!(check_head(&h, own).unwrap_err().status, 403);
    }

    #[test]
    fn the_base64_sentinel_is_decoded() {
        assert_eq!(decode_name("=?base64?SGVsbG8sIOS4lueVjA==?="), Some("Hello, \u{4e16}\u{754c}".to_string()));
        assert_eq!(decode_name("plain_tool"), Some("plain_tool".to_string()));
        assert_eq!(decode_name("=?base64?***?="), None);
        assert_eq!(decode_name("a\u{7f}b"), None);
        let want = check_head(&head(Some("resources/read"), Some("=?base64?bHVjaWQ6Ly9hY21lL3RlbGVtZXRyeS9jYXRhbG9n?=")), OWN).unwrap();
        assert_eq!(want.name.as_deref(), Some("lucid://acme/telemetry/catalog"));
    }

    #[test]
    fn the_body_must_match_the_headers() {
        let want = Want { method: Method::ToolsCall, name: Some("lucid_health".into()) };
        let good = body("tools/call", json!({"name": "lucid_health", "arguments": {}, "_meta": meta()}));
        let rpc = parse_body(Ok(&good), &want).unwrap();
        assert_eq!((rpc.id.clone(), rpc.name.as_deref(), rpc.caps.clone()), (json!(7), Some("lucid_health"), json!({})));
        let code = |b: &[u8]| parse_body(Ok(b), &want).unwrap_err().0;
        assert_eq!(code(&body("tools/call", json!({"name": "lucid_capacity", "_meta": meta()}))).code, HEADER_MISMATCH);
        assert_eq!(code(&body("tools/list", json!({"_meta": meta()}))).code, HEADER_MISMATCH);
        let mut m = meta();
        m[META_VERSION] = json!("2025-11-25");
        assert_eq!(code(&body("tools/call", json!({"name": "lucid_health", "_meta": m}))).code, HEADER_MISMATCH);
        let f = code(&body("tools/call", json!({"name": "lucid_health"})));
        assert_eq!((f.status, f.code), (400, INVALID_PARAMS), "_meta is required");
        let mut m = meta();
        m.as_object_mut().unwrap().remove(META_CAPS);
        assert_eq!(code(&body("tools/call", json!({"name": "lucid_health", "_meta": m}))).code, INVALID_PARAMS);
        assert_eq!(code(b"{not json").code, PARSE_ERROR);
        assert_eq!(code(br#"{"jsonrpc":"2.0","method":"tools/call","params":{}}"#).code, INVALID_REQUEST, "a notification");
        assert_eq!(code(br#"{"jsonrpc":"2.0","id":null,"method":"tools/call"}"#).code, INVALID_REQUEST);
        assert_eq!(parse_body(Err("too-large"), &want).unwrap_err().0.status, 413);
    }

    #[test]
    fn request_state_is_bound_and_tamper_evident() {
        let key = SecretKey::from_slice(&[7u8; 32]).unwrap();
        let s = State { approval: "a".repeat(32), client: "c_1".into(), sub: "ann@acme.test".into(), tool: "post_message".into(), args_sha256: "0".repeat(64), exp: 1000 };
        let sealed = seal_state(&key, &s).unwrap();
        let back = open_state(&key, &sealed).unwrap();
        assert_eq!(back, s);
        assert!(back.fits("c_1", "ann@acme.test", "post_message", &"0".repeat(64), 999));
        assert!(!back.fits("c_1", "ben@acme.test", "post_message", &"0".repeat(64), 999), "another person");
        assert!(!back.fits("c_2", "ann@acme.test", "post_message", &"0".repeat(64), 999), "another client");
        assert!(!back.fits("c_1", "ann@acme.test", "post_message", &"1".repeat(64), 999), "other arguments");
        assert!(!back.fits("c_1", "ann@acme.test", "post_message", &"0".repeat(64), 1000), "expired");
        let mut raw = unb64u(&sealed).unwrap();
        raw[14] ^= 1;
        assert!(open_state(&key, &b64u(&raw)).is_none(), "a flipped bit");
        assert!(open_state(&SecretKey::from_slice(&[8u8; 32]).unwrap(), &sealed).is_none(), "another key");
        assert_eq!(seal_state_with(&key, [1; 12], &s), seal_state_with(&key, [1; 12], &s));
    }

    #[test]
    fn canonical_json_sorts_keys_at_every_depth() {
        assert_eq!(canonical(&json!({"b": 1, "a": {"d": [{"z": 1, "y": 2}], "c": null}})), r#"{"a":{"c":null,"d":[{"y":2,"z":1}]},"b":1}"#);
        let mut a = Map::new();
        a.insert("text".into(), json!("hi"));
        a.insert("conv".into(), json!("ch:ops"));
        let mut b = Map::new();
        b.insert("conv".into(), json!("ch:ops"));
        b.insert("text".into(), json!("hi"));
        assert_eq!(args_sha256(&a), args_sha256(&b));
    }

    #[test]
    fn elicitation_follows_the_declared_capabilities() {
        let url = "https://connector.acme.test:9445/api/orgs/acme/v1/content/approvals/ab/page";
        assert_eq!(approval_request(&json!({"elicitation": {"url": {}, "form": {}}}), url).unwrap()["params"]["mode"], "url");
        assert_eq!(approval_request(&json!({"elicitation": {}}), url).unwrap()["params"]["mode"], "form", "an empty object means form");
        assert_eq!(approval_request(&json!({"elicitation": {"form": {}}}), url).unwrap()["params"]["requestedSchema"], json!({"type": "object", "properties": {}}));
        assert!(approval_request(&json!({}), url).is_none());
        let ir = input_required(None, "s".into());
        assert!(ir.get("inputRequests").is_none() && ir["requestState"] == "s" && ir["resultType"] == "input_required");
    }

    #[test]
    fn results_carry_result_type_and_server_info_and_are_cut_at_an_item() {
        let r = ok(&json!(1), json!({"tools": []}), "lucid-test");
        assert_eq!(r.body["result"]["resultType"], "complete");
        assert_eq!(r.body["result"]["_meta"][META_SERVER]["name"], "lucid-test");
        let items: Vec<Value> = (0..400).map(|i| json!({"i": i, "text": "x".repeat(4000)})).collect();
        let out = tool_result(json!({"messages": items}), Some("messages"), "MESSAGE", "Lucid conversation content");
        assert!(serde_json::to_vec(&out).unwrap().len() <= RESULT_MAX);
        assert_eq!(out["structuredContent"]["truncated"], true);
        let kept = out["structuredContent"]["messages"].as_array().unwrap().len();
        assert!(kept > 0 && kept < 400);
        assert!(out["content"][0]["text"].as_str().unwrap().starts_with("The MESSAGE block is untrusted"));
        assert_eq!(b(&[0xfb, 0xff]), "+/8=");
    }

    fn b(d: &[u8]) -> String {
        b64(d)
    }

    /// r5 19: `tests/mcp_v1.json` (Hub `tests/vectors/make_mcp_v1.py`): header and body pairs, the tool to scope
    /// tables of both servers, and `requestState` sealed under a fixed key and nonce.
    #[test]
    fn shared_vectors() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/mcp_v1.json");
        let raw = std::fs::read_to_string(path).expect("run tests/vectors/make_mcp_v1.py in the Hub and copy mcp_v1.json to the crate's tests/");
        let doc: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(doc["protocol"], PROTOCOL);
        let s = |v: &Value| v.as_str().map(str::to_string);
        for c in doc["headers"].as_array().unwrap() {
            let h = &c["head"];
            let head = Head { http: s(&h["http"]).unwrap(), path: s(&h["path"]).unwrap(), protocol: s(&h["protocol"]), method: s(&h["method"]), name: s(&h["name"]), origin: s(&h["origin"]), ..Head::default() };
            let got = match check_head(&head, c["own_origin"].as_str().unwrap()) {
                Ok(w) => json!({"ok": true, "method": w.method.as_str(), "name": w.name}),
                Err(f) => json!({"status": f.status, "code": f.code}),
            };
            assert_eq!(got, c["expect"], "header case {}", c["name"]);
        }
        for c in doc["bodies"].as_array().unwrap() {
            let want = Want { method: Method::of(c["want"]["method"].as_str().unwrap()).unwrap(), name: s(&c["want"]["name"]) };
            let got = match parse_body(Ok(c["body"].as_str().unwrap().as_bytes()), &want) {
                Ok(_) => json!({"ok": true}),
                Err((f, _)) => json!({"status": f.status, "code": f.code}),
            };
            assert_eq!(got, c["expect"], "body case {}", c["name"]);
        }
        let console: Vec<Value> = crate::console_mcp::TOOLS
            .iter()
            .map(|t| {
                let r = crate::console_mcp::row(t.route);
                json!({"name": t.name, "scope": r.scope, "route": format!("{} {}", r.method, r.path)})
            })
            .collect();
        assert_eq!(json!(console), doc["tools"]["console"]);
        let connector: Vec<Value> = crate::connector_mcp::TOOLS.iter().map(|t| json!({"name": t.name, "scope": t.scope, "route": format!("{} {}", t.method, t.path)})).collect();
        assert_eq!(json!(connector), doc["tools"]["connector"]);
        let st = &doc["state"];
        let unhex = |v: &Value| (0..v.as_str().unwrap().len()).step_by(2).map(|i| u8::from_str_radix(&v.as_str().unwrap()[i..i + 2], 16).unwrap()).collect::<Vec<u8>>();
        let key = SecretKey::from_slice(&unhex(&st["key"])).unwrap();
        let mut nonce = [0u8; NONCE_LEN];
        nonce.copy_from_slice(&unhex(&st["nonce"]));
        let o = &st["state"];
        let state = State {
            approval: s(&o["approval"]).unwrap(),
            client: s(&o["client"]).unwrap(),
            sub: s(&o["sub"]).unwrap(),
            tool: s(&o["tool"]).unwrap(),
            args_sha256: s(&o["args_sha256"]).unwrap(),
            exp: o["exp"].as_i64().unwrap(),
        };
        assert_eq!(state.canonical(), st["canonical"].as_str().unwrap());
        assert_eq!(seal_state_with(&key, nonce, &state).as_deref(), st["sealed"].as_str());
        let back = open_state(&key, st["sealed"].as_str().unwrap()).expect("the vector opens");
        assert_eq!(back, state);
        assert!(open_state(&key, st["tampered"].as_str().unwrap()).is_none());
        for a in st["args"].as_array().unwrap() {
            assert_eq!(args_sha256(a["arguments"].as_object().unwrap()), a["args_sha256"].as_str().unwrap());
        }
        for c in st["checks"].as_array().unwrap() {
            let got = back.fits(c["client"].as_str().unwrap(), c["sub"].as_str().unwrap(), c["tool"].as_str().unwrap(), c["args_sha256"].as_str().unwrap(), c["now"].as_i64().unwrap());
            assert_eq!(got, c["fits"].as_bool().unwrap(), "state check {}", c["name"]);
        }
    }

    #[test]
    fn arguments_are_checked() {
        let a = json!({"conv": "ch:ops", "limit": 5, "before": 1700}).as_object().unwrap().clone();
        assert!(only(&a, &["conv", "limit", "before"]).is_ok());
        assert!(only(&a, &["conv"]).is_err());
        assert_eq!(req_str(&a, "conv", 128).unwrap(), "ch:ops");
        assert!(req_str(&a, "text", 10).is_err());
        assert_eq!(opt_int(&a, "limit", 1, 100).unwrap(), Some(5));
        assert!(opt_int(&a, "limit", 10, 100).is_err());
        assert_eq!(opt_cursor(&a, "before").unwrap().as_deref(), Some("1700"));
        assert_eq!(query_of(&[("q", Some("a b&c".into())), ("conv", None)]), "q=a%20b%26c");
    }
}
