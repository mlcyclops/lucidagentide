// Contract API-1 revision 5 (phase 1c), section 7.6: the connector's content events, in the order the connector
// verified them. A bounded in-memory log with increasing ids; an event keeps only (app, conversation, message id,
// type), never content: the message is read from the content store when the event is delivered, so a message
// deleted meanwhile is never revealed, and visibility (5.2) is judged again for each event at delivery
// (`connector_api`). Long polls wait here at most 30 seconds. Each client's cursor is kept per (client, sub) for a
// poll that names none. There are no content webhooks (O9).

use crate::connector_session::{ContentEvent, ContentKind};
use parking_lot::{Condvar, Mutex};
use std::collections::{HashMap, VecDeque};
use std::time::{Duration, Instant};

/// Events kept; older ones leave first.
pub const EVENTS_MAX: usize = 10_000;
/// The longest long poll (7.6 `wait`).
pub const WAIT_MAX_S: u64 = 30;
/// Client cursors kept; the oldest is forgotten first.
const CURSORS_MAX: usize = 10_000;

/// One content event as kept.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Noted {
    pub id: u64,
    pub app: String,
    pub conv: String,
    pub mid: Option<String>,
    pub kind: ContentKind,
}

struct Log {
    next: u64,
    events: VecDeque<Noted>,
    cursors: HashMap<String, (u64, u64)>,
    stamp: u64,
}

/// The content event log (7.6).
pub struct ContentEvents {
    log: Mutex<Log>,
    wake: Condvar,
}

impl Default for ContentEvents {
    fn default() -> ContentEvents {
        ContentEvents::new()
    }
}

impl ContentEvents {
    pub fn new() -> ContentEvents {
        ContentEvents { log: Mutex::new(Log { next: 1, events: VecDeque::new(), cursors: HashMap::new(), stamp: 0 }), wake: Condvar::new() }
    }

    /// The `ContentHooks::event` call: keep (app, conv, mid, type) and wake the long polls.
    pub fn push(&self, app: &str, ev: &ContentEvent) {
        let mut l = self.log.lock();
        let id = l.next;
        l.next += 1;
        l.events.push_back(Noted { id, app: app.to_string(), conv: ev.conv.clone(), mid: ev.mid.clone(), kind: ev.kind });
        while l.events.len() > EVENTS_MAX {
            l.events.pop_front();
        }
        drop(l);
        self.wake.notify_all();
    }

    /// The id of the newest event (0 before any).
    pub fn head(&self) -> u64 {
        self.log.lock().next - 1
    }

    /// At most `limit` events after `after`, oldest first, waiting up to `wait` for the first one.
    pub fn after(&self, after: u64, limit: usize, wait: Duration) -> Vec<Noted> {
        let deadline = Instant::now() + wait.min(Duration::from_secs(WAIT_MAX_S));
        let mut l = self.log.lock();
        loop {
            if l.next - 1 > after {
                return l.events.iter().filter(|e| e.id > after).take(limit).cloned().collect();
            }
            if self.wake.wait_until(&mut l, deadline).timed_out() {
                return Vec::new();
            }
        }
    }

    /// The cursor kept for a client (`client sub`), None before its first poll.
    pub fn cursor(&self, key: &str) -> Option<u64> {
        self.log.lock().cursors.get(key).map(|c| c.0)
    }

    /// Keep a client's cursor (the least recently set one leaves past the bound).
    pub fn set_cursor(&self, key: &str, id: u64) {
        let mut l = self.log.lock();
        l.stamp += 1;
        let stamp = l.stamp;
        l.cursors.insert(key.to_string(), (id, stamp));
        if l.cursors.len() > CURSORS_MAX {
            if let Some(old) = l.cursors.iter().min_by_key(|(_, c)| c.1).map(|(k, _)| k.clone()) {
                l.cursors.remove(&old);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn ev(kind: ContentKind, conv: &str, mid: Option<&str>) -> ContentEvent {
        ContentEvent { kind, conv: conv.into(), mid: mid.map(str::to_string) }
    }

    #[test]
    fn events_keep_no_content_and_ids_increase() {
        let e = ContentEvents::new();
        assert_eq!(e.head(), 0);
        e.push("helpdesk", &ev(ContentKind::MessageCreated, "ch:a", Some("m1")));
        e.push("helpdesk", &ev(ContentKind::ConversationAdded, "ch:b", None));
        let got = e.after(0, 10, Duration::ZERO);
        assert_eq!(got.iter().map(|n| n.id).collect::<Vec<_>>(), vec![1, 2]);
        assert_eq!(got[0], Noted { id: 1, app: "helpdesk".into(), conv: "ch:a".into(), mid: Some("m1".into()), kind: ContentKind::MessageCreated });
        assert_eq!(e.after(1, 10, Duration::ZERO).len(), 1);
        assert!(e.after(2, 10, Duration::ZERO).is_empty());
    }

    #[test]
    fn the_log_is_bounded_and_a_long_poll_wakes() {
        let e = Arc::new(ContentEvents::new());
        for _ in 0..EVENTS_MAX + 5 {
            e.push("helpdesk", &ev(ContentKind::MessageDeleted, "ch:a", Some("m")));
        }
        let all = e.after(0, usize::MAX, Duration::ZERO);
        assert_eq!(all.len(), EVENTS_MAX);
        assert_eq!(all[0].id, 6, "the oldest left first");
        let head = e.head();
        let e2 = e.clone();
        let t = std::thread::spawn(move || e2.after(head, 10, Duration::from_secs(10)));
        std::thread::sleep(Duration::from_millis(50));
        e.push("helpdesk", &ev(ContentKind::ConversationRemoved, "ch:a", None));
        let got = t.join().unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].kind, ContentKind::ConversationRemoved);
        e.set_cursor("c_1 c_1", 7);
        assert_eq!(e.cursor("c_1 c_1"), Some(7));
        assert_eq!(e.cursor("c_2 c_2"), None);
    }
}
