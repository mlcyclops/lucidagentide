// Contract AI-1 sections 3.1, 4.1 and 5.2 for the AI gateway: the backends a card names and how the gateway calls
// them (no streaming in AI-1): Local Providers over the OpenAI-compatible chat API (vLLM, NIM, any Local Provider),
// OpenAI, Azure OpenAI (including Azure Government: the card's endpoint names the cloud), the Anthropic Messages API
// and AWS Bedrock's Converse API (including GovCloud) signed with AWS Signature Version 4. Org cards report their live
// load from the runtime's Prometheus `/metrics` (vLLM names: waiting requests, KV cache usage and the cache config),
// which gives `queue_ms` and `free_kv_bytes` (4.1). Keys come from the environment variables the gateway's config
// names, never from a card. One rustls client (the crate's AWS-LC provider) with the webpki roots plus an optional
// extra CA file for an internal backend.

use crate::ai_gateway_cards::Card;
use crate::codec::{hex, sha256_hex};
use aws_lc_rs::hmac;
use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper_rustls::HttpsConnector;
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::client::legacy::Client;
use hyper_util::rt::TokioExecutor;
use rustls::pki_types::CertificateDer;
use rustls::{ClientConfig, RootCertStore};
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;

/// A backend's secrets and deployment settings (from the gateway config's `backends[card_id]`).
#[derive(Clone, Debug, Default)]
pub struct Credential {
    pub api_key: String,
    pub azure_api_version: String,
    pub azure_deployment: String,
    pub aws_region: String,
    pub aws_access_key_id: String,
    pub aws_secret_access_key: String,
    pub aws_session_token: String,
    /// vLLM or NIM: the folder of the served weights (the benchmark's digest check).
    pub model_path: String,
}

impl Credential {
    /// `{"api_key_env", "azure_api_version", "azure_deployment", "aws_region", "aws_access_key_id_env",
    /// "aws_secret_access_key_env", "aws_session_token_env", "model_path"}`, every `_env` read from `env`.
    pub fn from_config(v: &Value, env: &dyn Fn(&str) -> Option<String>) -> Credential {
        let s = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or_default().to_string();
        let e = |k: &str| v.get(k).and_then(Value::as_str).and_then(|name| env(name)).unwrap_or_default();
        Credential {
            api_key: e("api_key_env"),
            azure_api_version: s("azure_api_version"),
            azure_deployment: s("azure_deployment"),
            aws_region: s("aws_region"),
            aws_access_key_id: e("aws_access_key_id_env"),
            aws_secret_access_key: e("aws_secret_access_key_env"),
            aws_session_token: e("aws_session_token_env"),
            model_path: s("model_path"),
        }
    }
}

/// One call: the system turn, the user turn and the output cap.
#[derive(Clone, Debug)]
pub struct Prompt {
    pub system: String,
    pub user: String,
    pub max_output: u64,
}

/// What came back; usage when the backend reported it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Completion {
    pub text: String,
    pub tokens_in: Option<u64>,
    pub tokens_out: Option<u64>,
}

