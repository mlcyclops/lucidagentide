// Trusted time for the Meeting Hub relay's deadlines (contract AC-1 2.4 "Trusted time", R3-M3, I13): license expiry
// and grace, the upgrade period and the seat clock are judged against an effective time kept in
// `state_dir/meet-time.json` (`{highWater, seatElapsed, seatUncertain}`, owner-only, fail closed), never against the
// wall clock alone.
//
// - The effective time never goes back: at start it is the later of the stored high-water mark and the wall clock;
//   while running it advances with the monotonic clock, and follows the wall clock forward only (fail closed: a
//   forward jump can end license service early, never extend it).
// - The seat clock counts `seatElapsed`: running time by the monotonic clock plus, at each start, the downtime by the
//   wall clock when it is at most 24 hours. A larger gap at start, or a wall clock more than 10 minutes ahead while
//   running, marks the time uncertain: the gap is held (not credited) and every seat notice and the day-14 unseat
//   wait until an admin confirms the time (`meet.clock.confirm`).
// - A wall clock behind the effective time raises `clock-back` and changes nothing.
//
// No clock setting is read from the environment or relay.json (R3-M10). Tests inject a `Clock`; the live check
// binary `lucid-relay-seatclock-check` (feature `live-check-clock`, never shipped) installs its own.

use parking_lot::Mutex;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::Instant;

#[cfg(all(feature = "live-check-clock", any(not(debug_assertions), feature = "fips")))]
compile_error!("the live-check-clock feature is for the unsigned seat clock check only: never with --release or fips (AC-1 2.4, decision 48)");

/// The marker the release artifact scan rejects (decision 48): in every `live-check-clock` binary, in none other.
#[cfg(feature = "live-check-clock")]
#[used]
static LIVE_CHECK_CLOCK_MARKER: [u8; 22] = *b"lucid-live-check-clock";

pub const TIME_FILE: &str = "meet-time.json";
pub const DAY_MS: i64 = 86_400_000;
/// A downtime credited to the seat clock at start: at most 24 hours.
pub const START_GAP_MAX_MS: i64 = DAY_MS;
/// A wall clock this far ahead of the effective time while running marks the time uncertain.
pub const AHEAD_MAX_MS: i64 = 10 * 60_000;
/// A wall clock this far behind the effective time while running raises `clock-back` (monotonic drift below it).
pub const BEHIND_MAX_MS: i64 = 60_000;
/// Confirm: the relay's wall clock and the browser's time agree within 5 minutes.
pub const CONFIRM_MAX_MS: i64 = 5 * 60_000;
/// The effective time is written at least this often (and before every deadline action).
pub const SAVE_EVERY_MS: i64 = 60_000;
/// 8.3 `clock-disagree`.
pub const CLOCK_DISAGREE: &str = "The relay's clock and your browser differ by more than 5 minutes. Fix the relay's clock first.";
const KEYS: [&str; 5] = ["highWater", "seatElapsed", "seatUncertain", "uncertainSince", "uncertainRunning"];
/// R4-M1: uncertain time holds the would-be overage after this much running time.
pub const HOLD_AFTER_MS: i64 = 72 * 3_600_000;

/// The wall and monotonic clocks (milliseconds). Tests inject a fake one; nothing reads a clock setting.
pub trait Clock: Send + Sync {
    /// Milliseconds since the Unix epoch, as the host says.
    fn wall_ms(&self) -> i64;
    /// Milliseconds from an arbitrary origin that never goes back.
    fn mono_ms(&self) -> i64;
    /// The length of one seat-clock day (one day in every deployable build).
    fn seat_day_ms(&self) -> i64 {
        DAY_MS
    }
    /// The live seat clock check (`lucid-relay-seatclock-check`): development licenses and its own state folder only.
    fn live_check(&self) -> bool {
        false
    }
}

pub struct SystemClock {
    origin: Instant,
}

