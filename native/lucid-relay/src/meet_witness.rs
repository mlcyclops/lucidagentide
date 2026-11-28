// MR-1 phase 1 section 2.5 (docs/multi-relay/contract-mr1-phase1.md): the witness that decides which node of a
// two-node cluster may be active. The nodes cannot tell "my peer is down" from "we cannot see each other", so a third
// party holds the answer: one Azure Blob with a `2 x lease_s` lease (the active renews it) and the cluster's epoch in its
// metadata. `witness_file` holds one HTTPS URL with a SAS token for that single blob (read and write only). The SAS
// URL is a secret: it is never logged.

use crate::http_client::{HttpClient, HttpResponse};
use std::path::Path;
use std::time::Duration;

/// The blob lease the active holds and renews: `2 x lease_s`, clamped to what Azure allows (15 to 60 s). The active
/// fences itself `lease_s` after its last renewal, before this lease can expire.
pub fn blob_lease_s(lease_s: u64) -> u64 {
    (2 * lease_s).clamp(15, 60)
}
const API_VERSION: &str = "2023-11-03";
const TIMEOUT: Duration = Duration::from_secs(10);

/// What `HEAD` of the blob says: its `epoch` metadata (0 when unset) and whether a lease is held now.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BlobView {
    pub epoch: u64,
    pub leased: bool,
}

/// The witness operations the cluster needs; tests use a fake.
pub trait Witness: Send + Sync {
    /// Take the lease with this id. Ok(false): another id holds it (it has not expired).
    fn acquire(&self, lease_id: &str) -> Result<bool, String>;
    /// Renew the lease this id holds. Ok(false): the lease is lost (expired and taken, or never held).
    fn renew(&self, lease_id: &str) -> Result<bool, String>;
    fn release(&self, lease_id: &str) -> Result<(), String>;
    fn read(&self) -> Result<BlobView, String>;
    /// Write `epoch` into the blob's metadata under the lease this id holds.
    fn set_epoch(&self, lease_id: &str, epoch: u64) -> Result<(), String>;
}

/// The lease id of a node: a GUID (as Azure wants it) derived from the cluster and node ids, so a restarted node
/// takes back its own lease at once.
pub fn lease_id(cluster: &str, node: &str) -> String {
    let h = crate::codec::sha256(format!("lucid-meet-cluster-lease\n{cluster}\n{node}").as_bytes());
    let x = crate::codec::hex(&h[..16]);
    format!("{}-{}-{}-{}-{}", &x[..8], &x[8..12], &x[12..16], &x[16..20], &x[20..32])
}

/// A secret of the cluster (the witness URL, the relay-client key): a regular file, never a link, and on Unix open to
/// its owner alone. The file opened is the file checked (no swap between the two looks).
pub fn read_private(path: &Path) -> Result<Vec<u8>, String> {
    let shown = path.display();
    let before = std::fs::symlink_metadata(path).map_err(|e| format!("cannot read {shown}: {e}"))?;
    if !before.file_type().is_file() {
        return Err(format!("{shown} must be a regular file, not a link"));
    }
    let mut f = std::fs::File::open(path).map_err(|e| format!("cannot read {shown}: {e}"))?;
    let meta = f.metadata().map_err(|e| format!("cannot read {shown}: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if meta.ino() != before.ino() || meta.dev() != before.dev() {
            return Err(format!("{shown} was replaced while it was read"));
        }
        if meta.mode() & 0o077 != 0 {
            return Err(format!("{shown} must be readable by the relay alone (mode 0600)"));
        }
    }
    if !meta.is_file() {
        return Err(format!("{shown} must be a regular file, not a link"));
    }
    let mut data = Vec::new();
    std::io::Read::read_to_end(&mut f, &mut data).map_err(|e| format!("cannot read {shown}: {e}"))?;
    Ok(data)
}

/// The SAS URL in `witness_file`: one `https://` URL with a query (the token), nothing else in the file.
pub fn read_url(path: &Path) -> Result<String, String> {
    let data = read_private(path).map_err(|e| format!("the witness file: {e}"))?;
    let text = String::from_utf8(data).map_err(|_| format!("the witness file {} must hold one https URL with a SAS token", path.display()))?;
    let url = text.trim();
    if !url.starts_with("https://") || !url.contains('?') || url.chars().any(char::is_whitespace) {
        return Err(format!("the witness file {} must hold one https URL with a SAS token", path.display()));
    }
    Ok(url.to_string())
}

/// `url` with `extra` added to its query (a SAS URL already has one, so `&`).
fn with_query(url: &str, extra: &str) -> String {
    if extra.is_empty() {
        url.to_string()
    } else if url.contains('?') {
        format!("{url}&{extra}")
    } else {
        format!("{url}?{extra}")
    }
}

/// The epoch metadata of a `HEAD` answer (Azure answers `x-ms-meta-Epoch`; header names are case-insensitive).
fn epoch_of(r: &HttpResponse) -> u64 {
    r.header("x-ms-meta-epoch").and_then(|v| v.trim().parse().ok()).unwrap_or(0)
}

/// The witness over the Azure Blob REST API.
pub struct AzureWitness {
    url: String,
    /// `x-ms-lease-duration` of an acquire, from `blob_lease_s`.
    duration: String,
}

impl AzureWitness {
    pub fn new(url: String, lease_s: u64) -> AzureWitness {
        AzureWitness { url, duration: blob_lease_s(lease_s).to_string() }
    }

