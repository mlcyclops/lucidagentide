// Sealed secrets (contract AC-1 3.11 "Sealed secrets" and "Backup and recovery"; R3-M2, R4-H2, R4-M2, R5-M1,
// R5-M2; I12 and I16). `console-secrets.json` (owner-only) holds every secret sealed with AES-256-GCM (AWS-LC)
// under a 32-byte per-console data key, with a random 96-bit nonce and the secret's name as the additional data.
// The data key is stored only wrapped by a key-encryption key that a provider holds outside the state folder. The
// relay picks the first available provider the profile allows, in this order:
// - `dpapi-service`: Windows, the process token's user is `NT SERVICE\LucidRelay`; user-scope DPAPI.
// - `dpapi-machine`: Windows, DPAPI with CRYPTPROTECT_LOCAL_MACHINE; Standard only.
// - `systemd-credential`: `$CREDENTIALS_DIRECTORY/lucid-console-kek` (32 bytes) wraps the data key by AES-256-GCM;
//   under High only outside a container and with a root-owned install record naming a real key mode and the
//   encrypted credential file with its SHA-256.
// - `key-file`: the adjacent `console-seal.key` (32 random bytes, 0600, owned by the relay's account); Standard
//   only for secrets, under High kept for the decoy key alone.
// The provider's name is stored with the wrapped key, so a changed provider counts as a lost key. A data key that
// does not unwrap (a restore to another host, another service account, a lost key-encryption key) is replaced and
// every old sealed value is dropped: the caller raises `seal-lost`. No function here logs anything, and none
// returns a secret except `get`, which returns the unsealed value to its caller.

use crate::codec::{b64u, exact_keys, num_is, parse_json, sha256_hex, str_of, stringify, unb64u};
#[cfg(unix)]
use crate::codec::{iso_time, now_ms};
use aws_lc_rs::aead;
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};

pub const SECRETS_FILE: &str = "console-secrets.json";
pub const KEY_FILE: &str = "console-seal.key";
pub const KEK_CREDENTIAL: &str = "lucid-console-kek";
/// The virtual service account `dpapi-service` needs (R4-H2).
pub const SERVICE_ACCOUNT: &str = "NT SERVICE\\LucidRelay";
/// The Windows service name whose virtual account is `SERVICE_ACCOUNT` (virtual accounts are `NT SERVICE\<name>`).
#[cfg_attr(not(windows), allow(dead_code))]
pub const WINDOWS_SERVICE: &str = "LucidRelay";
/// The systemd install record written by `seal_setup` (R4-M2, R5-M1).
pub const RECORD_PATH: &str = "/etc/lucid-relay/seal-provider.json";

/// `seal_setup` writes `lucid-console-kek.cred` and `seal-provider.json` here.
#[cfg_attr(not(unix), allow(dead_code))]
const ETC_DIR: &str = "/etc/lucid-relay";
#[cfg_attr(not(unix), allow(dead_code))]
const UNIT_DIR: &str = "/etc/systemd/system";
#[cfg_attr(not(unix), allow(dead_code))]
const DROP_IN: &str = "lucid-console-seal.conf";
const VERSION: f64 = 1.0;
const KEYS: [&str; 4] = ["v", "provider", "dataKey", "secrets"];
const RECORD_KEYS: [&str; 6] = ["provider", "keyMode", "credential", "credentialPath", "credentialSha256", "createdAt"];
const KEY_MODES: [&str; 2] = ["tpm2+host", "host"];
/// Bound into the wrapping of the data key (AES-256-GCM additional data, DPAPI entropy) with the provider's name.
const WRAP_LABEL: &[u8] = b"lucid-console-seal-v1";
const KEY_LEN: usize = 32;
const NONCE_LEN: usize = 12;
const TAG_LEN: usize = 16;
const RECORD_MAX: u64 = 64 * 1024;
const RANDOM_FAILED: &str = "the relay could not draw random bytes";

// Refusal codes of `refused_providers()`; the page maps each to its 8.1 `seal.provider` `<why>` words.
const WHY_NOT_SERVICE: &str = "not-service-account";
const WHY_CONTAINER: &str = "container";
const WHY_RECORD_MISSING: &str = "record-missing";
/// Also an install record that does not read back or names another provider or credential.
const WHY_NO_KEY: &str = "record-null-key";
/// Also a record writable by anyone but root.
#[cfg_attr(not(unix), allow(dead_code))]
const WHY_NOT_ROOT: &str = "record-not-root";
const WHY_CREDENTIAL_MISSING: &str = "credential-missing";
const WHY_CREDENTIAL_CHANGED: &str = "credential-mismatch";
const WHY_KEY_FILE: &str = "key-file-refused";

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Provider {
    DpapiService,
    DpapiMachine,
    SystemdCredential,
    KeyFile,
}

impl Provider {
    pub fn as_str(self) -> &'static str {
        match self {
            Provider::DpapiService => "dpapi-service",
            Provider::DpapiMachine => "dpapi-machine",
            Provider::SystemdCredential => "systemd-credential",
            Provider::KeyFile => "key-file",
        }
    }

    fn parse(s: &str) -> Option<Provider> {
        match s {
            "dpapi-service" => Some(Provider::DpapiService),
            "dpapi-machine" => Some(Provider::DpapiMachine),
            "systemd-credential" => Some(Provider::SystemdCredential),
            "key-file" => Some(Provider::KeyFile),
            _ => None,
        }
    }
}

/// Overwrite bytes with zeros in a way the compiler keeps.
fn wipe(b: &mut [u8]) {
    for x in b.iter_mut() {
        // SAFETY: `x` is a valid, aligned, exclusive reference to one byte.
        unsafe { std::ptr::write_volatile(x, 0) };
    }
    std::sync::atomic::compiler_fence(std::sync::atomic::Ordering::SeqCst);
}

/// 32 bytes of key material, zeroed when dropped.
struct Key32([u8; KEY_LEN]);

impl Key32 {
    fn random() -> Result<Key32, String> {
        let mut k = Key32([0u8; KEY_LEN]);
        aws_lc_rs::rand::fill(&mut k.0).map_err(|_| RANDOM_FAILED.to_string())?;
        Ok(k)
    }

    fn from_slice(b: &[u8]) -> Option<Key32> {
        if b.len() != KEY_LEN {
            return None;
        }
        let mut k = Key32([0u8; KEY_LEN]);
        k.0.copy_from_slice(b);
        Some(k)
    }
}

impl Drop for Key32 {
    fn drop(&mut self) {
        wipe(&mut self.0);
    }
}

/// `nonce || ciphertext || tag` under AES-256-GCM with a random 96-bit nonce.
fn gcm_seal(key: &[u8; KEY_LEN], aad: &[u8], plain: &[u8]) -> Result<Vec<u8>, String> {
    let mut nonce = [0u8; NONCE_LEN];
    aws_lc_rs::rand::fill(&mut nonce).map_err(|_| RANDOM_FAILED.to_string())?;
    let k = aead::LessSafeKey::new(aead::UnboundKey::new(&aead::AES_256_GCM, key).map_err(|_| "the seal key could not be made".to_string())?);
    let mut out = Vec::with_capacity(NONCE_LEN + plain.len() + TAG_LEN);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(plain);
    match k.seal_in_place_separate_tag(aead::Nonce::assume_unique_for_key(nonce), aead::Aad::from(aad), &mut out[NONCE_LEN..]) {
        Ok(tag) => {
            out.extend_from_slice(tag.as_ref());
            Ok(out)
        }
        Err(_) => {
            wipe(&mut out);
            Err("a value could not be sealed".to_string())
        }
    }
}

/// The plaintext of `nonce || ciphertext || tag`, or None when it does not authenticate.
fn gcm_open(key: &[u8; KEY_LEN], aad: &[u8], sealed: &[u8]) -> Option<Vec<u8>> {
    if sealed.len() < NONCE_LEN + TAG_LEN {
        return None;
    }
    let k = aead::LessSafeKey::new(aead::UnboundKey::new(&aead::AES_256_GCM, key).ok()?);
    let mut nonce = [0u8; NONCE_LEN];
    nonce.copy_from_slice(&sealed[..NONCE_LEN]);
    let mut buf = sealed[NONCE_LEN..].to_vec();
    let n = match k.open_in_place(aead::Nonce::assume_unique_for_key(nonce), aead::Aad::from(aad), &mut buf) {
        Ok(plain) => plain.len(),
        Err(_) => {
            wipe(&mut buf);
            return None;
        }
    };
    wipe(&mut buf[n..]);
    buf.truncate(n);
    Some(buf)
}