/// An HTTP request ready to send.
#[derive(Clone, Debug)]
pub struct Outgoing {
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

fn trim(endpoint: &str) -> &str {
    endpoint.trim_end_matches('/')
}

/// `scheme://host[:port]` of a URL.
pub fn origin(url: &str) -> &str {
    let after = url.find("://").map(|i| i + 3).unwrap_or(0);
    match url[after..].find('/') {
        Some(i) => &url[..after + i],
        None => url,
    }
}

fn host_of(url: &str) -> &str {
    let o = origin(url);
    o.find("://").map(|i| &o[i + 3..]).unwrap_or(o)
}

/// RFC 3986 unreserved characters kept, everything else `%XX` (upper case), as SigV4 encodes.
pub fn uri_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn hmac256(key: &[u8], data: &[u8]) -> Vec<u8> {
    hmac::sign(&hmac::Key::new(hmac::HMAC_SHA256, key), data).as_ref().to_vec()
}

/// `YYYYMMDDTHHMMSSZ` of a UTC time in seconds.
pub fn amz_date(secs: i64) -> String {
    let (y, m, d) = crate::meet_json::civil(secs.div_euclid(86_400));
    let t = secs.rem_euclid(86_400);
    format!("{y:04}{m:02}{d:02}T{:02}{:02}{:02}Z", t / 3600, t / 60 % 60, t % 60)
}

/// AWS Signature Version 4: the `Authorization` value for a request whose path is already URI-encoded once (each
/// segment is encoded again for the canonical URI, as every service but S3 expects). `headers` are lower-case names
/// and are all signed; they must include `host` and `x-amz-date`.
#[allow(clippy::too_many_arguments)]
pub fn sigv4(method: &str, path: &str, query: &str, headers: &[(String, String)], body: &[u8], region: &str, service: &str, key_id: &str, secret: &str, date: &str) -> String {
    let canonical_uri = if path.is_empty() { "/".to_string() } else { path.split('/').map(uri_encode).collect::<Vec<_>>().join("/") };
    let mut hs: Vec<(String, String)> = headers.iter().map(|(k, v)| (k.to_lowercase(), v.trim().to_string())).collect();
    hs.sort();
    let canonical_headers: String = hs.iter().map(|(k, v)| format!("{k}:{v}\n")).collect();
    let signed: String = hs.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>().join(";");
    let request = format!("{method}\n{canonical_uri}\n{query}\n{canonical_headers}\n{signed}\n{}", sha256_hex(body));
    let day = &date[..8];
    let scope = format!("{day}/{region}/{service}/aws4_request");
    let to_sign = format!("AWS4-HMAC-SHA256\n{date}\n{scope}\n{}", sha256_hex(request.as_bytes()));
    let k = hmac256(format!("AWS4{secret}").as_bytes(), day.as_bytes());
    let k = hmac256(&k, region.as_bytes());
    let k = hmac256(&k, service.as_bytes());
    let k = hmac256(&k, b"aws4_request");
    let sig = hex(&hmac256(&k, to_sign.as_bytes()));
    format!("AWS4-HMAC-SHA256 Credential={key_id}/{scope}, SignedHeaders={signed}, Signature={sig}")
}

/// The region of a Bedrock endpoint (`bedrock-runtime.<region>.amazonaws.com`), else the configured one.
fn bedrock_region(card: &Card, cred: &Credential) -> String {
    if !cred.aws_region.is_empty() {
        return cred.aws_region.clone();
    }
    host_of(&card.endpoint).split('.').nth(1).unwrap_or("us-east-1").to_string()
}

fn chat_body(model: &str, p: &Prompt, max_key: &str) -> Vec<u8> {
    let mut v = json!({"model": model, "messages": [{"role": "system", "content": p.system}, {"role": "user", "content": p.user}], "temperature": 0, "stream": false});
    v[max_key] = json!(p.max_output);
    v.to_string().into_bytes()
}

/// The body a card's provider takes for a plain prompt (no tools).
fn plain_body(card: &Card, p: &Prompt) -> Vec<u8> {
    match card.provider.as_str() {
        "local" => chat_body(&card.model, p, "max_tokens"),
        "openai" | "azure" => chat_body(&card.model, p, "max_completion_tokens"),
        "anthropic" => json!({"model": card.model, "max_tokens": p.max_output, "temperature": 0, "system": p.system, "messages": [{"role": "user", "content": p.user}]}).to_string().into_bytes(),
        "amazon-bedrock" => json!({"messages": [{"role": "user", "content": [{"text": p.user}]}], "system": [{"text": p.system}], "inferenceConfig": {"maxTokens": p.max_output, "temperature": 0}}).to_string().into_bytes(),
        _ => Vec::new(),
    }
}

/// The request a card's backend takes for a prompt (`now` in seconds, for Bedrock's signature).
pub fn build(card: &Card, cred: &Credential, p: &Prompt, now: i64) -> Result<Outgoing, String> {
    build_with(card, cred, plain_body(card, p), now)
}

/// The request a card's backend takes for a body already in its provider's form (tool calling builds its own,
/// ai_gateway_tools.rs): the URL, the key or the AWS signature over that body.
pub fn build_with(card: &Card, cred: &Credential, body: Vec<u8>, now: i64) -> Result<Outgoing, String> {
    let json_ct = ("content-type".to_string(), "application/json".to_string());
    let bearer = |key: &str| ("authorization".to_string(), format!("Bearer {key}"));
    match card.provider.as_str() {
        "local" => {
            let mut headers = vec![json_ct];
            if !cred.api_key.is_empty() {
                headers.push(bearer(&cred.api_key));
            }
            Ok(Outgoing { url: format!("{}/chat/completions", trim(&card.endpoint)), headers, body })
        }
        "openai" => {
            if cred.api_key.is_empty() {
                return Err("no OpenAI key is set for this card".into());
            }
            Ok(Outgoing { url: format!("{}/chat/completions", trim(&card.endpoint)), headers: vec![json_ct, bearer(&cred.api_key)], body })
        }
        "azure" => {
            if cred.api_key.is_empty() {
                return Err("no Azure OpenAI key is set for this card".into());
            }
            let deployment = if cred.azure_deployment.is_empty() { &card.model } else { &cred.azure_deployment };
            let version = if cred.azure_api_version.is_empty() { "2024-10-21" } else { &cred.azure_api_version };
            Ok(Outgoing {
                url: format!("{}/openai/deployments/{}/chat/completions?api-version={}", trim(&card.endpoint), uri_encode(deployment), uri_encode(version)),
                headers: vec![json_ct, ("api-key".into(), cred.api_key.clone())],
                body,
            })
        }
        "anthropic" => {
            if cred.api_key.is_empty() {
                return Err("no Anthropic key is set for this card".into());
            }
            Ok(Outgoing { url: format!("{}/v1/messages", trim(&card.endpoint)), headers: vec![json_ct, ("x-api-key".into(), cred.api_key.clone()), ("anthropic-version".into(), "2023-06-01".into())], body })
        }
        "amazon-bedrock" => {
            let path = format!("/model/{}/converse", uri_encode(&card.model));
            let url = format!("{}{path}", trim(&card.endpoint));
            if !cred.api_key.is_empty() {
                // a Bedrock API key (bearer token)
                return Ok(Outgoing { url, headers: vec![json_ct, bearer(&cred.api_key)], body });
            }
            if cred.aws_access_key_id.is_empty() || cred.aws_secret_access_key.is_empty() {
                return Err("no AWS credentials are set for this card".into());
            }
            let date = amz_date(now);
            let mut headers = vec![json_ct, ("host".to_string(), host_of(&card.endpoint).to_string()), ("x-amz-date".to_string(), date.clone())];
            if !cred.aws_session_token.is_empty() {
                headers.push(("x-amz-security-token".into(), cred.aws_session_token.clone()));
            }
            let auth = sigv4("POST", &path, "", &headers, &body, &bedrock_region(card, cred), "bedrock", &cred.aws_access_key_id, &cred.aws_secret_access_key, &date);
            headers.retain(|(k, _)| k != "host");
            headers.push(("authorization".into(), auth));
            Ok(Outgoing { url, headers, body })
        }
        other => Err(format!("the gateway cannot call {other}")),
    }
}

/// The answer text and usage from a backend's reply body.
pub fn parse(provider: &str, body: &[u8]) -> Result<Completion, String> {
    let v: Value = serde_json::from_slice(body).map_err(|_| "the backend's answer is not JSON".to_string())?;
    let n = |x: &Value| x.as_u64();
    match provider {
        "anthropic" => {
            let text: String = v["content"].as_array().ok_or("the backend's answer has no content")?.iter().filter(|c| c["type"] == "text").filter_map(|c| c["text"].as_str()).collect();
            Ok(Completion { text, tokens_in: n(&v["usage"]["input_tokens"]), tokens_out: n(&v["usage"]["output_tokens"]) })
        }
        "amazon-bedrock" => {
            let text: String = v["output"]["message"]["content"].as_array().ok_or("the backend's answer has no content")?.iter().filter_map(|c| c["text"].as_str()).collect();
            Ok(Completion { text, tokens_in: n(&v["usage"]["inputTokens"]), tokens_out: n(&v["usage"]["outputTokens"]) })
        }
        _ => {
            let text = v["choices"][0]["message"]["content"].as_str().ok_or("the backend's answer has no message")?.to_string();
            Ok(Completion { text, tokens_in: n(&v["usage"]["prompt_tokens"]), tokens_out: n(&v["usage"]["completion_tokens"]) })
        }
    }
}

/// What a runtime's `/metrics` says (vLLM names).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Metrics {
    pub waiting: Option<u64>,
    pub running: Option<u64>,
    /// KV cache in use, 0 to 1.
    pub kv_usage: Option<f64>,
    pub kv_blocks: Option<u64>,
    pub block_size: Option<u64>,
}

