//! API-1 revision 4 7.1: the relay's durable outbox of call events. The hub raises meeting and member events in memory
//! under its lock; the event thread moves them here (one JSON line per event in `api-events-outbox.jsonl` under the
//! state folder, flushed before the hub's copy is gone) and removes each only once the event chains have taken it, so
//! a closed chain, a failed write or a restart retries the event instead of losing it.

use crate::codec::{parse_json, stringify};
use crate::fleet_local::write_durable;
use serde_json::{json, Value};
use std::collections::{HashSet, VecDeque};
use std::path::{Path, PathBuf};

/// The outbox file under the relay state folder.
pub const FILE: &str = "api-events-outbox.jsonl";

/// The most events the outbox keeps; past it the oldest are dropped (each a security line), so chains that stay
/// closed cannot fill the disk.
pub const MAX_PENDING: usize = 10_000;

/// One pending event: `(org, type, data)`.
type Pending = (String, String, Value);

pub struct Outbox {
    path: PathBuf,
    pending: VecDeque<Pending>,
}

/// What became of an event handed to the chains.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Delivery {
    /// Appended (or not for this relay to append): removed from the outbox.
    Settled,
    /// Not appended now: kept, with the later events of its org, for the next round.
    Retry,
}

impl Outbox {
    /// The outbox of state folder `dir`, with the events a previous run left in it. A line that does not parse (a torn
    /// write cannot leave one, since the file is replaced whole) is skipped.
    pub fn open(dir: &Path) -> Outbox {
        let path = dir.join(FILE);
        let pending = std::fs::read_to_string(&path)
            .unwrap_or_default()
            .lines()
            .filter_map(|l| {
                let v = parse_json(l)?;
                let org = v.get("org")?.as_str()?.to_owned();
                let kind = v.get("type")?.as_str()?.to_owned();
                Some((org, kind, v.get("data").cloned().unwrap_or(Value::Null)))
            })
            .collect();
        Outbox { path, pending }
    }

    pub fn is_empty(&self) -> bool {
        self.pending.is_empty()
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.pending.len()
    }

    /// Add events taken from the hub, in order, and flush the outbox before returning. Returns the oldest events
    /// dropped to stay within `MAX_PENDING`.
    pub fn push(&mut self, taken: impl IntoIterator<Item = (String, String, Value)>) -> Result<Vec<Pending>, String> {
        let before = self.pending.len();
        self.pending.extend(taken);
        if self.pending.len() == before {
            return Ok(Vec::new());
        }
        let over = self.pending.len().saturating_sub(MAX_PENDING);
        let dropped: Vec<Pending> = self.pending.drain(..over).collect();
        self.save()?;
        Ok(dropped)
    }

    /// Hand each pending event to `send` in order. A settled event is removed; after a retry the later events of the
    /// same org wait too (the chain keeps their order), while other orgs go on. The outbox is flushed when it changed.
    pub fn deliver(&mut self, send: &mut dyn FnMut(&str, &str, Value) -> Delivery) -> Result<(), String> {
        if self.pending.is_empty() {
            return Ok(());
        }
        let mut held: HashSet<String> = HashSet::new();
        let mut kept = VecDeque::with_capacity(self.pending.len());
        let mut changed = false;
        for (org, kind, data) in std::mem::take(&mut self.pending) {
            if held.contains(&org) {
                kept.push_back((org, kind, data));
                continue;
            }
            match send(&org, &kind, data.clone()) {
                Delivery::Settled => changed = true,
                Delivery::Retry => {
                    held.insert(org.clone());
                    kept.push_back((org, kind, data));
                }
            }
        }
        self.pending = kept;
        if changed {
            self.save()?;
        }
        Ok(())
    }

    fn save(&self) -> Result<(), String> {
        if self.pending.is_empty() {
            return match std::fs::remove_file(&self.path) {
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(format!("cannot clear {FILE}: {e}")),
                _ => Ok(()),
            };
        }
        let mut out = String::new();
        for (org, kind, data) in &self.pending {
            out.push_str(&stringify(&json!({"org": org, "type": kind, "data": data})));
            out.push('\n');
        }
        write_durable(&self.path, out.as_bytes())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fleet_ca::tests_dir;

    fn ev(org: &str, kind: &str, room: &str) -> (String, String, Value) {
        (org.into(), kind.into(), json!({"room": room}))
    }

    #[test]
    fn an_event_leaves_the_outbox_only_once_the_chain_takes_it() {
        let dir = tests_dir("api-event-outbox-retry");
        let mut o = Outbox::open(&dir);
        o.push([ev("acme", "meeting.started", "m-1"), ev("acme", "member.joined", "m-1"), ev("beta", "meeting.started", "m-2")]).unwrap();
        // acme's chain is closed: its events stay, in order; beta's goes through
        let mut seen = Vec::new();
        o.deliver(&mut |org, kind, _| {
            seen.push(format!("{org}/{kind}"));
            if org == "acme" { Delivery::Retry } else { Delivery::Settled }
        })
        .unwrap();
        assert_eq!(seen, ["acme/meeting.started", "beta/meeting.started"], "a retried org holds its later events");
        assert_eq!(o.len(), 2);
        // a restart finds them on disk
        let mut again = Outbox::open(&dir);
        assert_eq!(again.len(), 2);
        let mut sent = Vec::new();
        again
            .deliver(&mut |org, kind, data| {
                sent.push((org.to_owned(), kind.to_owned(), data));
                Delivery::Settled
            })
            .unwrap();
        assert_eq!(sent, [ev("acme", "meeting.started", "m-1"), ev("acme", "member.joined", "m-1")]);
        assert!(again.is_empty() && !dir.join(FILE).exists(), "an empty outbox leaves no file");
        assert!(Outbox::open(&dir).is_empty());
    }

    #[test]
    fn a_full_outbox_drops_its_oldest_events() {
        let dir = tests_dir("api-event-outbox-full");
        let mut o = Outbox::open(&dir);
        let many: Vec<_> = (0..MAX_PENDING + 2).map(|i| ev("acme", "member.joined", &format!("m-{i}"))).collect();
        let dropped = o.push(many).unwrap();
        assert_eq!(dropped, [ev("acme", "member.joined", "m-0"), ev("acme", "member.joined", "m-1")]);
        assert_eq!(Outbox::open(&dir).len(), MAX_PENDING);
    }
}
