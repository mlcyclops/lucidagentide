// Contract API-1 revision 5 (phase 1c), sections 2.2 (the config's `seal` object), 2.6 (keys at rest) and 2.8 (the
// `seal` value of the sync acknowledgment, revision 6's `key_store` classification). Port of Python
// `connector/lucid_connector/service_client.py` (`Sealer`, `Sealer.from_config`, `SealedStore`, `_write_private`).
//
// The connector's sealing key comes from a `SealSource` chosen by `seal.source`:
// - `systemd-creds`: the 32-byte key is `$CREDENTIALS_DIRECTORY/<credential>` (`LoadCredentialEncrypted=` in the
//   unit), else `systemd-creds decrypt` of `encrypted_file` (the admin commands, run as root). The installer
//   (`connector/deploy/install.sh --api-connector`) makes that file with `systemd-creds encrypt`. Its `key_store` is
//   `tpm` with a TPM2 (`systemd-creds has-tpm2`), else `os_store`.
// - `pkcs11` and `azure_key_vault`: recognized and classified, but this build refuses them at runtime with one
//   sentence each.
// On top, `Sealer` is AES-256-GCM under a key derived per sealed name with HKDF-SHA-384 from the sealing key, the
// name bound as additional data (byte compatible with Python's `Sealer`), and `SealedStore` keeps named sealed
// values in an owner-only folder (atomic write and fsync). Everything 2.6 lists is kept through it (`names`).
// Nothing here logs a key or returns one except to its caller.

use aws_lc_rs::{aead, hkdf};
use parking_lot::Mutex;
use serde_json::Value;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

pub const KEY_LEN: usize = 32;
const NONCE_LEN: usize = 12;
const TAG_LEN: usize = 16;
/// `SEAL_INFO + name` is the HKDF info of a sealed name's key (Python `SEAL_INFO`).
pub const SEAL_INFO: &[u8] = b"lucid-connector-seal-v1|";
/// Every sealed value starts with this (Python `SEAL_MAGIC`).
pub const SEAL_MAGIC: &[u8] = b"LS1";
/// The sealed folder under `state_dir`.
pub const SEALED_DIR: &str = "sealed";
const RANDOM_FAILED: &str = "the connector could not draw random bytes";

/// The runtime refusal of a `pkcs11` source.
pub const PKCS11_REFUSED: &str = "This lucid-relay build cannot use a PKCS#11 module to seal the connector's keys; use \"source\": \"systemd-creds\".";
/// The runtime refusal of an `azure_key_vault` source.
pub const AZURE_REFUSED: &str = "This lucid-relay build cannot use Azure Key Vault to seal the connector's keys; use \"source\": \"systemd-creds\".";

/// Revision 6's `key_store` values (2.8 `seal`).
pub const KEY_STORE_TPM: &str = "tpm";
pub const KEY_STORE_OS: &str = "os_store";
pub const KEY_STORE_PKCS11: &str = "pkcs11";
pub const KEY_STORE_AZURE: &str = "azure_key_vault";

/// The sealed names of what 2.6 lists. Every one is kept only through `SealedStore`.
pub mod names {
    /// The listener's TLS private key (PKCS#8).
    pub const TLS_KEY: &str = "tls-key";
    /// The MCP state key (8.4).
    pub const MCP_STATE_KEY: &str = "mcp-state-key";
    /// The org's audit pseudonym key received in sync (2.8; 1a 11.4).
    pub const AUDIT_PSEUDONYM_KEY: &str = "audit-pseudonym-key";
    /// The per-client id keys (5.5), one JSON object `{client: key}`.
    pub const CLIENT_ID_KEYS: &str = "client-id-keys";
    /// The approval records (7.5).
    pub const APPROVALS: &str = "approvals";
    /// The `Idempotency-Key` records of content posts (7.1): ids and hashes, never text.
    pub const IDEMPOTENCY: &str = "idempotency";
    /// The person deny list (7.6).
    pub const DENY_LIST: &str = "deny-list";
    /// The delegation notice marks (6.3): `sent` or `skipped` per (client, person), never a token.
    pub const NOTICES: &str = "notices";

