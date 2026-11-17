// Meeting Hub seats (contract AC-1 2.4 "Meet seats", R4-2, R3-M5, R3-M6, decisions 28, 42 and 50; I13).
//
// `users` counts seated principals: principals with at least one device certificate the relay knows that is neither
// revoked nor expired (the caller passes them as `live`), and who are not unseated. The book is
// `state_dir/meet-seats.json`, owner-only, fail closed:
//   {clock: null or {startedAt, startElapsed, notices: [{day, at}]}, picks: [{principal, by, at}],
//    unseated: [{principal, at, why}], firstSeen: {principal: at}, migrated: [principal]}
// (`startElapsed`, the seat clock's `seatElapsed` when the clock started, and `migrated`, the principals whose
// `firstSeen` came from the upgrade migration, are what the contract's fields need to be kept across a restart.)
//
// Everything here is pure bookkeeping over the effective time and the seat clock of meet_time.rs; the caller
// (meet_license.rs) writes the book before it answers, then audits, mails and closes sessions for the events.

use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub const SEATS_FILE: &str = "meet-seats.json";
/// The notices of the 14-day clock (days 0, 7 and 13) and the day of the unseat.
pub const NOTICE_DAYS: [i64; 3] = [0, 7, 13];
pub const UNSEAT_DAY: i64 = 14;
/// 8.3 words.
pub const NO_SEAT: &str = "Your organization has no Meeting Hub seat for you. Ask your admin.";
/// 8.3 `seat-protected`: "<principal> is a relay admin or console admin and always keeps a seat."
pub fn seat_protected(principal: &str) -> String {
    format!("{principal} is a relay admin or console admin and always keeps a seat.")
}
pub const NOT_OVER: &str = "This relay is within its seats, so no one gives up a seat.";
const KEYS: [&str; 6] = ["clock", "picks", "unseated", "held", "firstSeen", "migrated"];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Clock {
    pub started_at: i64,
    pub start_elapsed: i64,
    pub notices: Vec<(i64, i64)>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Pick {
    pub principal: String,
    pub by: String,
    pub at: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Unseated {
    pub principal: String,
    pub at: i64,
    pub why: String,
}

/// What a reconcile did, in order; each is audited with actor `relay` (`meet.seats.*`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Event {
    Unseat { principal: String, why: &'static str },
    Reseat { principal: String, why: &'static str },
    ClockStart { started_at: i64 },
    ClockClear,
    Notice { day: i64 },
    /// Protected people alone exceed `users` (attention item `seats-protected`).
    Protected,
    /// R4-M1: held without service (not unseated) after 72 hours of uncertain running time; released at once by a
    /// confirmation.
    Hold { principal: String },
    ReleaseHold { principal: String },
}

/// The seat state of the Seats page and the attention items.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Level {
    Ok,
    High,
    Over,
}

impl Level {
    pub fn as_str(self) -> &'static str {
        match self {
            Level::Ok => "ok",
            Level::High => "high",
            Level::Over => "over",
        }
    }
}

/// The relay's view this reconcile needs.
pub struct Now<'a> {
    /// Effective time (milliseconds).
    pub t: i64,
    pub seat_elapsed: i64,
    pub day_ms: i64,
    /// `clock-uncertain`: notices and the day-14 unseat wait.
    pub uncertain: bool,
    /// R4-M1: 72 hours of running time while uncertain.
    pub hold_due: bool,
    /// The license's `users` while seats are enforced (valid or grace); None otherwise.
    pub users: Option<i64>,
    /// A relay admin (relay.json `admins`) or an active console admin.
    pub protected: &'a dyn Fn(&str) -> bool,
}

#[derive(Debug, Default)]
pub struct Seats {
    file: Option<PathBuf>,
    pub clock: Option<Clock>,
    pub picks: Vec<Pick>,
    pub unseated: Vec<Unseated>,
    /// R4-M1: the would-be overage held without service while the time stays unconfirmed: (principal, at).
    pub held: Vec<(String, i64)>,
    pub first_seen: BTreeMap<String, i64>,
    pub migrated: Vec<String>,
}