/// The additional data (AES-256-GCM) or entropy (DPAPI) of the wrapped data key: the label and the provider.
fn wrap_aad(p: Provider) -> Vec<u8> {
    crate::meet_org_policy::lp(&[WRAP_LABEL, p.as_str().as_bytes()])
}

#[cfg(windows)]
mod win {
    use std::ffi::c_void;

    #[repr(C)]
    struct Blob {
        cb_data: u32,
        pb_data: *mut u8,
    }

    const CRYPTPROTECT_UI_FORBIDDEN: u32 = 0x1;
    const CRYPTPROTECT_LOCAL_MACHINE: u32 = 0x4;
    const TOKEN_QUERY: u32 = 0x0008;
    /// TOKEN_INFORMATION_CLASS TokenUser.
    const TOKEN_USER: u32 = 1;

    #[link(name = "crypt32")]
    extern "system" {
        fn CryptProtectData(data_in: *const Blob, description: *const u16, entropy: *const Blob, reserved: *mut c_void, prompt: *mut c_void, flags: u32, data_out: *mut Blob) -> i32;
        fn CryptUnprotectData(data_in: *const Blob, description: *mut *mut u16, entropy: *const Blob, reserved: *mut c_void, prompt: *mut c_void, flags: u32, data_out: *mut Blob) -> i32;
    }

    #[link(name = "advapi32")]
    extern "system" {
        fn OpenProcessToken(process: *mut c_void, access: u32, token: *mut *mut c_void) -> i32;
        fn GetTokenInformation(token: *mut c_void, class: u32, info: *mut c_void, len: u32, ret_len: *mut u32) -> i32;
        fn LookupAccountSidW(system: *const u16, sid: *mut c_void, name: *mut u16, name_len: *mut u32, domain: *mut u16, domain_len: *mut u32, sid_use: *mut u32) -> i32;
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn LocalFree(mem: *mut c_void) -> *mut c_void;
        fn GetCurrentProcess() -> *mut c_void;
        fn CloseHandle(handle: *mut c_void) -> i32;
    }

    fn blob(b: &[u8]) -> Option<Blob> {
        Some(Blob { cb_data: u32::try_from(b.len()).ok()?, pb_data: b.as_ptr() as *mut u8 })
    }

    /// Copy DPAPI's output, wipe it when asked, and give it back with LocalFree.
    fn take(out: &Blob, secret: bool) -> Vec<u8> {
        if out.pb_data.is_null() {
            return Vec::new();
        }
        // SAFETY: on success DPAPI returns `cb_data` bytes at `pb_data`, allocated with LocalAlloc and owned by us.
        let bytes = unsafe { std::slice::from_raw_parts_mut(out.pb_data, out.cb_data as usize) };
        let v = bytes.to_vec();
        if secret {
            super::wipe(bytes);
        }
        // SAFETY: `pb_data` came from DPAPI's LocalAlloc and is freed exactly once.
        unsafe { LocalFree(out.pb_data as *mut c_void) };
        v
    }

    /// DPAPI: user scope (only this account can unprotect, `dpapi-service`) or machine scope (any account on this
    /// computer, `dpapi-machine`).
    pub fn protect(plain: &[u8], entropy: &[u8], machine: bool) -> Option<Vec<u8>> {
        let (input, ent) = (blob(plain)?, blob(entropy)?);
        let mut out = Blob { cb_data: 0, pb_data: std::ptr::null_mut() };
        let flags = if machine { CRYPTPROTECT_UI_FORBIDDEN | CRYPTPROTECT_LOCAL_MACHINE } else { CRYPTPROTECT_UI_FORBIDDEN };
        // SAFETY: every pointer is valid for the call; the optional ones are null; `out` receives a LocalAlloc buffer.
        let ok = unsafe { CryptProtectData(&input, std::ptr::null(), &ent, std::ptr::null_mut(), std::ptr::null_mut(), flags, &mut out) };
        if ok == 0 {
            return None;
        }
        Some(take(&out, false))
    }

    pub fn unprotect(wrapped: &[u8], entropy: &[u8]) -> Option<Vec<u8>> {
        let (input, ent) = (blob(wrapped)?, blob(entropy)?);
        let mut out = Blob { cb_data: 0, pb_data: std::ptr::null_mut() };
        // SAFETY: as in `protect`; the description pointer is optional and null.
        let ok = unsafe { CryptUnprotectData(&input, std::ptr::null_mut(), &ent, std::ptr::null_mut(), std::ptr::null_mut(), CRYPTPROTECT_UI_FORBIDDEN, &mut out) };
        if ok == 0 {
            return None;
        }
        Some(take(&out, true))
    }

    /// The process token's user as `DOMAIN\name` (for a virtual service account `NT SERVICE\<service>`).
    pub fn token_user() -> Option<String> {
        let mut token: *mut c_void = std::ptr::null_mut();
        // SAFETY: GetCurrentProcess returns a pseudo handle; `token` receives a handle closed below.
        if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
            return None;
        }
        // TOKEN_USER (a SID_AND_ATTRIBUTES whose first field is the SID pointer) and the SID it points to; 8-aligned.
        let mut buf = [0u64; 128];
        let mut len = 0u32;
        // SAFETY: `buf` is writable for the length given; `token` is a valid token handle.
        let ok = unsafe { GetTokenInformation(token, TOKEN_USER, buf.as_mut_ptr() as *mut c_void, std::mem::size_of_val(&buf) as u32, &mut len) };
        // SAFETY: `token` came from OpenProcessToken and is closed once.
        unsafe { CloseHandle(token) };
        if ok == 0 {
            return None;
        }
        // SAFETY: on success `buf` starts with TOKEN_USER, whose first field is the PSID (pointing inside `buf`).
        let sid = unsafe { *(buf.as_ptr() as *const *mut c_void) };
        let mut name = [0u16; 256];
        let mut domain = [0u16; 256];
        let (mut name_len, mut domain_len, mut sid_use) = (name.len() as u32, domain.len() as u32, 0u32);
        // SAFETY: `sid` is valid while `buf` lives; the name buffers are writable for the lengths given.
        let ok = unsafe { LookupAccountSidW(std::ptr::null(), sid, name.as_mut_ptr(), &mut name_len, domain.as_mut_ptr(), &mut domain_len, &mut sid_use) };
        if ok == 0 {
            return None;
        }
        let name = String::from_utf16_lossy(&name[..(name_len as usize).min(name.len())]);
        let domain = String::from_utf16_lossy(&domain[..(domain_len as usize).min(domain.len())]);
        Some(format!("{domain}\\{name}"))
    }
}

#[cfg(windows)]
fn dpapi_protect(plain: &[u8], entropy: &[u8], machine: bool) -> Option<Vec<u8>> {
    win::protect(plain, entropy, machine)
}

#[cfg(windows)]
fn dpapi_unprotect(wrapped: &[u8], entropy: &[u8]) -> Option<Vec<u8>> {
    win::unprotect(wrapped, entropy)
}

#[cfg(not(windows))]
fn dpapi_protect(_plain: &[u8], _entropy: &[u8], _machine: bool) -> Option<Vec<u8>> {
    None
}

#[cfg(not(windows))]
fn dpapi_unprotect(_wrapped: &[u8], _entropy: &[u8]) -> Option<Vec<u8>> {
    None
}

#[cfg(unix)]
extern "C" {
    fn geteuid() -> u32;
}

/// What the relay looks at to pick a provider. Production uses `Host::real()`; tests build their own, so there is
/// no switch a deployment can turn.
struct Host {
    /// The DPAPI providers are considered (Windows), else the systemd one.
    windows: bool,
    /// The process token's user, `DOMAIN\name` (Windows).
    account: Option<String>,
    /// The systemd install record.
    record: PathBuf,
    /// Files whose presence means a container.
    markers: Vec<PathBuf>,
    /// The owner the install record must have (root).
    root_uid: u32,
}

impl Host {
    fn real() -> Host {
        #[cfg(windows)]
        let account = win::token_user();
        #[cfg(not(windows))]
        let account = None;
        Host {
            windows: cfg!(windows),
            account,
            record: PathBuf::from(RECORD_PATH),
            markers: vec![PathBuf::from("/run/systemd/container"), PathBuf::from("/.dockerenv")],
            root_uid: 0,
        }
    }
}

/// Container detection (R4-M2): a `container` environment variable or a marker file.
fn in_container(env: &dyn Fn(&str) -> Option<String>, host: &Host) -> bool {
    env("container").is_some_and(|v| !v.is_empty()) || host.markers.iter().any(|m| std::fs::symlink_metadata(m).is_ok())
}

