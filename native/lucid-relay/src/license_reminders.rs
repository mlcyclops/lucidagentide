// AC-1 revision 4.2 (R42-3, 2.4 "Reminders", I13): the schedule of license renewal reminders for both products and
// `license-reminders.json` in the state folder:
//   {key: null or "<license id>" or "upgrade:<upgradePeriodEnds>" or "none", service: null or "on" or "grace" or "upgrade-period"
//    or "stopped", sent: [{kind, moment, at}]}
// `key` is the schedule's license id (a new id starts a new schedule); `service` the last service state the console
// audited (`license.service`); `sent` every reminder sent for `key`, each with the moment it stands for and when it
// went out, with a SHA-256 of the rest (`sum`), replaced atomically. Service never depends on it; one that does not
// read back is reinitialized from now (`license.reminders-unreadable`, R7-L2): past steps count as sent with no mail,
// and the banners and Overview items still show.
//
// The moments: 30, 14, 7, 3 and 1 days before `exp` (`days-<n>`), `exp` when grace starts (`grace-start`), every 12
// hours in grace (`grace-repeat`), the start of a Meeting Hub upgrade period and every 12 hours in it
// (`upgrade-period`), and once when service stops (`stopped`). At each check only the latest moment passed is due, so
// a relay that was down across a moment sends it once at its next start, and while stopped only the stop mail.

use crate::console::{ServiceState, ServiceView};
use serde_json::{json, Value};
use std::path::Path;

pub const FILE: &str = "license-reminders.json";
pub const DAY_MS: i64 = 86_400_000;
pub const REPEAT_MS: i64 = 12 * 3_600_000;
/// The upgrade period's length (R42-4).
pub const UPGRADE_PERIOD_MS: i64 = 2 * DAY_MS;
/// Days before `exp` with a reminder, latest moment last.
pub const DAYS_BEFORE: [i64; 5] = [30, 14, 7, 3, 1];

/// One reminder sent: its kind, the moment it stands for (ms) and when it went out (ms).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Sent {
    pub kind: &'static str,
    pub moment: i64,
    pub at: i64,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Book {
    pub key: Option<String>,
    pub service: Option<&'static str>,
    pub sent: Vec<Sent>,
}

const KINDS: [&str; 9] = ["days-30", "days-14", "days-7", "days-3", "days-1", "grace-start", "grace-repeat", "stopped", "upgrade-period"];
const SERVICES: [&str; 4] = ["on", "grace", "upgrade-period", "stopped"];

fn days_kind(d: i64) -> &'static str {
    match d {
        30 => "days-30",
        14 => "days-14",
        7 => "days-7",
        3 => "days-3",
        _ => "days-1",
    }
}

