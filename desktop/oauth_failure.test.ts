// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/oauth_failure.test.ts - the OAuth "why did the login die" record (oauth_failure.ts).
// The load-bearing case: Google's Gemini CLI flow throws AFTER the browser's "Authentication
// Successful" page (project discovery), so the broker's stderr is the only evidence; extraction
// must find that line, and the record lifecycle must clear on retry/success so a stale reason
// never shadows a working credential.

import { describe, expect, test } from "bun:test";
import { clearOauthFailure, extractOauthFailure, getOauthFailure, recordOauthFailure } from "./oauth_failure.ts";

const GEMINI_ABORT =
  "This account requires setting the GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_PROJECT_ID environment variable.\n" +
  "See https://goo.gle/gemini-cli-auth-docs#workspace-gca";

describe("extractOauthFailure", () => {
  test("finds the Gemini GOOGLE_CLOUD_PROJECT abort on stderr behind stdout progress noise", () => {
    const out = "Open this URL in your browser:\nhttps://accounts.google.com/o/oauth2/v2/auth?x=1\nExchanging authorization code for tokens...\nChecking for existing Cloud Code Assist project...";
    const err = `Error: ${GEMINI_ABORT}`;
    const msg = extractOauthFailure(out, err);
    expect(msg).toContain("GOOGLE_CLOUD_PROJECT");
    expect(msg).toContain("goo.gle/gemini-cli-auth-docs"); // the remedy line rides along
  });

  test("stderr wins over stdout; the LAST error-looking line wins within a stream", () => {
    const err = "loadCodeAssist failed: 429 rate limited\nonboardUser failed: 403 Forbidden: no license";
    expect(extractOauthFailure("Token exchange failed: earlier", err)).toContain("onboardUser failed: 403");
  });

  test("no error-looking line: falls back to the last non-empty line, ANSI-stripped", () => {
    expect(extractOauthFailure("progress a\n\u001b[31mfinal line\u001b[0m\n\n", "")).toBe("final line");
  });

  test("empty output extracts empty (record substitutes the generic message)", () => {
    expect(extractOauthFailure("", "")).toBe("");
    expect(recordOauthFailure("t-empty", "").message).toContain("without saving a credential");
    clearOauthFailure("t-empty");
  });

  test("caps runaway output so a stack dump cannot flood a toast", () => {
    const msg = extractOauthFailure("", "Error: " + "x".repeat(2000));
    expect(msg.length).toBeLessThanOrEqual(500);
  });
});

describe("failure record lifecycle", () => {
  test("record → get → clear; clearing is what a retry and a success both do", () => {
    expect(getOauthFailure("t-gemini")).toBeUndefined();
    const f = recordOauthFailure("t-gemini", GEMINI_ABORT.replace("\n", " "));
    expect(getOauthFailure("t-gemini")?.message).toContain("GOOGLE_CLOUD_PROJECT");
    expect(f.at).toBeGreaterThan(0);
    clearOauthFailure("t-gemini");
    expect(getOauthFailure("t-gemini")).toBeUndefined();
  });
});