fn label_value(labels: &str, name: &str) -> Option<String> {
    let at = labels.find(&format!("{name}=\""))? + name.len() + 2;
    let end = labels[at..].find('"')?;
    Some(labels[at..at + end].to_string())
}

/// Prometheus text: the sums of `vllm:num_requests_waiting` and `_running`, `vllm:gpu_cache_usage_perc` (or
/// `vllm:kv_cache_usage_perc`), and `num_gpu_blocks` and `block_size` of `vllm:cache_config_info`.
pub fn parse_metrics(text: &str) -> Metrics {
    let mut m = Metrics::default();
    for line in text.lines().filter(|l| !l.starts_with('#')) {
        let (head, value) = match line.rsplit_once(' ') {
            Some(x) => x,
            None => continue,
        };
        let name = head.split('{').next().unwrap_or_default();
        let labels = head.find('{').map(|i| &head[i..]).unwrap_or_default();
        let Ok(x) = value.trim().parse::<f64>() else { continue };
        match name {
            "vllm:num_requests_waiting" => m.waiting = Some(m.waiting.unwrap_or(0) + x as u64),
            "vllm:num_requests_running" => m.running = Some(m.running.unwrap_or(0) + x as u64),
            "vllm:gpu_cache_usage_perc" | "vllm:kv_cache_usage_perc" => m.kv_usage = Some(m.kv_usage.unwrap_or(0.0).max(x)),
            "vllm:cache_config_info" => {
                m.kv_blocks = label_value(labels, "num_gpu_blocks").and_then(|v| v.parse().ok());
                m.block_size = label_value(labels, "block_size").and_then(|v| v.parse().ok());
            }
            _ => {}
        }
    }
    m
}