fn bad() -> String {
    format!("{SEATS_FILE} is not valid; the relay will not start until it is fixed or restored")
}

fn int(v: Option<&Value>) -> Result<i64, String> {
    v.and_then(Value::as_i64).ok_or_else(bad)
}

fn text(v: Option<&Value>) -> Result<String, String> {
    v.and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned).ok_or_else(bad)
}

impl Seats {
    /// Read the book. Ok(None) when there is none yet (the first AC-1 start migrates); Err stops the start.
    pub fn read(dir: Option<&Path>) -> Result<Option<Seats>, String> {
        let file = dir.map(|d| d.join(SEATS_FILE));
        let Some(f) = &file else { return Ok(None) };
        let Some(o) = crate::meet_time::read_object(f)? else { return Ok(None) };
        if o.len() != KEYS.len() || !KEYS.iter().all(|k| o.contains_key(*k)) {
            return Err(bad());
        }
        let mut s = Seats { file: file.clone(), ..Default::default() };
        s.clock = match o.get("clock") {
            Some(Value::Null) => None,
            Some(Value::Object(c)) => {
                let mut notices = Vec::new();
                for n in c.get("notices").and_then(Value::as_array).ok_or_else(bad)? {
                    notices.push((int(n.get("day"))?, int(n.get("at"))?));
                }
                Some(Clock { started_at: int(c.get("startedAt"))?, start_elapsed: int(c.get("startElapsed"))?, notices })
            }
            _ => return Err(bad()),
        };
        for p in o.get("picks").and_then(Value::as_array).ok_or_else(bad)? {
            s.picks.push(Pick { principal: text(p.get("principal"))?, by: text(p.get("by"))?, at: int(p.get("at"))? });
        }
        for u in o.get("unseated").and_then(Value::as_array).ok_or_else(bad)? {
            s.unseated.push(Unseated { principal: text(u.get("principal"))?, at: int(u.get("at"))?, why: text(u.get("why"))? });
        }
        for h in o.get("held").and_then(Value::as_array).ok_or_else(bad)? {
            s.held.push((text(h.get("principal"))?, int(h.get("at"))?));
        }
        for (p, at) in o.get("firstSeen").and_then(Value::as_object).ok_or_else(bad)? {
            s.first_seen.insert(p.clone(), at.as_i64().ok_or_else(bad)?);
        }
        for p in o.get("migrated").and_then(Value::as_array).ok_or_else(bad)? {
            s.migrated.push(p.as_str().ok_or_else(bad)?.to_owned());
        }
        Ok(Some(s))
    }

    /// The first AC-1 start (R3-M5): `firstSeen` for every principal that already has devices, from the earliest
    /// persisted timestamp the relay holds for it (None: no trustworthy one). Equal values are ordered by principal
    /// id; principals without one get the migration time and come after every principal that had one. Map iteration
    /// order is never used: the result depends only on the values and the ids.
    pub fn migrate(dir: Option<&Path>, existing: &[(String, Option<i64>)], t: i64) -> Seats {
        let mut s = Seats { file: dir.map(|d| d.join(SEATS_FILE)), ..Default::default() };
        let mut rows: Vec<(String, Option<i64>)> = existing.to_vec();
        rows.sort();
        rows.dedup_by(|a, b| {
            if a.0 == b.0 {
                b.1 = match (a.1, b.1) {
                    (Some(x), Some(y)) => Some(x.min(y)),
                    (x, y) => x.or(y),
                };
                true
            } else {
                false
            }
        });
        for (p, at) in rows {
            // a record cannot be later than the migration: clamp, so the no-record principals stay after it
            let at = at.map(|a| a.min(t - 1)).unwrap_or(t);
            s.first_seen.insert(p.clone(), at);
            s.migrated.push(p);
        }
        s
    }

