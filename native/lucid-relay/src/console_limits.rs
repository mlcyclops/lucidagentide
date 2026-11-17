// The Admin Console's rate limits (contract AC-1 section 3.9): sliding windows per key (a source key, a session, an
// admin or the console), each refusal a 429 with Retry-After in seconds, and a `console.rate-limited` security line
// once per key per window. The few limits that must survive a restart (single-admin suspensions, hub and app invites)
// are kept in the book instead (console_auth.rs). The per-email sign-in lockout of 3.3 (AC-7) is console_password.rs.

use std::collections::{HashMap, VecDeque};

pub const MINUTE: i64 = 60_000;
pub const HOUR: i64 = 60 * MINUTE;
pub const DAY: i64 = 24 * HOUR;
/// Keys one limiter keeps; past it the key used least recently goes, never every counter at once.
const KEYS_MAX: usize = 10_000;

/// One row of 3.9.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Limit {
    /// Sign-in begins: 30 per 10 minutes per source.
    SigninBegin,
    /// Any API request: 600 per minute per session.
    Api,
    /// POST routes: 60 per minute per session.
    Post,
    /// `stepup/begin`: 20 per minute per session.
    Stepup,
    /// `admins.invite`: 10 per day per admin.
    Invites,
    /// New requests: 30 per hour per admin.
    Requests,
    /// Blocks (`*.block`): 5 per hour per admin.
    Blocks,
    /// Ending someone else's sessions: 10 per hour per admin.
    EndSessions,
    /// Audit and log exports: 10 per hour per admin.
    Exports,
    /// Search: 60 per minute per session.
    Search,
    /// `meet/files/start`: 6 per hour per console.
    FilesStart,
    /// `recover/begin`: 10 per hour per source (revision 4).
    RecoverBegin,
    /// Password reset mails: 1 per hour per email (revision 4).
    RecoverMail,
    /// Test emails (`settings.email-test`): 5 per hour per admin (revision 4).
    EmailTest,
    /// Seat requests (`meet.seats.request`): 3 per day per console (revision 4).
    SeatRequests,
    /// Seat picks (`meet.seats.pick`): 60 per hour per admin or user manager (revision 4).
    SeatPicks,
    /// Attention mails: 1 per kind a day per admin (3.11, revision 4).
    AttentionMail,
}

impl Limit {
    /// (count, window in ms).
    pub fn window(self) -> (usize, i64) {
        match self {
            Limit::SigninBegin => (30, 10 * MINUTE),
            Limit::Api => (600, MINUTE),
            Limit::Post => (60, MINUTE),
            Limit::Stepup => (20, MINUTE),
            Limit::Invites => (10, DAY),
            Limit::Requests => (30, HOUR),
            Limit::Blocks => (5, HOUR),
            Limit::EndSessions => (10, HOUR),
            Limit::Exports => (10, HOUR),
            Limit::Search => (60, MINUTE),
            Limit::FilesStart => (6, HOUR),
            Limit::RecoverBegin => (10, HOUR),
            Limit::RecoverMail => (1, HOUR),
            Limit::EmailTest => (5, HOUR),
            Limit::SeatRequests => (3, DAY),
            Limit::SeatPicks => (60, HOUR),
            Limit::AttentionMail => (1, DAY),
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Limit::SigninBegin => "signin-begin",
            Limit::Api => "api",
            Limit::Post => "post",
            Limit::Stepup => "stepup",
            Limit::Invites => "invites",
            Limit::Requests => "requests",
            Limit::Blocks => "blocks",
            Limit::EndSessions => "end-sessions",
            Limit::Exports => "exports",
            Limit::Search => "search",
            Limit::FilesStart => "files-start",
            Limit::RecoverBegin => "recover-begin",
            Limit::RecoverMail => "recover-mail",
            Limit::EmailTest => "email-test",
            Limit::SeatRequests => "seat-requests",
            Limit::SeatPicks => "seat-picks",
            Limit::AttentionMail => "attention-mail",
        }
    }
}

