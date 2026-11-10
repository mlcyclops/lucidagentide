// Phase C (ADR-0540): the Meet relay server's own operations (meet_relay.RelayServer): the CRL bundle (the root's CRL
// and the signer's CRLs in crl.pem, rebuilt and applied to new connections), CRL and CA pushes, the signer for admins
// (status, ledger, next key, installing an intermediate, revoking), the daily expiry check and its alerts, releases
// (releases.json), the version gate and update links for the download server (meet_downloads.mint).

use crate::meet::{self as m, bad, kv, log_error, log_info, log_warn, Identity, Relay, E, R};
use crate::meet_hub::SIGNER_DOWN;
use crate::meet_json::{self as pj, obj, Obj};
use crate::meet_tls::{crl_parts, crl_path, read_bytes, tls_config, write_atomic, SignerErr};
use crate::meet_x509::{pem_blocks, Cert, Crl};
use indexmap::IndexMap;
use serde_json::Value;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

const CRL_FETCH_EVERY: f64 = 6.0 * 3600.0;
const CHECK_EVERY: f64 = 86400.0;
const UPKEEP_TICK: f64 = 60.0;
const CRL_WARN_DAYS: i64 = 10;
const SIGNER_CRL_WARN_DAYS: i64 = 3;
const SIGNER_WARN_DAYS: i64 = 30;
const RELEASES_FILE: &str = "releases.json";
const PLATFORMS: [&str; 2] = ["windows", "macos"];
const NOTES_MAX: usize = 4000;
const INSTALLER_MAX: i64 = 4 << 30;
const UPDATE_LINK_DAYS: i64 = 2;
const UPDATE_LOG_EVERY: f64 = 600.0;
const IOS_CHANNELS: [&str; 2] = ["TestFlight", "App Store"];
const NO_SIGNER: &str = "this relay has no certificate server (signer_url)";

fn down_or(e: SignerErr) -> E {
    match e {
        SignerErr::Down(msg) => E::Unavailable(msg),
        SignerErr::Refused(e) => e,
    }
}

/// meet_downloads.NAME_RE: a file in the download folder, no folder.
fn file_name_ok(name: &str) -> bool {
    let b = name.as_bytes();
    !b.is_empty() && b.len() <= 128 && b[0].is_ascii_alphanumeric() && b.iter().all(|c| c.is_ascii_alphanumeric() || b"._+-".contains(c))
}

/// meet_downloads.load_secret: at least 32 bytes, base64 (either alphabet) in a file.
fn load_secret(path: &str) -> Result<Vec<u8>, String> {
    let raw = std::fs::read(path).map_err(|e| format!("[Errno {}] {}: '{path}'", e.raw_os_error().unwrap_or(0), e.kind()))?;
    let text = String::from_utf8_lossy(&raw).trim().replace('-', "+").replace('_', "/");
    let secret = pj::b64_strict(&text).ok_or_else(|| format!("{path} does not hold base64"))?;
    if secret.len() < 32 {
        return Err(format!("{path} holds fewer than 32 bytes"));
    }
    Ok(secret)
}

/// meet_downloads.mint: one link's token.
fn mint(secret: &[u8], name: &str, who: &str, expires: i64, nonce: &str) -> Result<String, String> {
    let who = who.trim();
    if !file_name_ok(name) {
        return Err("a file name is letters, digits, dots, dashes, underscores or plus signs (no folder), up to 128 characters".into());
    }
    if who.is_empty() || pj::char_len(who) > 254 || !pj::printable(who) {
        return Err("who must be an email address or a principal".into());
    }
    let payload = pj::dumps_compact(&Value::Object(obj([("f", Value::from(name)), ("w", Value::from(who)), ("e", Value::from(expires)), ("n", Value::from(nonce))])));
    let key = aws_lc_rs::hmac::Key::new(aws_lc_rs::hmac::HMAC_SHA256, secret);
    let mac = aws_lc_rs::hmac::sign(&key, payload.as_bytes());
    Ok(format!("{}.{}", crate::codec::b64u(payload.as_bytes()), crate::codec::b64u(mac.as_ref())))
}

/// meet_downloads.link: `<base>/d/<token>`.
fn link(base: &str, token: &str) -> Result<String, String> {
    let base = base.trim().trim_end_matches('/');
    let rest = base.strip_prefix("https://").unwrap_or("");
    let (host, port) = match rest.split_once(':') {
        Some((h, p)) => (h, Some(p)),
        None => (rest, None),
    };
    let host_ok = !host.is_empty() && host.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'.' || c == b'-');
    let port_ok = port.map(|p| !p.is_empty() && p.len() <= 5 && p.bytes().all(|c| c.is_ascii_digit())).unwrap_or(true);
    if !base.starts_with("https://") || !host_ok || !port_ok {
        return Err("the link base must be https://host or https://host:port".into());
    }
    Ok(format!("{base}/d/{token}"))
}

