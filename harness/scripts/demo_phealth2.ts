// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_phealth2.ts
//
// P-HEALTH.2: when the harness recovers a stalled session, it now RESUMES THE RUN the recovery
// interrupted, instead of healing the session and silently dropping the work.
//
// The gap this closes. P-HEALTH.1 (demo_phealth1.ts) built the ladder ok -> quiet -> probe -> recover,
// and `recover` cancels the wedged turn, drops the omp child, and reloads the SAME session id so the
// conversation survives. But dropping the child rejects the in-flight `session/prompt`, so the turn fell
// into its error path, printed "[agent unavailable: ...]" and settled. The session was healthy again and
// the run was gone, with nothing telling the user which. They had to notice the stall themselves and
// re-ask, which is exactly the manual habit P-HEALTH.1 set out to remove.
//
// Proves, headlessly, against the REAL modules (the real ladder, the real resume policy, the real marker,
// the real note builder):
//   1. THE SEQUENCE: a busy silent session climbs to `recover`, the watchdog marks the recovery BEFORE
//      the child dies, the interrupted run takes that mark, and the verdict is "resume".
//   2. THE USER IS TOLD: the resume reason says the stalled session is being restarted and picked up, and
//      names which restart this is. Silence was the original bug; a silent fix would be the same bug.
//   3. A USER STOP IS NEVER RESUMED. Stop means stop, so a Stop clears the authorization.
//   4. ONE MARK, ONE RESUME: the mark is consumable exactly once, so a second failure in the same run
//      cannot reuse one authorization. This is where an infinite restart loop would live.
//   5. NO RESTART LOOP, even though activity refills the HEALTH episode budget: the resume budget is per
//      RUN and is not refilled by activity, so wedge -> resume -> wedge -> resume -> wedge STOPS, and
//      says the work so far is saved rather than pretending nothing happened.
//   6. A PHANTOM SESSION IS NEVER RESUMED: if `session/load` failed, the run is not re-sent.
//   7. THE NOTE: operator origin like the probe note, forbids starting over, demands re-verifying a
//      half-written file, carries the request / last output / open calls, and stays short because
//      `session/load` already restored the conversation.
//
// VERIFICATION BOUNDARY: the re-send itself lives in Backend.prompt (desktop/acp_backend.ts), which owns
// the master omp session and is not constructible headlessly, so this demo proves the POLICY, the MARKER
// LIFECYCLE and the WORDING against the real modules, plus the ordering the wiring depends on. The live
// re-send is verified in the running app: stall a turn past 7 minutes and watch the turn restart in place.
//
// Run: bun run harness/scripts/demo_phealth2.ts

import {
  HEALTH_DEFAULTS,
  HEALTH_PROBE_NOTE,
  RESUME_MAX_PER_RUN,
  RecoverMarker,
  buildResumeNote,
  healthVerdict,
  newEpisode,
  onActivity,
  onRecover,
  resumeVerdict,
  type HealthEpisode,
} from "../../desktop/health_watch.ts";

function fail(msg: string): never {
  console.error(`   FAIL - ${msg}`);
  process.exit(1);
}
function ok(msg: string): void {
  console.log(`   ok - ${msg}`);
}

const NOW = 1_800_000_000_000;
const fresh = (): HealthEpisode => newEpisode(NOW - 3_600_000);
const verdictAt = (silentMs: number, episode: HealthEpisode = fresh()) =>
  healthVerdict({ busy: true, dead: false, lastActivityAt: NOW - silentMs, now: NOW, openCalls: 0, episode });

// -- 1. the sequence ----------------------------------------------------------------------------------
console.log("1) stall -> recover -> the interrupted run is authorized to resume");
{
  const v = verdictAt(HEALTH_DEFAULTS.recoverMs);
  if (v.action !== "recover") fail(`a busy session silent for recoverMs should be recover, got ${v.action}`);
  ok(`silent ${HEALTH_DEFAULTS.recoverMs / 1000}s with a turn in flight is "recover"`);

  // The watchdog marks the recovery BEFORE it drops the child, because dropping the child is what rejects
  // the in-flight request, and the run's error handler runs immediately after.
  const marker = new RecoverMarker();
  marker.set({ reason: v.reason, at: NOW, silentMs: v.silentMs, pending: ["write src/server.ts"] });

  const mark = marker.take();
  if (!mark) fail("the interrupted run found no recovery mark, so it would drop the work (the old bug)");
  const decision = resumeVerdict({ recovered: true, sessionAlive: true, resumesSoFar: 0 });
  if (!decision.resume) fail(`a recovered live session should resume, got: ${decision.reason}`);
  ok("the run takes the mark and the verdict is: resume in place");
}

// -- 2. the user is told ------------------------------------------------------------------------------
console.log("2) the user is TOLD, in plain words, that the run is being restarted and picked up");
{
  const { reason } = resumeVerdict({ recovered: true, sessionAlive: true, resumesSoFar: 0 });
  if (!/restarting the stalled session/i.test(reason)) fail(`the notice must say it is restarting: ${reason}`);
  if (!/picking up where it left off/i.test(reason)) fail(`the notice must say it picks up: ${reason}`);
  if (!/restart 1 of 2/.test(reason)) fail(`the notice must name which restart this is: ${reason}`);
  if (reason.includes("\u2014")) fail("house rule: no em dashes in anything a user reads");
  ok(`"${reason}"`);
}