/// The install record as written by `seal_setup`.
#[cfg_attr(not(unix), allow(dead_code))]
fn record_json(key_mode: &str, credential_path: &str, credential_sha256: &str, created_at: &str) -> Value {
    let mut o = Map::new();
    o.insert("provider".to_string(), Value::from(Provider::SystemdCredential.as_str()));
    o.insert("keyMode".to_string(), Value::from(key_mode));
    o.insert("credential".to_string(), Value::from(KEK_CREDENTIAL));
    o.insert("credentialPath".to_string(), Value::from(credential_path));
    o.insert("credentialSha256".to_string(), Value::from(credential_sha256));
    o.insert("createdAt".to_string(), Value::from(created_at));
    Value::Object(o)
}

/// A record that passed every check of 3.11 (R4-M2, R5-M1).
struct Record {
    key_mode: String,
    /// Checked (exists, SHA-256 matches) by `check_record` at every open; read again only by the Linux `seal_setup`,
    /// which keeps a credential whose record still passes.
    #[cfg_attr(not(unix), allow(dead_code))]
    credential_path: PathBuf,
}

/// The install record's checks: present, a regular file owned by `root_uid` and writable by nobody else (unix),
/// naming `systemd-credential`, `lucid-console-kek`, a real key mode, and an encrypted credential file that exists
/// and whose SHA-256 matches. Err holds the 8.1 `<why>`.
fn check_record(path: &Path, root_uid: u32) -> Result<Record, &'static str> {
    let file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(WHY_RECORD_MISSING),
        Err(_) => return Err(WHY_NO_KEY),
    };
    let meta = file.metadata().map_err(|_| WHY_NO_KEY)?;
    if !meta.is_file() {
        return Err(WHY_NO_KEY);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if meta.uid() != root_uid || meta.mode() & 0o022 != 0 {
            return Err(WHY_NOT_ROOT);
        }
    }
    #[cfg(not(unix))]
    let _ = root_uid;
    let mut text = String::new();
    file.take(RECORD_MAX).read_to_string(&mut text).map_err(|_| WHY_NO_KEY)?;
    let v = parse_json(&text).ok_or(WHY_NO_KEY)?;
    let o = v.as_object().ok_or(WHY_NO_KEY)?;
    if !exact_keys(o, &RECORD_KEYS, &RECORD_KEYS)
        || str_of(o.get("provider")) != Some(Provider::SystemdCredential.as_str())
        || str_of(o.get("credential")) != Some(KEK_CREDENTIAL)
    {
        return Err(WHY_NO_KEY);
    }
    let key_mode = str_of(o.get("keyMode")).filter(|m| KEY_MODES.contains(m)).ok_or(WHY_NO_KEY)?;
    let credential_path = str_of(o.get("credentialPath")).map(PathBuf::from).filter(|p| p.is_absolute()).ok_or(WHY_CREDENTIAL_MISSING)?;
    let want = str_of(o.get("credentialSha256")).ok_or(WHY_CREDENTIAL_CHANGED)?;
    let bytes = match std::fs::read(&credential_path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(WHY_CREDENTIAL_MISSING),
        Err(_) => return Err(WHY_CREDENTIAL_CHANGED),
    };
    if sha256_hex(&bytes) != want {
        return Err(WHY_CREDENTIAL_CHANGED);
    }
    Ok(Record { key_mode: key_mode.to_string(), credential_path })
}

/// `console-seal.key`: None when it does not exist yet; Err(why) when it must not be used (the caller logs
/// `console.seal-refused`): a symbolic link, not a regular file, group or other access, another owner, or not 32
/// bytes.
fn read_key_file(path: &Path) -> Result<Option<Key32>, String> {
    match std::fs::symlink_metadata(path) {
        Ok(m) if m.file_type().is_symlink() => return Err(format!("{KEY_FILE} is a symbolic link")),
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("{KEY_FILE} could not be read: {e}")),
    }
    let file = std::fs::File::open(path).map_err(|e| format!("{KEY_FILE} could not be read: {e}"))?;
    let meta = file.metadata().map_err(|e| format!("{KEY_FILE} could not be read: {e}"))?;
    if !meta.is_file() {
        return Err(format!("{KEY_FILE} is not a regular file"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if meta.mode() & 0o077 != 0 {
            return Err(format!("{KEY_FILE} allows group or other access (mode {:o}); it must be 600", meta.mode() & 0o777));
        }
        // SAFETY: geteuid has no preconditions and cannot fail.
        if meta.uid() != unsafe { geteuid() } {
            return Err(format!("{KEY_FILE} is not owned by the relay's account"));
        }
    }
    let mut bytes = Vec::with_capacity(KEY_LEN + 1);
    let read = file.take(KEY_LEN as u64 + 1).read_to_end(&mut bytes);
    let key = Key32::from_slice(&bytes);
    wipe(&mut bytes);
    read.map_err(|e| format!("{KEY_FILE} could not be read: {e}"))?;
    key.map(Some).ok_or_else(|| format!("{KEY_FILE} is not {KEY_LEN} bytes"))
}

/// The systemd credential when `$CREDENTIALS_DIRECTORY/lucid-console-kek` holds exactly 32 bytes.
fn read_credential(env: &dyn Fn(&str) -> Option<String>) -> Option<Key32> {
    let dir = env("CREDENTIALS_DIRECTORY").filter(|d| !d.is_empty())?;
    let mut bytes = std::fs::read(Path::new(&dir).join(KEK_CREDENTIAL)).ok()?;
    let key = Key32::from_slice(&bytes);
    wipe(&mut bytes);
    key
}

/// The provider picked for a profile, with the refusals of the earlier ones.
struct Pick {
    provider: Provider,
    kek: Option<Key32>,
    refused: Option<String>,
    refused_providers: Vec<(&'static str, &'static str)>,
    compliant: bool,
    key_mode: Option<String>,
}

fn chosen(provider: Provider, kek: Option<Key32>, compliant: bool, key_mode: Option<String>, refused_providers: Vec<(&'static str, &'static str)>) -> Pick {
    Pick { provider, kek, refused: None, refused_providers, compliant, key_mode }
}

/// The first available provider the profile allows (3.11). A provider that is simply absent (no DPAPI off
/// Windows, no systemd credential delivered) or not allowed by the profile (`dpapi-machine` under High, which has
/// no refusal code) is not listed as refused.
fn pick(state_dir: &Path, env: &dyn Fn(&str) -> Option<String>, high: bool, host: &Host) -> Pick {
    let mut no: Vec<(&'static str, &'static str)> = Vec::new();
    if host.windows {
        if host.account.as_deref().is_some_and(|a| a.eq_ignore_ascii_case(SERVICE_ACCOUNT)) {
            return chosen(Provider::DpapiService, None, true, None, no);
        }
        no.push((Provider::DpapiService.as_str(), WHY_NOT_SERVICE));
        if !high {
            return chosen(Provider::DpapiMachine, None, false, None, no);
        }
    } else if let Some(kek) = read_credential(env) {
        let record = check_record(&host.record, host.root_uid);
        let key_mode = record.as_ref().ok().map(|r| r.key_mode.clone());
        let why = if in_container(env, host) { Some(WHY_CONTAINER) } else { record.err() };
        match why {
            None => return chosen(Provider::SystemdCredential, Some(kek), true, key_mode, no),
            Some(_) if !high => return chosen(Provider::SystemdCredential, Some(kek), false, key_mode, no),
            Some(why) => no.push((Provider::SystemdCredential.as_str(), why)),
        }
    }
    let (kek, refused) = match read_key_file(&state_dir.join(KEY_FILE)) {
        Ok(k) => (k, None),
        Err(why) => {
            no.push((Provider::KeyFile.as_str(), WHY_KEY_FILE));
            (None, Some(why))
        }
    };
    Pick { provider: Provider::KeyFile, kek, refused, refused_providers: no, compliant: false, key_mode: None }
}

/// The file as stored: a provider name, the wrapped data key and the sealed values (base64url, no padding).
struct Stored {
    provider: Provider,
    data_key: String,
    secrets: BTreeMap<String, String>,
}

/// None when the file does not exist; Err(why) when it exists and does not read back.
fn read_stored(path: &Path) -> Result<Option<Stored>, String> {
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("{SECRETS_FILE} could not be read: {e}")),
    };
    let bad = || format!("{SECRETS_FILE} does not read back");
    let v = std::str::from_utf8(&bytes).ok().and_then(parse_json).ok_or_else(bad)?;
    let o = v.as_object().ok_or_else(bad)?;
    if !exact_keys(o, &KEYS, &KEYS) || !num_is(o.get("v"), VERSION) {
        return Err(bad());
    }
    let provider = str_of(o.get("provider")).and_then(Provider::parse).ok_or_else(bad)?;
    let data_key = str_of(o.get("dataKey")).filter(|s| unb64u(s).is_some_and(|b| !b.is_empty())).ok_or_else(bad)?.to_string();
    let mut secrets = BTreeMap::new();
    for (name, value) in o.get("secrets").and_then(Value::as_object).ok_or_else(bad)? {
        let sealed = value.as_str().filter(|s| unb64u(s).is_some_and(|b| b.len() >= NONCE_LEN + TAG_LEN)).ok_or_else(bad)?;
        if name.is_empty() {
            return Err(bad());
        }
        secrets.insert(name.clone(), sealed.to_string());
    }
    Ok(Some(Stored { provider, data_key, secrets }))
}