fn ios_release(entry: Option<&Value>) -> R<Obj> {
    let o = match entry {
        None | Some(Value::Null) => return Ok(Obj::new()),
        Some(Value::Object(o)) if o.is_empty() => return Ok(Obj::new()),
        Some(Value::Object(o)) => o,
        Some(_) => return bad("ios must be {version, build, channel}"),
    };
    let version = pj::s(o, "version").trim().to_string();
    if !m::version_ok(&version) {
        return bad("ios.version must look like 0.91.15");
    }
    let build = match pj::as_int(o.get("build")) {
        Some(b) if b > 0 && b < 100000 => b,
        _ => return bad("ios.build must be the build number, for example 16"),
    };
    let channel = Some(pj::s(o, "channel")).filter(|c| !c.is_empty()).unwrap_or_else(|| "TestFlight".into());
    if !IOS_CHANNELS.contains(&channel.as_str()) {
        return bad("ios.channel must be TestFlight or App Store");
    }
    Ok(obj([("version", Value::from(version)), ("build", Value::from(build)), ("channel", Value::from(channel))]))
}

/// release_manifest: the release an admin's request describes, published now.
fn release_manifest(body: &Obj) -> R<Obj> {
    let version = pj::s(body, "version").trim().to_string();
    if !m::version_ok(&version) {
        return bad("version must look like 0.92.0");
    }
    let ios = ios_release(body.get("ios"))?;
    let files = if pj::truthy(body.get("files")) { body.get("files").cloned().unwrap_or(Value::Null) } else { Value::Object(Obj::new()) };
    let files = match files {
        Value::Object(o) if !o.is_empty() || !ios.is_empty() => o,
        _ => return bad("files must describe the windows and/or macos installer"),
    };
    let mut out = Obj::new();
    for (platform, entry) in &files {
        if !PLATFORMS.contains(&platform.as_str()) {
            return bad("files may only describe the windows and macos installers");
        }
        let Some(entry) = entry.as_object() else { return bad(format!("files.{platform} must be {{name, sha256, size}}")) };
        let name = pj::s(entry, "name");
        if !file_name_ok(&name) {
            return bad(format!("files.{platform}.name must be a plain file name (letters, digits, dots, dashes, underscores, plus signs; no folder)"));
        }
        let sha = pj::s(entry, "sha256").trim().to_lowercase();
        if sha.len() != 64 || !sha.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)) {
            return bad(format!("files.{platform}.sha256 must be 64 hex digits"));
        }
        let size = match pj::as_int(entry.get("size")) {
            Some(s) if s > 0 && s <= INSTALLER_MAX => s,
            _ => return bad(format!("files.{platform}.size must be the installer's size in bytes")),
        };
        out.insert(platform.clone(), Value::Object(obj([("name", Value::from(name)), ("sha256", Value::from(sha)), ("size", Value::from(size))])));
    }
    let notes: String = pj::s(body, "notes").trim().chars().filter(|c| pj::printable(&c.to_string()) || *c == '\n' || *c == '\t').collect();
    if pj::char_len(&notes) > NOTES_MAX {
        return bad(format!("notes are at most {NOTES_MAX} characters"));
    }
    let minimum = m::minimum(body.get("minimum"), "minimum").map_err(E::Bad)?;
    let published = pj::iso_utc(pj::now().floor() as i64);
    let mut manifest = obj([("version", Value::from(version)), ("published", Value::from(published)), ("files", Value::Object(out)), ("notes", Value::from(notes))]);
    if !ios.is_empty() {
        manifest.insert("ios".into(), Value::Object(ios));
    }
    if !minimum.is_empty() {
        manifest.insert("minimum".into(), Value::Object(minimum));
    }
    Ok(manifest)
}

/// int(seconds // 86400) of a duration.
fn days_floor(secs: f64) -> i64 {
    (secs / 86400.0).floor() as i64
}

impl Relay {
    fn client_ca(&self) -> Option<Cert> {
        Cert::from_pem(&String::from_utf8_lossy(&read_bytes(Path::new(&self.settings.client_ca))))
    }

    fn reload_tls(&self) {
        match tls_config(&self.settings) {
            Ok(cfg) => *self.tls.write() = cfg,
            Err(e) => log_error(&format!("TLS cannot use the new files: {e}")),
        }
    }

    /// The constructor's part: an older relay's crl.pem becomes the root part, and the bundle is rebuilt.
    pub fn prepare_bundle(&self) {
        let Some((root_part, _)) = crl_parts(&self.settings) else { return };
        let bundle = crl_path(&self.settings);
        if let Some(b) = &bundle {
            if !root_part.exists() && b.exists() {
                let _ = write_atomic(&root_part, &read_bytes(b));
            }
        }
        if root_part.exists() {
            let _g = self.files.lock();
            self.rebuild_bundle();
        }
    }

