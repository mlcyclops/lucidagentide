// desktop/managed_config.test.ts — the pure update-channel policy resolver (ADR-A009, #74). Fail-safe by
// design: unmanaged/unknown ⇒ github (never silently disable), feed-without-url ⇒ managed (never hit a
// wrong/empty feed), managed ⇒ disabled.

import { describe, expect, test } from "bun:test";
import { resolveUpdatePolicy, type ManagedConfig } from "./managed_config.ts";

describe("resolveUpdatePolicy (ADR-A009 #74)", () => {
  test("unmanaged (null) defaults to the github channel", () => {
    expect(resolveUpdatePolicy(null)).toEqual({ channel: "github" });
  });

  test("a managed config with no updateChannel defaults to github", () => {
    expect(resolveUpdatePolicy({ orgName: "Acme" })).toEqual({ channel: "github" });
  });

  test("an unknown channel value fails safe to github (never silently disables updates)", () => {
    expect(resolveUpdatePolicy({ updateChannel: "nonsense" as never })).toEqual({ channel: "github" });
  });

  test("github channel is explicit github", () => {
    expect(resolveUpdatePolicy({ updateChannel: "github" })).toEqual({ channel: "github" });
  });

  test("feed channel with a URL uses that internal mirror", () => {
    const mc: ManagedConfig = { updateChannel: "feed", updateFeedUrl: "https://feed.acme.com/lucid/" };
    expect(resolveUpdatePolicy(mc)).toEqual({ channel: "feed", feedUrl: "https://feed.acme.com/lucid/" });
  });

  test("feed URL is trimmed", () => {
    const mc: ManagedConfig = { updateChannel: "feed", updateFeedUrl: "  https://feed.acme.com/  " };
    expect(resolveUpdatePolicy(mc)).toEqual({ channel: "feed", feedUrl: "https://feed.acme.com/" });
  });

  test("feed channel with NO usable URL fails safe to managed (no wrong/empty feed)", () => {
    expect(resolveUpdatePolicy({ updateChannel: "feed" })).toEqual({ channel: "managed" });
    expect(resolveUpdatePolicy({ updateChannel: "feed", updateFeedUrl: "   " })).toEqual({ channel: "managed" });
  });

  test("managed channel disables the in-app check (no feedUrl)", () => {
    expect(resolveUpdatePolicy({ updateChannel: "managed" })).toEqual({ channel: "managed" });
    expect(resolveUpdatePolicy({ updateChannel: "managed", updateFeedUrl: "https://ignored/" })).toEqual({ channel: "managed" });
  });
});