/// The console's sealed secrets. Holds the data key (zeroed on drop), never a plaintext value.
pub struct Seal {
    path: PathBuf,
    key_path: PathBuf,
    provider: Provider,
    /// The key-encryption key of `systemd-credential` and `key-file` (None for DPAPI, and for a key file not yet made).
    kek: Option<Key32>,
    /// None only while the key file is refused.
    data_key: Option<Key32>,
    /// The wrapped data key as stored, once made.
    wrapped: Option<String>,
    secrets: BTreeMap<String, String>,
    lost: bool,
    refused: Option<String>,
    refused_providers: Vec<(&'static str, &'static str)>,
    compliant: bool,
    key_mode: Option<String>,
}

impl Seal {
    /// Reads console-secrets.json (owner-only) from state_dir. Err(why) when the file exists and does not read back
    /// (the console then answers 503 state-unreadable). Picks the first available provider `high` allows, in the
    /// order dpapi-service, dpapi-machine (Standard), systemd-credential (under High with every check), key-file.
    /// A data key that cannot be unwrapped (key-encryption key missing or different, another service account, or a
    /// changed provider) gives Ok with `lost()` true: a new data key is drawn, every old sealed value is dropped
    /// and the file is rewritten. No file yet: a new data key, written on the first put. A key file that must not
    /// be used gives Ok with `refused()` set: nothing unseals and nothing is written.
    pub fn open(state_dir: &Path, env: &dyn Fn(&str) -> Option<String>, high: bool) -> Result<Seal, String> {
        Seal::open_with(state_dir, env, high, &Host::real())
    }

    fn open_with(state_dir: &Path, env: &dyn Fn(&str) -> Option<String>, high: bool, host: &Host) -> Result<Seal, String> {
        let path = state_dir.join(SECRETS_FILE);
        let key_path = state_dir.join(KEY_FILE);
        let stored = read_stored(&path)?;
        let p = pick(state_dir, env, high, host);
        let mut seal = Seal {
            path,
            key_path,
            provider: p.provider,
            kek: p.kek,
            data_key: None,
            wrapped: None,
            secrets: BTreeMap::new(),
            lost: false,
            refused: p.refused,
            refused_providers: p.refused_providers,
            compliant: p.compliant,
            key_mode: p.key_mode,
        };
        if seal.refused.is_some() {
            if let Some(s) = stored {
                seal.secrets = s.secrets;
            }
            return Ok(seal);
        }
        let Some(stored) = stored else {
            seal.data_key = Some(Key32::random()?);
            return Ok(seal);
        };
        let data_key = if stored.provider == seal.provider { seal.unwrap_data_key(&stored.data_key) } else { None };
        match data_key {
            Some(dk) => {
                for (name, sealed) in &stored.secrets {
                    let raw = unb64u(sealed).unwrap_or_default();
                    match gcm_open(&dk.0, name.as_bytes(), &raw) {
                        Some(mut plain) => wipe(&mut plain),
                        None => return Err(format!("{SECRETS_FILE} holds a sealed value that does not open")),
                    }
                }
                seal.data_key = Some(dk);
                seal.wrapped = Some(stored.data_key);
                seal.secrets = stored.secrets;
            }
            None => {
                seal.lost = true;
                seal.data_key = Some(Key32::random()?);
                seal.persist(&BTreeMap::new())?;
            }
        }
        Ok(seal)
    }

    pub fn provider(&self) -> Provider {
        self.provider
    }

    /// The provider is allowed for secrets under High: `dpapi-service`, or `systemd-credential` with every check
    /// passed (no container, the install record and the credential file it names).
    pub fn compliant(&self) -> bool {
        self.compliant
    }

    /// The install record's key mode ("tpm2+host" or "host") when `systemd-credential` is used and its record
    /// passed its checks.
    pub fn key_mode(&self) -> Option<&str> {
        self.key_mode.as_deref()
    }

    /// Every refused provider with its refusal code (`not-service-account`, `container`, `record-missing`,
    /// `record-null-key`, `record-not-root`, `credential-missing`, `credential-mismatch`, `key-file-refused`); the
    /// page maps codes to the 8.1 `seal.provider` `<why>` words.
    pub fn refused_providers(&self) -> Vec<(&'static str, &'static str)> {
        self.refused_providers.clone()
    }

    /// The stored data key did not unwrap at open: every old sealed value was dropped (`seal-lost`).
    pub fn lost(&self) -> bool {
        self.lost
    }

    /// Why the key file was refused (the caller logs `console.seal-refused`); while set, nothing unseals and
    /// `put` and `remove` fail. Never holds key material.
    pub fn refused(&self) -> Option<&str> {
        self.refused.as_deref()
    }

    /// The unsealed value, or None when it is not stored (or nothing unseals).
    pub fn get(&self, name: &str) -> Option<Vec<u8>> {
        let dk = self.data_key.as_ref()?;
        let raw = unb64u(self.secrets.get(name)?)?;
        gcm_open(&dk.0, name.as_bytes(), &raw)
    }

    /// Seal `value` under the data key (AES-256-GCM, random 96-bit nonce, AAD = the name) and rewrite the file
    /// owner-only. Nothing changes when the write fails.
    pub fn put(&mut self, name: &str, value: &[u8]) -> Result<(), String> {
        if name.is_empty() {
            return Err("a sealed value needs a name".to_string());
        }
        let sealed = {
            let dk = self.data_key.as_ref().ok_or_else(|| self.refused_why())?;
            b64u(&gcm_seal(&dk.0, name.as_bytes(), value)?)
        };
        let mut next = self.secrets.clone();
        next.insert(name.to_string(), sealed);
        self.persist(&next)?;
        self.secrets = next;
        Ok(())
    }

    /// Drop a sealed value and rewrite the file; a name not stored is a no-op.
    pub fn remove(&mut self, name: &str) -> Result<(), String> {
        if self.data_key.is_none() {
            return Err(self.refused_why());
        }
        if !self.secrets.contains_key(name) {
            return Ok(());
        }
        let mut next = self.secrets.clone();
        next.remove(name);
        self.persist(&next)?;
        self.secrets = next;
        Ok(())
    }

    /// The names of the stored values, sorted.
    pub fn names(&self) -> Vec<String> {
        self.secrets.keys().cloned().collect()
    }

    fn refused_why(&self) -> String {
        format!("the sealed secrets cannot be used: {}", self.refused.as_deref().unwrap_or("no data key"))
    }

    fn unwrap_data_key(&self, wrapped: &str) -> Option<Key32> {
        let raw = unb64u(wrapped)?;
        let aad = wrap_aad(self.provider);
        let mut plain = match self.provider {
            Provider::DpapiService | Provider::DpapiMachine => dpapi_unprotect(&raw, &aad)?,
            Provider::SystemdCredential | Provider::KeyFile => gcm_open(&self.kek.as_ref()?.0, &aad, &raw)?,
        };
        let key = Key32::from_slice(&plain);
        wipe(&mut plain);
        key
    }

    /// The data key wrapped by this provider; `key-file` makes `console-seal.key` (0600) when it does not exist.
    fn wrap_data_key(&mut self) -> Result<String, String> {
        if self.provider == Provider::KeyFile && self.kek.is_none() {
            let kek = Key32::random()?;
            crate::store::write_private(&self.key_path, &kek.0).map_err(|e| format!("{KEY_FILE} could not be written: {e}"))?;
            self.kek = Some(kek);
        }
        let dk = self.data_key.as_ref().ok_or_else(|| self.refused_why())?;
        let aad = wrap_aad(self.provider);
        let raw = match self.provider {
            Provider::DpapiService => dpapi_protect(&dk.0, &aad, false).ok_or_else(|| "Windows DPAPI could not wrap the data key".to_string())?,
            Provider::DpapiMachine => dpapi_protect(&dk.0, &aad, true).ok_or_else(|| "Windows DPAPI could not wrap the data key".to_string())?,
            Provider::SystemdCredential | Provider::KeyFile => {
                let kek = self.kek.as_ref().ok_or_else(|| "the key-encryption key is missing".to_string())?;
                gcm_seal(&kek.0, &aad, &dk.0)?
            }
        };
        Ok(b64u(&raw))
    }