    /// crl.pem = the root's CRL + the signer's CRLs (caller holds `files`); new connections use it at once.
    fn rebuild_bundle(&self) {
        let Some((root_part, signer_part)) = crl_parts(&self.settings) else { return };
        let root = read_bytes(&root_part);
        let root = String::from_utf8_lossy(&root).trim_matches(|c: char| c.is_ascii_whitespace()).as_bytes().to_vec();
        if root.is_empty() {
            return;
        }
        let mut data = root;
        data.push(b'\n');
        data.extend(read_bytes(&signer_part));
        if let Some(path) = crl_path(&self.settings) {
            if let Err(e) = write_atomic(&path, &data) {
                log_warn(&format!("cannot write {}: {e}", path.display()));
                return;
            }
        }
        self.reload_tls();
    }

    /// The signer's current and previous intermediates, each issued directly by the root.
    fn intermediates(&self, fresh: bool) -> Vec<Cert> {
        let Some(signer) = &self.hub.signer else { return Vec::new() };
        let status = if fresh { None } else { signer.snapshot() };
        let status = match status {
            Some(s) => s,
            None => match signer.refresh() {
                Ok(s) => s,
                Err(_) => return Vec::new(),
            },
        };
        let Some(root) = self.client_ca() else { return Vec::new() };
        ["intermediate_pem", "previous_pem"].iter().filter_map(|k| Cert::from_pem(&pj::s(&status, k))).filter(|c| c.issued_directly_by_root(&root)).collect()
    }

    fn store_signer_crls(&self, pem: &[u8], replace_all: bool) -> bool {
        let Some((_, signer_part)) = crl_parts(&self.settings) else { return false };
        let inters = self.intermediates(true);
        let mut good: IndexMap<Vec<u8>, Vec<u8>> = IndexMap::new();
        for (block, der) in pem_blocks(pem, "X509 CRL") {
            let Some(crl) = Crl::from_der(&der) else { continue };
            if inters.iter().any(|c| c.subject == crl.issuer && crl.signature_valid(&c.spki)) {
                good.insert(crl.issuer.clone(), block);
            }
        }
        if good.is_empty() {
            log_warn("the signer's CRL did not verify against its signing certificate");
            return false;
        }
        {
            let _g = self.files.lock();
            let old = read_bytes(&signer_part);
            if !replace_all {
                for (block, der) in pem_blocks(&old, "X509 CRL") {
                    if let Some(c) = Crl::from_der(&der) {
                        good.entry(c.issuer).or_insert(block);
                    }
                }
            }
            let data: Vec<u8> = good.values().flatten().copied().collect();
            if data == old {
                return false;
            }
            if write_atomic(&signer_part, &data).is_err() {
                return false;
            }
            self.rebuild_bundle();
        }
        log_info(&format!("signer CRL loaded ({}), CRL check: {}", good.len(), self.crl_check()));
        true
    }

    fn store_root_crl(&self, pem: Option<&Value>) -> bool {
        let Some((root_part, _)) = crl_parts(&self.settings) else { return false };
        let data = pj::str_or(pem).into_bytes();
        if String::from_utf8_lossy(&data).trim().is_empty() {
            return false;
        }
        let (Some(crl), Some(ca)) = (Crl::from_pem(&data), self.client_ca()) else {
            log_warn("the signer's root CRL could not be read");
            return false;
        };
        if crl.issuer != ca.subject || !crl.signature_valid(&ca.spki) {
            log_warn("the signer's root CRL did not verify against the root");
            return false;
        }
        if crl.next_update.map(|n| (n as f64) <= pj::now()).unwrap_or(false) {
            return false;
        }
        {
            let _g = self.files.lock();
            let old = Crl::from_pem(&read_bytes(&root_part)).map(|c| c.this_update);
            if old.map(|o| crl.this_update <= o).unwrap_or(false) {
                return false;
            }
            if write_atomic(&root_part, &data).is_err() {
                return false;
            }
            self.rebuild_bundle();
        }
        let dropped = self.hub.drop_serials(&crl.serials);
        let mut unique = crl.serials.clone();
        unique.sort();
        unique.dedup();
        log_info(&format!("root CRL from the signer loaded: {} revoked, {dropped} dropped, CRL check: {}", unique.len(), self.crl_check()));
        true
    }

    /// fetch_signer_crl: the signer's CRLs into the bundle (at start and every CRL_FETCH_EVERY).
    pub fn fetch_signer_crl(&self) -> bool {
        let Some(signer) = &self.hub.signer else { return false };
        if crl_parts(&self.settings).is_none() {
            return false;
        }
        *self.last_fetch.lock() = pj::mono();
        let answer = match signer.call("crl", &Obj::new()) {
            Ok(a) => a,
            Err(e) => {
                let msg = match e {
                    SignerErr::Down(m) => m,
                    SignerErr::Refused(e) => e.message(),
                };
                log_warn(&format!("cannot fetch the signer's CRL: {msg}"));
                return false;
            }
        };
        let signer_changed = self.store_signer_crls(pj::s(&answer, "crl_pem").as_bytes(), true);
        let root_changed = self.store_root_crl(answer.get("root_crl_pem"));
        signer_changed || root_changed
    }

