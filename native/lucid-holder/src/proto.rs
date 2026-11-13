// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

//! The holder's wire format (ADR-0534).
//!
//! Handshake v2, one JSON line each, so the attach token never crosses the endpoint (whoever answers on it, the
//! holder or a process that took the name after the holder was gone, learns nothing it could use):
//! client `{"v":2,"nonce":<32 hex>}`; holder `{"v":2,"nonce":<32 hex>,"proof":proof(token,"holder",client nonce)}`;
//! client `{"v":2,"proof":proof(token,"engine",holder nonce),"from":<offset>}`; holder `{"v":2,"ok":true,...}`.
//! A refusal at any step is `{"v":2,"ok":false,"error"}`; a client that speaks another version is refused so.
//!
//! After the handshake, one frame is `kind (1 byte) | payload length (u32 little endian) | payload`.
//!
//! Holder to client: `O` agent stdout bytes (contiguous from the offset the client asked for),
//! `E` agent stderr bytes (live, plus the recent tail once per attach), `X` the agent's exit code (i32 LE,
//! -1 when a signal ended it).
//! Client to holder: `I` bytes for the agent's stdin, `C` close the agent's stdin, `T` trim the spool to an
//! offset (u64 LE), `P` how long to keep the agent with no client attached (u64 LE milliseconds), `K` end the
//! agent and everything it started, then the holder.

use hmac::{Hmac, Mac};
use sha2::Sha256;
use std::io::{self, Read, Write};

/// The handshake version this holder speaks (lane_holder.ts HANDSHAKE).
pub const HANDSHAKE: u64 = 2;

pub const OUT: u8 = b'O';
pub const ERR: u8 = b'E';
pub const EXIT: u8 = b'X';
pub const STDIN: u8 = b'I';
pub const CLOSE_STDIN: u8 = b'C';
pub const TRIM: u8 = b'T';
pub const ORPHAN: u8 = b'P';
pub const KILL: u8 = b'K';

/// A client frame larger than this is a broken or hostile client: the connection is dropped.
pub const MAX_FRAME: usize = 16 * 1024 * 1024;

pub fn encode(kind: u8, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(5 + payload.len());
    out.push(kind);
    out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    out.extend_from_slice(payload);
    out
}

pub fn write_frame(w: &mut impl Write, kind: u8, payload: &[u8]) -> io::Result<()> {
    w.write_all(&encode(kind, payload))?;
    w.flush()
}

/// The next frame, or None on a clean end of stream between frames.
pub fn read_frame(r: &mut impl Read) -> io::Result<Option<(u8, Vec<u8>)>> {
    let mut head = [0u8; 5];
    let mut got = 0;
    while got < head.len() {
        let n = r.read(&mut head[got..])?;
        if n == 0 {
            return if got == 0 { Ok(None) } else { Err(io::ErrorKind::UnexpectedEof.into()) };
        }
        got += n;
    }
    let len = u32::from_le_bytes([head[1], head[2], head[3], head[4]]) as usize;
    if len > MAX_FRAME {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "frame too large"));
    }
    let mut payload = vec![0u8; len];
    r.read_exact(&mut payload)?;
    Ok(Some((head[0], payload)))
}

pub fn u64_of(payload: &[u8]) -> Option<u64> {
    <[u8; 8]>::try_from(payload).ok().map(u64::from_le_bytes)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn hmac_sha256_hex(key: &[u8], data: &[u8]) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("HMAC takes a key of any length");
    mac.update(data);
    hex(&mac.finalize().into_bytes())
}

/// What one side of the handshake proves with: HMAC-SHA256 keyed with the attach token over
/// `lucid-holder/v2 <role> <nonce>`, in lowercase hex. The holder proves over the client's nonce, the client over the
/// holder's; the role keeps either proof from being reflected as the other.
pub fn proof(token: &[u8], role: &str, nonce: &str) -> String {
    hmac_sha256_hex(token, format!("lucid-holder/v2 {role} {nonce}").as_bytes())
}

/// `n` bytes from the OS random source, in lowercase hex.
pub fn random_hex(n: usize) -> io::Result<String> {
    let mut buf = vec![0u8; n];
    getrandom::getrandom(&mut buf).map_err(|e| io::Error::other(e.to_string()))?;
    Ok(hex(&buf))
}

/// A handshake nonce: 16 bytes in lowercase hex.
pub fn is_nonce(s: &str) -> bool {
    s.len() == 32 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Equal-time comparison for a handshake proof.
pub fn same_secret(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_round_trip_and_end_cleanly() {
        let mut wire = Vec::new();
        write_frame(&mut wire, OUT, b"hello\n").unwrap();
        write_frame(&mut wire, TRIM, &42u64.to_le_bytes()).unwrap();
        let mut r = wire.as_slice();
        assert_eq!(read_frame(&mut r).unwrap(), Some((OUT, b"hello\n".to_vec())));
        let (kind, p) = read_frame(&mut r).unwrap().unwrap();
        assert_eq!((kind, u64_of(&p)), (TRIM, Some(42)));
        assert_eq!(read_frame(&mut r).unwrap(), None);
    }

    #[test]
    fn a_frame_cut_short_or_oversized_is_an_error() {
        let wire = encode(OUT, b"abc");
        assert!(read_frame(&mut &wire[..6]).is_err());
        assert!(read_frame(&mut &wire[..3]).is_err());
        let mut big = vec![OUT];
        big.extend_from_slice(&((MAX_FRAME as u32) + 1).to_le_bytes());
        assert!(read_frame(&mut big.as_slice()).is_err());
    }

    #[test]
    fn the_mac_is_hmac_sha256() {
        // RFC 4231, test case 2.
        assert_eq!(hmac_sha256_hex(b"Jefe", b"what do ya want for nothing?"), "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
    }

    #[test]
    fn a_proof_is_bound_to_its_role_its_nonce_and_the_token() {
        let token = "a".repeat(64);
        let nonce = "00112233445566778899aabbccddeeff";
        let p = proof(token.as_bytes(), "holder", nonce);
        assert_eq!(p.len(), 64);
        assert!(!p.contains(&token));
        assert_eq!(p, proof(token.as_bytes(), "holder", nonce));
        assert_ne!(p, proof(token.as_bytes(), "engine", nonce), "a holder proof is no engine proof");
        assert_ne!(p, proof(token.as_bytes(), "holder", "ffeeddccbbaa99887766554433221100"));
        assert_ne!(p, proof("b".repeat(64).as_bytes(), "holder", nonce));
    }

    #[test]
    fn nonces_come_from_the_os_and_have_one_shape() {
        let a = random_hex(16).unwrap();
        let b = random_hex(16).unwrap();
        assert!(is_nonce(&a) && is_nonce(&b));
        assert_ne!(a, b);
        assert!(!is_nonce("00112233445566778899AABBCCDDEEFF"), "lowercase only");
        assert!(!is_nonce("0011"));
    }

    #[test]
    fn secrets_compare_by_value_and_length() {
        assert!(same_secret(b"abc", b"abc"));
        assert!(!same_secret(b"abc", b"abd"));
        assert!(!same_secret(b"abc", b"abcd"));
    }
}