impl SystemClock {
    pub fn new() -> SystemClock {
        SystemClock { origin: Instant::now() }
    }
}

impl Default for SystemClock {
    fn default() -> Self {
        Self::new()
    }
}

impl Clock for SystemClock {
    fn wall_ms(&self) -> i64 {
        crate::codec::now_ms()
    }
    fn mono_ms(&self) -> i64 {
        self.origin.elapsed().as_millis() as i64
    }
}

static CLOCK: OnceLock<Arc<dyn Clock>> = OnceLock::new();

/// The process clock: the system clock, or the live check's (installed only by that binary).
pub fn clock() -> Arc<dyn Clock> {
    CLOCK.get_or_init(|| Arc::new(SystemClock::new())).clone()
}

/// The live check binary installs its clock before the relay starts. Not compiled into any deployable build.
#[cfg(feature = "live-check-clock")]
pub fn install(c: Arc<dyn Clock>) -> Result<(), String> {
    CLOCK.set(c).map_err(|_| "the clock was already in use".to_string())
}

/// The marker the live check writes in the empty state folder it creates (2.4, R3-M10).
pub const LIVE_CHECK_MARKER: &str = "live-check-state";

/// The live check refuses any state folder it did not create: an empty (or missing) folder gets the marker, a folder
/// with the marker is accepted, anything else is refused.
pub fn live_check_folder(dir: &Path) -> Result<(), String> {
    let marker = dir.join(LIVE_CHECK_MARKER);
    if marker.is_file() {
        return Ok(());
    }
    let empty = match std::fs::read_dir(dir) {
        Ok(mut it) => it.next().is_none(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => true,
        Err(e) => return Err(format!("the state folder cannot be read: {e}")),
    };
    if !empty {
        return Err("lucid-relay-seatclock-check runs only on a state folder it created itself (no live-check-state marker)".into());
    }
    crate::store::write_private(&marker, b"lucid-relay-seatclock-check\n").map_err(|e| format!("the live-check-state marker cannot be written: {e}"))
}

/// Read a fail-closed state file: Ok(None) when missing, Err when unreadable or not a JSON object.
pub fn read_object(file: &Path) -> Result<Option<serde_json::Map<String, Value>>, String> {
    let bytes = match std::fs::read(file) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("{} cannot be read: {e}", file.display())),
    };
    match serde_json::from_slice::<Value>(&bytes) {
        Ok(Value::Object(o)) => Ok(Some(o)),
        _ => Err(format!("{} is not valid; the relay will not start until it is fixed or restored", file.display())),
    }
}

fn int_of(v: Option<&Value>) -> Option<i64> {
    v.and_then(Value::as_i64)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TimeView {
    pub wall: i64,
    pub effective: i64,
    pub high_water: i64,
    pub uncertain: bool,
    pub back: bool,
    pub held_gap_ms: i64,
    pub seat_elapsed: i64,
    pub uncertain_since: Option<i64>,
    pub uncertain_running: i64,
}

impl TimeView {
    /// R4-M1: the running time while uncertain has reached 72 hours (the would-be overage is held).
    pub fn hold_due(&self) -> bool {
        self.uncertain && self.uncertain_running >= HOLD_AFTER_MS
    }
}

/// What a confirm changed (audited with the old and new times).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Confirmed {
    pub old: i64,
    pub new: i64,
    pub credited: i64,
}

struct Inner {
    /// The effective time at `base_mono`.
    base_eff: i64,
    base_mono: i64,
    /// seatElapsed at `base_mono`.
    seat_base: i64,
    uncertain: bool,
    back: bool,
    held_gap: i64,
    saved_mono: i64,
    /// R4-M1: when the time became uncertain (effective ms), and the running time while uncertain: `unc_base` at
    /// `unc_mono`, growing with the monotonic clock while uncertain (downtime never counts).
    since: Option<i64>,
    unc_base: i64,
    unc_mono: i64,
}