    /// An API app's private key (2.4), as Python's `ServiceIdentity.key_name`.
    pub fn app_key(app: &str) -> String {
        format!("key-app-{app}")
    }
    /// An API app's next key while a renewal is under way.
    pub fn app_next_key(app: &str) -> String {
        format!("key-app-{app}-next")
    }
    /// An API app's chat keys (DCK and epoch keys, CE-1).
    pub fn chat_keys(app: &str) -> String {
        format!("chat-keys-{app}")
    }
    /// The data key of an API app's content store (2.7).
    pub fn store_key(app: &str) -> String {
        format!("store-key-{app}")
    }
    // The connector's audit checkpoint keys (12.1) are sealed under `api_checkpoint::seal_name` through
    // `connector_sync::SealedVault`.
}

/// Overwrite bytes with zeros in a way the compiler keeps.
pub fn wipe(b: &mut [u8]) {
    for x in b.iter_mut() {
        // SAFETY: `x` is a valid, aligned, exclusive reference to one byte.
        unsafe { std::ptr::write_volatile(x, 0) };
    }
    std::sync::atomic::compiler_fence(Ordering::SeqCst);
}

/// 32 bytes of key material, zeroed when dropped. `Debug` never prints it.
#[derive(Clone)]
pub struct SecretKey([u8; KEY_LEN]);

impl SecretKey {
    pub fn random() -> Result<SecretKey, String> {
        let mut k = SecretKey([0u8; KEY_LEN]);
        aws_lc_rs::rand::fill(&mut k.0).map_err(|_| RANDOM_FAILED.to_string())?;
        Ok(k)
    }

    pub fn from_slice(b: &[u8]) -> Option<SecretKey> {
        if b.len() != KEY_LEN {
            return None;
        }
        let mut k = SecretKey([0u8; KEY_LEN]);
        k.0.copy_from_slice(b);
        Some(k)
    }

    pub fn bytes(&self) -> &[u8; KEY_LEN] {
        &self.0
    }
}

impl Drop for SecretKey {
    fn drop(&mut self) {
        wipe(&mut self.0);
    }
}

impl std::fmt::Debug for SecretKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SecretKey(<redacted>)")
    }
}

struct OutLen(usize);

impl hkdf::KeyType for OutLen {
    fn len(&self) -> usize {
        self.0
    }
}

/// HKDF-SHA-384 with no salt (48 zero bytes, as Python's `salt=None`), 32 bytes out.
pub fn hkdf_sha384(ikm: &[u8], info: &[u8]) -> Result<SecretKey, String> {
    let prk = hkdf::Salt::new(hkdf::HKDF_SHA384, &[0u8; 48]).extract(ikm);
    let parts = [info];
    let mut k = SecretKey([0u8; KEY_LEN]);
    prk.expand(&parts, OutLen(KEY_LEN)).and_then(|okm| okm.fill(&mut k.0)).map_err(|_| "a sealing key could not be derived".to_string())?;
    Ok(k)
}

