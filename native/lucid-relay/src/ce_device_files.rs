// CE-1 encrypted files (chat-e2ee contract revision 11, section 9; API-1c r5 2.1 to 2.8 device side): a file is cut
// into 64 KiB chunks, each sealed with AES-256-GCM under the file key, nonce `0^4 || u64(i)` and the additional data
// `lp("lucid-meet-chat-file-v1", fid, u64(i), "1" | "0")` (final flag). Nothing decrypted is released before the
// final chunk, the size and the SHA-256 of the descriptor have all been checked. The reader side of
// `meet_chat_e2ee.py` (`FileOpener` .. `decrypt_bytes`): the connector only reads files, whole and in memory, at most
// 25 MiB (r5 2.7, 7.1).

use aws_lc_rs::{aead, digest};
use serde_json::Value;

use crate::ce_device::{fail, CeError, CeResult};

/// Plaintext bytes in every chunk but the last.
pub const CHUNK: usize = 65536;
/// The AES-GCM tag after every chunk.
pub const TAG: usize = 16;

const FILE: &str = "lucid-meet-chat-file-v1";
const MAX_INT: u64 = (1 << 53) - 1;

fn lp(fields: &[&[u8]]) -> Vec<u8> {
    let mut out = Vec::with_capacity(fields.iter().map(|f| 4 + f.len()).sum());
    for f in fields {
        out.extend_from_slice(&(f.len() as u32).to_be_bytes());
        out.extend_from_slice(f);
    }
    out
}