impl Metrics {
    /// Free KV cache bytes: the unused share of `num_gpu_blocks * block_size` tokens times the card's bytes per
    /// token. None when the runtime does not report all of it (admission then says `unknown`).
    pub fn free_kv_bytes(&self, kv_per_token: Option<u64>) -> Option<u64> {
        let tokens = self.kv_blocks? * self.block_size?;
        let free = (tokens as f64 * (1.0 - self.kv_usage?.clamp(0.0, 1.0))).floor() as u64;
        Some(free.saturating_mul(kv_per_token?))
    }
}

/// The client every backend call uses.
#[derive(Clone)]
pub struct Backends {
    client: Client<HttpsConnector<HttpConnector>, Full<Bytes>>,
}

impl Backends {
    /// The webpki roots plus every certificate of `extra_ca` (a PEM file) for internal backends.
    pub fn new(extra_ca: Option<&str>) -> Result<Backends, String> {
        let mut roots = RootCertStore::empty();
        roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        if let Some(path) = extra_ca.filter(|p| !p.is_empty()) {
            let data = std::fs::read(path).map_err(|e| format!("cannot read the backend CA file {path}: {e}"))?;
            for (_, der) in crate::meet_x509::pem_blocks(&data, "CERTIFICATE") {
                roots.add(CertificateDer::from(der)).map_err(|e| format!("the backend CA file {path} does not read: {e}"))?;
            }
        }
        let cfg = ClientConfig::builder_with_provider(Arc::new(crate::server::provider()))
            .with_safe_default_protocol_versions()
            .map_err(|e| e.to_string())?
            .with_root_certificates(roots)
            .with_no_client_auth();
        let connector = hyper_rustls::HttpsConnectorBuilder::new().with_tls_config(cfg).https_only().enable_http1().build();
        Ok(Backends { client: Client::builder(TokioExecutor::new()).build(connector) })
    }