impl Inner {
    fn mark_uncertain(&mut self, eff: i64, mono: i64) {
        if !self.uncertain {
            self.uncertain = true;
            self.unc_mono = mono;
        }
        if self.since.is_none() {
            self.since = Some(eff);
        }
    }

    fn running(&self, mono: i64) -> i64 {
        if self.uncertain {
            self.unc_base + (mono - self.unc_mono).max(0)
        } else {
            self.unc_base
        }
    }
}

pub struct TrustedTime {
    file: Option<PathBuf>,
    clock: Arc<dyn Clock>,
    inner: Mutex<Inner>,
}

impl TrustedTime {
    /// At start: the stored high-water mark (None in a fresh folder), the wall clock and the downtime rule. Err stops
    /// the start (an unreadable or invalid file, or one that cannot be written).
    pub fn open(dir: Option<&Path>, clock: Arc<dyn Clock>) -> Result<TrustedTime, String> {
        let file = dir.map(|d| d.join(TIME_FILE));
        let stored = match &file {
            Some(f) => read_object(f)?,
            None => None,
        };
        let (wall, mono) = (clock.wall_ms(), clock.mono_ms());
        let mut inner = Inner { base_eff: wall, base_mono: mono, seat_base: 0, uncertain: false, back: false, held_gap: 0, saved_mono: mono, since: None, unc_base: 0, unc_mono: mono };
        if let Some(o) = stored {
            let bad = || format!("{TIME_FILE} is not valid; the relay will not start until it is fixed or restored");
            if o.len() != KEYS.len() || !KEYS.iter().all(|k| o.contains_key(*k)) {
                return Err(bad());
            }
            let high = int_of(o.get("highWater")).filter(|v| *v >= 0).ok_or_else(bad)?;
            let seat = int_of(o.get("seatElapsed")).filter(|v| *v >= 0).ok_or_else(bad)?;
            let uncertain = o.get("seatUncertain").and_then(Value::as_bool).ok_or_else(bad)?;
            let since = match o.get("uncertainSince") {
                Some(Value::Null) => None,
                v => Some(int_of(v).ok_or_else(bad)?),
            };
            let running = int_of(o.get("uncertainRunning")).filter(|v| *v >= 0).ok_or_else(bad)?;
            inner.seat_base = seat;
            inner.uncertain = uncertain;
            // R4-M1: neither is reset by a restart; only a confirmation clears them
            inner.since = since;
            inner.unc_base = running;
            if wall < high {
                // the host clock moved back: nothing is extended
                inner.base_eff = high;
                inner.back = true;
            } else {
                let gap = wall - high;
                if gap > START_GAP_MAX_MS {
                    inner.mark_uncertain(wall, mono);
                    inner.held_gap = gap;
                } else {
                    inner.seat_base += gap;
                }
            }
            // R4-M1 (round 3): while uncertain, the wall-clock downtime since the last high-water mark (never below
            // zero) also counts toward the 72 hours
            if inner.uncertain {
                inner.unc_base += (wall - high).max(0);
            }
        }
        let t = TrustedTime { file, clock, inner: Mutex::new(inner) };
        t.save()?;
        Ok(t)
    }

    pub fn clock(&self) -> &Arc<dyn Clock> {
        &self.clock
    }

    /// Advance from the monotonic clock and look at the wall clock: never back, forward with the wall clock (the gap
    /// held when it is more than 10 minutes), `clock-back` when the wall clock is behind.
    fn tick(&self, inner: &mut Inner) {
        let (wall, mono) = (self.clock.wall_ms(), self.clock.mono_ms());
        let run = (mono - inner.base_mono).max(0);
        let eff = inner.base_eff + run;
        if wall > eff + AHEAD_MAX_MS {
            inner.mark_uncertain(wall, mono);
            inner.held_gap += wall - eff;
            inner.seat_base += run;
            inner.base_eff = wall;
            inner.base_mono = mono;
        } else if wall > eff {
            // within the tolerance: follow the wall clock forward, crediting the running time only
            inner.seat_base += run;
            inner.base_eff = wall;
            inner.base_mono = mono;
        } else if wall < eff - BEHIND_MAX_MS {
            inner.back = true;
        }
    }