    /// One request on a fresh runtime and client: a call every few seconds at most, from plain threads.
    fn call(&self, method: &str, query: &str, headers: &[(&str, &str)]) -> Result<HttpResponse, String> {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|e| e.to_string())?;
        let url = with_query(&self.url, query);
        let mut all: Vec<(&str, &str)> = vec![("x-ms-version", API_VERSION)];
        if method == "PUT" {
            all.push(("content-length", "0"));
        }
        all.extend_from_slice(headers);
        rt.block_on(async {
            let client = HttpClient::new()?;
            client.send(method, &url, &all, Vec::new(), TIMEOUT).await
        })
        .map_err(|e| format!("the witness did not answer ({e})"))
    }

    fn create(&self) -> Result<(), String> {
        let r = self.call("PUT", "", &[("x-ms-blob-type", "BlockBlob")])?;
        match r.status {
            201 | 200 => Ok(()),
            s => Err(format!("the witness blob could not be created (HTTP {s})")),
        }
    }

    fn lease(&self, action: &str, id_header: &str, lease_id: &str) -> Result<u16, String> {
        let mut h = vec![("x-ms-lease-action", action), (id_header, lease_id)];
        if action == "acquire" {
            h.push(("x-ms-lease-duration", self.duration.as_str()));
        }
        Ok(self.call("PUT", "comp=lease", &h)?.status)
    }
}

impl Witness for AzureWitness {
    fn acquire(&self, lease_id: &str) -> Result<bool, String> {
        let mut status = self.lease("acquire", "x-ms-proposed-lease-id", lease_id)?;
        if status == 404 {
            self.create()?;
            status = self.lease("acquire", "x-ms-proposed-lease-id", lease_id)?;
        }
        match status {
            200 | 201 => Ok(true),
            409 => Ok(false),
            s => Err(format!("the witness refused the lease (HTTP {s})")),
        }
    }

    fn renew(&self, lease_id: &str) -> Result<bool, String> {
        match self.lease("renew", "x-ms-lease-id", lease_id)? {
            200 => Ok(true),
            404 | 409 | 412 => Ok(false),
            s => Err(format!("the witness refused the renewal (HTTP {s})")),
        }
    }

    fn release(&self, lease_id: &str) -> Result<(), String> {
        match self.lease("release", "x-ms-lease-id", lease_id)? {
            200 | 409 | 412 => Ok(()),
            s => Err(format!("the witness refused the release (HTTP {s})")),
        }
    }

    fn read(&self) -> Result<BlobView, String> {
        let r = self.call("HEAD", "", &[])?;
        match r.status {
            200 => Ok(BlobView { epoch: epoch_of(&r), leased: r.header("x-ms-lease-state") == Some("leased") }),
            404 => {
                self.create()?;
                Ok(BlobView { epoch: 0, leased: false })
            }
            s => Err(format!("the witness blob could not be read (HTTP {s})")),
        }
    }

    fn set_epoch(&self, lease_id: &str, epoch: u64) -> Result<(), String> {
        let n = epoch.to_string();
        let r = self.call("PUT", "comp=metadata", &[("x-ms-meta-epoch", n.as_str()), ("x-ms-lease-id", lease_id)])?;
        match r.status {
            200 => Ok(()),
            s => Err(format!("the witness refused the epoch (HTTP {s})")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lease_ids_are_guids_per_node() {
        let a = lease_id("emertins-meet", "lab");
        assert_eq!(a.len(), 36);
        assert_eq!(a.split('-').map(str::len).collect::<Vec<_>>(), vec![8, 4, 4, 4, 12]);
        assert!(a.bytes().all(|c| c == b'-' || c.is_ascii_hexdigit()));
        assert_eq!(a, lease_id("emertins-meet", "lab"));
        assert_ne!(a, lease_id("emertins-meet", "azure"));
        assert_ne!(a, lease_id("other", "lab"));
    }

    #[test]
    fn the_blob_lease_is_twice_lease_s_within_azure_bounds() {
        assert_eq!(blob_lease_s(10), 20);
        assert_eq!(blob_lease_s(25), 50);
        assert_eq!(blob_lease_s(30), 60);
        assert_eq!(blob_lease_s(50), 60);
        assert_eq!(blob_lease_s(5), 15);
        for lease_s in 10..=50 {
            assert!(lease_s < blob_lease_s(lease_s), "the active fences before the lease can expire");
        }
        assert_eq!(AzureWitness::new("https://h/b?sig=1".into(), 10).duration, "20");
    }

    #[test]
    fn the_sas_url_keeps_its_query() {
        let sas = "https://x.blob.core.windows.net/c/lease?sv=2022&sig=abc";
        assert_eq!(with_query(sas, "comp=lease"), format!("{sas}&comp=lease"));
        assert_eq!(with_query(sas, ""), sas);
        assert_eq!(with_query("https://h/b", "comp=metadata"), "https://h/b?comp=metadata");
        let d = crate::meet_tls::testpki::dir("witness");
        let f = d.join("w.url");
        std::fs::write(&f, format!("{sas}\n")).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o640)).unwrap();
            assert!(read_url(&f).unwrap_err().contains("mode 0600"));
            std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o600)).unwrap();
            std::os::unix::fs::symlink(&f, d.join("link.url")).unwrap();
            assert!(read_url(&d.join("link.url")).unwrap_err().contains("not a link"));
        }
        assert!(read_url(&d).unwrap_err().contains("regular file"), "a folder is refused");
        assert_eq!(read_url(&f).unwrap(), sas);
        for bad in ["http://x/b?sig=1", "https://x/b", "https://x/b?a=1 https://y"] {
            std::fs::write(&f, bad).unwrap();
            assert!(read_url(&f).is_err(), "{bad}");
        }
        assert!(read_url(&d.join("absent")).is_err());
    }
}
