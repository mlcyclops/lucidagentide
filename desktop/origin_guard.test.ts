// Tests for the local control-plane request guard (H1/H2, ADR-0022).
import { describe, expect, test } from "bun:test";
import { hostAllowed, isAllowedRequest, reqShape, tokenValid, type ReqShape } from "./origin_guard.ts";

const PORT = 5319;
const base: ReqShape = { method: "GET", host: `localhost:${PORT}`, origin: null, contentType: null };

describe("hostAllowed (DNS-rebind defense)", () => {
  test("accepts loopback authorities on the right port", () => {
    for (const h of [`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`, `LOCALHOST:${PORT}`]) {
      expect(hostAllowed(h, PORT)).toBe(true);
    }
  });
  test("rejects a foreign Host (rebound attacker domain) and wrong port", () => {
    expect(hostAllowed(`evil.example:${PORT}`, PORT)).toBe(false);
    expect(hostAllowed(`localhost:${PORT + 1}`, PORT)).toBe(false);
    expect(hostAllowed(null, PORT)).toBe(false);
  });
});

describe("isAllowedRequest", () => {
  test("same-origin GET passes", () => {
    expect(isAllowedRequest(base, PORT)).toBe(true);
  });
  test("GET with a foreign Host is rejected (rebinding)", () => {
    expect(isAllowedRequest({ ...base, host: `evil.example:${PORT}` }, PORT)).toBe(false);
  });

  test("same-origin JSON POST passes", () => {
    expect(isAllowedRequest(
      { method: "POST", host: `localhost:${PORT}`, origin: `http://localhost:${PORT}`, contentType: "application/json" },
      PORT,
    )).toBe(true);
  });
  test("cross-site POST is rejected even with a JSON body (drive-by CSRF)", () => {
    expect(isAllowedRequest(
      { method: "POST", host: `localhost:${PORT}`, origin: "https://evil.example", contentType: "application/json" },
      PORT,
    )).toBe(false);
  });
  test("same-origin POST without a JSON content-type is rejected (form CSRF)", () => {
    expect(isAllowedRequest(
      { method: "POST", host: `localhost:${PORT}`, origin: `http://localhost:${PORT}`, contentType: "application/x-www-form-urlencoded" },
      PORT,
    )).toBe(false);
  });
  test("local non-browser POST (no Origin) with JSON passes", () => {
    expect(isAllowedRequest(
      { method: "POST", host: `127.0.0.1:${PORT}`, origin: null, contentType: "application/json; charset=utf-8" },
      PORT,
    )).toBe(true);
  });
  test("a malformed Origin is rejected", () => {
    expect(isAllowedRequest(
      { method: "POST", host: `localhost:${PORT}`, origin: "::not a url::", contentType: "application/json" },
      PORT,
    )).toBe(false);
  });
});

describe("tokenValid (capability token)", () => {
  const TOKEN = "a".repeat(64);
  test("accepts the exact token", () => {
    expect(tokenValid(TOKEN, TOKEN)).toBe(true);
  });
  test("rejects a wrong, short, or missing token", () => {
    expect(tokenValid("b".repeat(64), TOKEN)).toBe(false);
    expect(tokenValid("a".repeat(63), TOKEN)).toBe(false);
    expect(tokenValid(null, TOKEN)).toBe(false);
    expect(tokenValid("", TOKEN)).toBe(false);
  });
  test("fails closed when no token is configured", () => {
    expect(tokenValid("anything", "")).toBe(false);
    expect(tokenValid("", "")).toBe(false);
  });
});

describe("reqShape", () => {
  test("extracts the guard-relevant headers from a Request", () => {
    const req = new Request(`http://localhost:${PORT}/api/auth/key`, {
      method: "POST",
      headers: { host: `localhost:${PORT}`, origin: `http://localhost:${PORT}`, "content-type": "application/json" },
      body: "{}",
    });
    const s = reqShape(req);
    expect(s.method).toBe("POST");
    expect(s.origin).toBe(`http://localhost:${PORT}`);
    expect(s.contentType).toContain("application/json");
    expect(isAllowedRequest(s, PORT)).toBe(true);
  });
});