    /// One request, the whole reply read (at most 4 MiB), bounded by `timeout`.
    pub async fn send(&self, method: &str, o: &Outgoing, timeout: Duration) -> Result<(u16, Bytes), String> {
        let mut req = hyper::Request::builder().method(method).uri(&o.url);
        for (k, v) in &o.headers {
            req = req.header(k.as_str(), v.as_str());
        }
        let req = req.body(Full::new(Bytes::from(o.body.clone()))).map_err(|e| e.to_string())?;
        let work = async {
            let res = self.client.request(req).await.map_err(|e| format!("the backend cannot be reached ({e})"))?;
            let status = res.status().as_u16();
            let body = http_body_util::Limited::new(res.into_body(), 4 << 20).collect().await.map_err(|_| "the backend's answer is too large or broken".to_string())?.to_bytes();
            Ok::<_, String>((status, body))
        };
        tokio::time::timeout(timeout, work).await.map_err(|_| "the backend did not answer in time".to_string())?
    }

    /// One completion. Err holds no content (the backend's status at most).
    pub async fn complete(&self, card: &Card, cred: &Credential, p: &Prompt, timeout: Duration) -> Result<Completion, String> {
        let o = build(card, cred, p, crate::meet_json::now() as i64)?;
        let (status, body) = self.send("POST", &o, timeout).await?;
        if !(200..300).contains(&status) {
            return Err(format!("the backend answered {status}"));
        }
        parse(&card.provider, &body)
    }

