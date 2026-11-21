// Phase C (ADR-0540): the Meet relay server's own operations (meet_relay.RelayServer): the CRL bundle (the root's CRL
// and the signer's CRLs in crl.pem, rebuilt and applied to new connections), CRL and CA pushes, the signer for admins
// (status, ledger, next key, installing an intermediate, revoking), the daily expiry check and its alerts, releases
// (releases.json), the version gate and update links for the download server (meet_downloads.mint).

use crate::meet::{self as m, bad, kv, log_error, log_info, log_warn, Identity, Relay, E, R};
use crate::meet_hub::{pc, SIGNER_DOWN};
use crate::meet_json::{self as pj, obj, Obj};
use crate::meet_tls::{adopt_pending_crl, cert_serial, crl_parts, crl_path, pending_crl_due, place_root_crl_changed, read_bytes, rebuild_bundle_files, self_signed_roots, tls_config, write_atomic, Placed, SignerErr};
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
/// AC-1 4.9: every publication with the minimums it put in force (for history and the N4 rule).
const RELEASE_HISTORY_FILE: &str = "release-history.json";
const RELEASE_HISTORY_KEEP: usize = 50;
pub const RELEASE_MINIMUM_TOO_NEW: &str = "A minimum version cannot be newer than a release this relay has published.";
const PLATFORMS: [&str; 2] = ["windows", "macos"];
const NOTES_MAX: usize = 4000;
const INSTALLER_MAX: i64 = 4 << 30;
const UPDATE_LINK_DAYS: i64 = 2;
const UPDATE_LOG_EVERY: f64 = 600.0;
const IOS_CHANNELS: [&str; 2] = ["TestFlight", "App Store"];
const NO_SIGNER: &str = "this relay has no certificate server (signer_url)";

/// AC-2b-D 8.5: what `/v1/admin/crl` answers on a `fleet_pki` relay for a root CRL of its CA (a Meeting Hub relay
/// word, like the relay's other refusals).
pub const ROOT_CRL_CONSOLE_ONLY: &str = "this relay takes its CA's revocation lists only from its Admin Console";
/// AC-2b-D 8.4 (R5-M1): a superseded `pki/<serial>/` folder is kept this long (ms) after the newer pair was reported.
pub const SUPERSEDED_KEEP_MS: i64 = 7 * 86_400_000;
/// When `hello` first reported each serial in `pki/current` (relay-owned, under `pki/`).
pub const PKI_REPORTED_FILE: &str = "reported.json";

/// AC-2b-D 10: `fleet.meet-crl-refused` (security, warn) with its `why`.
pub fn crl_refused(why: &str) {
    crate::console_meet::logger().security("fleet.meet-crl-refused", &crate::log::Fields::new().with("why", why), crate::log::Level::Warn);
}

fn down_or(e: SignerErr) -> E {
    match e {
        SignerErr::Down(msg) => E::Unavailable(msg),
        SignerErr::Refused(e) => e,
    }
}