    pub fn to_value(&self) -> Value {
        let clock = match &self.clock {
            None => Value::Null,
            Some(c) => json!({"startedAt": c.started_at, "startElapsed": c.start_elapsed, "notices": c.notices.iter().map(|(d, at)| json!({"day": d, "at": at})).collect::<Vec<_>>()}),
        };
        let first: Map<String, Value> = self.first_seen.iter().map(|(k, v)| (k.clone(), Value::from(*v))).collect();
        json!({
            "clock": clock,
            "picks": self.picks.iter().map(|p| json!({"principal": p.principal, "by": p.by, "at": p.at})).collect::<Vec<_>>(),
            "unseated": self.unseated.iter().map(|u| json!({"principal": u.principal, "at": u.at, "why": u.why})).collect::<Vec<_>>(),
            "held": self.held.iter().map(|(p, at)| json!({"principal": p, "at": at})).collect::<Vec<_>>(),
            "firstSeen": first,
            "migrated": self.migrated,
        })
    }

    pub fn save(&self) -> Result<(), String> {
        let Some(f) = &self.file else { return Ok(()) };
        crate::store::write_private(f, format!("{}\n", self.to_value()).as_bytes()).map_err(|e| format!("{SEATS_FILE} cannot be written: {e}"))
    }

    pub fn is_unseated(&self, principal: &str) -> bool {
        self.unseated.iter().any(|u| u.principal == principal)
    }

    pub fn unseated_at(&self, principal: &str) -> Option<i64> {
        self.unseated.iter().find(|u| u.principal == principal).map(|u| u.at)
    }

    pub fn pick_of(&self, principal: &str) -> Option<&Pick> {
        self.picks.iter().find(|p| p.principal == principal)
    }