impl Book {
    /// The book in `dir`: empty when there is none; Err when it does not read back.
    pub fn read(dir: &Path) -> Result<Book, String> {
        let path = dir.join(FILE);
        let raw = match std::fs::read(&path) {
            Ok(r) => r,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Book::default()),
            Err(e) => return Err(format!("{FILE} cannot be read: {e}")),
        };
        let v: Value = serde_json::from_slice(&raw).map_err(|_| format!("{FILE} is not valid"))?;
        Book::from_sealed(v)
    }

    /// A book from its sealed value (`to_value` with `sum`); Err when it does not check.
    pub fn from_sealed(mut v: Value) -> Result<Book, String> {
        let bad = || format!("{FILE} is not valid");
        // R7-L2: the record carries the SHA-256 of the rest, so a damaged file is told from a sound one.
        let sum = v.as_object_mut().and_then(|o| o.remove("sum")).and_then(|s| s.as_str().map(str::to_owned)).ok_or_else(bad)?;
        if sum != crate::codec::sha256_hex(v.to_string().as_bytes()) {
            return Err(format!("{FILE} does not match its checksum"));
        }
        let o = v.as_object().ok_or_else(bad)?;
        let key = match o.get("key") {
            None | Some(Value::Null) => None,
            Some(Value::String(s)) => Some(s.clone()),
            _ => return Err(bad()),
        };
        let service = match o.get("service") {
            None | Some(Value::Null) => None,
            Some(Value::String(s)) => Some(*SERVICES.iter().find(|x| **x == s.as_str()).ok_or_else(bad)?),
            _ => return Err(bad()),
        };
        let mut sent = Vec::new();
        for s in o.get("sent").and_then(Value::as_array).ok_or_else(bad)? {
            let kind = s.get("kind").and_then(Value::as_str).and_then(|k| KINDS.iter().find(|x| **x == k)).ok_or_else(bad)?;
            let moment = s.get("moment").and_then(Value::as_i64).ok_or_else(bad)?;
            let at = s.get("at").and_then(Value::as_i64).ok_or_else(bad)?;
            sent.push(Sent { kind, moment, at });
        }
        Ok(Book { key, service, sent })
    }

    pub fn to_value(&self) -> Value {
        json!({
            "key": self.key, "service": self.service,
            "sent": self.sent.iter().map(|s| json!({ "kind": s.kind, "moment": s.moment, "at": s.at })).collect::<Vec<_>>(),
        })
    }

    /// `to_value` with the SHA-256 of the rest as `sum` (R7-L2).
    pub fn sealed(&self) -> Value {
        let mut v = self.to_value();
        let sum = crate::codec::sha256_hex(v.to_string().as_bytes());
        v["sum"] = Value::from(sum);
        v
    }

    /// Written atomically (a temporary file, synced, renamed).
    pub fn write(&self, dir: &Path) -> Result<(), String> {
        let path = dir.join(FILE);
        let tmp = dir.join(format!("{FILE}.tmp"));
        let data = format!("{}\n", self.sealed());
        let run = || -> std::io::Result<()> {
            use std::io::Write as _;
            let mut f = std::fs::File::create(&tmp)?;
            f.write_all(data.as_bytes())?;
            f.sync_all()?;
            std::fs::rename(&tmp, &path)
        };
        run().map_err(|e| format!("{FILE} cannot be written: {e}"))
    }

    /// A book reinitialized at `s` after the file did not read back (R7-L2): the step due now counts as sent, so no
    /// past step is mailed again; later steps go out as usual.
    pub fn reset_at(s: &ServiceView) -> Book {
        let mut b = Book { key: Some(key_of(s)), service: Some(s.state.as_str()), sent: Vec::new() };
        if let Some((kind, moment)) = due(s, &b) {
            b.sent.push(Sent { kind, moment, at: s.at });
        }
        b
    }

    /// The 4.7 `reminders` of the current schedule: `[{kind, at}]`.
    pub fn view(&self) -> Value {
        Value::Array(self.sent.iter().map(|s| json!({ "kind": s.kind, "at": s.at })).collect())
    }

    pub fn has(&self, kind: &str, moment: i64) -> bool {
        self.sent.iter().any(|s| s.kind == kind && s.moment == moment)
    }

    fn has_kind(&self, kind: &str) -> bool {
        self.sent.iter().any(|s| s.kind == kind)
    }
}

/// The schedule a service view belongs to: its license id, else the upgrade period, else "none".
pub fn key_of(s: &ServiceView) -> String {
    match (&s.license_id, s.state) {
        (Some(id), _) => id.clone(),
        // R7-L1: an upgrade period is keyed by its end.
        (None, ServiceState::UpgradePeriod) => format!("upgrade:{}", s.upgrade_period_ends.or(s.stops_at).unwrap_or(0)),
        (None, _) => "none".into(),
    }
}

/// The reminder due at `s.at` for a book already on `s`'s schedule: its kind and moment, or None.
pub fn due(s: &ServiceView, book: &Book) -> Option<(&'static str, i64)> {
    let t = s.at;
    match s.state {
        ServiceState::Stopped => (!book.has_kind("stopped")).then_some(("stopped", t)),
        ServiceState::Grace => {
            let exp = s.exp?;
            let k = (t - exp).max(0) / REPEAT_MS;
            let moment = exp + k * REPEAT_MS;
            let kind = if k == 0 { "grace-start" } else { "grace-repeat" };
            (!book.has(kind, moment)).then_some((kind, moment))
        }
        ServiceState::UpgradePeriod => {
            let end = s.upgrade_period_ends.or(s.stops_at)?;
            let start = end - UPGRADE_PERIOD_MS;
            let moment = start + (t - start).max(0) / REPEAT_MS * REPEAT_MS;
            (!book.has("upgrade-period", moment)).then_some(("upgrade-period", moment))
        }
        ServiceState::On => {
            let exp = s.exp?;
            let d = DAYS_BEFORE.iter().rev().copied().find(|d| t >= exp - d * DAY_MS)?;
            let kind = days_kind(d);
            (!book.has_kind(kind)).then_some((kind, exp - d * DAY_MS))
        }
    }
}

/// A time for mail words: `2026-11-18 10:00 UTC`.
pub fn when(ms: i64) -> String {
    let iso = crate::meet_json::iso_utc(ms.div_euclid(1000));
    format!("{} {} UTC", &iso[..10], &iso[11..16])
}