// -- 3. a user Stop is never resumed -------------------------------------------------------------------
console.log("3) a user Stop is never auto-resumed");
{
  const marker = new RecoverMarker();
  marker.set({ reason: "stalled", at: NOW, silentMs: 420_000, pending: [] });
  marker.clear(); // what Backend.cancel() does for every caller that is not the recovery itself
  if (marker.take() !== null) fail("a Stop left the resume authorized, so Stop would restart the turn");
  const v = resumeVerdict({ recovered: false, sessionAlive: true, resumesSoFar: 0 });
  if (v.resume) fail("a run that did not end in a recovery must never resume");
  ok("Stop clears the authorization, and a non-recovered run is refused");
}

// -- 4. one mark, one resume ---------------------------------------------------------------------------
console.log("4) one mark authorizes exactly ONE resume");
{
  const marker = new RecoverMarker();
  marker.set({ reason: "stalled", at: NOW, silentMs: 420_000, pending: [] });
  if (!marker.take()) fail("the first take should return the mark");
  if (marker.take() !== null) fail("a second take reused one authorization: that is the restart loop");
  ok("the second take returns null, so a repeat failure falls through to the normal error path");
}

// -- 5. no restart loop, even though activity refills the HEALTH budget --------------------------------
console.log("5) wedge -> resume -> wedge -> resume -> wedge STOPS (the budget is per run)");
{
  let episode = fresh();
  let resumes = 0;
  const timeline: string[] = [];
  for (let wedge = 1; wedge <= 4; wedge++) {
    // Each resumed run produces a little output before wedging again. That activity resets the health
    // episode by design (a session that worked again deserves a fresh probe/recover budget) - which is
    // exactly why the RESUME budget cannot live on the episode.
    episode = onActivity(episode, NOW);
    episode = onRecover(episode, NOW);
    const v = resumeVerdict({ recovered: true, sessionAlive: true, resumesSoFar: resumes });
    timeline.push(`wedge ${wedge}: ${v.resume ? "resume" : "STOP"}`);
    if (v.resume) { resumes++; continue; }
    if (resumes !== RESUME_MAX_PER_RUN) fail(`stopped after ${resumes} resumes, expected ${RESUME_MAX_PER_RUN}`);
    if (!/saved in this session/i.test(v.reason)) fail(`giving up must say the work is kept: ${v.reason}`);
    break;
  }
  if (resumes !== RESUME_MAX_PER_RUN) fail(`the loop never stopped: ${timeline.join(", ")}`);
  ok(timeline.join(" | "));
  ok("activity refilled the health episode, and the per-run resume budget still ran out");
}

// -- 6. a phantom session is never resumed -------------------------------------------------------------
console.log("6) a session that failed to reload is NOT resumed");
{
  const v = resumeVerdict({ recovered: true, sessionAlive: false, resumesSoFar: 0 });
  if (v.resume) fail("resuming onto a session that failed to load would talk to a phantom session");
  if (!/could not be reloaded/i.test(v.reason)) fail(`the refusal must explain itself: ${v.reason}`);
  ok(`"${v.reason}"`);
}

// -- 7. the note the resumed agent reads ---------------------------------------------------------------
console.log("7) the resume note: operator origin, do not start over, verify half-written files");
{
  const note = buildResumeNote({
    request: "add a /health endpoint and a test for it",
    progress: "I added the route and was about to write the test",
    pending: ["write src/server.ts", "bash: bun test"],
    stalledMs: HEALTH_DEFAULTS.recoverMs,
    attempt: 1,
    max: RESUME_MAX_PER_RUN,
  });
  if (!note.startsWith("Operator note from the LUCID harness:")) fail("the note must be operator origin, like the probe note");
  if (!/do not start over/i.test(note)) fail("the note must forbid starting over");
  if (!/read it first and verify/i.test(note)) fail("the note must demand re-verifying a half-written file");
  for (const fragment of ["/health endpoint", "about to write the test", "write src/server.ts", "restart 1 of 2"]) {
    if (!note.includes(fragment)) fail(`the note lost context it needs: ${fragment}`);
  }
  if (note.includes("\u2014")) fail("house rule: no em dashes");
  ok(`the note carries request + progress + open calls in ${note.length} chars`);

  // A huge turn must not be re-pasted back: session/load already restored the conversation.
  const big = buildResumeNote({
    request: "q".repeat(20_000), progress: "a".repeat(20_000), pending: [],
    stalledMs: HEALTH_DEFAULTS.recoverMs, attempt: 2, max: RESUME_MAX_PER_RUN,
  });
  if (big.length > 1400) fail(`the note must stay short, got ${big.length} chars`);
  ok(`a 40KB turn still yields a ${big.length}-char note (both quotes clipped)`);

  // The probe note and the resume note are different jobs and must not have converged into one string.
  if (note === HEALTH_PROBE_NOTE) fail("the resume note and the probe note must stay distinct");
  ok("the probe note (are you alive?) and the resume note (carry on from here) stay distinct");
}

console.log("\nP-HEALTH.2 demo: PASS");