    fn active_crl_path(&self) -> Option<std::path::PathBuf> {
        if !self.settings.crl.is_empty() {
            return Some(self.settings.crl.clone().into());
        }
        crl_path(&self.settings)
    }

    /// crl_check: "chain", "leaf" or "off".
    pub fn crl_check(&self) -> String {
        match self.active_crl_path() {
            Some(p) if p.exists() => if crate::meet_tls::bundle_checks_chain(&p, Path::new(&self.settings.client_ca)) { "chain" } else { "leaf" }.into(),
            _ => "off".into(),
        }
    }

    /// crl_info: `[{issuer, root, next_update, days_left}]` for every CRL new connections check.
    pub fn crl_info(&self) -> Vec<Obj> {
        let Some(path) = self.active_crl_path() else { return Vec::new() };
        let root = self.client_ca().map(|c| c.subject);
        let now = pj::now();
        crate::meet_tls::crls_in(&read_bytes(&path))
            .into_iter()
            .map(|c| {
                obj([
                    ("issuer", Value::from(c.issuer_cn.clone().unwrap_or_else(|| c.issuer_text.clone()))),
                    ("root", Value::Bool(root.as_ref() == Some(&c.issuer))),
                    ("next_update", Value::from(c.next_update.map(pj::iso_utc).unwrap_or_default())),
                    ("days_left", c.next_update.map(|n| Value::from(days_floor(n as f64 - now))).unwrap_or(Value::Null)),
                ])
            })
            .collect()
    }

    /// check_expiry: WARNING lines and admin alerts for a CRL or signing certificate near its end.
    pub fn check_expiry(&self) -> Vec<Obj> {
        *self.last_check.lock() = pj::mono();
        let mut alerts = Vec::new();
        for info in self.crl_info() {
            let Some(left) = pj::as_int(info.get("days_left")) else { continue };
            let limit = if pj::truthy(info.get("root")) { CRL_WARN_DAYS } else { SIGNER_CRL_WARN_DAYS };
            if left < limit {
                log_warn(&format!(
                    "CRL from {} expires {} ({left} days left): when it expires every handshake is refused; push a new one",
                    pj::s(&info, "issuer"),
                    pj::s(&info, "next_update")
                ));
                alerts.push(obj([("type", Value::from("crl_expiring")), ("days_left", Value::from(left)), ("next_update", info["next_update"].clone()), ("issuer", info["issuer"].clone())]));
            }
        }
        if let Some(signer) = &self.hub.signer {
            match signer.refresh() {
                Err(e) => {
                    log_warn(&format!("the certificate server cannot be reached: {e}"));
                    alerts.push(obj([("type", Value::from("signer_down")), ("error", Value::from(e))]));
                }
                Ok(status) => {
                    if !pj::truthy(status.get("healthy")) {
                        log_warn(&format!("the certificate server cannot sign: {}", pj::py_str(status.get("error").unwrap_or(&Value::Null))));
                        alerts.push(obj([("type", Value::from("signer_down")), ("error", Value::from(pj::s(&status, "error")))]));
                    }
                    if let Some(left) = pj::as_int(status.get("days_left")).filter(|l| *l <= SIGNER_WARN_DAYS) {
                        log_warn(&format!("the signing certificate expires {} ({left} days left): renew it from the issuer's PC", pj::py_str(status.get("not_after").unwrap_or(&Value::Null))));
                        alerts.push(obj([("type", Value::from("signer_expiring")), ("days_left", Value::from(left)), ("not_after", Value::from(pj::s(&status, "not_after")))]));
                    }
                }
            }
        }
        self.hub.set_alerts(alerts.clone());
        alerts
    }

