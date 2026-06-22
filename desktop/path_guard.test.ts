// Tests for filesystem path containment (M1, ADR-0022).
import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { pathWithin } from "./path_guard.ts";

const ROOT = resolve("/home/user");

describe("pathWithin", () => {
  test("accepts the root itself and descendants", () => {
    // Compare against resolve(...) so the expectation uses the platform separator
    // (Windows backslash vs POSIX slash) — pathWithin returns a resolved path.
    expect(pathWithin(ROOT, ROOT)).toBe(ROOT);
    expect(pathWithin(ROOT, `${ROOT}/projects`)).toBe(resolve(ROOT, "projects"));
    expect(pathWithin(ROOT, "projects/app")).toBe(resolve(ROOT, "projects/app"));
  });
  test("rejects traversal that escapes the root", () => {
    expect(pathWithin(ROOT, "../../etc/passwd")).toBeNull();
    expect(pathWithin(ROOT, `${ROOT}/../secret`)).toBeNull();
    expect(pathWithin(ROOT, "/etc/passwd")).toBeNull();
  });
  test("rejects the sibling-prefix bypass", () => {
    // /home/user-evil shares the /home/user prefix but is NOT inside it.
    expect(pathWithin(ROOT, "/home/user-evil")).toBeNull();
  });
});