    /// Write `secrets` with the wrapped data key, owner-only and atomically.
    fn persist(&mut self, secrets: &BTreeMap<String, String>) -> Result<(), String> {
        let wrapped = match self.wrapped.clone() {
            Some(w) => w,
            None => {
                let w = self.wrap_data_key()?;
                self.wrapped = Some(w.clone());
                w
            }
        };
        let mut sealed = Map::new();
        for (name, value) in secrets {
            sealed.insert(name.clone(), Value::String(value.clone()));
        }
        let mut o = Map::new();
        o.insert("v".to_string(), Value::from(1));
        o.insert("provider".to_string(), Value::from(self.provider.as_str()));
        o.insert("dataKey".to_string(), Value::String(wrapped));
        o.insert("secrets".to_string(), Value::Object(sealed));
        crate::store::write_private(&self.path, stringify(&Value::Object(o)).as_bytes()).map_err(|e| format!("{SECRETS_FILE} could not be written: {e}"))
    }
}

// ── console seal-setup (I16, R4-H2, R4-M2, R5-M1, R5-M2) ─────────────────────────────────────────────────────

/// `lucid-relay console seal-setup [--service <name>] --state <dir>`: an offline command. It takes `console.lock`
/// in `state_dir` first and answers `cli.running` (`console_auth::RUNNING`) while a relay holds it. Windows: the
/// service `service` (it must be `LucidRelay`, whose virtual account is `NT SERVICE\LucidRelay`) is set to run as
/// that account and the state folder's ACL is limited to it and Administrators. Linux (as root): a new 32-byte
/// key-encryption key is encrypted by `systemd-creds` (`tpm2+host`, or `host` without a TPM2) into
/// `/etc/lucid-relay/lucid-console-kek.cred` (an existing one that matches its record is kept), the unit drop-in
/// loads it, the root-owned install record is written with the file's path and SHA-256, and systemd reloads.
/// Returns the words to print.
pub fn seal_setup(state_dir: &Path, service: &str) -> Result<String, String> {
    if !state_dir.is_dir() {
        return Err(format!("The state folder {} does not exist.", state_dir.display()));
    }
    let _lock = crate::console_auth::lock_state(state_dir)?;
    setup_os(state_dir, service)
}

/// Run a command and say what it printed when it fails.
fn run(cmd: &mut std::process::Command, what: &str) -> Result<(), String> {
    let out = cmd.stdin(std::process::Stdio::null()).output().map_err(|e| format!("{what} could not be started: {e}"))?;
    if out.status.success() {
        return Ok(());
    }
    let text = String::from_utf8_lossy(if out.stderr.is_empty() { &out.stdout } else { &out.stderr }).trim().to_string();
    Err(format!("{what} failed: {text}"))
}

#[cfg(windows)]
fn setup_os(state_dir: &Path, service: &str) -> Result<String, String> {
    use std::process::Command;
    if !service.eq_ignore_ascii_case(WINDOWS_SERVICE) {
        return Err(format!("On Windows the relay's service must be named {WINDOWS_SERVICE}, so that it runs as {SERVICE_ACCOUNT}."));
    }
    run(Command::new("sc.exe").args(["config", WINDOWS_SERVICE, "obj=", SERVICE_ACCOUNT]), "sc.exe config")?;
    // Inheritance removed, then full control for the service account and Administrators (by SID, any language).
    let service_grant = format!("{SERVICE_ACCOUNT}:(OI)(CI)F");
    run(
        Command::new("icacls").arg(state_dir).args(["/inheritance:r", "/grant:r", service_grant.as_str(), "*S-1-5-32-544:(OI)(CI)F", "/T", "/Q"]),
        "icacls",
    )?;
    Ok(format!(
        "The service {WINDOWS_SERVICE} now runs as {SERVICE_ACCOUNT}, and the state folder {} is open only to that account and Administrators. Restart the service. Secrets sealed under another account do not come back: enter the mail credentials again and run lucid-relay console break-glass --replace.",
        state_dir.display()
    ))
}

#[cfg(unix)]
fn setup_os(state_dir: &Path, service: &str) -> Result<String, String> {
    // SAFETY: geteuid has no preconditions and cannot fail.
    if unsafe { geteuid() } != 0 {
        return Err("lucid-relay console seal-setup must run as root on Linux.".to_string());
    }
    // A console.lock this root process just made must stay usable by the relay's account.
    {
        use std::os::unix::fs::MetadataExt;
        let m = std::fs::metadata(state_dir).map_err(|e| format!("The state folder could not be read: {e}"))?;
        std::os::unix::fs::chown(state_dir.join(crate::console_auth::LOCK_FILE), Some(m.uid()), Some(m.gid())).map_err(|e| format!("console.lock could not be given to the relay's account: {e}"))?;
    }
    setup_systemd(service, Path::new(ETC_DIR), Path::new(UNIT_DIR))
}

#[cfg(not(any(windows, unix)))]
fn setup_os(_state_dir: &Path, _service: &str) -> Result<String, String> {
    Err("lucid-relay console seal-setup supports Windows and Linux under systemd.".to_string())
}

/// A systemd unit name without its `.service` suffix: letters, digits, `-`, `_`, `.`, `@`, not starting with `.`.
#[cfg_attr(not(unix), allow(dead_code))]
fn unit_name_ok(service: &str) -> bool {
    !service.is_empty() && !service.starts_with('.') && service.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b'.' | b'@'))
}

#[cfg(unix)]
fn make_root_dir(dir: &Path) -> Result<(), String> {
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
    std::fs::DirBuilder::new().recursive(true).mode(0o755).create(dir).map_err(|e| format!("{} could not be made: {e}", dir.display()))?;
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o755)).map_err(|e| format!("{} could not be set to 755: {e}", dir.display()))
}

/// Write a file atomically with `mode` (a temporary file in the same folder, then renamed).
#[cfg(unix)]
fn write_root_file(path: &Path, data: &[u8], mode: u32) -> Result<(), String> {
    use std::io::Write;
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(format!(".tmp-{}", std::process::id()));
    let tmp = PathBuf::from(tmp);
    let fail = |e: std::io::Error| format!("{} could not be written: {e}", path.display());
    let mut f = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(mode).open(&tmp).map_err(fail)?;
    f.write_all(data).map_err(fail)?;
    f.sync_all().map_err(fail)?;
    drop(f);
    std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(mode)).map_err(fail)?;
    std::fs::rename(&tmp, path).map_err(fail)
}

/// A new key-encryption key, piped (never written in the clear) into `systemd-creds encrypt`; the key mode used.
#[cfg(unix)]
fn encrypt_new_credential(credential: &Path) -> Result<&'static str, String> {
    use std::io::Write;
    use std::os::unix::fs::PermissionsExt;
    use std::process::{Command, Stdio};
    let tpm2 = Command::new("systemd-creds").arg("has-tpm2").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status().is_ok_and(|s| s.success());
    let mode = if tpm2 { "tpm2+host" } else { "host" };
    let mut tmp = credential.as_os_str().to_owned();
    tmp.push(format!(".tmp-{}", std::process::id()));
    let tmp = PathBuf::from(tmp);
    let kek = Key32::random()?;
    let mut child = Command::new("systemd-creds")
        .arg("encrypt")
        .arg(format!("--with-key={mode}"))
        .arg(format!("--name={KEK_CREDENTIAL}"))
        .arg("-")
        .arg(&tmp)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("systemd-creds could not be started: {e}"))?;
    let fed = match child.stdin.take() {
        Some(mut stdin) => stdin.write_all(&kek.0).map_err(|e| format!("systemd-creds could not be given the key: {e}")),
        None => Err("systemd-creds could not be given the key".to_string()),
    };
    drop(kek);
    let out = child.wait_with_output().map_err(|e| format!("systemd-creds failed: {e}"))?;
    if let Err(e) = fed {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    if !out.status.success() {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("systemd-creds encrypt failed: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    // Encrypted to the host key (and TPM2): readable by the relay's account so it can check the hash (R5-M1).
    std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o644)).map_err(|e| format!("{} could not be set to 644: {e}", tmp.display()))?;
    std::fs::rename(&tmp, credential).map_err(|e| format!("{} could not be written: {e}", credential.display()))?;
    Ok(mode)
}