/// A refusal: seconds until the next try, and whether this is the first refusal of the key in its window (the one
/// that gets a security line).
#[derive(Debug, PartialEq, Eq)]
pub struct Over {
    pub retry_secs: i64,
    pub first: bool,
}

/// The words of a `rate` refusal: minutes rounded up, "1 minute" at 60 seconds or less.
pub fn rate_words(retry_secs: i64) -> String {
    let n = ((retry_secs.max(1) + 59) / 60).max(1);
    if n == 1 {
        "Too many requests. Try again in 1 minute.".into()
    } else {
        format!("Too many requests. Try again in {n} minutes.")
    }
}

#[derive(Default)]
struct Key {
    hits: VecDeque<i64>,
    refused_at: Option<i64>,
}

/// Every limit's windows, by (limit, key).
#[derive(Default)]
pub struct Limits {
    keys: HashMap<(Limit, String), Key>,
}

impl Limits {
    fn make_room(&mut self, t: i64) {
        if self.keys.len() < KEYS_MAX {
            return;
        }
        self.keys.retain(|(l, _), k| k.hits.back().is_some_and(|at| t - *at < l.window().1));
        if self.keys.len() >= KEYS_MAX {
            let oldest = self.keys.iter().min_by_key(|(_, k)| k.hits.back().copied().unwrap_or(i64::MIN)).map(|(k, _)| k.clone());
            if let Some(k) = oldest {
                self.keys.remove(&k);
            }
        }
    }

    /// Count one use of `limit` by `key` at `t`, or refuse it (a refused use is not counted).
    pub fn hit(&mut self, limit: Limit, key: &str, t: i64) -> Result<(), Over> {
        let (max, span) = limit.window();
        let id = (limit, key.to_owned());
        if !self.keys.contains_key(&id) {
            self.make_room(t);
        }
        let k = self.keys.entry(id).or_default();
        while k.hits.front().is_some_and(|at| t - *at >= span) {
            k.hits.pop_front();
        }
        if k.hits.len() >= max {
            let retry_secs = ((k.hits.front().copied().unwrap_or(t) + span - t + 999) / 1000).max(1);
            let first = k.refused_at.is_none_or(|at| t - at >= span);
            if first {
                k.refused_at = Some(t);
            }
            return Err(Over { retry_secs, first });
        }
        k.hits.push_back(t);
        Ok(())
    }
}

/// Failed sign-in assertions per credential id and source (3.3): after 5 in 10 minutes that source waits 10 minutes for
/// that credential; other sources are never affected, and nobody is locked out by name.
#[derive(Default)]
pub struct Failures {
    keys: HashMap<String, VecDeque<i64>>,
}

pub const FAILURES_MAX: usize = 5;
pub const FAILURE_WINDOW_MS: i64 = 10 * MINUTE;
pub const FAILURE_WAIT_MS: i64 = 10 * MINUTE;

impl Failures {
    fn key(credential: &str, source: &str) -> String {
        format!("{credential}|{source}")
    }

    /// Seconds this source waits for this credential, or None.
    pub fn waiting(&self, credential: &str, source: &str, t: i64) -> Option<i64> {
        let v = self.keys.get(&Self::key(credential, source))?;
        let last = *v.back()?;
        let recent = v.iter().filter(|at| last - **at < FAILURE_WINDOW_MS).count();
        (recent >= FAILURES_MAX && t < last + FAILURE_WAIT_MS).then(|| ((last + FAILURE_WAIT_MS - t + 999) / 1000).max(1))
    }

    pub fn fail(&mut self, credential: &str, source: &str, t: i64) {
        if self.keys.len() >= KEYS_MAX {
            self.keys.retain(|_, v| v.back().is_some_and(|at| t - *at < FAILURE_WINDOW_MS + FAILURE_WAIT_MS));
            if self.keys.len() >= KEYS_MAX {
                let oldest = self.keys.iter().min_by_key(|(_, v)| v.back().copied().unwrap_or(i64::MIN)).map(|(k, _)| k.clone());
                if let Some(k) = oldest {
                    self.keys.remove(&k);
                }
            }
        }
        let v = self.keys.entry(Self::key(credential, source)).or_default();
        while v.front().is_some_and(|at| t - *at >= FAILURE_WINDOW_MS) {
            v.pop_front();
        }
        v.push_back(t);
    }