    fn snapshot(&self, inner: &Inner) -> (i64, i64) {
        let run = (self.clock.mono_ms() - inner.base_mono).max(0);
        (inner.base_eff + run, inner.seat_base + run)
    }

    /// The effective time now (milliseconds), written to the file at most a minute apart.
    pub fn now(&self) -> i64 {
        let mut inner = self.inner.lock();
        self.tick(&mut inner);
        let due = self.clock.mono_ms() - inner.saved_mono >= SAVE_EVERY_MS;
        let (eff, _) = self.snapshot(&inner);
        drop(inner);
        if due {
            if let Err(e) = self.save() {
                crate::meet::log_error(&format!("meet-time.json cannot be written: {e}"));
            }
        }
        eff
    }

    /// The seat clock's running time (milliseconds of `seatElapsed`).
    pub fn seat_elapsed(&self) -> i64 {
        let mut inner = self.inner.lock();
        self.tick(&mut inner);
        self.snapshot(&inner).1
    }

    pub fn seat_day_ms(&self) -> i64 {
        self.clock.seat_day_ms().max(1)
    }

    pub fn view(&self) -> TimeView {
        let mut inner = self.inner.lock();
        self.tick(&mut inner);
        let (effective, seat_elapsed) = self.snapshot(&inner);
        let mono = self.clock.mono_ms();
        TimeView {
            wall: self.clock.wall_ms(),
            effective,
            high_water: effective,
            uncertain: inner.uncertain,
            back: inner.back,
            held_gap_ms: inner.held_gap,
            seat_elapsed,
            uncertain_since: inner.since,
            uncertain_running: inner.running(mono),
        }
    }

    /// When the hold starts at the latest (effective ms), while uncertain.
    pub fn hold_at(&self) -> Option<i64> {
        let v = self.view();
        v.uncertain.then(|| v.effective + (HOLD_AFTER_MS - v.uncertain_running).max(0))
    }

    /// Whole hours of running time left before the hold (rounded up), while uncertain; the words show this, never an
    /// absolute time.
    pub fn hold_hours_left(&self) -> Option<i64> {
        let v = self.view();
        v.uncertain.then(|| ((HOLD_AFTER_MS - v.uncertain_running).max(0) + 3_599_999) / 3_600_000)
    }

    /// Write `{highWater, seatElapsed, seatUncertain, uncertainSince, uncertainRunning}` now (before every deadline
    /// action).
    pub fn save(&self) -> Result<(), String> {
        let mut inner = self.inner.lock();
        self.tick(&mut inner);
        let (eff, seat) = self.snapshot(&inner);
        let mono = self.clock.mono_ms();
        inner.saved_mono = mono;
        let (uncertain, since, running) = (inner.uncertain, inner.since, inner.running(mono));
        drop(inner);
        let Some(file) = &self.file else { return Ok(()) };
        let body = json!({"highWater": eff, "seatElapsed": seat, "seatUncertain": uncertain, "uncertainSince": since, "uncertainRunning": running});
        crate::store::write_private(file, format!("{body}\n").as_bytes()).map_err(|e| format!("{TIME_FILE} cannot be written: {e}"))
    }

    /// Whether confirming now would set the effective time behind the high-water mark (a second admin when
    /// two-person is on).
    pub fn confirm_goes_back(&self) -> bool {
        let v = self.view();
        v.wall < v.effective
    }

