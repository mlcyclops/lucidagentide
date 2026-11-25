// Where an Admin Console request comes from (contract AC-1 section 3.1, H5): the networks the console answers
// (`--console-sources`, Meeting Hub `console_sources`), the TLS fronts allowed to name the client in X-Forwarded-For
// (`--console-trusted-fronts`), and the key every per-source limit counts by (IPv4 by address, IPv6 by /64).
//
// Rules: without a front the source is the TCP peer. Behind a front, X-Forwarded-For is read only when the TCP peer is
// inside the trusted fronts; its addresses (every header, joined in order) are walked from the right, skipping trusted
// fronts, and the first address outside them is the source. A peer outside the fronts, no header, a value that is not
// an IP address (including `ip:port`), or a header whose every address is a trusted front is refused, never judged by
// the peer's own address.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

/// `--console-sources` when not given (decision 9): loopback, the private ranges, CGNAT and IPv6 unique local.
pub const DEFAULT_SOURCES: &str = "127.0.0.0/8,::1/128,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,100.64.0.0/10,fc00::/7";
pub const SOURCES_MAX: usize = 32;
pub const FRONTS_MAX: usize = 16;

/// An address range: the network (host bits cleared) and the prefix length.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Cidr {
    net: IpAddr,
    prefix: u8,
}

/// An IPv4-mapped IPv6 address (::ffff:a.b.c.d) as the IPv4 address it carries; anything else unchanged.
pub fn canonical(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map(IpAddr::V4).unwrap_or(ip),
        v4 => v4,
    }
}

fn mask_v4(a: Ipv4Addr, prefix: u8) -> Ipv4Addr {
    let bits = u32::from(a);
    let m = if prefix == 0 { 0 } else { u32::MAX << (32 - u32::from(prefix)) };
    Ipv4Addr::from(bits & m)
}

fn mask_v6(a: Ipv6Addr, prefix: u8) -> Ipv6Addr {
    let bits = u128::from(a);
    let m = if prefix == 0 { 0 } else { u128::MAX << (128 - u32::from(prefix)) };
    Ipv6Addr::from(bits & m)
}

impl Cidr {
    /// Whether `ip` (an IPv4-mapped IPv6 address read as IPv4) is inside the range.
    pub fn contains(&self, ip: IpAddr) -> bool {
        match (self.net, canonical(ip)) {
            (IpAddr::V4(n), IpAddr::V4(a)) => mask_v4(a, self.prefix) == n,
            (IpAddr::V6(n), IpAddr::V6(a)) => mask_v6(a, self.prefix) == n,
            _ => false,
        }
    }

    /// Wider than /24 (IPv4) or /64 (IPv6): too broad for a trusted front (start warning `console.fronts-wide`).
    pub fn wide(&self) -> bool {
        match self.net {
            IpAddr::V4(_) => self.prefix < 24,
            IpAddr::V6(_) => self.prefix < 64,
        }
    }
}

impl std::fmt::Display for Cidr {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}/{}", self.net, self.prefix)
    }
}

/// One range: `address/prefix`, or a bare address (the one address).
pub fn parse_cidr(s: &str) -> Result<Cidr, String> {
    let s = s.trim();
    let bad = || format!("{s} is not an address range (for example 10.0.0.0/8 or fd00::/8)");
    let (addr, prefix) = match s.split_once('/') {
        Some((a, p)) => (a, Some(p)),
        None => (s, None),
    };
    let ip: IpAddr = addr.parse().map_err(|_| bad())?;
    let ip = canonical(ip);
    let max = if ip.is_ipv4() { 32 } else { 128 };
    let prefix = match prefix {
        None => max,
        Some(p) => {
            if p.is_empty() || p.len() > 3 || !p.bytes().all(|b| b.is_ascii_digit()) {
                return Err(bad());
            }
            p.parse::<u8>().ok().filter(|n| *n <= max).ok_or_else(bad)?
        }
    };
    let net = match ip {
        IpAddr::V4(a) => IpAddr::V4(mask_v4(a, prefix)),
        IpAddr::V6(a) => IpAddr::V6(mask_v6(a, prefix)),
    };
    Ok(Cidr { net, prefix })
}

/// A list of ranges, 1 to `max`.
pub fn parse_cidrs(items: &[String], max: usize) -> Result<Vec<Cidr>, String> {
    if items.is_empty() || items.len() > max {
        return Err(format!("give 1 to {max} address ranges"));
    }
    items.iter().map(|s| parse_cidr(s)).collect()
}

/// A comma-separated list of ranges (the flag and environment form), 1 to `max`.
pub fn parse_cidr_list(text: &str, max: usize) -> Result<Vec<Cidr>, String> {
    let items: Vec<String> = text.split(',').map(|s| s.trim().to_owned()).filter(|s| !s.is_empty()).collect();
    parse_cidrs(&items, max)
}

/// The key every per-source limit counts by: an IPv4 address, or an IPv6 address's /64.
pub fn source_key(ip: IpAddr) -> String {
    match canonical(ip) {
        IpAddr::V4(a) => a.to_string(),
        IpAddr::V6(a) => format!("{}/64", mask_v6(a, 64)),
    }
}

/// Why a request's source could not be read (logged; the caller sees the 3.1 words).
#[derive(Debug, PartialEq, Eq)]
pub enum NoSource {
    /// Behind a front, a TCP peer that is not a trusted front.
    Peer,
    /// No X-Forwarded-For header.
    Missing,
    /// A value that is not an IP address (including `ip:port`).
    Junk,
    /// Every address in the header is a trusted front.
    AllFronts,
}