    /// An org card's runtime metrics; Err when `/metrics` cannot be read (the card counts as down).
    pub async fn metrics(&self, card: &Card, cred: &Credential) -> Result<Metrics, String> {
        let mut headers = Vec::new();
        if !cred.api_key.is_empty() {
            headers.push(("authorization".to_string(), format!("Bearer {}", cred.api_key)));
        }
        let o = Outgoing { url: format!("{}/metrics", origin(&card.endpoint)), headers, body: Vec::new() };
        let (status, body) = self.send("GET", &o, Duration::from_secs(5)).await?;
        if status != 200 {
            return Err(format!("the runtime's metrics answered {status}"));
        }
        Ok(parse_metrics(&String::from_utf8_lossy(&body)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai_gateway_cards::{check_card, testcards::*};

    fn prompt() -> Prompt {
        Prompt { system: "sys".into(), user: "question".into(), max_output: 512 }
    }

    /// The AWS SigV4 test suite's `get-vanilla` case.
    #[test]
    fn sigv4_matches_the_aws_test_suite() {
        let headers = vec![("host".to_string(), "example.amazonaws.com".to_string()), ("x-amz-date".to_string(), "20150830T123600Z".to_string())];
        let auth = sigv4("GET", "/", "", &headers, b"", "us-east-1", "service", "AKIDEXAMPLE", "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", "20150830T123600Z");
        assert_eq!(auth, "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31");
        assert_eq!(amz_date(1440938160), "20150830T123600Z");
    }

    #[test]
    fn bedrock_requests_are_signed_with_the_model_id_encoded_twice_in_the_canonical_path() {
        let mut v = frontier_card("br", "amazon-bedrock", "https://bedrock-runtime.us-gov-west-1.amazonaws.com", &["public"]);
        v["exact_model_id"] = json!("anthropic.claude-3-5-sonnet-20240620-v1:0");
        let card = check_card(&v).unwrap();
        let cred = Credential { aws_access_key_id: "AKID".into(), aws_secret_access_key: "secret".into(), ..Credential::default() };
        let o = build(&card, &cred, &prompt(), 1440938160).unwrap();
        assert_eq!(o.url, "https://bedrock-runtime.us-gov-west-1.amazonaws.com/model/anthropic.claude-3-5-sonnet-20240620-v1%3A0/converse");
        let auth = o.headers.iter().find(|(k, _)| k == "authorization").unwrap().1.clone();
        assert!(auth.starts_with("AWS4-HMAC-SHA256 Credential=AKID/20150830/us-gov-west-1/bedrock/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature="));
        // the same request signed by hand: the canonical URI encodes the already encoded path again
        let headers = vec![("content-type".to_string(), "application/json".to_string()), ("host".to_string(), "bedrock-runtime.us-gov-west-1.amazonaws.com".to_string()), ("x-amz-date".to_string(), "20150830T123600Z".to_string())];
        let again = sigv4("POST", "/model/anthropic.claude-3-5-sonnet-20240620-v1%3A0/converse", "", &headers, &o.body, "us-gov-west-1", "bedrock", "AKID", "secret", "20150830T123600Z");
        assert_eq!(auth, again);
        assert!(!o.headers.iter().any(|(k, _)| k == "host"));
    }

    #[test]
    fn each_provider_gets_its_own_request_and_answer_shape() {
        let a = check_card(&frontier_card("a", "anthropic", "https://api.anthropic.com/", &["public"])).unwrap();
        let cred = Credential { api_key: "k".into(), ..Credential::default() };
        let o = build(&a, &cred, &prompt(), 0).unwrap();
        assert_eq!(o.url, "https://api.anthropic.com/v1/messages");
        let body: Value = serde_json::from_slice(&o.body).unwrap();
        assert_eq!((body["system"].as_str(), body["max_tokens"].as_u64()), (Some("sys"), Some(512)));
        let got = parse("anthropic", br#"{"content":[{"type":"text","text":"North lot [s1]"}],"usage":{"input_tokens":10,"output_tokens":4}}"#).unwrap();
        assert_eq!(got, Completion { text: "North lot [s1]".into(), tokens_in: Some(10), tokens_out: Some(4) });
        let z = check_card(&frontier_card("z", "azure", "https://acme.openai.azure.us", &["public"])).unwrap();
        let o = build(&z, &Credential { azure_deployment: "gpt4o-prod".into(), ..cred.clone() }, &prompt(), 0).unwrap();
        assert_eq!(o.url, "https://acme.openai.azure.us/openai/deployments/gpt4o-prod/chat/completions?api-version=2024-10-21");
        assert!(o.headers.contains(&("api-key".to_string(), "k".to_string())));
        let l = check_card(&org_card("l", "https://vllm.acme.example:8000/v1", &["internal"])).unwrap();
        let o = build(&l, &Credential::default(), &prompt(), 0).unwrap();
        assert_eq!(o.url, "https://vllm.acme.example:8000/v1/chat/completions");
        assert!(o.headers.iter().all(|(k, _)| k != "authorization"));
        let got = parse("local", br#"{"choices":[{"message":{"content":"ok"}}],"usage":{"prompt_tokens":7,"completion_tokens":1}}"#).unwrap();
        assert_eq!((got.text.as_str(), got.tokens_in), ("ok", Some(7)));
        let got = parse("amazon-bedrock", br#"{"output":{"message":{"content":[{"text":"hi"}]}},"usage":{"inputTokens":3,"outputTokens":1}}"#).unwrap();
        assert_eq!((got.text.as_str(), got.tokens_out), ("hi", Some(1)));
        assert!(build(&a, &Credential::default(), &prompt(), 0).is_err());
    }

    #[test]
    fn vllm_metrics_give_queue_and_free_kv() {
        let text = "# HELP x\nvllm:num_requests_waiting{model_name=\"m\"} 3.0\nvllm:num_requests_running{model_name=\"m\"} 2.0\nvllm:gpu_cache_usage_perc{model_name=\"m\"} 0.25\nvllm:cache_config_info{block_size=\"16\",num_gpu_blocks=\"1000\"} 1.0\n";
        let m = parse_metrics(text);
        assert_eq!((m.waiting, m.running, m.kv_blocks, m.block_size), (Some(3), Some(2), Some(1000), Some(16)));
        assert_eq!(m.free_kv_bytes(Some(163840)), Some(12000 * 163840));
        assert_eq!(Metrics { kv_blocks: None, ..m }.free_kv_bytes(Some(1)), None);
        assert_eq!(origin("https://h:8000/v1"), "https://h:8000");
    }
}