    /// start_upkeep: the signer's CRL now and every CRL_FETCH_EVERY; expiry checks now and every CHECK_EVERY.
    pub fn start_upkeep(self: &Arc<Self>) {
        let relay = self.clone();
        let _ = std::thread::Builder::new().name("relay-crl-upkeep".into()).spawn(move || loop {
            let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let now = pj::mono();
                if now - *relay.last_fetch.lock() >= CRL_FETCH_EVERY {
                    relay.fetch_signer_crl();
                }
                if now - *relay.last_check.lock() >= CHECK_EVERY {
                    relay.check_expiry();
                }
                relay.refusals.flush();
            }));
            if r.is_err() {
                log_error("relay upkeep failed");
            }
            std::thread::sleep(Duration::from_secs_f64(UPKEEP_TICK));
        });
    }

    /// push_crl: a new CRL from the issuer: the root's or one of the signer's intermediates'.
    pub fn push_crl(&self, session: &str, who: &Identity, crl_pem: Option<&Value>) -> R<Obj> {
        self.hub.check_admin(session, who)?;
        let Some(path) = crl_path(&self.settings) else { return bad("this relay has no place to keep a revocation list") };
        let pem = pj::str_or(crl_pem).into_bytes();
        let crl = Crl::from_pem(&pem).ok_or_else(|| E::Bad("that is not a revocation list".into()))?;
        if crl.next_update.map(|n| (n as f64) <= pj::now()).unwrap_or(false) {
            return bad("the revocation list has already expired");
        }
        let ca = self.client_ca().ok_or_else(|| E::Internal("the client CA cannot be read".into()))?;
        let parts = crl_parts(&self.settings);
        if crl.issuer == ca.subject && crl.signature_valid(&ca.spki) {
            let _g = self.files.lock();
            match &parts {
                Some((root_part, _)) => {
                    write_atomic(root_part, &pem).map_err(|e| E::Internal(e.to_string()))?;
                    self.rebuild_bundle();
                }
                None => {
                    write_atomic(&path, &pem).map_err(|e| E::Internal(e.to_string()))?;
                    self.reload_tls();
                }
            }
        } else {
            if !self.intermediates(true).iter().any(|c| c.subject == crl.issuer && crl.signature_valid(&c.spki)) {
                return bad("the revocation list was not signed by this relay's CA or its signing CA");
            }
            self.store_signer_crls(&pem, false);
        }
        let mut serials = crl.serials.clone();
        serials.sort();
        serials.dedup();
        let dropped = self.hub.drop_serials(&serials);
        log_info(&format!("CRL pushed by {}: {} revoked, {dropped} dropped", who.principal, serials.len()));
        Ok(obj([("ok", Value::Bool(true)), ("revoked", Value::from(serials.len())), ("dropped", Value::from(dropped))]))
    }

    /// GET /v1/admin/signer: the signer's status, the CRLs in use, and the ledger from `since`.
    pub fn admin_signer(&self, session: &str, who: &Identity, op: &str, since: Option<i64>) -> R<Obj> {
        self.hub.check_admin(session, who)?;
        let signer = self.hub.signer.clone();
        if op == "next_key" {
            let Some(signer) = signer else { return Err(E::Unavailable(NO_SIGNER.into())) };
            return signer.call("next_key", &Obj::new()).map_err(down_or);
        }
        if !op.is_empty() {
            return bad("op must be next_key or left out");
        }
        let mut out = obj([
            ("configured", Value::Bool(signer.is_some())),
            ("healthy", Value::Bool(false)),
            ("crls", Value::Array(self.crl_info().into_iter().map(Value::Object).collect())),
            ("crl_check", Value::from(self.crl_check())),
            ("alerts", Value::Array(self.hub.alerts().into_iter().map(Value::Object).collect())),
        ]);
        let Some(signer) = signer else { return Ok(out) };
        let status = match signer.refresh() {
            Ok(s) => s,
            Err(e) => {
                out.insert("error".into(), Value::from(e));
                return Ok(out);
            }
        };
        for (k, v) in status {
            out.insert(k, v);
        }
        out.insert("configured".into(), Value::Bool(true));
        if let Some(since) = since {
            match signer.call("ledger", &obj([("since", Value::from(since.max(0)))])) {
                Ok(l) => {
                    out.insert("ledger".into(), Value::Object(l));
                }
                Err(SignerErr::Down(e)) => {
                    out.insert("ledger_error".into(), Value::from(e));
                }
                Err(SignerErr::Refused(e)) => return Err(e),
            }
        }
        Ok(out)
    }

    /// POST /v1/admin/signer {op: install_intermediate, ...}: passed to the signer with this relay's root.
    pub fn signer_install(&self, session: &str, who: &Identity, body: &Obj) -> R<Obj> {
        self.hub.check_admin(session, who)?;
        if pj::s(body, "op") != "install_intermediate" {
            return bad("op must be install_intermediate");
        }
        let Some(signer) = self.hub.signer.clone() else { return Err(E::Unavailable(NO_SIGNER.into())) };
        let mut payload = Obj::new();
        for k in ["intermediate_pem", "policy", "ledger_baseline"] {
            if let Some(v) = body.get(k).filter(|v| !v.is_null()) {
                payload.insert(k.into(), v.clone());
            }
        }
        if pj::truthy(body.get("proof")) {
            payload.insert("proof".into(), Value::from(pj::s(body, "proof")));
            payload.insert("ts".into(), pj::as_num(body.get("ts")).map(|x| Value::from(x.trunc() as i64)).unwrap_or(Value::Null));
            payload.insert("cert_pem".into(), Value::from(who.cert_pem.clone()));
        }
        let ca = std::fs::read_to_string(&self.settings.client_ca).map_err(|e| E::Internal(e.to_string()))?;
        payload.insert("ca_pem".into(), Value::from(ca));
        let answer = signer.call("install_intermediate", &payload).map_err(down_or)?;
        let _ = signer.refresh();
        self.fetch_signer_crl();
        log_info(&format!("signing certificate installed by {} serial={}", who.principal, answer.get("intermediate_serial").map(pj::py_str).unwrap_or_default()));
        Ok(answer)
    }

    /// admin_revoke: an admin revokes a person's device (or the person) through the signer.
    pub fn admin_revoke(&self, session: &str, who: &Identity, principal: Option<&Value>, device: Option<&Value>, proof: Option<&Value>, ts: Option<&Value>) -> R<Obj> {
        self.hub.check_admin(session, who)?;
        let principal = m::principal(principal);
        let device = pj::str_or(device);
        if !principal.contains('@') {
            return bad("name the person (their email)");
        }
        if who.cert_pem.is_empty() {
            return m::forbidden("revoke from one of your devices");
        }
        let Some(signer) = self.hub.signer.clone().filter(|s| s.ready()) else { return Err(E::Unavailable(SIGNER_DOWN.into())) };
        let body = obj([
            ("principal", Value::from(principal.clone())),
            ("device", Value::from(device.clone())),
            ("cert_pem", Value::from(who.cert_pem.clone())),
            ("proof", Value::from(pj::str_or(proof))),
            ("ts", pj::as_num(ts).map(|x| Value::from(x.trunc() as i64)).unwrap_or(Value::Null)),
        ]);
        let answer = match signer.call("revoke", &body) {
            Ok(a) => a,
            Err(SignerErr::Down(_)) => return Err(E::Unavailable(SIGNER_DOWN.into())),
            Err(SignerErr::Refused(e)) => return Err(e),
        };
        let rows: Vec<Obj> = answer.get("revoked").and_then(Value::as_array).map(|a| a.iter().filter_map(|r| r.as_object().cloned()).collect()).unwrap_or_default();
        let serials = self.hub.deny(&rows, &principal, &device);
        if pj::truthy(answer.get("crl_pem")) {
            self.store_signer_crls(pj::s(&answer, "crl_pem").as_bytes(), true);
        }
        let dropped = self.hub.drop_serials(&serials);
        self.store_root_crl(answer.get("root_crl_pem"));
        log_info(&format!(
            "revoked principal={principal} device={} by={} certificates={} dropped={dropped}",
            if device.is_empty() { "*" } else { &device },
            who.principal,
            serials.len()
        ));
        let root_signed: Vec<Value> = rows.iter().filter(|r| r.get("issuer").and_then(Value::as_str) == Some("root")).map(|r| Value::from(m::serial_of(r.get("serial")))).collect();
        Ok(obj([("ok", Value::Bool(true)), ("revoked", Value::from(serials)), ("dropped", Value::from(dropped)), ("root_signed", Value::Array(root_signed))]))
    }

    /// release: the latest release an admin set ({} when none).
    pub fn release(&self) -> Obj {
        let Some(path) = m::state_file(&self.settings, RELEASES_FILE) else { return Obj::new() };
        match std::fs::read(&path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Obj::new(),
            Err(e) => {
                log_warn(&format!("{} cannot be read: {e}", path.display()));
                Obj::new()
            }
            Ok(raw) => match serde_json::from_slice::<Value>(&raw) {
                Ok(Value::Object(o)) => o,
                Ok(_) => Obj::new(),
                Err(e) => {
                    log_warn(&format!("{} cannot be read: {e}", path.display()));
                    Obj::new()
                }
            },
        }
    }

    /// POST /v1/admin/release: the latest release, which every Hub reads from /v1/version.
    pub fn set_release(&self, session: &str, who: &Identity, body: &Obj) -> R<Obj> {
        self.hub.check_admin(session, who)?;
        let Some(path) = m::state_file(&self.settings, RELEASES_FILE) else { return Err(E::Unavailable("this relay has no state folder to keep releases in".into())) };
        let manifest = release_manifest(body)?;
        {
            let _g = self.files.lock();
            write_atomic(&path, pj::dumps_indent(&Value::Object(manifest.clone()), 1).as_bytes()).map_err(|e| E::Internal(e.to_string()))?;
        }
        let minimum = manifest.get("minimum").and_then(Value::as_object).cloned().unwrap_or_default();
        let mut platforms: Vec<String> = manifest.get("files").and_then(Value::as_object).map(|f| f.keys().cloned().collect()).unwrap_or_default();
        platforms.sort();
        log_info(&format!(
            "release version={} platforms={} minimum_hub={} minimum_ios={} by={}",
            pj::s(&manifest, "version"),
            platforms.join(","),
            m::kv_of(minimum.get("hub")),
            m::kv_of(minimum.get("ios")),
            who.principal
        ));
        Ok(obj([("ok", Value::Bool(true)), ("release", Value::Object(manifest))]))
    }

    /// GET /v1/version: the latest release and the version gate in force.
    pub fn version(&self, session: &str, who: &Identity) -> R<Obj> {
        self.hub.check_session(session, who)?;
        let mut manifest = self.release();
        if manifest.is_empty() {
            manifest = obj([("version", Value::from("")), ("published", Value::from("")), ("files", Value::Object(Obj::new())), ("notes", Value::from(""))]);
        }
        let mut answer: Obj = manifest.iter().filter(|(k, _)| *k != "minimum").map(|(k, v)| (k.clone(), v.clone())).collect();
        let minimum = self.minimums(&manifest);
        if !minimum.is_empty() {
            answer.insert("minimum".into(), Value::Object(minimum));
        }
        Ok(answer)
    }

    /// minimums: per app the higher of relay.json min_client and the release's minimum.
    pub fn minimums(&self, manifest: &Obj) -> Obj {
        let published = match m::minimum(manifest.get("minimum"), "minimum") {
            Ok(p) => p,
            Err(e) => {
                log_warn(&format!("{RELEASES_FILE}: {e}; its minimum is ignored"));
                Obj::new()
            }
        };
        let mut out = self.settings.min_client.clone();
        for (app, value) in published {
            let v = pj::py_str(&value);
            let higher = match out.get(&app) {
                None => true,
                Some(cur) => m::version_key(&v) > m::version_key(&pj::py_str(cur)),
            };
            if higher {
                out.insert(app, value);
            }
        }
        out
    }

    /// outdated: `{app, current, minimum, release}` when the caller's app is older than the minimum for it.
    pub fn outdated(&self, who: &Identity, client: &Obj) -> Option<Obj> {
        if who.seed || who.console {
            return None;
        }
        if self.settings.version_exempt.iter().any(|p| p.trim().to_lowercase() == who.principal) {
            return None;
        }
        let app = Some(pj::s(client, "app")).filter(|a| !a.is_empty()).unwrap_or_else(|| "hub".into()).to_lowercase();
        if m::UNGATED_APPS.contains(&app.as_str()) || !m::GATED_APPS.contains(&app.as_str()) {
            return None;
        }
        let manifest = self.release();
        let minimum = self.minimums(&manifest).get(&app).map(pj::py_str).filter(|m| !m.is_empty())?;
        let current = Some(pj::s(client, "version")).filter(|v| !v.is_empty()).unwrap_or_else(|| "0".into());
        if m::version_key(&current) >= m::version_key(&minimum) {
            return None;
        }
        let ios = manifest.get("ios").filter(|v| pj::truthy(Some(*v))).and_then(Value::as_object).cloned().unwrap_or_default();
        Some(obj([
            ("app", Value::from(app)),
            ("current", Value::from(current)),
            ("minimum", Value::from(minimum)),
            ("release", Value::Object(obj([("version", Value::from(pj::s(&manifest, "version"))), ("ios", Value::Object(ios))]))),
        ]))
    }

    /// note_outdated: one `update required` line per device per UPDATE_LOG_EVERY.
    pub fn note_outdated(&self, who: &Identity, info: &Obj) {
        let key = m::key(&who.principal, &who.device);
        let now = pj::mono();
        {
            let mut logged = self.outdated_logged.lock();
            if logged.get(&key).map(|t| now - t < UPDATE_LOG_EVERY).unwrap_or(false) {
                return;
            }
            logged.retain(|_, t| now - *t < UPDATE_LOG_EVERY);
            logged.insert(key, now);
        }
        log_info(&format!(
            "update required principal={} app={} current={} minimum={} device={}",
            who.principal,
            pj::s(info, "app"),
            m::kv_of(info.get("current")),
            pj::s(info, "minimum"),
            kv(&who.device)
        ));
    }

    /// POST /v1/update/link {platform}: the caller's own link to the latest installer.
    pub fn update_link(&self, session: &str, who: &Identity, platform: Option<&Value>) -> R<Obj> {
        self.hub.check_session(session, who)?;
        let platform = pj::str_or(platform).trim().to_lowercase();
        if !PLATFORMS.contains(&platform.as_str()) {
            return bad("platform must be windows or macos");
        }
        let manifest = self.release();
        let version = pj::s(&manifest, "version");
        if version.is_empty() {
            return Err(E::NotFound("no release has been published yet".into()));
        }
        let entry = manifest.get("files").filter(|v| pj::truthy(Some(*v))).and_then(Value::as_object).and_then(|f| f.get(&platform)).and_then(Value::as_object).cloned();
        let Some(entry) = entry else { return Err(E::NotFound(format!("release {version} has no {platform} installer"))) };
        let s = &self.settings;
        if s.files_secret_file.is_empty() || s.files_base.is_empty() {
            return Err(E::Unavailable("this relay has no download server (files_secret_file, files_base)".into()));
        }
        let nonce = pj::token_hex(8);
        let expires = (pj::now() + (UPDATE_LINK_DAYS * 86400) as f64) as i64;
        let url = load_secret(&s.files_secret_file).and_then(|secret| mint(&secret, &pj::s(&entry, "name"), &who.principal, expires, &nonce)).and_then(|token| link(&s.files_base, &token));
        let url = match url {
            Ok(u) => u,
            Err(e) => {
                log_error(&format!("update link cannot be made: {e}"));
                return Err(E::Unavailable("the download server is not set up on this relay".into()));
            }
        };
        let starting = self.console.start_files();
        log_info(&format!("update link for={} version={version} platform={platform} nonce={nonce} starting={}", who.principal, if starting { "True" } else { "False" }));
        let get = |k: &str| entry.get(k).cloned().unwrap_or(Value::Null);
        Ok(obj([
            ("url", Value::from(url)),
            ("version", Value::from(version)),
            ("platform", Value::from(platform)),
            ("name", get("name")),
            ("sha256", get("sha256")),
            ("size", get("size")),
            ("expires", Value::from(expires)),
            ("starting", Value::Bool(starting)),
        ]))
    }

    /// push_ca: the same CA with a later expiry: same key and subject, or refused.
    pub fn push_ca(&self, session: &str, who: &Identity, ca_pem: Option<&Value>) -> R<Obj> {
        self.hub.check_admin(session, who)?;
        let pem = pj::str_or(ca_pem);
        let new = Cert::from_pem(&pem).ok_or_else(|| E::Bad("that is not a certificate".into()))?;
        let current = self.client_ca().ok_or_else(|| E::Internal("the client CA cannot be read".into()))?;
        if new.subject != current.subject || new.spki != current.spki {
            return bad("that is not the same CA (its key or name differs)");
        }
        if (new.not_after as f64) <= pj::now() {
            return bad("that CA certificate has already expired");
        }
        {
            let _g = self.files.lock();
            self.write_client_ca(pem.as_bytes())?;
        }
        log_info(&format!("CA certificate replaced by {} (valid until {})", who.principal, pj::iso_date(new.not_after)));
        Ok(obj([("ok", Value::Bool(true)), ("not_after", Value::from(pj::iso_utc(new.not_after)))]))
    }

    /// Replace the client CA file and use it for new connections (caller holds `files`); the old file back when TLS
    /// cannot use it.
    fn write_client_ca(&self, pem: &[u8]) -> R<()> {
        let path = Path::new(&self.settings.client_ca);
        let old = std::fs::read(path).map_err(|e| E::Internal(e.to_string()))?;
        write_atomic(path, pem).map_err(|e| E::Internal(e.to_string()))?;
        match tls_config(&self.settings) {
            Ok(cfg) => {
                *self.tls.write() = cfg;
                Ok(())
            }
            Err(_) => {
                let _ = write_atomic(path, &old);
                bad("the relay could not use that CA certificate")
            }
        }
    }

    /// _adopt_signer_root: a re-issue of this relay's root from a signer in root mode becomes the client CA.
    pub fn adopt_signer_root(&self, status: &Obj) -> bool {
        let pem = pj::s(status, "ca_pem");
        if pem.is_empty() {
            return false;
        }
        let (Some(new), Some(current)) = (Cert::from_pem(&pem), self.client_ca()) else { return false };
        if new.subject != current.subject || new.spki != current.spki || new.not_before <= current.not_before || (new.not_after as f64) <= pj::now() || !new.issued_directly_by_root(&current) {
            return false;
        }
        let r = {
            let _g = self.files.lock();
            self.write_client_ca(pem.as_bytes())
        };
        if let Err(e) = r {
            log_warn(&format!("the signer's root was not taken: {}", e.message()));
            return false;
        }
        log_info(&format!("CA certificate re-issued by the signer taken (valid until {})", pj::iso_date(new.not_after)));
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn download_tokens_match_meet_downloads() {
        let token = mint(&[7u8; 32], "Lucid.exe", "ann@x", 100, "0123456789abcdef").unwrap();
        let (payload, mac) = token.split_once('.').unwrap();
        assert_eq!(crate::codec::unb64u(payload).unwrap(), br#"{"f":"Lucid.exe","w":"ann@x","e":100,"n":"0123456789abcdef"}"#.to_vec());
        assert_eq!(mac.len(), 43);
        assert_eq!(link("https://files.test:8443/", "t").unwrap(), "https://files.test:8443/d/t");
        assert!(link("http://files.test", "t").is_err());
    }

    #[test]
    fn a_release_manifest_is_checked() {
        let body = json!({"version": "0.93.0", "files": {"windows": {"name": "Lucid.exe", "sha256": "a".repeat(64), "size": 10}}, "minimum": {"hub": "0.92.0"}});
        let m = release_manifest(body.as_object().unwrap()).unwrap();
        assert_eq!(m.keys().cloned().collect::<Vec<_>>(), vec!["version", "published", "files", "notes", "minimum"]);
        let bad = json!({"version": "x"});
        assert_eq!(release_manifest(bad.as_object().unwrap()).unwrap_err().message(), "version must look like 0.92.0");
        let none = json!({"version": "1.0"});
        assert_eq!(release_manifest(none.as_object().unwrap()).unwrap_err().message(), "files must describe the windows and/or macos installer");
    }
}
