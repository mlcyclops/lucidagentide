// Owner-only files written the way the add-on's src/files.ts writes them (`<file>.tmp-<pid>`, then renamed), so a
// state folder moves between the Bun relay and this one in both directions.

use std::fs;
use std::io::Write;
use std::path::Path;

/// mkdir -p, owner-only for the folders it creates.
pub fn make_dir(dir: &Path) -> std::io::Result<()> {
    let mut b = fs::DirBuilder::new();
    b.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        b.mode(0o700);
    }
    b.create(dir)
}

fn open_private(path: &Path) -> std::io::Result<fs::File> {
    let mut o = fs::OpenOptions::new();
    o.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.mode(0o600);
    }
    o.open(path)
}

fn chmod_private(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }
    #[cfg(not(unix))]
    let _ = path;
}

/// Write atomically, 0600 (files.ts writePrivate).
pub fn write_private(path: &Path, data: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
        make_dir(parent)?;
    }
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(format!(".tmp-{}", std::process::id()));
    let tmp = Path::new(&tmp);
    let mut f = open_private(tmp)?;
    f.write_all(data)?;
    drop(f);
    fs::rename(tmp, path)?;
    chmod_private(path);
    Ok(())
}

/// Write in place, 0600 when created (the CRL file: writeFileSync with a mode).
pub fn write_in_place(path: &Path, data: &[u8]) -> std::io::Result<()> {
    open_private(path)?.write_all(data)
}

/// The file's text, trimmed, or None when it does not exist (files.ts readText).
pub fn read_text(path: &Path) -> Option<String> {
    let bytes = fs::read(path).ok()?;
    Some(crate::codec::js_trim(&crate::codec::utf8_lossy(&bytes)).to_owned())
}

pub fn remove(path: &Path) {
    let _ = fs::remove_file(path);
}