/// The Linux steps of `seal_setup` with their folders (`/etc/lucid-relay`, `/etc/systemd/system`).
#[cfg(unix)]
fn setup_systemd(service: &str, etc: &Path, units: &Path) -> Result<String, String> {
    use std::process::Command;
    if !unit_name_ok(service) {
        return Err(format!("{service} is not a systemd service name."));
    }
    make_root_dir(etc)?;
    let credential = etc.join(format!("{KEK_CREDENTIAL}.cred"));
    let record_path = etc.join("seal-provider.json");
    let kept = check_record(&record_path, 0).ok().filter(|r| r.credential_path == credential).map(|r| r.key_mode);
    let key_mode = match &kept {
        Some(m) => m.clone(),
        None => encrypt_new_credential(&credential)?.to_string(),
    };
    let unit_dir = units.join(format!("{service}.service.d"));
    make_root_dir(&unit_dir)?;
    let drop_in = unit_dir.join(DROP_IN);
    write_root_file(&drop_in, drop_in_text(&credential).as_bytes(), 0o644)?;
    if kept.is_none() {
        let bytes = std::fs::read(&credential).map_err(|e| format!("{} could not be read: {e}", credential.display()))?;
        let record = record_json(&key_mode, &credential.to_string_lossy(), &sha256_hex(&bytes), &iso_time(now_ms()));
        write_root_file(&record_path, stringify(&record).as_bytes(), 0o644)?;
    }
    run(Command::new("systemctl").arg("daemon-reload"), "systemctl daemon-reload")?;
    let first = if kept.is_some() { "The existing systemd encrypted credential was kept" } else { "The Admin Console's secrets now use a new systemd encrypted credential" };
    Ok(format!(
        "{first} ({key_mode}): {}, loaded by {} and recorded in {}. Restart {service} to use it. To keep the secrets through a move to another host, back up the systemd host key separately; never copy it into the state folder.",
        credential.display(),
        drop_in.display(),
        record_path.display()
    ))
}

