// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

//! The holder's wire format after the handshake line (ADR-0528). One frame is
//! `kind (1 byte) | payload length (u32 little endian) | payload`.
//!
//! Holder to client: `O` agent stdout bytes (contiguous from the offset the client asked for),
//! `E` agent stderr bytes (live, plus the recent tail once per attach), `X` the agent's exit code (i32 LE,
//! -1 when a signal ended it).
//! Client to holder: `I` bytes for the agent's stdin, `C` close the agent's stdin, `T` trim the spool to an
//! offset (u64 LE), `P` how long to keep the agent with no client attached (u64 LE milliseconds), `K` end the
//! agent and everything it started, then the holder.

use std::io::{self, Read, Write};

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

/// Equal-time comparison for the attach token.
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
    fn secrets_compare_by_value_and_length() {
        assert!(same_secret(b"abc", b"abc"));
        assert!(!same_secret(b"abc", b"abd"));
        assert!(!same_secret(b"abc", b"abcd"));
    }
}
