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
    /// LH-08: the most bytes kept at once. Past it the oldest half goes, cut at a line start.
    cap: u64,
    /// The offset up to which the cap (not a client's trim) dropped bytes; 0 while it never did.
    capped: u64,
    /// After a cap cut failed, none is tried again before `end` reaches this: each try copies up to half the cap,
    /// and retrying it on every write would copy that much per write while the cause lasts.
    cut_after: u64,
    /// How the trimmed copy replaces the file (a test makes it fail).
    rename: fn(&Path, &Path) -> io::Result<()>,
}

impl Spool {
    pub fn create(path: &Path, cap: u64) -> io::Result<Spool> {
        let file = OpenOptions::new().create(true).truncate(true).write(true).read(true).open(path)?;
        Ok(Spool { path: path.to_path_buf(), file: Some(file), base: 0, end: 0, cap: cap.max(2), capped: 0, cut_after: 0, rename: |from: &Path, to: &Path| fs::rename(from, to) })
    }

    pub fn base(&self) -> u64 { self.base }
    pub fn end(&self) -> u64 { self.end }
    pub fn cap(&self) -> u64 { self.cap }
    pub fn capped(&self) -> u64 { self.capped }

    /// Keep `data`. LH-08: when that takes the kept bytes past the cap, the oldest go, so the file never holds much
    /// more than the cap however long one turn writes. The cut lands just after a newline at or past the middle of
    /// what is kept (the agent speaks one JSON message per line, so a replay from there starts on a whole message),
    /// or at the end when the kept half holds no newline. A cut that fails (Windows will not replace a file a
    /// replay still reads) is tried again once another eighth of the cap was written; the bytes are never refused
    /// for it.
    pub fn append(&mut self, data: &[u8]) -> io::Result<()> {
        let file = self.file.as_mut().ok_or_else(|| io::Error::other("spool is being trimmed"))?;
        file.write_all(data)?;
        self.end += data.len() as u64;
        if self.end - self.base > self.cap && self.end >= self.cut_after {
            let cut = self.line_start_from(self.end - self.cap / 2).unwrap_or(self.end);
            match self.trim(cut) {
                Ok(()) => self.capped = cut,
                Err(_) => self.cut_after = self.end + self.cap / 8,
            }
        }
        Ok(())
    }

    /// The offset just past the first newline at or after `from`, or None when there is none before the end.
    fn line_start_from(&self, from: u64) -> Option<u64> {
        let mut at = from;
        let mut found = None;
        let _ = self.read_from(from, |chunk| {
            if let Some(i) = chunk.iter().position(|b| *b == b'\n') {
                found = Some(at + i as u64 + 1);
                return Err(io::Error::other("found"));
            }
            at += chunk.len() as u64;
            Ok(())
        });
        found
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
        let renamed = (self.rename)(&tmp, &self.path);
        if renamed.is_err() {
            let _ = fs::remove_file(&tmp);
        }
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
        let mut s = Spool::create(&dir.join("t.spool"), u64::MAX).unwrap();
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

    #[test]
    fn the_cap_drops_the_oldest_output_at_a_line_start_and_says_how_far() {
        let dir = std::env::temp_dir().join(format!("lucid-holder-cap-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("c.spool");
        let mut s = Spool::create(&path, 40).unwrap();
        s.append(b"0123456789abcdefghi\n").unwrap(); // 20 bytes, under the cap
        assert_eq!((s.base(), s.capped()), (0, 0));
        s.append(b"line two is here...\n").unwrap(); // 40: at the cap, still kept whole
        assert_eq!((s.base(), s.capped()), (0, 0));
        s.append(b"three\n").unwrap(); // 46 > 40: cut after the first newline at or past 46 - 20 = 26
        assert_eq!((s.base(), s.end(), s.capped()), (40, 46, 40));
        assert_eq!(collect(&s, 40), b"three\n");
        assert!(s.read_from(0, |_| Ok(())).is_err(), "the dropped bytes are gone");
        assert!(fs::metadata(&path).unwrap().len() <= 40, "the file holds no more than the cap");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_cut_that_fails_is_tried_again_only_after_more_output_not_on_every_write() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static RENAMES: AtomicUsize = AtomicUsize::new(0);
        fn refuse(_: &Path, _: &Path) -> io::Result<()> {
            RENAMES.fetch_add(1, Ordering::SeqCst);
            Err(io::Error::new(io::ErrorKind::PermissionDenied, "a replay still reads the file"))
        }
        let dir = std::env::temp_dir().join(format!("lucid-holder-cutfail-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("f.spool");
        let mut s = Spool::create(&path, 64).unwrap();
        s.rename = refuse;
        s.append(&[b'x'; 70]).unwrap(); // past the cap: the cut is tried and fails
        assert_eq!(RENAMES.load(Ordering::SeqCst), 1);
        assert_eq!((s.base(), s.capped()), (0, 0), "nothing was dropped");
        assert!(!path.with_extension("spool.tmp").exists(), "the failed copy is gone");
        for _ in 0..3 {
            s.append(b"y\n").unwrap(); // still past the cap, but within an eighth of it since the failure
        }
        assert_eq!(RENAMES.load(Ordering::SeqCst), 1, "not retried on every write");
        assert_eq!(collect(&s, 0).len(), 76, "every byte is still kept and readable");
        s.append(b"y\n").unwrap(); // an eighth of the cap later: tried again
        assert_eq!(RENAMES.load(Ordering::SeqCst), 2);
        s.rename = |from: &Path, to: &Path| fs::rename(from, to);
        for _ in 0..4 {
            s.append(b"y\n").unwrap();
        }
        // Tried once more an eighth later, and it holds: cut after the first newline at or past 86 - 32.
        assert_eq!((s.base(), s.end(), s.capped()), (72, 86, 72));
        assert_eq!(collect(&s, 72), b"y\n".repeat(7));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn output_with_no_newline_past_the_cap_is_dropped_whole_and_writing_goes_on() {
        let dir = std::env::temp_dir().join(format!("lucid-holder-cap2-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let mut s = Spool::create(&dir.join("d.spool"), 16).unwrap();
        s.append(&[b'x'; 40]).unwrap();
        assert_eq!((s.base(), s.end(), s.capped()), (40, 40, 40));
        s.append(b"next\n").unwrap();
        assert_eq!(collect(&s, 40), b"next\n");
        fs::remove_dir_all(&dir).ok();
    }
}