    /// `meet.clock.confirm`: accepted only when the relay's wall clock and the browser's time agree within 5
    /// minutes; then the effective time is the wall clock, the held gap is credited to the seat clock, and
    /// `clock-uncertain` and `clock-back` clear.
    pub fn confirm(&self, browser_ms: i64) -> Result<Confirmed, &'static str> {
        let mut inner = self.inner.lock();
        self.tick(&mut inner);
        let (wall, mono) = (self.clock.wall_ms(), self.clock.mono_ms());
        if (wall - browser_ms).abs() > CONFIRM_MAX_MS {
            return Err(CLOCK_DISAGREE);
        }
        let (old, seat) = self.snapshot(&inner);
        let credited = inner.held_gap;
        inner.seat_base = seat + credited;
        inner.base_eff = wall;
        inner.base_mono = mono;
        inner.held_gap = 0;
        inner.uncertain = false;
        inner.back = false;
        inner.since = None;
        inner.unc_base = 0;
        drop(inner);
        if let Err(e) = self.save() {
            crate::meet::log_error(&e);
        }
        Ok(Confirmed { old, new: wall, credited })
    }
}

#[cfg(test)]
pub mod testclock {
    use super::Clock;
    use std::sync::atomic::{AtomicI64, Ordering};

    /// A fake wall and monotonic clock.
    pub struct FakeClock {
        pub wall: AtomicI64,
        pub mono: AtomicI64,
    }

    impl FakeClock {
        pub fn new(wall: i64) -> std::sync::Arc<FakeClock> {
            std::sync::Arc::new(FakeClock { wall: AtomicI64::new(wall), mono: AtomicI64::new(0) })
        }
        /// Real time passes: both clocks move.
        pub fn run(&self, ms: i64) {
            self.wall.fetch_add(ms, Ordering::SeqCst);
            self.mono.fetch_add(ms, Ordering::SeqCst);
        }
        /// The host clock is moved: only the wall clock changes.
        pub fn shift_wall(&self, ms: i64) {
            self.wall.fetch_add(ms, Ordering::SeqCst);
        }
        /// A restart: a new monotonic origin; downtime passes on the wall clock.
        pub fn restart(&self, down_ms: i64) {
            self.wall.fetch_add(down_ms, Ordering::SeqCst);
            self.mono.store(0, Ordering::SeqCst);
        }
    }