/// `nonce || ciphertext || tag` under AES-256-GCM with a random 96-bit nonce.
pub fn gcm_seal(key: &SecretKey, aad: &[u8], plain: &[u8]) -> Result<Vec<u8>, String> {
    let mut nonce = [0u8; NONCE_LEN];
    aws_lc_rs::rand::fill(&mut nonce).map_err(|_| RANDOM_FAILED.to_string())?;
    let k = aead::LessSafeKey::new(aead::UnboundKey::new(&aead::AES_256_GCM, key.bytes()).map_err(|_| "the sealing key could not be made".to_string())?);
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
pub fn gcm_open(key: &SecretKey, aad: &[u8], sealed: &[u8]) -> Option<Vec<u8>> {
    if sealed.len() < NONCE_LEN + TAG_LEN {
        return None;
    }
    let k = aead::LessSafeKey::new(aead::UnboundKey::new(&aead::AES_256_GCM, key.bytes()).ok()?);
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

// ── files: owner-only, atomic, durable ──────────────────────────────────────────────────────────────────────

/// Make a folder (and its parents) and limit it to this user (0700 on unix).
pub fn make_private_dir(dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

/// fsync a folder so a rename or removal in it is durable (unix; Windows has no folder handle for this).
pub fn sync_dir(dir: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        std::fs::File::open(dir)?.sync_all()?;
    }
    #[cfg(not(unix))]
    {
        let _ = dir;
    }
    Ok(())
}

fn parent_of(path: &Path) -> PathBuf {
    match path.parent() {
        Some(p) if !p.as_os_str().is_empty() => p.to_path_buf(),
        _ => PathBuf::from("."),
    }
}

/// The prefix of the temporary files `write_private` makes (readers skip and may remove them).
pub const TMP_PREFIX: &str = ".tmp-";

/// Write a file atomically, readable only by this user (0600 on unix): a new temporary file in the same folder,
/// written and fsynced, renamed over `path`, then the folder fsynced.
pub fn write_private(path: &Path, data: &[u8]) -> std::io::Result<()> {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let dir = parent_of(path);
    std::fs::create_dir_all(&dir)?;
    let file = path.file_name().ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "no file name"))?;
    let mut tmp_name = std::ffi::OsString::from(TMP_PREFIX);
    tmp_name.push(file);
    tmp_name.push(format!("-{}-{}", std::process::id(), SEQ.fetch_add(1, Ordering::Relaxed)));
    let tmp = dir.join(tmp_name);
    let written = (|| -> std::io::Result<()> {
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut f = opts.open(&tmp)?;
        f.write_all(data)?;
        f.sync_all()
    })();
    if let Err(e) = written {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    if let Err(e) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    sync_dir(&dir)
}

/// Remove a file durably (the folder fsynced); a missing file is fine.
pub fn remove_durable(path: &Path) -> std::io::Result<()> {
    match std::fs::remove_file(path) {
        Ok(()) => sync_dir(&parent_of(path)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

/// Remove a folder and everything in it durably; a missing folder is fine.
pub fn remove_dir_durable(dir: &Path) -> std::io::Result<()> {
    match std::fs::remove_dir_all(dir) {
        Ok(()) => sync_dir(&parent_of(dir)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

// ── the `seal` config (2.2) ─────────────────────────────────────────────────────────────────────────────────

/// The config's `seal` object, paths resolved from the config file's folder. This build refuses `pkcs11` and
/// `azure_key_vault` at runtime, so their keys are checked and not kept.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SealConfig {
    SystemdCreds { credential: String, encrypted_file: PathBuf },
    Pkcs11,
    AzureKeyVault,
}

fn resolve(base: &Path, p: &str) -> PathBuf {
    let p = Path::new(p);
    if p.is_absolute() {
        p.to_path_buf()
    } else {
        base.join(p)
    }
}

fn credential_ok(name: &str) -> bool {
    (1..=64).contains(&name.len()) && name.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-'))
}

impl SealConfig {
    /// Read `seal` (unknown keys refused, every key of the source required). `base` is the config file's folder.
    pub fn parse(v: &Value, base: &Path) -> Result<SealConfig, String> {
        let o = v.as_object().ok_or("'seal' must be an object")?;
        let source = o.get("source").and_then(Value::as_str).unwrap_or_default();
        let keys: &[&str] = match source {
            "systemd-creds" => &["source", "credential", "encrypted_file"],
            "pkcs11" => &["source", "module", "token", "key_label", "pin_file"],
            "azure_key_vault" => &["source", "vault", "key"],
            _ => return Err("seal.source must be \"systemd-creds\", \"pkcs11\" or \"azure_key_vault\"".to_string()),
        };
        if let Some(k) = o.keys().find(|k| !keys.contains(&k.as_str())) {
            return Err(format!("seal.{k} is not a key of a {source} seal"));
        }
        let mut got = Vec::with_capacity(keys.len());
        for k in &keys[1..] {
            match o.get(*k).and_then(Value::as_str) {
                Some(s) if !s.is_empty() => got.push(s.to_string()),
                _ => return Err(format!("seal.{k} must be a non-empty string")),
            }
        }
        Ok(match source {
            "systemd-creds" => {
                if !credential_ok(&got[0]) {
                    return Err("seal.credential must name the systemd credential (1 to 64 of A-Z, a-z, 0-9, '.', '_' and '-')".to_string());
                }
                SealConfig::SystemdCreds { credential: got[0].clone(), encrypted_file: resolve(base, &got[1]) }
            }
            "pkcs11" => SealConfig::Pkcs11,
            _ => SealConfig::AzureKeyVault,
        })
    }

    /// The source on this host: the real `systemd-creds` and `$CREDENTIALS_DIRECTORY`.
    pub fn source(&self) -> Arc<dyn SealSource> {
        let creds_dir = std::env::var_os("CREDENTIALS_DIRECTORY").filter(|v| !v.is_empty()).map(PathBuf::from);
        self.source_with(Arc::new(SystemdCredsTool), creds_dir)
    }

    /// The source with a given `systemd-creds` and credentials folder (tests pass their own).
    pub fn source_with(&self, tool: Arc<dyn CredsTool>, creds_dir: Option<PathBuf>) -> Arc<dyn SealSource> {
        match self {
            SealConfig::SystemdCreds { credential, encrypted_file } => {
                let tpm = tool.has_tpm2();
                Arc::new(SystemdCredsSource { credential: credential.clone(), encrypted_file: encrypted_file.clone(), creds_dir, tpm, tool })
            }
            SealConfig::Pkcs11 => Arc::new(Pkcs11Source),
            SealConfig::AzureKeyVault => Arc::new(AzureKeyVaultSource),
        }
    }
}

// ── sources ─────────────────────────────────────────────────────────────────────────────────────────────────

/// Where the connector's sealing key comes from.
pub trait SealSource: Send + Sync {
    /// Revision 6's `key_store` classification, reported as `seal` in the sync acknowledgment (2.8).
    fn key_store(&self) -> &'static str;
    /// The 32-byte sealing key, or one sentence saying why it is not available.
    fn data_key(&self) -> Result<SecretKey, String>;
}

/// `systemd-creds`, as a seam: the real one runs the command, tests use their own.
pub trait CredsTool: Send + Sync {
    /// `systemd-creds has-tpm2` succeeds.
    fn has_tpm2(&self) -> bool;
    /// `systemd-creds decrypt --name=<name> <path> -`: the plaintext.
    fn decrypt(&self, name: &str, path: &Path) -> Result<Vec<u8>, String>;
}

/// The real `systemd-creds` (unix only; elsewhere every call fails).
pub struct SystemdCredsTool;

impl CredsTool for SystemdCredsTool {
    #[cfg(unix)]
    fn has_tpm2(&self) -> bool {
        use std::process::{Command, Stdio};
        Command::new("systemd-creds").arg("has-tpm2").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status().is_ok_and(|s| s.success())
    }

    #[cfg(not(unix))]
    fn has_tpm2(&self) -> bool {
        false
    }

    #[cfg(unix)]
    fn decrypt(&self, name: &str, path: &Path) -> Result<Vec<u8>, String> {
        use std::process::{Command, Stdio};
        let out = Command::new("systemd-creds")
            .arg("decrypt")
            .arg(format!("--name={name}"))
            .arg(path)
            .arg("-")
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .map_err(|e| format!("systemd-creds could not be started: {e}"))?;
        if !out.status.success() {
            let mut stdout = out.stdout;
            wipe(&mut stdout);
            return Err("systemd-creds could not decrypt the sealing key (run this command as root)".to_string());
        }
        Ok(out.stdout)
    }

    #[cfg(not(unix))]
    fn decrypt(&self, _name: &str, _path: &Path) -> Result<Vec<u8>, String> {
        Err("systemd-creds is not available on this system".to_string())
    }
}

fn unhex(text: &[u8]) -> Option<Vec<u8>> {
    if text.len() % 2 != 0 {
        return None;
    }
    let nib = |c: u8| match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    };
    text.chunks(2).map(|p| Some(nib(p[0])? << 4 | nib(p[1])?)).collect()
}

/// The sealing key from a credential's bytes: exactly 32 raw bytes, or 64 hex digits (white space around them
/// ignored), as Python's `_seal_key_bytes` reads a hex key.
fn key_of(mut raw: Vec<u8>) -> Result<SecretKey, String> {
    let trimmed = raw.trim_ascii();
    let key = if trimmed.len() == 2 * KEY_LEN && trimmed.iter().all(u8::is_ascii_hexdigit) {
        let mut b = unhex(trimmed).unwrap_or_default();
        let k = SecretKey::from_slice(&b);
        wipe(&mut b);
        k
    } else {
        SecretKey::from_slice(&raw)
    };
    wipe(&mut raw);
    key.ok_or_else(|| "the sealing key must be 32 bytes".to_string())
}

/// `{"source": "systemd-creds", "credential", "encrypted_file"}`.
pub struct SystemdCredsSource {
    credential: String,
    encrypted_file: PathBuf,
    creds_dir: Option<PathBuf>,
    tpm: bool,
    tool: Arc<dyn CredsTool>,
}

impl SealSource for SystemdCredsSource {
    fn key_store(&self) -> &'static str {
        if self.tpm {
            KEY_STORE_TPM
        } else {
            KEY_STORE_OS
        }
    }

    fn data_key(&self) -> Result<SecretKey, String> {
        if let Some(dir) = &self.creds_dir {
            let path = dir.join(&self.credential);
            if path.is_file() {
                let raw = std::fs::read(&path).map_err(|_| format!("the credential {} could not be read", self.credential))?;
                return key_of(raw);
            }
        }
        if self.encrypted_file.is_file() {
            return key_of(self.tool.decrypt(&self.credential, &self.encrypted_file)?);
        }
        Err(format!(
            "the sealing key is not available: run under the service unit (LoadCredentialEncrypted={}:{}) or set it up first",
            self.credential,
            self.encrypted_file.display()
        ))
    }
}

/// `{"source": "pkcs11", ...}`: classified, refused at runtime by this build.
pub struct Pkcs11Source;

impl SealSource for Pkcs11Source {
    fn key_store(&self) -> &'static str {
        KEY_STORE_PKCS11
    }
    fn data_key(&self) -> Result<SecretKey, String> {
        Err(PKCS11_REFUSED.to_string())
    }
}

/// `{"source": "azure_key_vault", ...}`: classified, refused at runtime by this build.
pub struct AzureKeyVaultSource;

impl SealSource for AzureKeyVaultSource {
    fn key_store(&self) -> &'static str {
        KEY_STORE_AZURE
    }
    fn data_key(&self) -> Result<SecretKey, String> {
        Err(AZURE_REFUSED.to_string())
    }
}

/// A fixed key, for tests only.
#[cfg(test)]
pub struct FixedSource(pub [u8; KEY_LEN]);

#[cfg(test)]
impl SealSource for FixedSource {
    fn key_store(&self) -> &'static str {
        KEY_STORE_OS
    }
    fn data_key(&self) -> Result<SecretKey, String> {
        Ok(SecretKey(self.0))
    }
}

// ── Sealer and SealedStore ──────────────────────────────────────────────────────────────────────────────────

/// AES-256-GCM under a key derived (HKDF-SHA-384, info `SEAL_INFO + name`) per sealed name from the sealing key,
/// with the name as associated data, so a sealed file cannot be swapped for another. A sealed value is
/// `SEAL_MAGIC || nonce || ciphertext || tag` (Python `Sealer`).
pub struct Sealer {
    key: SecretKey,
}

impl Sealer {
    pub fn new(key: SecretKey) -> Sealer {
        Sealer { key }
    }

    pub fn from_source(source: &dyn SealSource) -> Result<Sealer, String> {
        Ok(Sealer::new(source.data_key()?))
    }

    fn name_key(&self, name: &str) -> Result<SecretKey, String> {
        hkdf_sha384(self.key.bytes(), &[SEAL_INFO, name.as_bytes()].concat())
    }

    pub fn seal(&self, name: &str, data: &[u8]) -> Result<Vec<u8>, String> {
        let body = gcm_seal(&self.name_key(name)?, name.as_bytes(), data)?;
        Ok([SEAL_MAGIC, body.as_slice()].concat())
    }

    pub fn open(&self, name: &str, blob: &[u8]) -> Result<Vec<u8>, String> {
        if !blob.starts_with(SEAL_MAGIC) || blob.len() < SEAL_MAGIC.len() + NONCE_LEN + TAG_LEN {
            return Err(format!("{name} is not a sealed file"));
        }
        gcm_open(&self.name_key(name)?, name.as_bytes(), &blob[SEAL_MAGIC.len()..]).ok_or_else(|| format!("{name} could not be unsealed (another sealing key, or the file was changed)"))
    }
}

/// Named sealed values in `<folder>/<name>.bin` (JSON or bytes), the folder owner-only.
pub struct SealedStore {
    sealer: Sealer,
    folder: PathBuf,
    lock: Mutex<()>,
}

/// A sealed name: `[a-z0-9][a-z0-9._-]{0,120}`.
pub fn sealed_name_ok(name: &str) -> bool {
    let b = name.as_bytes();
    !b.is_empty() && b.len() <= 121 && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit()) && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, b'.' | b'_' | b'-'))
}