impl NoSource {
    pub fn why(&self) -> &'static str {
        match self {
            NoSource::Peer => "the peer is not a trusted front",
            NoSource::Missing => "no X-Forwarded-For header from the front",
            NoSource::Junk => "an X-Forwarded-For value that is not an IP address",
            NoSource::AllFronts => "every X-Forwarded-For address is a trusted front",
        }
    }
}

/// The request's source address. `behind` is a TLS front deployment; `forwarded` every X-Forwarded-For header value.
pub fn source_of(peer: IpAddr, forwarded: &[String], fronts: &[Cidr], behind: bool) -> Result<IpAddr, NoSource> {
    let peer = canonical(peer);
    if !behind {
        return Ok(peer);
    }
    if !fronts.iter().any(|f| f.contains(peer)) {
        return Err(NoSource::Peer);
    }
    let parts: Vec<&str> = forwarded.iter().flat_map(|h| h.split(',')).map(str::trim).filter(|s| !s.is_empty()).collect();
    if parts.is_empty() {
        return Err(NoSource::Missing);
    }
    let mut addrs = Vec::with_capacity(parts.len());
    for p in parts {
        addrs.push(canonical(p.parse::<IpAddr>().map_err(|_| NoSource::Junk)?));
    }
    addrs.into_iter().rev().find(|a| !fronts.iter().any(|f| f.contains(*a))).ok_or(NoSource::AllFronts)
}

/// Whether the console answers this source.
pub fn allowed(sources: &[Cidr], ip: IpAddr) -> bool {
    sources.iter().any(|c| c.contains(ip))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    fn hdr(s: &str) -> Vec<String> {
        vec![s.to_owned()]
    }

    #[test]
    fn ranges_parse_and_contain() {
        let list = parse_cidr_list(DEFAULT_SOURCES, SOURCES_MAX).unwrap();
        assert_eq!(list.len(), 7);
        assert!(allowed(&list, ip("10.1.2.3")) && allowed(&list, ip("192.168.0.9")) && allowed(&list, ip("100.64.0.1")));
        assert!(allowed(&list, ip("::1")) && allowed(&list, ip("fd12::5")));
        assert!(!allowed(&list, ip("203.0.113.7")) && !allowed(&list, ip("2001:db8::1")));
        // IPv4-mapped IPv6 reads as IPv4, inside and outside the list.
        assert!(allowed(&list, ip("::ffff:10.0.0.7")));
        assert!(!allowed(&list, ip("::ffff:203.0.113.7")));
        assert_eq!(parse_cidr("10.1.2.3/8").unwrap().to_string(), "10.0.0.0/8");
        assert!(parse_cidr("10.0.0.0/33").is_err() && parse_cidr("nope").is_err() && parse_cidr("10.0.0.0/").is_err());
        assert!(parse_cidr_list("", 16).is_err());
        let many = vec!["10.0.0.0/8".to_owned(); 17];
        assert!(parse_cidrs(&many, FRONTS_MAX).is_err());
    }

    #[test]
    fn wide_fronts_are_flagged() {
        assert!(parse_cidr("10.0.0.0/16").unwrap().wide());
        assert!(!parse_cidr("10.0.0.0/24").unwrap().wide());
        assert!(!parse_cidr("10.0.0.5").unwrap().wide());
        assert!(parse_cidr("2001:db8::/48").unwrap().wide());
        assert!(!parse_cidr("2001:db8::/64").unwrap().wide());
    }

    #[test]
    fn keys_count_ipv6_by_64() {
        assert_eq!(source_key(ip("203.0.113.7")), "203.0.113.7");
        assert_eq!(source_key(ip("::ffff:203.0.113.7")), "203.0.113.7");
        assert_eq!(source_key(ip("2001:db8:1:2:aaaa::1")), source_key(ip("2001:db8:1:2:bbbb::9")));
        assert_ne!(source_key(ip("2001:db8:1:2::1")), source_key(ip("2001:db8:1:3::1")));
    }

    #[test]
    fn the_source_behind_a_front() {
        let fronts = parse_cidr_list("10.9.0.1,10.9.0.2", FRONTS_MAX).unwrap();
        let front = ip("10.9.0.1");
        // No front: the TCP peer, whatever the header says.
        assert_eq!(source_of(ip("203.0.113.7"), &hdr("10.0.0.1"), &fronts, false), Ok(ip("203.0.113.7")));
        // A trusted front names the client.
        assert_eq!(source_of(front, &hdr("198.51.100.4"), &fronts, true), Ok(ip("198.51.100.4")));
        // A spoofed header from an untrusted peer is refused, never judged by the peer.
        assert_eq!(source_of(ip("203.0.113.7"), &hdr("10.0.0.1"), &fronts, true), Err(NoSource::Peer));
        assert_eq!(source_of(front, &[], &fronts, true), Err(NoSource::Missing));
        assert_eq!(source_of(front, &hdr("198.51.100.4:5555"), &fronts, true), Err(NoSource::Junk));
        assert_eq!(source_of(front, &hdr("junk"), &fronts, true), Err(NoSource::Junk));
        // A chain through two trusted fronts: the first address from the right outside them.
        assert_eq!(source_of(front, &hdr("1.2.3.4, 198.51.100.4, 10.9.0.2"), &fronts, true), Ok(ip("198.51.100.4")));
        // Several headers are joined in order.
        assert_eq!(source_of(front, &["198.51.100.4".to_owned(), "10.9.0.2".to_owned()], &fronts, true), Ok(ip("198.51.100.4")));
        // Every address a trusted front: refused.
        assert_eq!(source_of(front, &hdr("10.9.0.2, 10.9.0.1"), &fronts, true), Err(NoSource::AllFronts));
    }
}