    impl Clock for FakeClock {
        fn wall_ms(&self) -> i64 {
            self.wall.load(Ordering::SeqCst)
        }
        fn mono_ms(&self) -> i64 {
            self.mono.load(Ordering::SeqCst)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::testclock::FakeClock;
    use super::*;

    const T0: i64 = 1_800_000_000_000;
    const HOUR: i64 = 3_600_000;

    fn dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("lucid-meet-time-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn moving_the_wall_clock_back_extends_nothing_running_or_across_a_restart() {
        let d = dir("back");
        let c = FakeClock::new(T0);
        let t = TrustedTime::open(Some(&d), c.clone()).unwrap();
        c.run(5 * HOUR);
        assert_eq!(t.now(), T0 + 5 * HOUR);
        c.shift_wall(-3 * DAY_MS);
        assert_eq!(t.now(), T0 + 5 * HOUR, "never back");
        assert!(t.view().back);
        assert_eq!(t.seat_elapsed(), 5 * HOUR);
        t.save().unwrap();
        drop(t);
        // a restart with the wall clock still behind
        c.restart(0);
        let t = TrustedTime::open(Some(&d), c.clone()).unwrap();
        assert_eq!(t.now(), T0 + 5 * HOUR);
        assert!(t.view().back);
        assert_eq!(t.seat_elapsed(), 5 * HOUR, "the seat clock is not paused or wound back");
    }

    #[test]
    fn a_forward_jump_while_running_moves_deadlines_early_and_holds_the_seat_clock() {
        let c = FakeClock::new(T0);
        let t = TrustedTime::open(None, c.clone()).unwrap();
        c.run(HOUR);
        c.shift_wall(2 * DAY_MS);
        assert_eq!(t.now(), T0 + HOUR + 2 * DAY_MS, "license deadlines follow forward");
        assert!(t.view().uncertain);
        assert_eq!(t.seat_elapsed(), HOUR, "the gap is not credited");
        assert_eq!(t.view().held_gap_ms, 2 * DAY_MS);
        // confirm refused when the browser disagrees by more than 5 minutes
        assert_eq!(t.confirm(c.wall_ms() + 6 * 60_000), Err(CLOCK_DISAGREE));
        let done = t.confirm(c.wall_ms() + 60_000).unwrap();
        assert_eq!(done.credited, 2 * DAY_MS);
        assert!(!t.view().uncertain);
        assert_eq!(t.seat_elapsed(), HOUR + 2 * DAY_MS);
    }

    #[test]
    fn a_three_day_gap_at_start_is_held_and_a_short_one_is_credited() {
        let d = dir("gap");
        let c = FakeClock::new(T0);
        TrustedTime::open(Some(&d), c.clone()).unwrap();
        c.restart(10 * HOUR);
        let t = TrustedTime::open(Some(&d), c.clone()).unwrap();
        assert_eq!(t.seat_elapsed(), 10 * HOUR);
        assert!(!t.view().uncertain);
        drop(t);
        c.restart(3 * DAY_MS);
        let t = TrustedTime::open(Some(&d), c.clone()).unwrap();
        assert!(t.view().uncertain);
        assert_eq!(t.seat_elapsed(), 10 * HOUR);
        assert_eq!(t.now(), T0 + 10 * HOUR + 3 * DAY_MS);
    }

    #[test]
    fn the_uncertain_time_survives_a_restart_and_counts_downtime_toward_the_hold() {
        let d = dir("bound");
        let c = FakeClock::new(T0);
        TrustedTime::open(Some(&d), c.clone()).unwrap();
        c.restart(2 * DAY_MS);
        let t = TrustedTime::open(Some(&d), c.clone()).unwrap();
        assert!(t.view().uncertain, "a 2-day gap at start");
        assert_eq!(t.view().uncertain_running, 2 * DAY_MS, "the downtime counts");
        c.run(20 * HOUR);
        assert!(!t.view().hold_due());
        t.save().unwrap();
        drop(t);
        // a restart keeps the running total; 5 hours stopped count too
        c.restart(5 * HOUR);
        let t = TrustedTime::open(Some(&d), c.clone()).unwrap();
        assert_eq!(t.view().uncertain_running, 2 * DAY_MS + 25 * HOUR);
        assert!(t.view().hold_due());
        t.confirm(c.wall_ms()).unwrap();
        assert!(!t.view().hold_due());
        assert_eq!(t.view().uncertain_since, None);
        assert_eq!(t.view().uncertain_running, 0);
    }

    #[test]
    fn stopped_four_days_then_restarted_reaches_the_hold() {
        let d = dir("four");
        let c = FakeClock::new(T0);
        TrustedTime::open(Some(&d), c.clone()).unwrap();
        c.restart(4 * DAY_MS);
        let t = TrustedTime::open(Some(&d), c.clone()).unwrap();
        assert!(t.view().hold_due());
        assert_eq!(t.hold_hours_left(), Some(0));
    }

    #[test]
    fn an_unreadable_time_file_stops_the_start() {
        let d = dir("bad");
        std::fs::write(d.join(TIME_FILE), b"{\"highWater\": 1}").unwrap();
        assert!(TrustedTime::open(Some(&d), FakeClock::new(T0)).is_err());
        std::fs::write(d.join(TIME_FILE), b"not json").unwrap();
        assert!(TrustedTime::open(Some(&d), FakeClock::new(T0)).is_err());
    }

    #[test]
    fn the_live_check_takes_only_a_folder_it_created() {
        let d = dir("live");
        live_check_folder(&d).unwrap();
        assert!(d.join(LIVE_CHECK_MARKER).is_file());
        live_check_folder(&d).unwrap();
        let other = dir("live-other");
        std::fs::write(other.join("meet-seats.json"), b"{}").unwrap();
        assert!(live_check_folder(&other).is_err());
    }
}