fn is_lower_hex(s: &str) -> bool {
    s.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

fn check_fid(fid: &str) -> CeResult<()> {
    if fid.len() != 32 || !is_lower_hex(fid) {
        return fail("encoding", "not a file id");
    }
    Ok(())
}

fn unhex(s: &str) -> Vec<u8> {
    let v = |c: u8| if c.is_ascii_digit() { c - b'0' } else { c - b'a' + 10 };
    s.as_bytes().chunks(2).map(|p| (v(p[0]) << 4) | v(p[1])).collect()
}

fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// The nonce of chunk `i`: four zero bytes, then `u64(i)` big-endian.
pub fn chunk_nonce(i: u64) -> [u8; 12] {
    let mut n = [0u8; 12];
    n[4..].copy_from_slice(&i.to_be_bytes());
    n
}

/// The additional data of chunk `i` of file `fid`.
pub fn chunk_aad(fid: &str, i: u64, final_chunk: bool) -> Vec<u8> {
    let flag: &[u8] = if final_chunk { b"1" } else { b"0" };
    lp(&[FILE.as_bytes(), fid.as_bytes(), &i.to_be_bytes(), flag])
}

fn file_key(fk: &[u8], fid: &str) -> CeResult<aead::LessSafeKey> {
    check_fid(fid)?;
    if fk.len() != 32 {
        return fail("file", "a file key is 32 bytes");
    }
    match aead::UnboundKey::new(&aead::AES_256_GCM, fk) {
        Ok(k) => Ok(aead::LessSafeKey::new(k)),
        Err(_) => fail("file", "a file key is 32 bytes"),
    }
}

/// Streaming decryption. What `feed` returns is verified chunk by chunk but must be held back (in memory or a
/// temporary file): nothing is released before `finish` checks the final flag, the size and the SHA-256.
pub struct FileOpener {
    key: aead::LessSafeKey,
    fid: String,
    size: u64,
    want: Vec<u8>,
    buf: Vec<u8>,
    i: u64,
    seen: u64,
    hash: digest::Context,
    done: bool,
}

impl FileOpener {
    pub fn new(fk: &[u8], fid: &str, size: u64, sha256_hex: &str) -> CeResult<Self> {
        let key = file_key(fk, fid)?;
        if size > MAX_INT {
            return fail("encoding", "size out of range");
        }
        if sha256_hex.len() != 64 || !is_lower_hex(sha256_hex) {
            return fail("encoding", "sha256 is not 32 bytes of lower-case hex");
        }
        Ok(FileOpener {
            key,
            fid: fid.to_string(),
            size,
            want: unhex(sha256_hex),
            buf: Vec::new(),
            i: 0,
            seen: 0,
            hash: digest::Context::new(&digest::SHA256),
            done: false,
        })
    }

    /// Opens one chunk (`self.buf[at..at + n]`) and appends its plaintext to `out`.
    fn open_chunk(&mut self, at: usize, n: usize, final_chunk: bool, out: &mut Vec<u8>) -> CeResult<()> {
        let start = out.len();
        out.extend_from_slice(&self.buf[at..at + n]);
        let aad = chunk_aad(&self.fid, self.i, final_chunk);
        let plain_len = match self.key.open_in_place(
            aead::Nonce::assume_unique_for_key(chunk_nonce(self.i)),
            aead::Aad::from(&aad[..]),
            &mut out[start..],
        ) {
            Ok(p) => p.len(),
            Err(_) => return fail("file", "a file chunk does not verify"),
        };
        out.truncate(start + plain_len);
        self.i += 1;
        self.seen += plain_len as u64;
        if self.seen > self.size {
            return fail("file", "the file is larger than its descriptor says");
        }
        self.hash.update(&out[start..]);
        Ok(())
    }

    pub fn feed(&mut self, data: &[u8]) -> CeResult<Vec<u8>> {
        if self.done {
            return fail("file", "the file is finished");
        }
        self.buf.extend_from_slice(data);
        let mut out = Vec::new();
        let mut at = 0;
        while self.buf.len() - at >= CHUNK + TAG {
            self.open_chunk(at, CHUNK + TAG, false, &mut out)?;
            at += CHUNK + TAG;
        }
        self.buf.drain(..at);
        Ok(out)
    }

    pub fn finish(&mut self) -> CeResult<Vec<u8>> {
        if self.done {
            return fail("file", "the file is finished");
        }
        self.done = true;
        if self.buf.len() < TAG {
            return fail("file", "the file has no final chunk");
        }
        let mut out = Vec::with_capacity(self.buf.len());
        let n = self.buf.len();
        self.open_chunk(0, n, true, &mut out)?;
        self.buf.clear();
        if self.seen != self.size {
            return fail("file", "the file size differs from its descriptor");
        }
        let got = self.hash.clone().finish();
        if !ct_eq(got.as_ref(), &self.want) {
            return fail("file", "the file hash differs from its descriptor");
        }
        Ok(out)
    }
}

/// The opener of a file descriptor (`fid`, `size`, `sha256`, `key`; `id`, `name`, `mime`, `clip` allowed).
pub fn opener(descriptor: &Value) -> CeResult<FileOpener> {
    const REQUIRED: [&str; 4] = ["fid", "size", "sha256", "key"];
    const OPTIONAL: [&str; 4] = ["id", "name", "mime", "clip"];
    let Some(obj) = descriptor.as_object() else { return fail("rules", "an object was expected") };
    if !REQUIRED.iter().all(|k| obj.contains_key(*k)) || !obj.keys().all(|k| REQUIRED.contains(&k.as_str()) || OPTIONAL.contains(&k.as_str())) {
        return fail("rules", "unexpected or missing fields");
    }
    let fk = match obj["key"].as_str().and_then(crate::meet_json::b64_strict) {
        Some(raw) if raw.len() == 32 && crate::meet_json::b64(&raw) == obj["key"].as_str().unwrap_or_default() => raw,
        _ => return fail("file", "unreadable file key"),
    };
    let Some(fid) = obj["fid"].as_str() else { return fail("file", "not a file id") };
    let Some(size) = obj["size"].as_u64() else { return fail("file", "size out of range") };
    let Some(sha) = obj["sha256"].as_str() else { return fail("file", "sha256 is not 32 bytes of lower-case hex") };
    FileOpener::new(&fk, fid, size, sha).map_err(|e| CeError { code: "file", message: e.message })
}

/// A whole ciphertext in memory, decrypted and checked.
pub fn decrypt_bytes(stream: &[u8], descriptor: &Value) -> CeResult<Vec<u8>> {
    let mut opener = opener(descriptor)?;
    let mut out = opener.feed(stream)?;
    out.extend_from_slice(&opener.finish()?);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The ciphertext length of a `size`-byte file: one tag per chunk, plus the final (possibly empty) chunk.
    fn ciphertext_size(size: u64) -> CeResult<u64> {
        if size > MAX_INT {
            return fail("encoding", "size out of range");
        }
        Ok(size + (TAG as u64) * (size / CHUNK as u64 + 1))
    }

    fn pattern(n: usize) -> Vec<u8> {
        (0..n).map(|i| (i % 251) as u8).collect()
    }

    fn vectors() -> Value {
        serde_json::from_str(include_str!("../tests/chat_e2ee_v1.json")).expect("vectors parse")
    }

    fn stream_b64(c: &Value) -> Vec<u8> {
        crate::meet_json::b64_strict(c["stream_b64"].as_str().unwrap()).unwrap()
    }

    // make_chat_e2ee_v1.py check_files
    #[test]
    fn file_vectors() {
        let data = vectors();
        let cases = data["file"].as_array().unwrap();
        assert!(!cases.is_empty());
        let by_name = |name: &str| cases.iter().find(|c| c["name"] == name).unwrap();
        for c in cases {
            let name = c["name"].as_str().unwrap();
            let desc = json!({
                "fid": c["fid"], "size": c["size"], "sha256": c["sha256"],
                "key": crate::meet_json::b64(&unhex(c["key_hex"].as_str().unwrap())),
            });
            let stream = if c.get("stream_b64").is_some() {
                stream_b64(c)
            } else {
                let base = stream_b64(by_name(c["stream_from"]["case"].as_str().unwrap()));
                let mut s = Vec::new();
                for r in c["stream_from"]["ranges"].as_array().unwrap() {
                    let (a, b) = (r[0].as_u64().unwrap() as usize, r[1].as_u64().unwrap() as usize);
                    s.extend_from_slice(&base[a.min(base.len())..b.min(base.len())]);
                }
                s
            };
            let got = decrypt_bytes(&stream, &desc);
            let want_ok = c["ok"].as_bool().unwrap();
            let code = match &got {
                Ok(_) => "",
                Err(e) => e.code,
            };
            assert_eq!((got.is_ok(), code), (want_ok, c["error"].as_str().unwrap_or("")), "{name}");
            if let Ok(plain) = got {
                assert_eq!(plain, pattern(c["plaintext"]["len"].as_u64().unwrap() as usize), "{name}");
                assert_eq!(ciphertext_size(plain.len() as u64).unwrap(), stream.len() as u64, "{name}");
            }
        }
    }

    // tests/test_meet_chat_e2ee.py test_files_stream_in_any_pieces (the opener half, on the `multi` vector)
    #[test]
    fn files_open_in_any_pieces() {
        let data = vectors();
        let c = data["file"].as_array().unwrap().iter().find(|c| c["name"] == "multi").unwrap();
        let sealed = stream_b64(c);
        let plain = pattern(c["plaintext"]["len"].as_u64().unwrap() as usize);
        let pieces = [1usize, 7, CHUNK - 1, CHUNK + 1, 1000, 3, 2 * CHUNK];
        let fk = unhex(c["key_hex"].as_str().unwrap());
        let mut opener = FileOpener::new(&fk, c["fid"].as_str().unwrap(), plain.len() as u64, c["sha256"].as_str().unwrap()).unwrap();
        let mut opened = Vec::new();
        let (mut at, mut k) = (0, 3);
        while at < sealed.len() {
            let n = pieces[k % pieces.len()].min(sealed.len() - at);
            opened.extend_from_slice(&opener.feed(&sealed[at..at + n]).unwrap());
            at += n;
            k += 1;
        }
        opened.extend_from_slice(&opener.finish().unwrap());
        assert_eq!(opened, plain);
        assert_eq!(opener.feed(b"x").unwrap_err().code, "file");
    }
}
