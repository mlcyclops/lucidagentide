// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

//! Everything the agent wrote to stdout since the last trim, on disk, addressed by absolute byte offset. A client
//! that comes back (a restarted engine) asks for the bytes from the offset it last handled and gets exactly those,
//! then the live stream. Memory stays flat however long the agent writes while nobody listens.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

const CHUNK: usize = 64 * 1024;

pub struct Spool {
    path: PathBuf,
    /// None only for the moment a trim swaps the file.
    file: Option<File>,
    /// Offset of the first byte still kept.
    base: u64,
    /// Offset one past the last byte written.
    end: u64,
}

impl Spool {
    pub fn create(path: &Path) -> io::Result<Spool> {
        let file = OpenOptions::new().create(true).truncate(true).write(true).read(true).open(path)?;
        Ok(Spool { path: path.to_path_buf(), file: Some(file), base: 0, end: 0 })
    }

    pub fn base(&self) -> u64 { self.base }
    pub fn end(&self) -> u64 { self.end }

    pub fn append(&mut self, data: &[u8]) -> io::Result<()> {
        let file = self.file.as_mut().ok_or_else(|| io::Error::other("spool is being trimmed"))?;
        file.write_all(data)?;
        self.end += data.len() as u64;
        Ok(())
    }

    /// A file handle at `from` and how many kept bytes follow it right now. The handle keeps reading the same bytes
    /// even if a trim swaps the file afterwards, so a caller may stream it without holding any lock.
    pub fn reader(&self, from: u64) -> io::Result<(File, u64)> {
        if from < self.base || from > self.end {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "offset not kept"));
        }
        let mut r = File::open(&self.path)?;
        r.seek(SeekFrom::Start(from - self.base))?;
        Ok((r, self.end - from))
    }

    /// Hand `each` the kept bytes from `from` to the end, in chunks. `from` must lie in `base..=end`.
    pub fn read_from(&self, from: u64, mut each: impl FnMut(&[u8]) -> io::Result<()>) -> io::Result<()> {
        let (mut r, mut left) = self.reader(from)?;
        let mut buf = vec![0u8; CHUNK];
        while left > 0 {
            let want = left.min(CHUNK as u64) as usize;
            let n = r.read(&mut buf[..want])?;
            if n == 0 {
                return Err(io::ErrorKind::UnexpectedEof.into());
            }
            each(&buf[..n])?;
            left -= n as u64;
        }
        Ok(())
    }

    /// Forget the bytes before `to` (the client handled them). Offsets outside the kept range change nothing.
    pub fn trim(&mut self, to: u64) -> io::Result<()> {
        if to <= self.base || to > self.end {
            return Ok(());
        }
        let tmp = self.path.with_extension("spool.tmp");
        {
            let mut out = File::create(&tmp)?;
            self.read_from(to, |chunk| out.write_all(chunk))?;
            out.sync_all()?;
        }
        // Windows will not rename over a file this process still has open.
        self.file = None;
        let renamed = fs::rename(&tmp, &self.path);
        self.file = Some(OpenOptions::new().append(true).read(true).open(&self.path)?);
        renamed?;
        self.base = to;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn collect(s: &Spool, from: u64) -> Vec<u8> {
        let mut out = Vec::new();
        s.read_from(from, |c| { out.extend_from_slice(c); Ok(()) }).unwrap();
        out
    }

    #[test]
    fn replays_from_any_kept_offset_and_trims_keep_offsets_absolute() {
        let dir = std::env::temp_dir().join(format!("lucid-holder-spool-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let mut s = Spool::create(&dir.join("t.spool")).unwrap();
        s.append(b"first line\n").unwrap();
        s.append(b"second line\n").unwrap();
        assert_eq!(collect(&s, 0), b"first line\nsecond line\n");
        assert_eq!(collect(&s, 11), b"second line\n");
        s.trim(11).unwrap();
        assert_eq!((s.base(), s.end()), (11, 23));
        assert_eq!(collect(&s, 11), b"second line\n");
        assert!(s.read_from(0, |_| Ok(())).is_err(), "trimmed bytes are gone");
        s.append(b"third\n").unwrap();
        assert_eq!(collect(&s, 23), b"third\n");
        s.trim(5).unwrap(); // before base: nothing changes
        s.trim(999).unwrap(); // past the end: nothing changes
        assert_eq!((s.base(), s.end()), (11, 29));
        fs::remove_dir_all(&dir).ok();
    }
}