/// The unit drop-in that hands the credential to the relay.
#[cfg_attr(not(unix), allow(dead_code))]
fn drop_in_text(credential: &Path) -> String {
    format!("[Service]\nLoadCredentialEncrypted={KEK_CREDENTIAL}:{}\n", credential.display())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("lucid-console-seal-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn no_env(_: &str) -> Option<String> {
        None
    }

    fn uid() -> u32 {
        #[cfg(unix)]
        // SAFETY: geteuid has no preconditions.
        return unsafe { geteuid() };
        #[cfg(not(unix))]
        return 0;
    }

    /// A Linux host in `d`: the install record under `d/etc`, container markers under `d`, the test's own account
    /// standing in for root.
    fn linux(d: &Path) -> Host {
        Host { windows: false, account: None, record: d.join("etc").join("seal-provider.json"), markers: vec![d.join("run-systemd-container"), d.join("dockerenv")], root_uid: uid() }
    }

    fn windows(account: Option<&str>) -> Host {
        Host { windows: true, account: account.map(str::to_string), record: PathBuf::from("/nonexistent/seal-provider.json"), markers: Vec::new(), root_uid: 0 }
    }

    /// A credentials folder holding `lucid-console-kek` with `kek`.
    fn creds(d: &Path, name: &str, kek: &[u8]) -> String {
        let c = d.join(name);
        std::fs::create_dir_all(&c).unwrap();
        std::fs::write(c.join(KEK_CREDENTIAL), kek).unwrap();
        c.to_string_lossy().into_owned()
    }

    fn set_mode(_path: &Path, _mode: u32) {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(_path, std::fs::Permissions::from_mode(_mode)).unwrap();
        }
    }

    /// The encrypted credential file and a valid install record for it, as `seal_setup` writes them.
    fn install(d: &Path) -> (PathBuf, Value) {
        let etc = d.join("etc");
        std::fs::create_dir_all(&etc).unwrap();
        let cred = etc.join("lucid-console-kek.cred");
        std::fs::write(&cred, b"encrypted credential bytes").unwrap();
        let record = record_json("tpm2+host", &cred.to_string_lossy(), &sha256_hex(b"encrypted credential bytes"), "2026-11-17T00:00:00.000Z");
        write_record(d, &record);
        (cred, record)
    }

    fn write_record(d: &Path, record: &Value) {
        let path = d.join("etc").join("seal-provider.json");
        std::fs::write(&path, stringify(record)).unwrap();
        set_mode(&path, 0o644);
    }

    fn contains(hay: &[u8], needle: &[u8]) -> bool {
        hay.windows(needle.len()).any(|w| w == needle)
    }

    fn round_trip(d: &Path, open: &dyn Fn() -> Seal) {
        let mut s = open();
        assert!(!s.lost());
        assert!(s.refused().is_none());
        assert!(s.names().is_empty());
        assert!(!d.join(SECRETS_FILE).exists(), "nothing is written before the first put");
        s.put("smtp.password", b"first").unwrap();
        s.put("decoy", &[7u8; 32]).unwrap();
        s.put("smtp.password", b"second").unwrap();
        assert_eq!(s.get("smtp.password").unwrap(), b"second");
        assert_eq!(s.names(), vec!["decoy".to_string(), "smtp.password".to_string()]);
        assert!(s.get("missing").is_none());
        assert!(s.put("", b"x").is_err());
        drop(s);
        let mut s = open();
        assert!(!s.lost());
        assert_eq!(s.get("smtp.password").unwrap(), b"second");
        assert_eq!(s.get("decoy").unwrap(), vec![7u8; 32]);
        s.remove("smtp.password").unwrap();
        s.remove("never-stored").unwrap();
        assert!(s.get("smtp.password").is_none());
        drop(s);
        let s = open();
        assert_eq!(s.names(), vec!["decoy".to_string()]);
        assert!(s.get("smtp.password").is_none());
    }

    #[test]
    fn key_file_only_under_standard() {
        let d = dir("key-file");
        let host = linux(&d);
        let s = Seal::open_with(&d, &no_env, false, &host).unwrap();
        assert_eq!(s.provider(), Provider::KeyFile);
        assert_eq!(s.provider().as_str(), "key-file");
        assert!(!s.compliant());
        assert!(s.key_mode().is_none());
        assert!(s.refused_providers().is_empty(), "no credential delivered is not a refusal");
        drop(s);
        round_trip(&d, &|| Seal::open_with(&d, &no_env, false, &host).unwrap());
        assert_eq!(std::fs::read(d.join(KEY_FILE)).unwrap().len(), KEY_LEN);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(d.join(KEY_FILE)).unwrap().permissions().mode() & 0o777, 0o600);
            assert_eq!(std::fs::metadata(d.join(SECRETS_FILE)).unwrap().permissions().mode() & 0o777, 0o600);
        }
        let text = std::fs::read_to_string(d.join(SECRETS_FILE)).unwrap();
        assert!(text.contains("\"provider\":\"key-file\""));
        // Under High the key file still holds the decoy key, but it is not compliant for secrets.
        let s = Seal::open_with(&d, &no_env, true, &host).unwrap();
        assert_eq!(s.provider(), Provider::KeyFile);
        assert!(!s.compliant());
        assert_eq!(s.get("decoy").unwrap(), vec![7u8; 32]);
    }

    #[test]
    fn production_host_order() {
        let d = dir("order");
        let standard = Seal::open(&d, &no_env, false).unwrap();
        let high = Seal::open(&d, &no_env, true).unwrap();
        if cfg!(windows) {
            // The test process is not NT SERVICE\LucidRelay.
            assert_eq!(standard.provider(), Provider::DpapiMachine);
            assert!(!standard.compliant());
            assert_eq!(standard.refused_providers(), vec![("dpapi-service", "not-service-account")]);
            assert_eq!(high.provider(), Provider::KeyFile);
            assert!(!high.compliant());
            assert_eq!(high.refused_providers(), vec![("dpapi-service", "not-service-account")]);
        } else {
            assert_eq!(standard.provider(), Provider::KeyFile);
            assert_eq!(high.provider(), Provider::KeyFile);
            assert!(!high.compliant());
        }
    }

    #[test]
    fn dpapi_service_needs_the_service_account() {
        let d = dir("dpapi-service-refused");
        for account in [None, Some("NT SERVICE\\OtherRelay"), Some("NT AUTHORITY\\SYSTEM")] {
            let s = Seal::open_with(&d, &no_env, true, &windows(account)).unwrap();
            assert_ne!(s.provider(), Provider::DpapiService);
            assert!(!s.compliant());
            assert_eq!(s.refused_providers()[0], ("dpapi-service", "not-service-account"));
        }
    }

    #[cfg(windows)]
    #[test]
    fn dpapi_service_under_the_service_account() {
        let d = dir("dpapi-service");
        // User-scope DPAPI under the test's own account stands in for the service account's.
        let host = windows(Some("nt service\\lucidrelay"));
        let s = Seal::open_with(&d, &no_env, true, &host).unwrap();
        assert_eq!(s.provider(), Provider::DpapiService);
        assert_eq!(s.provider().as_str(), "dpapi-service");
        assert!(s.compliant());
        assert!(s.refused_providers().is_empty());
        drop(s);
        round_trip(&d, &|| Seal::open_with(&d, &no_env, true, &host).unwrap());
        assert!(!d.join(KEY_FILE).exists());
        assert!(std::fs::read_to_string(d.join(SECRETS_FILE)).unwrap().contains("\"provider\":\"dpapi-service\""));

        // The service account changed (machine scope picked now): lost.
        let s = Seal::open_with(&d, &no_env, false, &windows(Some("HOST\\someone"))).unwrap();
        assert_eq!(s.provider(), Provider::DpapiMachine);
        assert!(s.lost());
        assert!(s.names().is_empty());
    }

    #[cfg(windows)]
    #[test]
    fn dpapi_machine_only_under_standard() {
        let d = dir("dpapi-machine");
        let host = windows(Some("HOST\\someone"));
        let s = Seal::open_with(&d, &no_env, false, &host).unwrap();
        assert_eq!(s.provider(), Provider::DpapiMachine);
        assert_eq!(s.provider().as_str(), "dpapi-machine");
        assert!(!s.compliant());
        drop(s);
        round_trip(&d, &|| Seal::open_with(&d, &no_env, false, &host).unwrap());
        let text = std::fs::read_to_string(d.join(SECRETS_FILE)).unwrap();
        assert!(text.contains("\"provider\":\"dpapi-machine\""));

        let high = Seal::open_with(&dir("dpapi-machine-high"), &no_env, true, &host).unwrap();
        assert_eq!(high.provider(), Provider::KeyFile);
        assert!(!high.compliant());
        assert_eq!(high.refused_providers(), vec![("dpapi-service", "not-service-account")]);

        // A wrapped key DPAPI does not take back (another machine's) counts as lost.
        let mut v = parse_json(&text).unwrap();
        v["dataKey"] = Value::from(b64u(&[9u8; 200]));
        std::fs::write(d.join(SECRETS_FILE), stringify(&v)).unwrap();
        let s = Seal::open_with(&d, &no_env, false, &host).unwrap();
        assert!(s.lost());
        assert!(s.names().is_empty());
    }

    #[test]
    fn systemd_credential_with_a_valid_install_record() {
        let d = dir("systemd");
        let host = linux(&d);
        install(&d);
        let c = creds(&d, "creds", &[0x11u8; 32]);
        let env = move |k: &str| (k == "CREDENTIALS_DIRECTORY").then(|| c.clone());
        let s = Seal::open_with(&d, &env, true, &host).unwrap();
        assert_eq!(s.provider(), Provider::SystemdCredential);
        assert_eq!(s.provider().as_str(), "systemd-credential");
        assert!(s.compliant());
        assert_eq!(s.key_mode(), Some("tpm2+host"));
        assert!(s.refused_providers().is_empty());
        drop(s);
        round_trip(&d, &|| Seal::open_with(&d, &env, true, &host).unwrap());
        assert!(!d.join(KEY_FILE).exists(), "the systemd provider never makes a key file");

        // A credential that is not exactly 32 bytes is not available: the key file is chosen.
        let e = dir("systemd-short");
        let short = creds(&e, "short", &[0x22u8; 31]);
        let env_short = move |k: &str| (k == "CREDENTIALS_DIRECTORY").then(|| short.clone());
        assert_eq!(Seal::open_with(&e, &env_short, false, &linux(&e)).unwrap().provider(), Provider::KeyFile);
    }

    /// Under High the systemd provider is refused with `why`; under Standard it is used, not compliant.
    fn refused_under_high(d: &Path, env: &dyn Fn(&str) -> Option<String>, why: &'static str) {
        let host = linux(d);
        let s = Seal::open_with(d, env, true, &host).unwrap();
        assert_eq!(s.provider(), Provider::KeyFile, "{why}");
        assert!(!s.compliant());
        assert_eq!(s.refused_providers(), vec![("systemd-credential", why)]);
        drop(s);
        let s = Seal::open_with(d, env, false, &host).unwrap();
        assert_eq!(s.provider(), Provider::SystemdCredential, "{why}");
        assert!(!s.compliant());
        assert!(s.refused_providers().is_empty());
    }

    #[test]
    fn systemd_credential_refusals_under_high() {
        // A container marker file, and a `container` environment variable.
        let d = dir("container-marker");
        install(&d);
        std::fs::write(d.join("run-systemd-container"), "docker\n").unwrap();
        let c = creds(&d, "creds", &[0x11u8; 32]);
        refused_under_high(&d, &move |k: &str| (k == "CREDENTIALS_DIRECTORY").then(|| c.clone()), "container");

        let d = dir("container-env");
        install(&d);
        let c = creds(&d, "creds", &[0x11u8; 32]);
        refused_under_high(
            &d,
            &move |k: &str| match k {
                "CREDENTIALS_DIRECTORY" => Some(c.clone()),
                "container" => Some("podman".to_string()),
                _ => None,
            },
            "container",
        );

        // A missing record.
        let d = dir("record-missing");
        let c = creds(&d, "creds", &[0x11u8; 32]);
        refused_under_high(&d, &move |k: &str| (k == "CREDENTIALS_DIRECTORY").then(|| c.clone()), "record-missing");

        // A null and an unknown key mode.
        for (name, mode) in [("record-null", Value::Null), ("record-unknown", Value::from("null")), ("record-tpm2", Value::from("tpm2"))] {
            let d = dir(name);
            let (_, mut record) = install(&d);
            record["keyMode"] = mode;
            write_record(&d, &record);
            let c = creds(&d, "creds", &[0x11u8; 32]);
            refused_under_high(&d, &move |k: &str| (k == "CREDENTIALS_DIRECTORY").then(|| c.clone()), "record-null-key");
        }

        // The credential file missing, and swapped behind an unchanged record (R5-M1).
        let d = dir("credential-missing");
        let (cred, _) = install(&d);
        std::fs::remove_file(&cred).unwrap();
        let c = creds(&d, "creds", &[0x11u8; 32]);
        refused_under_high(&d, &move |k: &str| (k == "CREDENTIALS_DIRECTORY").then(|| c.clone()), "credential-missing");

        let d = dir("credential-swapped");
        let (cred, _) = install(&d);
        std::fs::write(&cred, b"a null-key credential").unwrap();
        let c = creds(&d, "creds", &[0x11u8; 32]);
        refused_under_high(&d, &move |k: &str| (k == "CREDENTIALS_DIRECTORY").then(|| c.clone()), "credential-mismatch");
    }

    #[cfg(unix)]
    #[test]
    fn systemd_install_record_not_owned_by_root_or_writable() {
        let d = dir("record-owner");
        install(&d);
        let c = creds(&d, "creds", &[0x11u8; 32]);
        let env = move |k: &str| (k == "CREDENTIALS_DIRECTORY").then(|| c.clone());
        let mut host = linux(&d);
        host.root_uid = uid().wrapping_add(1);
        let s = Seal::open_with(&d, &env, true, &host).unwrap();
        assert_eq!(s.provider(), Provider::KeyFile);
        assert_eq!(s.refused_providers(), vec![("systemd-credential", "record-not-root")]);

        set_mode(&d.join("etc").join("seal-provider.json"), 0o666);
        let s = Seal::open_with(&d, &env, true, &linux(&d)).unwrap();
        assert_eq!(s.refused_providers(), vec![("systemd-credential", "record-not-root")]);
    }

    #[cfg(unix)]
    #[test]
    fn a_key_file_with_group_or_other_access_is_refused() {
        use std::os::unix::fs::PermissionsExt;
        let d = dir("refused");
        let host = linux(&d);
        let mut s = Seal::open_with(&d, &no_env, false, &host).unwrap();
        s.put("decoy", b"decoy-key-bytes").unwrap();
        drop(s);
        let before = std::fs::read(d.join(SECRETS_FILE)).unwrap();
        std::fs::set_permissions(d.join(KEY_FILE), std::fs::Permissions::from_mode(0o644)).unwrap();
        let mut s = Seal::open_with(&d, &no_env, false, &host).unwrap();
        assert_eq!(s.provider(), Provider::KeyFile);
        assert!(s.refused().unwrap().contains("group or other access"));
        assert_eq!(s.refused_providers(), vec![("key-file", "key-file-refused")]);
        assert!(!s.lost());
        assert!(s.get("decoy").is_none());
        assert_eq!(s.names(), vec!["decoy".to_string()]);
        assert!(s.put("decoy", b"other").is_err());
        assert!(s.remove("decoy").is_err());
        drop(s);
        assert_eq!(std::fs::read(d.join(SECRETS_FILE)).unwrap(), before, "a refused key file changes nothing");
        std::fs::set_permissions(d.join(KEY_FILE), std::fs::Permissions::from_mode(0o600)).unwrap();
        let s = Seal::open_with(&d, &no_env, false, &host).unwrap();
        assert!(s.refused().is_none());
        assert_eq!(s.get("decoy").unwrap(), b"decoy-key-bytes");
    }

    #[test]
    fn a_key_file_of_the_wrong_length_is_refused() {
        let d = dir("short-key");
        std::fs::write(d.join(KEY_FILE), [1u8; 16]).unwrap();
        set_mode(&d.join(KEY_FILE), 0o600);
        let s = Seal::open_with(&d, &no_env, false, &linux(&d)).unwrap();
        assert!(s.refused().unwrap().contains("is not 32 bytes"));
        assert_eq!(s.refused_providers(), vec![("key-file", "key-file-refused")]);
    }

    #[test]
    fn a_folder_restored_without_its_systemd_kek_opens_lost() {
        let d = dir("lost-systemd");
        let host = linux(&d);
        install(&d);
        let a = creds(&d, "a", &[0x33u8; 32]);
        let b = creds(&d, "b", &[0x44u8; 32]);
        let env_a = move |k: &str| (k == "CREDENTIALS_DIRECTORY").then(|| a.clone());
        let env_b = move |k: &str| (k == "CREDENTIALS_DIRECTORY").then(|| b.clone());
        let mut s = Seal::open_with(&d, &env_a, true, &host).unwrap();
        s.put("smtp.password", b"old-password").unwrap();
        drop(s);
        let old = std::fs::read_to_string(d.join(SECRETS_FILE)).unwrap();

        let mut s = Seal::open_with(&d, &env_b, true, &host).unwrap();
        assert!(s.lost());
        assert!(s.names().is_empty());
        assert!(s.get("smtp.password").is_none());
        let now = std::fs::read_to_string(d.join(SECRETS_FILE)).unwrap();
        assert_ne!(now, old, "the file is rewritten with a new data key");
        let old_key = parse_json(&old).unwrap()["dataKey"].clone();
        assert_ne!(parse_json(&now).unwrap()["dataKey"], old_key);
        s.put("decoy", b"new-decoy").unwrap();
        drop(s);
        let s = Seal::open_with(&d, &env_b, true, &host).unwrap();
        assert!(!s.lost());
        assert_eq!(s.get("decoy").unwrap(), b"new-decoy");
        assert!(s.get("smtp.password").is_none());
    }

    #[test]
    fn a_folder_restored_without_its_key_file_opens_lost() {
        let d = dir("lost-key-file");
        let host = linux(&d);
        let mut s = Seal::open_with(&d, &no_env, false, &host).unwrap();
        s.put("decoy", b"old-decoy").unwrap();
        drop(s);
        std::fs::remove_file(d.join(KEY_FILE)).unwrap();
        let s = Seal::open_with(&d, &no_env, false, &host).unwrap();
        assert!(s.lost());
        assert!(s.names().is_empty());
        assert!(s.get("decoy").is_none());
        assert_eq!(std::fs::read(d.join(KEY_FILE)).unwrap().len(), KEY_LEN, "a new key file wraps the new data key");
        drop(s);
        let s = Seal::open_with(&d, &no_env, false, &host).unwrap();
        assert!(!s.lost());
        assert!(s.names().is_empty());
    }

    #[test]
    fn a_changed_provider_counts_as_lost() {
        let d = dir("lost-provider");
        let host = linux(&d);
        let c = creds(&d, "creds", &[0x55u8; 32]);
        let env = move |k: &str| (k == "CREDENTIALS_DIRECTORY").then(|| c.clone());
        let mut s = Seal::open_with(&d, &env, false, &host).unwrap();
        s.put("smtp.password", b"pw").unwrap();
        drop(s);
        let s = Seal::open_with(&d, &no_env, false, &host).unwrap();
        assert_eq!(s.provider(), Provider::KeyFile);
        assert!(s.lost());
        assert!(s.names().is_empty());
    }

    #[test]
    fn an_unreadable_secrets_file_is_an_error() {
        let d = dir("unreadable");
        let host = linux(&d);
        let open = || Seal::open_with(&d, &no_env, false, &host);
        for text in [
            "not json",
            "",
            "[]",
            "{\"v\":1}",
            "{\"v\":2,\"provider\":\"key-file\",\"dataKey\":\"AA\",\"secrets\":{}}",
            "{\"v\":1,\"provider\":\"tpm\",\"dataKey\":\"AA\",\"secrets\":{}}",
            "{\"v\":1,\"provider\":\"key-file\",\"dataKey\":\"AA\",\"secrets\":{\"x\":\"AA\"}}",
            "{\"v\":1,\"provider\":\"key-file\",\"dataKey\":\"AA\",\"secrets\":{},\"extra\":1}",
        ] {
            std::fs::write(d.join(SECRETS_FILE), text).unwrap();
            assert!(open().is_err(), "{text}");
        }
        std::fs::remove_file(d.join(SECRETS_FILE)).unwrap();
        std::fs::create_dir_all(d.join(SECRETS_FILE)).unwrap();
        assert!(open().is_err(), "a folder in place of the file");
        std::fs::remove_dir_all(d.join(SECRETS_FILE)).unwrap();

        // A sealed value that does not open under a data key that does is a file that does not read back.
        let mut s = open().unwrap();
        s.put("a", b"value-a").unwrap();
        s.put("b", b"value-b").unwrap();
        drop(s);
        let mut v = parse_json(&std::fs::read_to_string(d.join(SECRETS_FILE)).unwrap()).unwrap();
        let b = v["secrets"]["b"].clone();
        v["secrets"]["a"] = b;
        std::fs::write(d.join(SECRETS_FILE), stringify(&v)).unwrap();
        assert!(open().is_err(), "a value moved to another name does not open");
    }

    #[test]
    fn the_file_never_holds_a_plaintext_value() {
        let d = dir("plaintext");
        let value = b"Plain-Text-Secret-0123456789";
        let mut s = Seal::open_with(&d, &no_env, false, &linux(&d)).unwrap();
        s.put("smtp.password", value).unwrap();
        s.put("graph.secret", value).unwrap();
        let bytes = std::fs::read(d.join(SECRETS_FILE)).unwrap();
        assert!(!contains(&bytes, value));
        assert!(!contains(&bytes, b64u(value).as_bytes()));
        let key = std::fs::read(d.join(KEY_FILE)).unwrap();
        assert!(!contains(&bytes, &key));
        assert!(!contains(&bytes, b64u(&key).as_bytes()));
        let v = parse_json(std::str::from_utf8(&bytes).unwrap()).unwrap();
        assert_ne!(v["secrets"]["smtp.password"], v["secrets"]["graph.secret"], "each seal draws its own nonce");
    }

    #[test]
    fn seal_setup_refuses_while_the_relay_holds_console_lock() {
        let d = dir("setup-lock");
        let held = crate::console_auth::lock_state(&d).unwrap();
        assert_eq!(seal_setup(&d, "lucid-meet-relay").unwrap_err(), crate::console_auth::RUNNING);
        drop(held);
        assert!(seal_setup(&d.join("missing"), "lucid-meet-relay").is_err(), "a state folder that does not exist");
    }

    #[test]
    fn the_install_record_and_drop_in_seal_setup_writes() {
        let d = dir("setup-record");
        let (cred, record) = install(&d);
        let r = check_record(&d.join("etc").join("seal-provider.json"), uid()).ok().unwrap();
        assert_eq!(r.key_mode, "tpm2+host");
        assert_eq!(r.credential_path, cred);
        let keys: Vec<&str> = record.as_object().unwrap().keys().map(String::as_str).collect();
        assert_eq!(keys, RECORD_KEYS.to_vec());
        assert_eq!(drop_in_text(Path::new("/etc/lucid-relay/lucid-console-kek.cred")), "[Service]\nLoadCredentialEncrypted=lucid-console-kek:/etc/lucid-relay/lucid-console-kek.cred\n");
        assert!(unit_name_ok("lucid-meet-relay"));
        assert!(!unit_name_ok("../evil") && !unit_name_ok("") && !unit_name_ok("a b") && !unit_name_ok(".hidden"));
    }

    #[test]
    fn no_long_dashes() {
        let src = include_str!("console_seal.rs");
        assert!(!src.contains('\u{2014}'));
        assert!(!src.contains('\u{2013}'));
    }
}