/// A day for mail words: `2026-11-18`.
pub fn day(ms: i64) -> String {
    crate::meet_json::iso_date(ms.div_euclid(1000))
}

/// 8.1 `license.why`, with the verifier's words of a refused token where the words call for them.
pub fn why_words(why: Option<&str>, reason: Option<&str>) -> String {
    match why {
        Some("wrong-product") => "the license is for another product".into(),
        Some("wrong-root") => "the license is for another root".into(),
        Some("expired") => "the license and its grace days are over".into(),
        Some("invalid") => match reason {
            Some(r) => format!("the license file could not be used: {}", crate::console_auth::clean(r)),
            None => "the license file could not be used".into(),
        },
        _ => "no license is installed".into(),
    }
}

/// The 8.4 mail of a reminder kind and its arguments (the mailer fills <host> and <console>). No mail holds the token.
pub fn mail_of(kind: &str, s: &ServiceView, product: crate::license::Product) -> (&'static str, Vec<(&'static str, String)>) {
    let name = product.name().to_owned();
    let section = product.as_str().to_owned();
    let id = s.license_id.clone().unwrap_or_default();
    let stops = s.stops_at.map(when).unwrap_or_default();
    match kind {
        "stopped" => ("mail.license-stopped", vec![("product", name), ("date and time", when(s.at)), ("why", why_words(s.why, s.reason.as_deref())), ("section", section)]),
        "grace-start" | "grace-repeat" => (
            "mail.license-grace",
            vec![("product", name), ("date", s.exp.map(day).unwrap_or_default()), ("license id", id), ("date and time", stops), ("section", section)],
        ),
        "upgrade-period" => ("mail.upgrade-period", vec![("date and time", stops)]),
        _ => {
            let n = s.exp.map(|e| (e - s.at + DAY_MS - 1).div_euclid(DAY_MS).max(0)).unwrap_or(0);
            (
                "mail.license-expiring",
                vec![("product", name), ("n", n.to_string()), ("date", s.exp.map(day).unwrap_or_default()), ("license id", id), ("section", section)],
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const EXP: i64 = 1_900_000_000_000;

    fn view(state: ServiceState, at: i64) -> ServiceView {
        let stops_at = matches!(state, ServiceState::Grace).then_some(EXP + 2 * DAY_MS);
        ServiceView { state, stops_at, why: None, reason: None, upgrade_period_ends: None, license_id: Some("l_1".into()), exp: Some(EXP), at }
    }

    fn send(book: &mut Book, s: &ServiceView) -> Option<&'static str> {
        let (kind, moment) = due(s, book)?;
        book.sent.push(Sent { kind, moment, at: s.at });
        Some(kind)
    }

    #[test]
    fn each_moment_is_due_once_and_only_the_latest_passed() {
        let mut b = Book::default();
        assert_eq!(send(&mut b, &view(ServiceState::On, EXP - 31 * DAY_MS)), None);
        assert_eq!(send(&mut b, &view(ServiceState::On, EXP - 30 * DAY_MS)), Some("days-30"));
        assert_eq!(send(&mut b, &view(ServiceState::On, EXP - 20 * DAY_MS)), None, "never twice");
        // down across the 14-day moment and the 7-day one: only the 7-day reminder, once
        assert_eq!(send(&mut b, &view(ServiceState::On, EXP - 5 * DAY_MS)), Some("days-7"));
        assert_eq!(send(&mut b, &view(ServiceState::On, EXP - 4 * DAY_MS)), None);
        assert_eq!(send(&mut b, &view(ServiceState::On, EXP - 3 * DAY_MS)), Some("days-3"));
        assert_eq!(send(&mut b, &view(ServiceState::On, EXP - DAY_MS)), Some("days-1"));
        assert_eq!(send(&mut b, &view(ServiceState::Grace, EXP)), Some("grace-start"));
        assert_eq!(send(&mut b, &view(ServiceState::Grace, EXP + REPEAT_MS - 1)), None);
        assert_eq!(send(&mut b, &view(ServiceState::Grace, EXP + REPEAT_MS)), Some("grace-repeat"));
        assert_eq!(send(&mut b, &view(ServiceState::Grace, EXP + REPEAT_MS + 1)), None);
        assert_eq!(send(&mut b, &view(ServiceState::Grace, EXP + 2 * REPEAT_MS)), Some("grace-repeat"));
        let mut stop = view(ServiceState::Stopped, EXP + 2 * DAY_MS);
        stop.why = Some("expired");
        assert_eq!(send(&mut b, &stop), Some("stopped"));
        stop.at += DAY_MS;
        assert_eq!(send(&mut b, &stop), None, "the stop mail once");
    }

    #[test]
    fn a_reset_book_replays_no_past_step_but_sends_the_next() {
        // R7-L2: reinitialized in grace, 13 hours after exp: neither grace-start nor the 12-hour step goes out again
        let mut b = Book::reset_at(&view(ServiceState::Grace, EXP + 13 * 3_600_000));
        assert_eq!(b.key.as_deref(), Some("l_1"));
        assert_eq!(send(&mut b, &view(ServiceState::Grace, EXP + 14 * 3_600_000)), None);
        assert_eq!(send(&mut b, &view(ServiceState::Grace, EXP + 2 * REPEAT_MS)), Some("grace-repeat"));
        let mut b = Book::reset_at(&view(ServiceState::Stopped, EXP + 3 * DAY_MS));
        assert_eq!(send(&mut b, &view(ServiceState::Stopped, EXP + 4 * DAY_MS)), None, "no second stop mail");
    }

    #[test]
    fn a_grace_of_zero_sends_only_the_stop_mail_at_exp() {
        let mut b = Book::default();
        assert_eq!(send(&mut b, &view(ServiceState::On, EXP - 1)), Some("days-1"));
        assert_eq!(send(&mut b, &view(ServiceState::Stopped, EXP)), Some("stopped"));
        assert!(!b.sent.iter().any(|s| s.kind.starts_with("grace")));
    }

    #[test]
    fn the_upgrade_period_reminds_at_its_start_and_every_12_hours() {
        let end = EXP;
        let s = |at| ServiceView { state: ServiceState::UpgradePeriod, stops_at: Some(end), why: None, reason: None, upgrade_period_ends: Some(end), license_id: None, exp: None, at };
        assert_eq!(key_of(&s(0)), format!("upgrade:{end}"));
        let mut b = Book::default();
        assert_eq!(send(&mut b, &s(end - UPGRADE_PERIOD_MS)), Some("upgrade-period"));
        assert_eq!(send(&mut b, &s(end - UPGRADE_PERIOD_MS + 1)), None);
        assert_eq!(send(&mut b, &s(end - UPGRADE_PERIOD_MS + REPEAT_MS)), Some("upgrade-period"));
        assert_eq!(b.sent.len(), 2);
    }

    #[test]
    fn the_book_reads_back_and_refuses_anything_else() {
        let d = std::env::temp_dir().join(format!("lucid-reminders-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        let _ = std::fs::remove_file(d.join(FILE));
        assert_eq!(Book::read(&d).unwrap(), Book::default());
        let b = Book { key: Some("l_1".into()), service: Some("grace"), sent: vec![Sent { kind: "days-7", moment: 5, at: 6 }] };
        b.write(&d).unwrap();
        assert_eq!(Book::read(&d).unwrap(), b);
        // R7-L2: a changed byte breaks the checksum
        let text = std::fs::read_to_string(d.join(FILE)).unwrap().replace("days-7", "days-3");
        std::fs::write(d.join(FILE), text).unwrap();
        assert!(Book::read(&d).unwrap_err().contains("checksum"));
        std::fs::write(d.join(FILE), b"{\"key\": 1, \"sent\": []}").unwrap();
        assert!(Book::read(&d).is_err());
        std::fs::write(d.join(FILE), b"not json").unwrap();
        assert!(Book::read(&d).is_err());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn mails_name_the_stop_time_and_never_the_token() {
        let mut s = view(ServiceState::Grace, EXP);
        let (kind, args) = mail_of("grace-start", &s, crate::license::Product::Meet);
        assert_eq!(kind, "mail.license-grace");
        let arg = |k: &str| args.iter().find(|(n, _)| *n == k).map(|(_, v)| v.clone()).unwrap();
        assert_eq!(arg("date and time"), when(EXP + 2 * DAY_MS));
        assert_eq!((arg("license id"), arg("section")), ("l_1".to_owned(), "meet".to_owned()));
        s.state = ServiceState::Stopped;
        s.why = Some("wrong-root");
        let (kind, args) = mail_of("stopped", &s, crate::license::Product::Spokes);
        assert_eq!(kind, "mail.license-stopped");
        assert!(args.iter().any(|(n, v)| *n == "why" && v == "the license is for another root"));
        assert_eq!(when(0), "1970-01-01 00:00 UTC");
        let (kind, args) = mail_of("days-7", &view(ServiceState::On, EXP - 7 * DAY_MS + 1), crate::license::Product::Spokes);
        assert_eq!(kind, "mail.license-expiring");
        assert!(args.iter().any(|(n, v)| *n == "n" && v == "7"));
    }
}
