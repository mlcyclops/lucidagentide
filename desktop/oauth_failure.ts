// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/oauth_failure.ts - remember WHY an OAuth login died after the browser said "success".
//
// The broker (`omp auth-broker login <id>`) serves the local callback page, so the browser shows
// "Authentication Successful" the instant the code lands - but the token exchange and any
// provider-side onboarding (e.g. Gemini's Code Assist loadCodeAssist/onboardUser project discovery)
// run AFTER that page renders. When one of those throws, the broker exits without persisting a
// credential, the Settings badge stays "not set", and until now the error text drained from the
// broker's pipes was simply dropped. This module keeps the LAST failure per oauthId so
// /api/auth can surface it: the poller stops spinning and the user sees the actual reason
// (most commonly Google's "requires setting the GOOGLE_CLOUD_PROJECT" abort for Workspace accounts).
//
// In-memory only, single dev-server process; a restart clears it, which is fine - the record only
// exists to explain the most recent attempt.

export interface OauthFailure { message: string; at: number }

const failures = new Map<string, OauthFailure>();

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;]*m/g;
const ERRORISH_RE = /error|fail(?:ed|ure)?|requires|denied|forbidden|invalid|expired|cancell?ed|timed? ?out|exception|unauthorized|not authorized|quota/i;

/** Pick the most meaningful failure text out of a broker's drained stdout/stderr.
 *  stderr is preferred (that's where the CLI prints its terminal error); within a stream the LAST
 *  error-looking line wins (progress lines precede the throw). Falls back to the last non-empty
 *  line so a novel failure shape still surfaces something. Returns "" only when both streams are
 *  effectively empty. Output is ANSI-stripped and capped so a stack dump can't flood a toast. */
export function extractOauthFailure(out: string, err: string, cap = 500): string {
  const errLines = err.replace(ANSI_RE, "").split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  const outLines = out.replace(ANSI_RE, "").split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  const pick = (ls: string[]) => {
    for (let i = ls.length - 1; i >= 0; i--) {
      const l = ls[i]!;
      if (ERRORISH_RE.test(l)) {
        // A wrapped multi-line error (message + "See https://..." remedy) reads better whole:
        // include the following lines of the same block (they were emitted together).
        return ls.slice(i, i + 3).join(" ");
      }
    }
    return "";
  };
  const msg = pick(errLines) || pick(outLines) || errLines.at(-1) || outLines.at(-1) || "";
  return msg.length > cap ? msg.slice(0, cap - 1) + "\u2026" : msg;
}

/** Record the failure for `oauthId` (empty message still records a generic one - the login DID fail). */
export function recordOauthFailure(oauthId: string, message: string): OauthFailure {
  const f: OauthFailure = { message: message || "Sign-in did not complete (the login helper exited without saving a credential).", at: Date.now() };
  failures.set(oauthId, f);
  return f;
}

/** Forget the failure for `oauthId` - called when a new attempt starts and when a credential lands. */
export function clearOauthFailure(oauthId: string): void {
  failures.delete(oauthId);
}

export function getOauthFailure(oauthId: string): OauthFailure | undefined {
  return failures.get(oauthId);
}