impl SealedStore {
    /// The store in `folder` (made owner-only when missing); the connector's is `state_dir/sealed`.
    pub fn open(sealer: Sealer, folder: PathBuf) -> Result<SealedStore, String> {
        make_private_dir(&folder).map_err(|e| format!("{} could not be made: {e}", folder.display()))?;
        Ok(SealedStore { sealer, folder, lock: Mutex::new(()) })
    }

    fn path(&self, name: &str) -> Result<PathBuf, String> {
        if !sealed_name_ok(name) {
            return Err(format!("not a sealed name: {name}"));
        }
        Ok(self.folder.join(format!("{name}.bin")))
    }

    // Test-only: the enroll, store, sync and seal tests check a sealed value is gone.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn has(&self, name: &str) -> bool {
        self.path(name).is_ok_and(|p| p.is_file())
    }

    /// The unsealed bytes, None when there is no such value.
    pub fn get_bytes(&self, name: &str) -> Result<Option<Vec<u8>>, String> {
        let path = self.path(name)?;
        let _g = self.lock.lock();
        let blob = match std::fs::read(&path) {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(format!("{name} could not be read: {e}")),
        };
        self.sealer.open(name, &blob).map(Some)
    }

    pub fn put_bytes(&self, name: &str, data: &[u8]) -> Result<(), String> {
        let path = self.path(name)?;
        let blob = self.sealer.seal(name, data)?;
        let _g = self.lock.lock();
        write_private(&path, &blob).map_err(|e| format!("{name} could not be written: {e}"))
    }

    pub fn get(&self, name: &str) -> Result<Option<Value>, String> {
        match self.get_bytes(name)? {
            None => Ok(None),
            Some(mut raw) => {
                let v = serde_json::from_slice(&raw).map_err(|_| format!("{name} is not JSON"));
                wipe(&mut raw);
                v.map(Some)
            }
        }
    }

    pub fn put(&self, name: &str, value: &Value) -> Result<(), String> {
        let mut raw = serde_json::to_vec(value).map_err(|_| format!("{name} could not be encoded"))?;
        let done = self.put_bytes(name, &raw);
        wipe(&mut raw);
        done
    }

    /// Delete a value durably; a missing one is fine.
    pub fn delete(&self, name: &str) -> Result<(), String> {
        let path = self.path(name)?;
        let _g = self.lock.lock();
        remove_durable(&path).map_err(|e| format!("{name} could not be deleted: {e}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp(name: &str) -> PathBuf {
        crate::meet_tls::testpki::dir(name)
    }

    fn sealer(b: u8) -> Sealer {
        Sealer::from_source(&FixedSource([b; KEY_LEN])).unwrap()
    }

    /// A stand-in for `systemd-creds`: the "encrypted" file is `<key mode>|<credential>|<hex key>`.
    struct FakeCreds {
        tpm: bool,
    }

    impl CredsTool for FakeCreds {
        fn has_tpm2(&self) -> bool {
            self.tpm
        }
        fn decrypt(&self, name: &str, path: &Path) -> Result<Vec<u8>, String> {
            let text = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
            let parts: Vec<&str> = text.split('|').collect();
            if parts.len() != 3 || parts[1] != name {
                return Err("wrong credential".into());
            }
            unhex(parts[2].as_bytes()).ok_or_else(|| "bad".to_string())
        }
    }

    #[test]
    fn a_sealed_value_opens_under_its_own_name_only() {
        let s = sealer(7);
        let blob = s.seal("key-app-helpdesk-api", b"private bytes").unwrap();
        assert!(blob.starts_with(SEAL_MAGIC));
        assert!(!blob.windows(13).any(|w| w == b"private bytes"));
        assert_eq!(s.open("key-app-helpdesk-api", &blob).unwrap(), b"private bytes");
        let wrong = s.open("key-app-other", &blob).unwrap_err();
        assert!(wrong.contains("could not be unsealed"), "{wrong}");
        assert!(sealer(8).open("key-app-helpdesk-api", &blob).is_err(), "another sealing key does not open it");
        let mut changed = blob.clone();
        let last = changed.len() - 1;
        changed[last] ^= 1;
        assert!(s.open("key-app-helpdesk-api", &changed).is_err());
        assert!(s.open("x", b"LS1short").unwrap_err().contains("is not a sealed file"));
    }

    #[test]
    fn the_sealer_derives_one_key_per_name() {
        // HKDF-SHA-384 with no salt and info SEAL_INFO + name, 32 bytes: the same key twice, another per name
        let a = hkdf_sha384(&[1u8; 32], &[SEAL_INFO, &b"a"[..]].concat()).unwrap();
        let b = hkdf_sha384(&[1u8; 32], &[SEAL_INFO, &b"a"[..]].concat()).unwrap();
        let c = hkdf_sha384(&[1u8; 32], &[SEAL_INFO, &b"b"[..]].concat()).unwrap();
        assert_eq!(a.bytes(), b.bytes());
        assert_ne!(a.bytes(), c.bytes());
    }

    #[test]
    fn the_sealed_store_keeps_named_values_owner_only() {
        let dir = temp("conn-sealed");
        let store = SealedStore::open(sealer(3), dir.join(SEALED_DIR)).unwrap();
        assert_eq!(store.get_bytes(names::TLS_KEY).unwrap(), None);
        store.put_bytes(names::TLS_KEY, b"tls private key").unwrap();
        assert!(store.has(names::TLS_KEY));
        assert_eq!(store.get_bytes(names::TLS_KEY).unwrap().unwrap(), b"tls private key");
        let raw = std::fs::read(dir.join(SEALED_DIR).join("tls-key.bin")).unwrap();
        assert!(!raw.windows(15).any(|w| w == b"tls private key"), "never in clear");
        store.put(names::APPROVALS, &json!({"a": [1, 2]})).unwrap();
        assert_eq!(store.get(names::APPROVALS).unwrap(), Some(json!({"a": [1, 2]})));
        // a sealed file renamed to another name does not open
        std::fs::copy(dir.join(SEALED_DIR).join("tls-key.bin"), dir.join(SEALED_DIR).join("deny-list.bin")).unwrap();
        assert!(store.get_bytes(names::DENY_LIST).is_err());
        store.delete(names::TLS_KEY).unwrap();
        store.delete(names::TLS_KEY).unwrap();
        assert!(!store.has(names::TLS_KEY));
        assert!(store.put_bytes("../escape", b"x").is_err());
        assert!(store.put_bytes("Upper", b"x").is_err());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(dir.join(SEALED_DIR)).unwrap().permissions().mode() & 0o777, 0o700);
            assert_eq!(std::fs::metadata(dir.join(SEALED_DIR).join("approvals.bin")).unwrap().permissions().mode() & 0o777, 0o600);
        }
    }

    #[test]
    fn the_seal_config_reads_each_source_and_refuses_unknown_keys() {
        let base = Path::new("/etc/lucid-api-connector");
        let sd = SealConfig::parse(&json!({"source": "systemd-creds", "credential": "lucid-api-connector-seal", "encrypted_file": "seal.cred"}), base).unwrap();
        assert_eq!(sd, SealConfig::SystemdCreds { credential: "lucid-api-connector-seal".into(), encrypted_file: base.join("seal.cred") });
        let p11 = SealConfig::parse(&json!({"source": "pkcs11", "module": "/usr/lib/p11.so", "token": "t", "key_label": "k", "pin_file": "pin"}), base).unwrap();
        assert_eq!(p11, SealConfig::Pkcs11);
        let az = SealConfig::parse(&json!({"source": "azure_key_vault", "vault": "https://acme.vault.azure.net", "key": "seal"}), base).unwrap();
        assert_eq!(az, SealConfig::AzureKeyVault);
        assert!(SealConfig::parse(&json!({"source": "systemd-creds", "credential": "c", "encrypted_file": "f", "extra": 1}), base).unwrap_err().contains("seal.extra"));
        assert!(SealConfig::parse(&json!({"source": "pkcs11", "module": "m", "token": "t", "key_label": "k"}), base).unwrap_err().contains("seal.pin_file"));
        assert!(SealConfig::parse(&json!({"source": "file"}), base).is_err());
        assert!(SealConfig::parse(&json!({"source": "systemd-creds", "credential": "a/b", "encrypted_file": "f"}), base).is_err());
        assert!(SealConfig::parse(&json!("systemd-creds"), base).is_err());
    }

    #[test]
    fn pkcs11_and_azure_key_vault_are_classified_and_refused_with_one_sentence() {
        let base = Path::new("/etc/x");
        let p11 = SealConfig::parse(&json!({"source": "pkcs11", "module": "m", "token": "t", "key_label": "k", "pin_file": "p"}), base).unwrap().source();
        assert_eq!(p11.key_store(), "pkcs11");
        assert_eq!(p11.data_key().unwrap_err(), "This lucid-relay build cannot use a PKCS#11 module to seal the connector's keys; use \"source\": \"systemd-creds\".");
        let az = SealConfig::parse(&json!({"source": "azure_key_vault", "vault": "v", "key": "k"}), base).unwrap().source();
        assert_eq!(az.key_store(), "azure_key_vault");
        assert_eq!(az.data_key().unwrap_err(), "This lucid-relay build cannot use Azure Key Vault to seal the connector's keys; use \"source\": \"systemd-creds\".");
        assert!(Sealer::from_source(az.as_ref()).is_err());
    }

    #[test]
    fn the_systemd_creds_source_is_classified_by_the_tpm_and_reads_the_key_back() {
        for (tpm, store, mode) in [(false, "os_store", "host"), (true, "tpm", "host+tpm2")] {
            let dir = temp("conn-seal-source");
            let cfg = SealConfig::parse(&json!({"source": "systemd-creds", "credential": "lucid-api-connector-seal", "encrypted_file": "seal.cred"}), &dir).unwrap();
            let tool = Arc::new(FakeCreds { tpm });
            std::fs::write(dir.join("seal.cred"), format!("{mode}|lucid-api-connector-seal|{}", "cd".repeat(32))).unwrap();
            let source = cfg.source_with(tool.clone(), None);
            assert_eq!(source.key_store(), store);
            let k1 = source.data_key().unwrap();
            assert_eq!(k1.bytes(), &[0xcd; 32]);
            assert_eq!(k1.bytes(), source.data_key().unwrap().bytes());
            // the unit's decrypted credential wins
            let creds = dir.join("creds");
            std::fs::create_dir_all(&creds).unwrap();
            std::fs::write(creds.join("lucid-api-connector-seal"), format!("{}\n", "ab".repeat(32))).unwrap();
            let from_unit = cfg.source_with(tool, Some(creds)).data_key().unwrap();
            assert_eq!(from_unit.bytes(), &[0xab; 32]);
        }
        // no encrypted file and no unit credential
        let dir = temp("conn-seal-none");
        let cfg = SealConfig::parse(&json!({"source": "systemd-creds", "credential": "c", "encrypted_file": "seal.cred"}), &dir).unwrap();
        assert!(cfg.source_with(Arc::new(FakeCreds { tpm: false }), None).data_key().unwrap_err().contains("not available"));
    }
}