    pub fn clear(&mut self, credential: &str, source: &str) {
        self.keys.remove(&Self::key(credential, source));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const T0: i64 = 1_800_000_000_000;

    #[test]
    fn every_row_of_the_table_refuses_past_its_count() {
        for limit in [Limit::SigninBegin, Limit::Api, Limit::Post, Limit::Stepup, Limit::Invites, Limit::Requests, Limit::Blocks, Limit::EndSessions, Limit::Exports, Limit::Search, Limit::FilesStart, Limit::RecoverBegin, Limit::RecoverMail, Limit::EmailTest, Limit::SeatRequests, Limit::SeatPicks, Limit::AttentionMail] {
            let mut l = Limits::default();
            let (max, span) = limit.window();
            for i in 0..max {
                assert!(l.hit(limit, "k", T0 + i as i64).is_ok(), "{}", limit.name());
            }
            let over = l.hit(limit, "k", T0 + max as i64).err().unwrap();
            assert!(over.first && over.retry_secs >= 1 && over.retry_secs <= span / 1000, "{}", limit.name());
            assert!(!l.hit(limit, "k", T0 + max as i64 + 1).err().unwrap().first);
            // Another key is not affected; the window passes.
            assert!(l.hit(limit, "other", T0 + max as i64).is_ok());
            assert!(l.hit(limit, "k", T0 + span).is_ok());
        }
        assert_eq!(Limit::SigninBegin.window(), (30, 600_000));
        assert_eq!(Limit::Post.window(), (60, 60_000));
    }

    #[test]
    fn a_full_table_evicts_the_key_used_least_recently_never_every_counter() {
        let mut l = Limits::default();
        for i in 0..KEYS_MAX - 1 {
            l.hit(Limit::SigninBegin, &format!("198.51.{}.{}", i / 256, i % 256), T0 + i as i64).unwrap();
        }
        let busy = "203.0.113.1";
        let t = T0 + KEYS_MAX as i64;
        for i in 0..30 {
            l.hit(Limit::SigninBegin, busy, t + i).unwrap();
        }
        assert_eq!(l.keys.len(), KEYS_MAX);
        // One more key: the one used least recently goes, and the busy one stays limited.
        l.hit(Limit::SigninBegin, "203.0.113.2", t + 100).unwrap();
        assert_eq!(l.keys.len(), KEYS_MAX);
        assert!(!l.keys.contains_key(&(Limit::SigninBegin, "198.51.0.0".to_owned())));
        assert!(l.hit(Limit::SigninBegin, busy, t + 101).is_err());
    }

    #[test]
    fn rate_words_round_up_to_minutes() {
        assert_eq!(rate_words(1), "Too many requests. Try again in 1 minute.");
        assert_eq!(rate_words(60), "Too many requests. Try again in 1 minute.");
        assert_eq!(rate_words(61), "Too many requests. Try again in 2 minutes.");
        assert_eq!(rate_words(600), "Too many requests. Try again in 10 minutes.");
    }

    #[test]
    fn failed_assertions_slow_one_source_for_one_credential() {
        let mut f = Failures::default();
        for i in 0..FAILURES_MAX as i64 {
            assert_eq!(f.waiting("cred", "198.51.100.4", T0 + i), None);
            f.fail("cred", "198.51.100.4", T0 + i);
        }
        let last = T0 + FAILURES_MAX as i64 - 1;
        assert_eq!(f.waiting("cred", "198.51.100.4", last + 1), Some(600));
        // Another source and another credential are never affected.
        assert_eq!(f.waiting("cred", "203.0.113.9", last + 1), None);
        assert_eq!(f.waiting("other", "198.51.100.4", last + 1), None);
        assert_eq!(f.waiting("cred", "198.51.100.4", last + FAILURE_WAIT_MS), None);
    }
}