/// NT-1 section 3.4: the thisUpdate (seconds) of the newest CRL in a signer answer's `crl_pem`, else now: the id of
/// the background `crl` push.
fn crl_issued(answer: &Obj) -> i64 {
    pem_blocks(pj::s(answer, "crl_pem").as_bytes(), "X509 CRL").iter().filter_map(|(_, der)| Crl::from_der(der)).map(|c| c.this_update).max().unwrap_or(pj::now() as i64)
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
        if crl_parts(&self.settings).is_none() {
            return;
        }
        match rebuild_bundle_files(Path::new(&self.settings.state_dir)) {
            Ok(true) => self.reload_tls(),
            Ok(false) => {}
            Err(e) => log_warn(&format!("cannot write {}: {e}", crl_path(&self.settings).unwrap_or_default().display())),
        }
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
        // AC-2b-D 8.5: a fleet_pki relay takes its CA's root CRLs only from the Admin Console (R2-L8)
        if self.settings.fleet_pki {
            crl_refused("path");
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
        if signer_changed || root_changed {
            self.hub.console_revoked(&self.revoked_serials());
        }
        signer_changed || root_changed
    }

    /// AC-1 3.2: every serial a CRL this relay holds lists (the configured `crl`, else the bundle and its root and
    /// signer parts).
    pub fn revoked_serials(&self) -> Vec<String> {
        let mut files: Vec<std::path::PathBuf> = self.active_crl_path().into_iter().collect();
        if let Some((root_part, signer_part)) = crl_parts(&self.settings) {
            files.push(root_part);
            files.push(signer_part);
        }
        let mut out: Vec<String> = files.iter().flat_map(|p| crate::meet_tls::crls_in(&read_bytes(p))).flat_map(|c| c.serials).map(|s| m::serial(&s)).filter(|s| !s.is_empty()).collect();
        out.sort();
        out.dedup();
        out
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
                // AC-2b-D 8.5 (R3-M1): a pending root CRL whose thisUpdate passed (the timer's backstop, and the first
                // tick after a restart); 8.4 (R5-M1): superseded key folders past their 7 days
                relay.adopt_pending();
                relay.prune_pki();
                relay.pc_upkeep();
                relay.refusals.flush();
            }));
            if r.is_err() {
                log_error("relay upkeep failed");
            }
            std::thread::sleep(Duration::from_secs_f64(UPKEEP_TICK));
        });
    }

    /// AC-2b-D 8.5, 9.3 `meet-crl`: a root CRL the Admin Console pushed, taken under `place_root_crl`'s rules into the
    /// bundle (only when the relay's CRL source is the bundle, else `why: "fixed"`); once current it is applied as a
    /// pushed CRL, before that it waits as pending with a timer. Err is the `why` of `fleet.meet-crl-refused` (the
    /// channel side logs it).
    pub fn adopt_root_crl(self: &Arc<Self>, pem: &[u8]) -> Result<Placed, String> {
        if crl_parts(&self.settings).is_none() {
            return Err("fixed".into());
        }
        let (placed, changed) = {
            let _g = self.files.lock();
            place_root_crl_changed(Path::new(&self.settings.state_dir), Path::new(&self.settings.client_ca), pem, pj::now() as i64)?
        };
        if changed {
            match placed {
                Placed::Current => {
                    if let Some((crl, der)) = pem_blocks(pem, "X509 CRL").into_iter().next().and_then(|(_, der)| Crl::from_der(&der).map(|c| (c, der))) {
                        self.root_crl_in_force(&crl, &der);
                    }
                }
                Placed::Pending => self.pending_timer(),
            }
        }
        Ok(placed)
    }

    /// A root CRL just put in force from the Admin Console: new connections check it, live sessions of the serials it
    /// lists are dropped (as `/v1/admin/crl` does), `fleet.meet-crl` is audited, and a `fleet_pki` relay with a
    /// certificate server forwards it there (`root_crl`, R3-M3).
    fn root_crl_in_force(&self, crl: &Crl, der: &[u8]) {
        self.reload_tls();
        let mut serials = crl.serials.clone();
        serials.sort();
        serials.dedup();
        let dropped = self.hub.drop_serials(&serials);
        self.hub.console_revoked(&serials);
        self.fleet_audit("fleet.meet-crl", serde_json::json!({"thisUpdate": crl.this_update * 1000}));
        log_info(&format!("root CRL from the Admin Console in force: {} revoked, {dropped} dropped, CRL check: {}", serials.len(), self.crl_check()));
        if !self.settings.fleet_pki {
            return;
        }
        if let Some(signer) = self.hub.signer.clone() {
            let der = der.to_vec();
            let _ = std::thread::Builder::new().name("relay-root-crl".into()).spawn(move || {
                if let Err(e) = signer.forward_root_crl(&der) {
                    log_warn(&format!("the certificate server did not take the root CRL: {e}"));
                }
            });
        }
    }

    /// An audit entry from the relay itself (actor "relay") in the book of its fleet link, else its own console.
    pub fn fleet_audit(&self, action: &str, detail: Value) {
        if let Some(f) = self.fleet.get() {
            f.book.audit_relay(action, "", detail);
        } else if let Some(c) = self.admin_console.get() {
            c.audit_relay(action, "", detail);
        }
    }

    /// R3-M1: adopt the pending list the moment its thisUpdate passes (one second after, on this relay's clock).
    fn pending_timer(self: &Arc<Self>) {
        let Some(due) = pending_crl_due(Path::new(&self.settings.state_dir)) else { return };
        let wait = (due as f64 - pj::now()).max(0.0) + 1.0;
        let weak = Arc::downgrade(self);
        let _ = std::thread::Builder::new().name("relay-crl-pending".into()).spawn(move || {
            std::thread::sleep(Duration::from_secs_f64(wait));
            if let Some(r) = weak.upgrade() {
                r.adopt_pending();
            }
        });
    }

    /// The pending root CRL becomes the one in force once its thisUpdate has passed (R3-M1); nothing before.
    pub fn adopt_pending(&self) {
        if crl_parts(&self.settings).is_none() {
            return;
        }
        let adopted = {
            let _g = self.files.lock();
            adopt_pending_crl(Path::new(&self.settings.state_dir), Path::new(&self.settings.client_ca), pj::now() as i64)
        };
        if let Some((crl, der)) = adopted {
            self.root_crl_in_force(&crl, &der);
        }
    }

    /// AC-2b-D 9.3 `meetPki` (null unless `fleet_pki`): the CA id, the server certificate in `pki/current`, and the
    /// certificate server's view: the signer client serial last used in a successful call, whether it enforces
    /// revocation, and the list it holds. Building it notes when each serial in `pki/current` was first reported
    /// (R5-M1).
    pub fn meet_pki_report(&self) -> Value {
        if !self.settings.fleet_pki || self.settings.state_dir.is_empty() {
            return Value::Null;
        }
        let dir = Path::new(&self.settings.state_dir);
        let cert = Cert::from_pem(&String::from_utf8_lossy(&read_bytes(&crate::fleet_agent::pki_current(dir).join("relay.crt"))));
        let ca_id = self_signed_roots(Path::new(&self.settings.client_ca)).first().map(|c| crate::license::meet_root_id(&c.spki));
        let signer = self.hub.signer.as_ref();
        let signer_serial = signer.and_then(|s| s.last_ok()).map(|(s, _)| s);
        let (enforced, held) = signer.map(|s| s.held()).unwrap_or((false, Value::Null));
        let cert_serial = cert.as_ref().map(|c| c.serial.clone()).unwrap_or_default();
        note_reported(dir, &cert_serial, signer_serial.as_deref(), crate::codec::now_ms());
        serde_json::json!({
            "caId": ca_id,
            "certSerial": cert.as_ref().map(|c| c.serial.clone()),
            "certNotAfter": cert.as_ref().map(|c| c.not_after * 1000),
            "signerSerial": signer_serial,
            "signerCrlEnforced": enforced,
            "signerHeld": held,
        })
    }

    /// AC-2b-D 8.4 (R2-M4): after `pki/current` switched to a renewed pair, new connections use the new certificate
    /// and the certificate server client presents the new signer client pair from its next call (no restart).
    pub fn pki_switched(&self) {
        self.reload_tls();
        if let Some(signer) = &self.hub.signer {
            if let Err(e) = signer.reload() {
                log_error(&format!("the certificate server client cannot use the new files: {e}"));
            }
        }
        log_info("the renewed certificates are in use");
    }

    /// AC-2b-D 8.4 (R5-M1): superseded key folders of a `fleet_pki` relay, 7 days after the newer pair was reported.
    pub fn prune_pki(&self) {
        if !self.settings.fleet_pki || self.settings.state_dir.is_empty() {
            return;
        }
        for name in prune_superseded(Path::new(&self.settings.state_dir), crate::codec::now_ms()) {
            log_info(&format!("superseded key folder pki/{name} overwritten and deleted"));
        }
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
            // AC-2b-D 8.5: on a fleet_pki relay the Admin Console is the only source of the root's CRL
            if self.settings.fleet_pki {
                crl_refused("path");
                return m::forbidden(ROOT_CRL_CONSOLE_ONLY);
            }
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
        // AC-1 3.2 and 3.8: anchors latched and `meet.revoke` requests observed from the CRL's serials
        self.hub.console_revoked(&serials);
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
        // PC-1: devices fetch the CRL on a crl event
        self.hub.pc_tell_crl(crl_issued(&answer));
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

    /// AC-1 4.9 history: every publication `{version, ios, minimum (in force after it), published (unix s)}`, oldest
    /// first, at most RELEASE_HISTORY_KEEP.
    pub fn release_history(&self) -> Vec<Obj> {
        let Some(path) = m::state_file(&self.settings, RELEASE_HISTORY_FILE) else { return Vec::new() };
        match std::fs::read(&path).ok().and_then(|raw| serde_json::from_slice::<Value>(&raw).ok()) {
            Some(Value::Array(a)) => a.into_iter().filter_map(|v| v.as_object().cloned()).collect(),
            _ => Vec::new(),
        }
    }

    fn history_append(&self, manifest: &Obj, in_force: &Obj) {
        let Some(path) = m::state_file(&self.settings, RELEASE_HISTORY_FILE) else { return };
        let mut rows = self.release_history();
        let ios = manifest.get("ios").and_then(Value::as_object).map(|i| pj::s(i, "version")).unwrap_or_default();
        rows.push(obj([
            ("version", Value::from(pj::s(manifest, "version"))),
            ("ios", Value::from(ios)),
            ("minimum", Value::Object(in_force.clone())),
            ("published", Value::from(pj::now().floor() as i64)),
        ]));
        let skip = rows.len().saturating_sub(RELEASE_HISTORY_KEEP);
        let rows: Vec<Value> = rows.into_iter().skip(skip).map(Value::Object).collect();
        if let Err(e) = write_atomic(&path, pj::dumps_indent(&Value::Array(rows), 1).as_bytes()) {
            log_warn(&format!("{RELEASE_HISTORY_FILE} cannot be written: {e}"));
        }
    }

    /// The last 10 publications for the console, newest first, each with `until` (when its minimum stopped
    /// applying: the next publication's time, null for the one in force).
    pub fn release_history_view(&self) -> Vec<Value> {
        let rows = self.release_history();
        let mut out: Vec<Value> = Vec::new();
        for (i, r) in rows.iter().enumerate() {
            let until = rows.get(i + 1).and_then(|n| n.get("published").cloned()).unwrap_or(Value::Null);
            out.push(Value::Object(obj([
                ("version", r.get("version").cloned().unwrap_or(Value::Null)),
                ("minimum", r.get("minimum").cloned().unwrap_or(Value::Null)),
                ("published", r.get("published").cloned().unwrap_or(Value::Null)),
                ("until", until),
            ])));
        }
        out.reverse();
        out.truncate(10);
        out
    }

    /// H6: `minimum.hub` not above the release's own version nor the newest this relay published; `minimum.ios` not
    /// above the release's iOS version nor the newest iOS version published.
    pub fn release_minimum_check(&self, manifest: &Obj) -> R<()> {
        let minimum = manifest.get("minimum").and_then(Value::as_object).cloned().unwrap_or_default();
        let history = self.release_history();
        let current = self.release();
        let newest = |field: &dyn Fn(&Obj) -> String| -> Option<Vec<u128>> {
            history.iter().chain(std::iter::once(&current)).map(field).filter(|v| !v.is_empty()).map(|v| m::version_key(&v)).max()
        };
        let too_new = || Err(E::Bad(RELEASE_MINIMUM_TOO_NEW.into()));
        if let Some(hub) = minimum.get("hub").and_then(Value::as_str) {
            let key = m::version_key(hub);
            let own = m::version_key(&pj::s(manifest, "version"));
            let top = newest(&|o: &Obj| pj::s(o, "version")).map(|n| n.max(own.clone())).unwrap_or(own.clone());
            if key > own || key > top {
                return too_new();
            }
        }
        if let Some(ios) = minimum.get("ios").and_then(Value::as_str) {
            let key = m::version_key(ios);
            let own = manifest.get("ios").and_then(Value::as_object).map(|i| pj::s(i, "version")).filter(|v| !v.is_empty()).map(|v| m::version_key(&v));
            let published = newest(&|o: &Obj| match o.get("ios") {
                Some(Value::String(s)) => s.clone(),
                Some(Value::Object(i)) => pj::s(i, "version"),
                _ => String::new(),
            });
            let top = match (&own, published) {
                (Some(a), Some(b)) => Some(a.clone().max(b)),
                (Some(a), None) => Some(a.clone()),
                (None, b) => b,
            };
            if own.as_ref().map(|o| key > *o).unwrap_or(false) || top.map(|t| key > t).unwrap_or(true) {
                return too_new();
            }
        }
        Ok(())
    }

    /// N4: whether one admin may publish `manifest`: for every app, the minimum in force after it equals the one in
    /// force now, or it goes up to exactly the value a publication in the last 24 hours lowered from.
    pub fn release_single_admin(&self, manifest: &Obj) -> bool {
        let now_in_force = self.minimums(&self.release());
        let next = self.minimums(manifest);
        let history = self.release_history();
        let cut = pj::now() as i64 - 86_400;
        for app in m::GATED_APPS {
            let (a, b) = (pj::s(&now_in_force, app), pj::s(&next, app));
            if a == b {
                continue;
            }
            let (ka, kb) = (if a.is_empty() { vec![0] } else { m::version_key(&a) }, if b.is_empty() { vec![0] } else { m::version_key(&b) });
            if kb <= ka {
                return false;
            }
            let lowered_from = history.windows(2).any(|w| {
                let at = pj::as_int(w[1].get("published")).unwrap_or(0);
                let before = w[0].get("minimum").and_then(Value::as_object).map(|o| pj::s(o, app)).unwrap_or_default();
                let after = w[1].get("minimum").and_then(Value::as_object).map(|o| pj::s(o, app)).unwrap_or_default();
                let lowered = (if after.is_empty() { vec![0] } else { m::version_key(&after) }) < (if before.is_empty() { vec![0] } else { m::version_key(&before) });
                at >= cut && lowered && before == b
            });
            if !lowered_from {
                return false;
            }
        }
        true
    }

    /// The manifest an admin's body describes, as set_release would publish it (the console's dry run).
    pub fn release_preview(&self, body: &Obj) -> R<Obj> {
        let manifest = release_manifest(body)?;
        self.release_minimum_check(&manifest)?;
        Ok(manifest)
    }

    /// POST /v1/admin/release: the latest release, which every Hub reads from /v1/version.
    pub fn set_release(&self, session: &str, who: &Identity, body: &Obj) -> R<Obj> {
        self.hub.check_admin(session, who)?;
        let Some(path) = m::state_file(&self.settings, RELEASES_FILE) else { return Err(E::Unavailable("this relay has no state folder to keep releases in".into())) };
        let manifest = release_manifest(body)?;
        // AC-1 H6: no minimum above the release itself or above what this relay has published
        self.release_minimum_check(&manifest)?;
        let in_force = self.minimums(&manifest);
        {
            let _g = self.files.lock();
            write_atomic(&path, pj::dumps_indent(&Value::Object(manifest.clone()), 1).as_bytes()).map_err(|e| E::Internal(e.to_string()))?;
            self.history_append(&manifest, &in_force);
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
        if who.seed || who.is_console() {
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

// ── parity wave C: org policies, service renewals and the SSO service, via the signer ───────────────────────

fn proof_ts(v: Option<&Value>) -> Value {
    pj::as_num(v).map(|x| Value::from(x.trunc() as i64)).unwrap_or(Value::Null)
}

/// _pc_own_cert: the SSO service forwards only its own certificate.
fn pc_own_cert(who: &Identity, body: &Obj) -> R<()> {
    if who.kind != "sso" {
        return m::forbidden(pc::SSO_ONLY);
    }
    let bare = |s: &str| s.split_whitespace().collect::<String>();
    if bare(&pj::s(body, "cert_pem")) != bare(&who.cert_pem) {
        return m::forbidden(pc::NOT_YOURS);
    }
    Ok(())
}

impl Relay {
    /// pc_upkeep: every upkeep tick, the signer's org policies; hourly, its CRL's age.
    pub fn pc_upkeep(&self) {
        self.pc_pull_policies();
        if pj::mono() - *self.pc_last_crl_check.lock() >= pc::CRL_CHECK_EVERY {
            self.pc_check_signer_crl();
        }
    }

    /// pc_pull_policies: the signer's `org_policies` (its signer policy and every org's current policy) into the hub's
    /// store; how many were new. A signer without the op is quiet.
    fn pc_pull_policies(&self) -> usize {
        let Some(signer) = &self.hub.signer else { return 0 };
        match signer.call("org_policies", &Obj::new()) {
            Ok(answer) => self.hub.pc_take_policies(answer.get("policies"), answer.get("signer_policy"), answer.get("cancels"), answer.get("lowerings")),
            Err(e) => {
                let msg = match e {
                    SignerErr::Down(m) => m,
                    SignerErr::Refused(e) => e.message(),
                };
                m::log_debug(&format!("org policies not pulled: {msg}"));
                0
            }
        }
    }

    fn pc_call(&self, op: &str, body: &Obj) -> R<Obj> {
        let Some(signer) = &self.hub.signer else { return Err(E::Unavailable(NO_SIGNER.into())) };
        signer.call(op, body).map_err(|e| match e {
            SignerErr::Down(_) => E::Unavailable(SIGNER_DOWN.into()),
            SignerErr::Refused(e) => e,
        })
    }

    /// _pc_revoked: serials a signer answer revoked (archive off, an SSO deactivation): denied at once, its CRL into
    /// the bundle, live sessions dropped, devices told `crl`.
    fn pc_revoked(&self, answer: &Obj, principal: &str) -> Vec<String> {
        let rows: Vec<Obj> = answer.get("revoked").and_then(Value::as_array).map(|a| a.iter().filter_map(|r| r.as_object().cloned()).collect()).unwrap_or_default();
        if rows.is_empty() {
            return Vec::new();
        }
        let serials = self.hub.deny(&rows, principal, "");
        if pj::truthy(answer.get("crl_pem")) {
            self.store_signer_crls(pj::s(answer, "crl_pem").as_bytes(), true);
        }
        self.hub.drop_serials(&serials);
        self.store_root_crl(answer.get("root_crl_pem"));
        self.hub.pc_tell_crl(crl_issued(answer));
        serials
    }

    /// `POST /v1/org/policy/sign {policy, proof, ts}`: an org admin's device asks the signer (`sign_org_policy` with
    /// the caller's certificate); the signed policy is stored and answered `{org, seq, hash, signed}`.
    pub fn pc_sign_policy(&self, session: &str, who: &Identity, policy: Option<&Value>, proof: Option<&Value>, ts: Option<&Value>) -> R<Obj> {
        self.hub.check_session(session, who)?;
        if who.cert_pem.is_empty() {
            return m::forbidden("sign from one of your devices");
        }
        // NT-1 section 3.9, BG-1 section 2.2: `notify` and `video` wait until every Hub and iPhone reads them
        let minimums = self.minimums(&self.release());
        crate::meet_org_policy::client_gate(policy, &minimums).map_err(E::Conflict)?;
        // SD-1 13.5: `storage` waits until every Hub and iPhone runs the SD-1b release
        crate::meet_org_policy::storage_gate(policy, &minimums).map_err(E::Conflict)?;
        self.pc_ai_gates(policy)?;
        let body = obj([
            ("policy", policy.cloned().unwrap_or(Value::Null)),
            ("proof", Value::from(pj::str_or(proof))),
            ("ts", proof_ts(ts)),
            ("cert_pem", Value::from(who.cert_pem.clone())),
            // AI-1 1.3: the signer applies ai_gate with the relay's minimums
            ("min_client", Value::Object(self.minimums(&self.release()))),
        ]);
        let answer = self.pc_call("sign_org_policy", &body)?;
        self.pc_revoked(&answer, "");
        let out = self.hub.pc_take_signed(answer.get("signed"))?;
        log_info(&format!("org_policy_signed org={} seq={} by={}", pj::s(&out, "org"), pj::as_int(out.get("seq")).unwrap_or(0), who.principal));
        Ok(out)
    }

    /// AI-1 1.3 and 1.5: `ai_gate` (the relay's minimum app versions) and `ai_edition_gate` (the license edition) of a
    /// policy about to be signed; 409 with their words (as `notify_gate`).
    pub fn pc_ai_gates(&self, policy: Option<&Value>) -> R<()> {
        crate::meet_org_policy::ai_gate(policy, &self.minimums(&self.release())).map_err(E::Conflict)?;
        if let Some(p) = policy.and_then(Value::as_object) {
            crate::meet_org_policy::ai_edition_gate(p, self.hub.ai_edition().as_deref()).map_err(E::Conflict)?;
        }
        Ok(())
    }

    /// `POST /v1/org/ai/sign {map, proof, ts}`: an org admin's device asks the signer (`sign_org_ai` with the caller's
    /// certificate); the signed map is stored and answered `{org, seq, hash, signed}`.
    pub fn pc_sign_ai(&self, session: &str, who: &Identity, map: Option<&Value>, proof: Option<&Value>, ts: Option<&Value>) -> R<Obj> {
        self.hub.check_session(session, who)?;
        if who.cert_pem.is_empty() {
            return m::forbidden("sign from one of your devices");
        }
        let body = obj([
            ("map", map.cloned().unwrap_or(Value::Null)),
            ("proof", Value::from(pj::str_or(proof))),
            ("ts", proof_ts(ts)),
            ("cert_pem", Value::from(who.cert_pem.clone())),
        ]);
        let answer = self.pc_call("sign_org_ai", &body)?;
        let out = self.hub.pc_ai_take_signed(answer.get("signed"))?;
        log_info(&format!("org_ai_signed org={} seq={} by={}", pj::s(&out, "org"), pj::as_int(out.get("seq")).unwrap_or(0), who.principal));
        Ok(out)
    }

    /// `POST /v1/org/storage/sign {session, map, proof, ts}` (SD-1 13.5): an org admin's device asks the signer
    /// (`sign_org_storage` with the caller's certificate); the signed map is kept and answered `{org, seq, hash,
    /// signed}`.
    pub fn sd_sign_storage(&self, session: &str, who: &Identity, storage_map: Option<&Value>, proof: Option<&Value>, ts: Option<&Value>) -> R<Obj> {
        self.hub.check_session(session, who)?;
        if who.cert_pem.is_empty() {
            return m::forbidden("sign from one of your devices");
        }
        let body = obj([
            ("map", storage_map.cloned().unwrap_or(Value::Null)),
            ("proof", Value::from(pj::str_or(proof))),
            ("ts", proof_ts(ts)),
            ("cert_pem", Value::from(who.cert_pem.clone())),
        ]);
        let answer = self.pc_call("sign_org_storage", &body)?;
        let out = self.hub.sd_storage_take_signed(answer.get("signed"))?;
        log_info(&format!("org_storage_signed org={} seq={} by={}", pj::s(&out, "org"), pj::as_int(out.get("seq")).unwrap_or(0), who.principal));
        Ok(out)
    }

    /// `POST /v1/apps/c/renew {csr_pem, proof, ts}`: the signer's `sign_service_renewal` with the caller's
    /// certificate; its answer passes through.
    pub fn pc_apps_renew(&self, who: &Identity, body: &Obj) -> R<Obj> {
        if (who.kind != "app" && who.kind != "archive") || who.cert_pem.is_empty() {
            return m::forbidden(pc::APPS_ONLY);
        }
        let request = obj([
            ("cert_pem", Value::from(who.cert_pem.clone())),
            ("csr_pem", body.get("csr_pem").cloned().unwrap_or(Value::Null)),
            ("proof", Value::from(pj::s(body, "proof"))),
            ("ts", proof_ts(body.get("ts"))),
        ]);
        let answer = self.pc_call("sign_service_renewal", &request)?;
        log_info(&format!("apps_renew principal={} kind={} state={}", who.principal, who.kind, m::kv_of(answer.get("state"))));
        Ok(answer)
    }

    /// `POST /v1/sso/c/sign {op, ...}`: `sign_sso_enrollment`, `sso_bind` or `sso_log`, forwarded to the signer with
    /// the service's own certificate.
    pub fn pc_sso_sign(&self, who: &Identity, body: &Obj) -> R<Obj> {
        if who.kind != "sso" {
            return m::forbidden(pc::SSO_ONLY);
        }
        let op = pj::text_of(body, "op");
        if !body.get("op").map(Value::is_string).unwrap_or(false) || !pc::SSO_OPS.contains(&op.as_str()) {
            return m::forbidden(pc::SSO_ROUTES_ONLY);
        }
        pc_own_cert(who, body)?;
        // ID-1 (1.5): the importer's and the poller's ledger lines name a provider registered to this service
        let event = pj::text_of(body, "event");
        if op == "sso_log" && (event == "idp_proposal" || event == "directory_deactivate") {
            let detail = body.get("detail").and_then(Value::as_object).cloned().unwrap_or_default();
            let field = |k: &str| detail.get(k).and_then(Value::as_str).unwrap_or_default().to_string();
            self.hub.pc_check_registered(who, &field("org"), &field("provider"), pc::LOG_REFUSED)?;
        }
        let forwarded: Obj = body.iter().filter(|(k, _)| k.as_str() != "op").map(|(k, v)| (k.clone(), v.clone())).collect();
        let answer = self.pc_call(&op, &forwarded)?;
        log_info(&format!("sso_sign op={op} service={} state={}", who.serial, m::kv_of(answer.get("state"))));
        Ok(answer)
    }

    /// `POST /v1/sso/c/revoke {principal, at, sso_attestation, cert_pem, approval?, batch?}`: the signer's `revoke`;
    /// what it revoked is applied as an admin's revoke is, and devices hear `crl`.
    pub fn pc_sso_revoke(&self, who: &Identity, body: &Obj) -> R<Obj> {
        pc_own_cert(who, body)?;
        let payload: Obj = ["principal", "at", "sso_attestation", "cert_pem", "approval", "batch"].iter().filter_map(|k| body.get(*k).filter(|v| !v.is_null()).map(|v| (k.to_string(), v.clone()))).collect();
        let answer = self.pc_call("revoke", &payload)?;
        let principal = m::principal(body.get("principal"));
        let serials = self.pc_revoked(&answer, &principal);
        log_info(&format!("sso_revoke principal={principal} service={} certificates={}", who.serial, serials.len()));
        Ok(answer)
    }

    /// `id_chain_pem`: the signer's intermediate (PEM) that issued the caller's certificate; "" when the root issued
    /// it directly.
    pub fn pc_chain_pem(&self, who: &Identity) -> String {
        let Some(leaf) = Cert::from_pem(&who.cert_pem) else { return String::new() };
        let Some(status) = self.hub.signer.as_ref().and_then(|s| s.snapshot()) else { return String::new() };
        let Some(root) = self.client_ca() else { return String::new() };
        for key in ["intermediate_pem", "previous_pem"] {
            let pem = pj::s(&status, key);
            if Cert::from_pem(&pem).is_some_and(|inter| inter.issued_directly_by_root(&root) && leaf.issued_by(&inter)) {
                return pem;
            }
        }
        String::new()
    }

    /// `POST /v1/sso/c/suspend` and `/v1/sso/c/unsuspend` `{principal, org, provider, at, sso_attestation, cert_pem,
    /// approval?}` (ID-1 2.11): checked by the hub (registry, domain, attestation), then the signer's `sso_suspend`
    /// (`lift` for an unsuspend). A suspension takes effect before the signer answers and stays when the signer cannot
    /// be reached (the service sends it again); a signer refusal undoes it. A lift takes effect only once the signer
    /// agrees, and never touches a stale status.
    pub fn pc_sso_suspend(&self, who: &Identity, body: &Obj, lift: bool) -> R<Obj> {
        pc_own_cert(who, body)?;
        let (principal, org, provider, at) = self.hub.pc_suspend_check(who, body, lift)?;
        let mut payload = obj([
            ("principal", Value::from(principal.clone())),
            ("org", Value::from(org.clone())),
            ("provider", Value::from(provider.clone())),
            ("at", Value::from(at)),
            ("cert_pem", Value::from(who.cert_pem.clone())),
            ("lift", Value::Bool(lift)),
        ]);
        for key in ["sso_attestation", "approval"] {
            if let Some(v) = body.get(key).filter(|v| !v.is_null()) {
                payload.insert(key.into(), v.clone());
            }
        }
        if lift {
            self.pc_call("sso_suspend", &payload)?;
            let why = if body.get("sso_attestation").is_some_and(|v| !v.is_null()) { "reactivated" } else { "stopped" };
            let lifted = self.hub.pc_unsuspend(&principal, why);
            return Ok(obj([("ok", Value::Bool(true)), ("state", Value::from("lifted")), ("lifted", Value::Bool(lifted))]));
        }
        let held = self.hub.pc_is_suspended(&principal);
        let dropped = self.hub.pc_suspend(who, &principal, &org, &provider, at);
        match self.pc_call("sso_suspend", &payload) {
            Ok(_) => {}
            // still suspended here; the service sends it again
            Err(e @ E::Unavailable(_)) => return Err(e),
            Err(e) => {
                if !held {
                    self.hub.pc_unsuspend(&principal, "refused by the certificate server");
                }
                return Err(e);
            }
        }
        Ok(obj([("ok", Value::Bool(true)), ("state", Value::from("suspended")), ("dropped", Value::from(dropped))]))
    }

    /// `POST /v1/org/policy/lower {session, lowering, certs_pem}` (an org admin's device; `certs_pem` the two signing
    /// administrators' device certificates): the signer's `lower_identity_rules`; the signed wire is held as the org's
    /// pending lowering and served by `GET /v1/org/policy?org=` (ID-1 3.8).
    pub fn pc_lower_policy(&self, session: &str, who: &Identity, body: &Obj) -> R<Obj> {
        let lowering = body.get("lowering").cloned().unwrap_or(Value::Null);
        let org = lowering.get("org").and_then(Value::as_str).unwrap_or_default().to_string();
        self.hub.pc_check_org_admin(session, who, &org)?;
        if who.cert_pem.is_empty() {
            return m::forbidden("sign from one of your devices");
        }
        let certs = body.get("certs_pem").and_then(Value::as_array).filter(|c| c.len() == 2 && c.iter().all(|x| x.as_str().is_some_and(|s| !s.is_empty())));
        let Some(certs) = certs else { return bad(pc::LOWER_TWO) };
        let request = obj([("lowering", lowering), ("certs_pem", Value::Array(certs.clone()))]);
        let answer = self.pc_call("lower_identity_rules", &request)?;
        let v = self.hub.pc_take_lowering(answer.get("wire"))?;
        log_info(&format!("identity_lowering_signed org={} next_seq={} effective_at={} by={}", v.org, v.next_seq, v.effective_at, who.principal));
        Ok(obj([
            ("org", Value::from(v.org)),
            ("base_seq", Value::from(v.base_seq)),
            ("next_seq", Value::from(v.next_seq)),
            ("effective_at", Value::from(v.effective_at)),
            ("hash", Value::from(v.hash)),
            ("wire", Value::Object(v.wire)),
        ]))
    }

    /// `POST /v1/org/policy/lower/cancel {session, org, base_seq, proof, ts}` (any admin of that org): the signer's
    /// `cancel_identity_lowering`; the signed cancel drops the held lowering.
    pub fn pc_cancel_lowering(&self, session: &str, who: &Identity, body: &Obj) -> R<Obj> {
        let org = body.get("org").and_then(Value::as_str).unwrap_or_default().to_string();
        self.hub.pc_check_org_admin(session, who, &org)?;
        if who.cert_pem.is_empty() {
            return m::forbidden("cancel from one of your devices");
        }
        let Some(base_seq) = pj::as_int(body.get("base_seq")).filter(|n| (0..=(1 << 53) - 1).contains(n)) else {
            return bad("base_seq must be a whole number of seconds");
        };
        let request = obj([
            ("org", Value::from(org)),
            ("base_seq", Value::from(base_seq)),
            ("proof", Value::from(pj::s(body, "proof"))),
            ("ts", proof_ts(body.get("ts"))),
            ("cert_pem", Value::from(who.cert_pem.clone())),
        ]);
        let answer = self.pc_call("cancel_identity_lowering", &request)?;
        let v = self.hub.pc_take_lowering(answer.get("cancel"))?;
        log_info(&format!("identity_lowering_canceled org={} base_seq={} by={}", v.org, v.base_seq, who.principal));
        Ok(obj([("org", Value::from(v.org)), ("base_seq", Value::from(v.base_seq)), ("next_seq", Value::from(v.next_seq)), ("canceled", Value::Bool(true))]))
    }

    /// pc_check_signer_crl: hourly, the signer's newest CRL older than 6 hours (fetched again first) gives admins the
    /// `signer_down` alert with SIGNER_CRL_OLD (and it goes once fresh).
    fn pc_check_signer_crl(&self) {
        *self.pc_last_crl_check.lock() = pj::mono();
        let Some((_, signer_part)) = crl_parts(&self.settings) else { return };
        if self.hub.signer.is_none() {
            return;
        }
        let newest = || pem_blocks(&read_bytes(&signer_part), "X509 CRL").iter().filter_map(|(_, der)| Crl::from_der(der)).map(|c| c.this_update).max();
        let stale = |when: Option<i64>| when.map(|w| pj::now() - w as f64 > pc::SIGNER_CRL_AGE).unwrap_or(false);
        let mut when = newest();
        if stale(when) {
            self.fetch_signer_crl();
            when = newest();
        }
        let old = self.hub.alerts();
        let mut alerts: Vec<Obj> = old.iter().filter(|a| pj::s(a, "error") != pc::SIGNER_CRL_OLD).cloned().collect();
        if stale(when) {
            log_warn(&format!("the certificate server has not issued a revocation list since {}", pj::iso_utc(when.unwrap_or(0))));
            alerts.push(obj([("type", Value::from("signer_down")), ("error", Value::from(pc::SIGNER_CRL_OLD))]));
        }
        if alerts != old {
            self.hub.set_alerts(alerts);
        }
    }
}

// ── AC-2b-D 8.4 (R5-M1): superseded key folders under pki/ ─────────────────────────────────────────────────

/// Note when `hello` first reported the server certificate serial and the signer client serial (last used in a
/// successful certificate server call) now in use, in `pki/reported.json` `{certSerial, certAt, signerSerial,
/// signerAt}` (ms); written only when one changed.
pub fn note_reported(state_dir: &Path, cert_serial: &str, signer_serial: Option<&str>, now_ms: i64) {
    let path = state_dir.join("pki").join(PKI_REPORTED_FILE);
    let mut v = serde_json::from_slice::<Value>(&read_bytes(&path)).ok().and_then(|v| v.as_object().cloned()).unwrap_or_default();
    let mut changed = false;
    if !cert_serial.is_empty() && v.get("certSerial").and_then(Value::as_str) != Some(cert_serial) {
        v.insert("certSerial".into(), Value::from(cert_serial));
        v.insert("certAt".into(), Value::from(now_ms));
        changed = true;
    }
    if let Some(s) = signer_serial.filter(|s| !s.is_empty()) {
        if v.get("signerSerial").and_then(Value::as_str) != Some(s) {
            v.insert("signerSerial".into(), Value::from(s));
            v.insert("signerAt".into(), Value::from(now_ms));
            changed = true;
        }
    }
    if changed {
        if let Err(e) = write_atomic(&path, pj::dumps(&Value::Object(v)).as_bytes()) {
            log_warn(&format!("cannot write {}: {e}", path.display()));
        }
    }
}

/// Overwrite every file of a folder with zeros, then remove the folder.
fn shred_dir(dir: &Path) -> std::io::Result<()> {
    use std::io::Write;
    for entry in std::fs::read_dir(dir)? {
        let p = entry?.path();
        let meta = std::fs::symlink_metadata(&p)?;
        if meta.is_file() {
            let mut f = std::fs::OpenOptions::new().write(true).open(&p)?;
            f.write_all(&vec![0u8; meta.len() as usize])?;
            f.sync_all()?;
        }
    }
    std::fs::remove_dir_all(dir)
}

/// R5-M1: every `pki/<serial>/` folder other than the one `pki/current` links to (and other than an unfinished
/// `new-` folder) is overwritten and deleted once the pair that replaced it was reported in `hello` 7 days ago: the
/// server pair by `certSerial`, a signer client pair by `signerSerial` (which only a successful certificate server
/// call sets). Never earlier, never without `pki/current` as a link. The folders deleted.
pub fn prune_superseded(state_dir: &Path, now_ms: i64) -> Vec<String> {
    let pki = state_dir.join("pki");
    let Ok(target) = std::fs::read_link(crate::fleet_agent::pki_current(state_dir)) else { return Vec::new() };
    let Some(current) = target.file_name().map(|n| n.to_os_string()) else { return Vec::new() };
    let serial_in = |dir: &Path, file: &str| cert_serial(&dir.join(file).to_string_lossy());
    let (cur_cert, cur_signer) = (serial_in(&pki.join(&current), "relay.crt"), serial_in(&pki.join(&current), "signer-client.crt"));
    if cur_cert.is_empty() {
        return Vec::new();
    }
    let rep = serde_json::from_slice::<Value>(&read_bytes(&pki.join(PKI_REPORTED_FILE))).unwrap_or(Value::Null);
    let at = |serial_key: &str, at_key: &str, serial: &str| (!serial.is_empty() && rep.get(serial_key).and_then(Value::as_str) == Some(serial)).then(|| rep.get(at_key).and_then(Value::as_i64)).flatten();
    let (cert_at, signer_at) = (at("certSerial", "certAt", &cur_cert), at("signerSerial", "signerAt", &cur_signer));
    let mut gone = Vec::new();
    let Ok(entries) = std::fs::read_dir(&pki) else { return gone };
    for entry in entries.flatten() {
        let name = entry.file_name();
        if name == current || name.to_string_lossy().starts_with("new-") {
            continue;
        }
        let dir = entry.path();
        if !std::fs::symlink_metadata(&dir).is_ok_and(|m| m.is_dir()) {
            continue;
        }
        let (old_cert, old_signer) = (serial_in(&dir, "relay.crt"), serial_in(&dir, "signer-client.crt"));
        let needs_signer = !old_signer.is_empty() && !cur_signer.is_empty() && old_signer != cur_signer;
        let needs_cert = old_cert != cur_cert || !needs_signer;
        let mut due = Some(0i64);
        for (needed, when) in [(needs_cert, cert_at), (needs_signer, signer_at)] {
            if needed {
                due = due.zip(when).map(|(a, b)| a.max(b));
            }
        }
        let Some(due) = due else { continue };
        if now_ms - due < SUPERSEDED_KEEP_MS {
            continue;
        }
        match shred_dir(&dir) {
            Ok(()) => gone.push(name.to_string_lossy().into_owned()),
            Err(e) => log_warn(&format!("cannot delete {}: {e}", dir.display())),
        }
    }
    gone
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

    // ── AC-2b-D (16.1 d-relay) ──

    use crate::meet_tls::testpki::{dir, pem, Ca, Key};
    use crate::meet_tls::{ROOT_CRL, ROOT_CRL_PENDING};

    const DAY_MS: i64 = 86_400_000;

    fn fleet_pki_relay(ca: &Ca, fleet_pki: bool) -> (Arc<Relay>, std::path::PathBuf) {
        let state = dir("ops");
        std::fs::create_dir_all(state.join("pki")).unwrap();
        std::fs::write(state.join("pki").join("ca.crt"), ca.pem()).unwrap();
        let s = m::Settings { state_dir: state.to_string_lossy().into_owned(), client_ca: state.join("pki").join("ca.crt").to_string_lossy().into_owned(), fleet_pki, ..m::Settings::default() };
        (crate::meet::test_relay(s), state)
    }

    /// 8.5 (R2-L8, D9): a fleet_pki relay takes its CA's root CRL only from the Admin Console: one from the certificate
    /// server is refused (`why: "path"`) and leaves nothing; a relay without fleet_pki keeps taking it.
    #[test]
    fn ac2b_fleet_pki_takes_root_crls_only_from_the_console() {
        let ca = Ca::new("Lucid Meet CA");
        let t = pj::now() as i64;
        let list = Value::from(ca.crl_pem(t - 300, t + 120 * 86_400, &[&[0x44]], Some(&[1])));
        let (managed, state) = fleet_pki_relay(&ca, true);
        assert!(!managed.store_root_crl(Some(&list)));
        assert!(!state.join(ROOT_CRL).exists());
        let (plain, plain_state) = fleet_pki_relay(&ca, false);
        assert!(plain.store_root_crl(Some(&list)));
        assert!(plain_state.join(ROOT_CRL).exists());
        // the channel's list is taken on the fleet_pki relay, a later one waits while not yet current
        assert_eq!(managed.adopt_root_crl(list.as_str().unwrap().as_bytes()), Ok(Placed::Current));
        assert!(state.join(ROOT_CRL).exists() && state.join("crl.pem").exists());
        assert_eq!(managed.adopt_root_crl(ca.crl_pem(t + 120, t + 120 * 86_400, &[], Some(&[2])).as_bytes()), Ok(Placed::Pending));
        assert!(state.join(ROOT_CRL_PENDING).exists());
        assert_eq!(managed.adopt_root_crl(ca.crl_pem(t + 600, t + 120 * 86_400, &[], Some(&[3])).as_bytes()).unwrap_err(), "future");
        // with a fixed `crl` file the relay takes no pushed list
        let fixed = crate::meet::test_relay(m::Settings { crl: state.join("fixed.pem").to_string_lossy().into_owned(), ..managed.settings.clone() });
        assert_eq!(fixed.adopt_root_crl(list.as_str().unwrap().as_bytes()).unwrap_err(), "fixed");
    }

    /// 9.3 `meetPki` and R5-M1: the certificate in `pki/current` is reported, and its first report is noted.
    #[test]
    fn ac2b_meet_pki_reports_the_current_pair() {
        let ca = Ca::new("Lucid Meet CA");
        let (relay, state) = fleet_pki_relay(&ca, true);
        let current = crate::fleet_agent::pki_current(&state);
        std::fs::create_dir_all(&current).unwrap();
        std::fs::write(current.join("relay.crt"), pem("CERTIFICATE", &ca.leaf(&[0x2b], "relay.example.org", None, &[], &Key::new(), false))).unwrap();
        let r = relay.meet_pki_report();
        let id = crate::license::meet_root_id(&Cert::from_der(&ca.der).unwrap().spki);
        assert_eq!((r["caId"].as_str(), r["certSerial"].as_str()), (Some(id.as_str()), Some("2b")));
        assert_eq!((r["signerSerial"].clone(), r["signerCrlEnforced"].clone(), r["signerHeld"].clone()), (Value::Null, Value::Bool(false), Value::Null));
        let noted: Value = serde_json::from_slice(&std::fs::read(state.join("pki").join(PKI_REPORTED_FILE)).unwrap()).unwrap();
        assert_eq!(noted["certSerial"], "2b");
    }

    /// R5-M1, D19: a superseded `pki/<serial>/` folder is overwritten and deleted 7 days after the newer pair was
    /// reported (a signer client pair: after a successful certificate server call with the new one was reported),
    /// never earlier, never the folder `current` links to, never an unfinished `new-` folder.
    #[cfg(unix)]
    #[test]
    fn ac2b_superseded_key_folders_go_seven_days_after_the_report() {
        let ca = Ca::new("Lucid Meet CA");
        let state = dir("prune");
        let pki = state.join("pki");
        let folder = |name: &str, server: &[u8], signer: Option<&[u8]>| {
            let d = pki.join(name);
            std::fs::create_dir_all(&d).unwrap();
            std::fs::write(d.join("relay.crt"), pem("CERTIFICATE", &ca.leaf(server, "relay.example.org", None, &[], &Key::new(), false))).unwrap();
            std::fs::write(d.join("relay.key"), "key").unwrap();
            if let Some(s) = signer {
                std::fs::write(d.join("signer-client.crt"), pem("CERTIFICATE", &ca.leaf(s, "Lucid Meet Relay", None, &[m::RELAY_URI], &Key::new(), true))).unwrap();
                std::fs::write(d.join("signer-client.key"), "key").unwrap();
            }
        };
        let switch = |name: &str| {
            let tmp = pki.join("current.next");
            std::os::unix::fs::symlink(name, &tmp).unwrap();
            std::fs::rename(&tmp, crate::fleet_agent::pki_current(&state)).unwrap();
        };
        folder("1a", &[0x1a], Some(&[0x5a]));
        folder("2b", &[0x2b], Some(&[0x5a]));
        switch("2b");
        let t0 = 1_900_000_000_000i64;
        assert!(prune_superseded(&state, t0 + 30 * DAY_MS).is_empty(), "nothing before the newer pair was reported");
        note_reported(&state, "2b", None, t0);
        assert!(prune_superseded(&state, t0 + SUPERSEDED_KEEP_MS - 1).is_empty());
        assert_eq!(prune_superseded(&state, t0 + SUPERSEDED_KEEP_MS), vec!["1a".to_string()]);
        assert!(!pki.join("1a").exists() && pki.join("2b").join("relay.crt").exists());
        // a signer client renewal: the server pair copied; the old folder waits for the new signer serial's report
        folder("2b-6b", &[0x2b], Some(&[0x6b]));
        switch("2b-6b");
        note_reported(&state, "2b", Some("5a"), t0 + 8 * DAY_MS);
        assert!(prune_superseded(&state, t0 + 100 * DAY_MS).is_empty(), "the old signer pair stays until the new one was used");
        let t1 = t0 + 101 * DAY_MS;
        note_reported(&state, "2b", Some("6b"), t1);
        assert!(prune_superseded(&state, t1 + SUPERSEDED_KEEP_MS - 1).is_empty());
        folder("new-x", &[0x01], None);
        assert_eq!(prune_superseded(&state, t1 + SUPERSEDED_KEEP_MS), vec!["2b".to_string()]);
        assert!(pki.join("2b-6b").join("relay.crt").exists() && pki.join("new-x").exists());
        assert!(prune_superseded(&state, t1 + 1000 * DAY_MS).is_empty(), "never the folder current links to");
    }
}