    /// The seated principals of `live`.
    pub fn seated<'a>(&self, live: &'a [String]) -> Vec<&'a String> {
        live.iter().filter(|p| !self.is_unseated(p)).collect()
    }

    pub fn level(seated: i64, users: i64) -> Level {
        if users > 0 && seated > users {
            Level::Over
        } else if users > 0 && seated * 10 >= users * 9 {
            Level::High
        } else {
            Level::Ok
        }
    }

    /// The whole days of `seatElapsed` since the clock started.
    pub fn day(&self, seat_elapsed: i64, day_ms: i64) -> Option<i64> {
        self.clock.as_ref().map(|c| (seat_elapsed - c.start_elapsed).max(0) / day_ms.max(1))
    }

    /// Whether any migrated principal is seated (the Seats page shows `seats.migrated`).
    pub fn migrated_seated(&self, live: &[String]) -> bool {
        self.migrated.iter().any(|p| live.contains(p) && !self.is_unseated(p))
    }

    /// The day-14 order among `seated`, unprotected only: picks first in pick order, then the newest first (by
    /// `firstSeen`, then principal id; a larger id counts as newer).
    fn unseat_order(&self, seated: &[String], protected: &dyn Fn(&str) -> bool) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for p in &self.picks {
            if seated.contains(&p.principal) && !protected(&p.principal) && !out.contains(&p.principal) {
                out.push(p.principal.clone());
            }
        }
        let mut rest: Vec<&String> = seated.iter().filter(|p| !protected(p) && !out.contains(*p)).collect();
        rest.sort_by(|a, b| {
            let fa = self.first_seen.get(*a).copied().unwrap_or(i64::MAX);
            let fb = self.first_seen.get(*b).copied().unwrap_or(i64::MAX);
            fb.cmp(&fa).then_with(|| b.as_bytes().cmp(a.as_bytes()))
        });
        out.extend(rest.into_iter().cloned());
        out
    }

    fn unseat(&mut self, principal: &str, t: i64, why: &'static str, events: &mut Vec<Event>) {
        self.picks.retain(|p| p.principal != principal);
        self.unseated.push(Unseated { principal: principal.to_owned(), at: t, why: why.to_owned() });
        events.push(Event::Unseat { principal: principal.to_owned(), why });
    }

    fn reseat(&mut self, principal: &str, why: &'static str, events: &mut Vec<Event>) {
        self.unseated.retain(|u| u.principal != principal);
        events.push(Event::Reseat { principal: principal.to_owned(), why });
    }

    /// Bring the book up to date with the live principals: `firstSeen` for new ones, the protection invariant with
    /// displacement, automatic reseat, the clock (start, notices, day 14, clear) and decision 42. The caller saves
    /// the book (before answering) when the result is not empty or `firstSeen` changed.
    pub fn reconcile(&mut self, live: &[String], now: &Now) -> (bool, Vec<Event>) {
        let mut events = Vec::new();
        let mut changed = false;
        let mut live: Vec<String> = live.to_vec();
        live.sort();
        live.dedup();
        for p in &live {
            if !self.first_seen.contains_key(p) {
                self.first_seen.insert(p.clone(), now.t);
                changed = true;
            }
        }
        // protected people always hold a seat (R3-M6); their picks are dropped
        let before = self.picks.len();
        self.picks.retain(|p| !(now.protected)(&p.principal));
        changed |= self.picks.len() != before;
        let to_reseat: Vec<String> = self.unseated.iter().filter(|u| live.contains(&u.principal) && (now.protected)(&u.principal)).map(|u| u.principal.clone()).collect();
        for p in to_reseat {
            self.reseat(&p, "protected", &mut events);
            if let Some(users) = now.users {
                let seated: Vec<String> = self.seated(&live).into_iter().cloned().collect();
                if seated.len() as i64 > users {
                    if let Some(next) = self.unseat_order(&seated, now.protected).first().cloned() {
                        self.unseat(&next, now.t, "displaced", &mut events);
                    }
                }
            }
        }
        let Some(users) = now.users else {
            changed |= !events.is_empty();
            return (changed, events);
        };
        // automatic reseat, oldest unseated first (by unseat time, then firstSeen, then id)
        loop {
            let seated = self.seated(&live).len() as i64;
            if seated >= users {
                break;
            }
            let mut waiting: Vec<&Unseated> = self.unseated.iter().filter(|u| live.contains(&u.principal)).collect();
            waiting.sort_by(|a, b| {
                let fa = self.first_seen.get(&a.principal).copied().unwrap_or(i64::MAX);
                let fb = self.first_seen.get(&b.principal).copied().unwrap_or(i64::MAX);
                a.at.cmp(&b.at).then(fa.cmp(&fb)).then_with(|| a.principal.as_bytes().cmp(b.principal.as_bytes()))
            });
            let Some(next) = waiting.first().map(|u| u.principal.clone()) else { break };
            self.reseat(&next, "room", &mut events);
        }
        let seated: Vec<String> = self.seated(&live).into_iter().cloned().collect();
        let over = seated.len() as i64 > users;
        if over && self.clock.is_none() {
            if !self.unseated.is_empty() {
                // decision 42: no second free period while anyone stays unseated
                let order = self.unseat_order(&seated, now.protected);
                let overage = (seated.len() as i64 - users) as usize;
                for p in order.into_iter().take(overage) {
                    self.unseat(&p, now.t, "over", &mut events);
                }
            } else {
                self.clock = Some(Clock { started_at: now.t, start_elapsed: now.seat_elapsed, notices: Vec::new() });
                events.push(Event::ClockStart { started_at: now.t });
            }
        }
        let seated: Vec<String> = self.seated(&live).into_iter().cloned().collect();
        if seated.len() as i64 > users && !now.uncertain {
            let day = self.day(now.seat_elapsed, now.day_ms).unwrap_or(0);
            if let Some(c) = self.clock.as_mut() {
                for d in NOTICE_DAYS {
                    if day >= d && !c.notices.iter().any(|(n, _)| *n == d) {
                        c.notices.push((d, now.t));
                        events.push(Event::Notice { day: d });
                    }
                }
            }
            if self.clock.is_some() && day >= UNSEAT_DAY {
                let order = self.unseat_order(&seated, now.protected);
                let overage = (seated.len() as i64 - users) as usize;
                let short = order.len() < overage;
                for p in order.into_iter().take(overage) {
                    self.unseat(&p, now.t, "day-14", &mut events);
                }
                if short {
                    events.push(Event::Protected);
                }
            }
        }
        let seated_n = self.seated(&live).len() as i64;
        if seated_n <= users && self.clock.is_some() {
            self.clock = None;
            events.push(Event::ClockClear);
        }
        // R4-M1: after 72 hours of uncertain running time with a seat clock running, hold the would-be overage (the
        // day-14 order, never a protected person), recomputed as seats change; released at once otherwise
        let target: Vec<String> = if now.hold_due && self.clock.is_some() {
            let seated: Vec<String> = self.seated(&live).into_iter().cloned().collect();
            let overage = (seated.len() as i64 - users).max(0) as usize;
            self.unseat_order(&seated, now.protected).into_iter().take(overage).collect()
        } else {
            Vec::new()
        };
        let released: Vec<String> = self.held.iter().filter(|(p, _)| !target.contains(p)).map(|(p, _)| p.clone()).collect();
        for p in released {
            self.held.retain(|(h, _)| *h != p);
            events.push(Event::ReleaseHold { principal: p });
        }
        for p in target {
            if !self.is_held(&p) {
                self.held.push((p.clone(), now.t));
                events.push(Event::Hold { principal: p });
            }
        }
        changed |= !events.is_empty();
        (changed, events)
    }

    pub fn is_held(&self, principal: &str) -> bool {
        self.held.iter().any(|(p, _)| p == principal)
    }

    pub fn held_at(&self, principal: &str) -> Option<i64> {
        self.held.iter().find(|(p, _)| p == principal).map(|(_, at)| *at)
    }

    /// `meet.seats.pick` (admins and user managers, only while the clock runs): pick or undo.
    pub fn pick(&mut self, principal: &str, by: &str, at: i64, pick: bool, protected: bool, seated: bool) -> Result<(), (&'static str, String)> {
        if self.clock.is_none() {
            return Err(("not-over", NOT_OVER.to_owned()));
        }
        if protected {
            return Err(("seat-protected", seat_protected(principal)));
        }
        if pick {
            if !seated {
                return Err(("not-found", "There is no such person.".to_owned()));
            }
            if self.pick_of(principal).is_none() {
                self.picks.push(Pick { principal: principal.to_owned(), by: by.to_owned(), at });
            }
        } else {
            self.picks.retain(|p| p.principal != principal);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const T0: i64 = 1_800_000_000_000;
    const DAY: i64 = 86_400_000;

    fn names(n: usize) -> Vec<String> {
        (0..n).map(|i| format!("p{i:02}@x.org")).collect()
    }

    fn now<'a>(t: i64, elapsed: i64, users: i64, protected: &'a dyn Fn(&str) -> bool) -> Now<'a> {
        Now { t, seat_elapsed: elapsed, day_ms: DAY, uncertain: false, hold_due: false, users: Some(users), protected }
    }

    #[test]
    fn seventy_two_uncertain_hours_hold_the_would_be_overage_and_a_confirmation_releases_it() {
        let nobody = |_: &str| false;
        let live = names(12);
        let mut s = seeded(&live);
        s.reconcile(&live, &now(T0, 0, 10, &nobody));
        let mut n = now(T0 + 4 * DAY, 4 * DAY, 10, &nobody);
        n.uncertain = true;
        n.hold_due = true;
        let (_, ev) = s.reconcile(&live, &n);
        assert_eq!(ev, vec![Event::Hold { principal: "p11@x.org".into() }, Event::Hold { principal: "p10@x.org".into() }]);
        assert!(s.unseated.is_empty(), "held, never unseated");
        assert_eq!(s.seated(&live).len(), 12);
        let (_, ev) = s.reconcile(&live, &n);
        assert!(ev.is_empty(), "stable");
        // confirmed: everyone held is released at once
        let (_, ev) = s.reconcile(&live, &now(T0 + 4 * DAY, 4 * DAY, 10, &nobody));
        assert!(ev.contains(&Event::ReleaseHold { principal: "p11@x.org".into() }) && ev.contains(&Event::ReleaseHold { principal: "p10@x.org".into() }));
        assert!(s.held.is_empty());
    }

    fn seeded(live: &[String]) -> Seats {
        let mut s = Seats::default();
        for (i, p) in live.iter().enumerate() {
            s.first_seen.insert(p.clone(), T0 + i as i64);
        }
        s
    }

    #[test]
    fn high_at_ninety_percent() {
        assert_eq!(Seats::level(8, 10), Level::Ok);
        assert_eq!(Seats::level(9, 10), Level::High);
        assert_eq!(Seats::level(10, 10), Level::High);
        assert_eq!(Seats::level(11, 10), Level::Over);
    }

    #[test]
    fn one_over_starts_the_clock_notices_once_and_day_14_unseats_picks_then_newest() {
        let nobody = |_: &str| false;
        let live = names(12);
        let mut s = seeded(&live);
        let (_, ev) = s.reconcile(&live, &now(T0, 0, 10, &nobody));
        assert_eq!(ev, vec![Event::ClockStart { started_at: T0 }, Event::Notice { day: 0 }]);
        let (_, ev) = s.reconcile(&live, &now(T0 + DAY, DAY, 10, &nobody));
        assert!(ev.is_empty(), "day 0 notice once");
        let (_, ev) = s.reconcile(&live, &now(T0 + 7 * DAY, 7 * DAY, 10, &nobody));
        assert_eq!(ev, vec![Event::Notice { day: 7 }]);
        s.pick("p03@x.org", "admin@x.org", T0, true, false, true).unwrap();
        // enrollments during the clock are counted
        let mut more = live.clone();
        more.push("p99@x.org".into());
        let (_, ev) = s.reconcile(&more, &now(T0 + 13 * DAY, 13 * DAY, 10, &nobody));
        assert_eq!(ev, vec![Event::Notice { day: 13 }]);
        let (_, ev) = s.reconcile(&more, &now(T0 + 14 * DAY, 14 * DAY, 10, &nobody));
        let gone: Vec<&str> = ev.iter().filter_map(|e| if let Event::Unseat { principal, .. } = e { Some(principal.as_str()) } else { None }).collect();
        assert_eq!(gone, vec!["p03@x.org", "p99@x.org", "p11@x.org"], "exactly the overage: the pick, then the newest");
        assert_eq!(ev.last(), Some(&Event::ClockClear));
        assert_eq!(s.seated(&more).len(), 10);
    }

    #[test]
    fn the_clock_waits_while_time_is_uncertain() {
        let nobody = |_: &str| false;
        let live = names(11);
        let mut s = seeded(&live);
        s.reconcile(&live, &now(T0, 0, 10, &nobody));
        let mut n = now(T0 + 20 * DAY, 20 * DAY, 10, &nobody);
        n.uncertain = true;
        let (_, ev) = s.reconcile(&live, &n);
        assert!(ev.is_empty());
    }

    #[test]
    fn picks_are_refused_for_protected_people_and_when_not_over() {
        let mut s = Seats::default();
        assert_eq!(s.pick("a@x.org", "b@x.org", T0, true, false, true).unwrap_err().0, "not-over");
        s.clock = Some(Clock { started_at: T0, start_elapsed: 0, notices: vec![] });
        assert_eq!(s.pick("a@x.org", "b@x.org", T0, true, true, true).unwrap_err().0, "seat-protected");
    }

    #[test]
    fn day_14_never_unseats_protected_people_and_raises_seats_protected() {
        let live = names(3);
        let admins = |p: &str| p != "p02@x.org";
        let mut s = seeded(&live);
        s.reconcile(&live, &now(T0, 0, 1, &admins));
        let (_, ev) = s.reconcile(&live, &now(T0 + 14 * DAY, 14 * DAY, 1, &admins));
        assert!(ev.contains(&Event::Unseat { principal: "p02@x.org".into(), why: "day-14" }));
        assert!(ev.contains(&Event::Protected));
        assert!(!s.is_unseated("p00@x.org") && !s.is_unseated("p01@x.org"));
    }

    #[test]
    fn reseat_oldest_first_when_room_and_no_second_free_period() {
        let nobody = |_: &str| false;
        let live = names(4);
        let mut s = seeded(&live);
        s.reconcile(&live, &now(T0, 0, 2, &nobody));
        s.reconcile(&live, &now(T0 + 14 * DAY, 14 * DAY, 2, &nobody));
        assert!(s.is_unseated("p03@x.org") && s.is_unseated("p02@x.org"));
        // a new enrollment past the limit while someone is unseated: unseated at once, no new clock
        let mut more = live.clone();
        more.push("p50@x.org".into());
        let (_, ev) = s.reconcile(&more, &now(T0 + 15 * DAY, 15 * DAY, 2, &nobody));
        assert_eq!(ev, vec![Event::Unseat { principal: "p50@x.org".into(), why: "over" }]);
        assert!(s.clock.is_none());
        // a bigger license: the oldest unseated first (same unseat time: the older firstSeen)
        let (_, ev) = s.reconcile(&more, &now(T0 + 16 * DAY, 16 * DAY, 3, &nobody));
        assert_eq!(ev, vec![Event::Reseat { principal: "p02@x.org".into(), why: "room" }]);
        // someone revoked: room again, the earlier unseat before the later one
        let fewer: Vec<String> = more.iter().filter(|p| *p != "p00@x.org").cloned().collect();
        let (_, ev) = s.reconcile(&fewer, &now(T0 + 17 * DAY, 17 * DAY, 3, &nobody));
        assert_eq!(ev, vec![Event::Reseat { principal: "p03@x.org".into(), why: "room" }]);
        // a smaller license starts the clock
        let mut s2 = seeded(&live);
        let (_, ev) = s2.reconcile(&live, &now(T0, 0, 3, &nobody));
        assert_eq!(ev[0], Event::ClockStart { started_at: T0 });
    }

    #[test]
    fn a_newly_protected_unseated_person_is_reseated_and_displaces_the_next() {
        let live = names(3);
        let nobody = |_: &str| false;
        let mut s = seeded(&live);
        s.reconcile(&live, &now(T0, 0, 2, &nobody));
        s.reconcile(&live, &now(T0 + 14 * DAY, 14 * DAY, 2, &nobody));
        assert!(s.is_unseated("p02@x.org"));
        let promoted = |p: &str| p == "p02@x.org";
        let (_, ev) = s.reconcile(&live, &now(T0 + 15 * DAY, 15 * DAY, 2, &promoted));
        assert_eq!(ev, vec![Event::Reseat { principal: "p02@x.org".into(), why: "protected" }, Event::Unseat { principal: "p01@x.org".into(), why: "displaced" }]);
    }

    #[test]
    fn the_migration_orders_by_value_then_id_and_puts_unknown_last() {
        let rows = vec![("c@x.org".to_string(), Some(T0)), ("b@x.org".to_string(), Some(T0)), ("z@x.org".to_string(), None), ("a@x.org".to_string(), None), ("d@x.org".to_string(), Some(T0 - 5)), ("d@x.org".to_string(), Some(T0 - 9))];
        let s = Seats::migrate(None, &rows, T0 + 100);
        assert_eq!(s.first_seen["d@x.org"], T0 - 9, "the earliest record");
        assert_eq!(s.first_seen["a@x.org"], T0 + 100);
        let live: Vec<String> = ["a@x.org", "b@x.org", "c@x.org", "d@x.org", "z@x.org"].iter().map(|s| s.to_string()).collect();
        let order = s.unseat_order(&live, &|_: &str| false);
        assert_eq!(order, vec!["z@x.org", "a@x.org", "c@x.org", "b@x.org", "d@x.org"]);
        assert!(s.migrated_seated(&live));
    }

    #[test]
    fn an_unreadable_book_stops_the_start_and_a_saved_one_reads_back() {
        let d = std::env::temp_dir().join(format!("lucid-meet-seats-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        assert!(Seats::read(Some(&d)).unwrap().is_none());
        let mut s = Seats::migrate(Some(&d), &[("a@x.org".into(), Some(T0))], T0 + 1);
        s.clock = Some(Clock { started_at: T0, start_elapsed: 5, notices: vec![(0, T0)] });
        s.save().unwrap();
        let back = Seats::read(Some(&d)).unwrap().unwrap();
        assert_eq!(back.clock, s.clock);
        assert_eq!(back.first_seen, s.first_seen);
        std::fs::write(d.join(SEATS_FILE), b"{\"clock\": null}").unwrap();
        assert!(Seats::read(Some(&d)).is_err());
    }
}
