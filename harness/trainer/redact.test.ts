// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/trainer/redact.test.ts - P-TRAINER.3 (ADR-0254): PII becomes placeholders BEFORE storage.

import { describe, expect, test } from "bun:test";
import { redactPii } from "./redact.ts";

describe("redactPii", () => {
  test("emails, phones, and dollar amounts become typed placeholders (soft: no quarantine)", () => {
    const r = redactPii("Call 813-555-0142 or mail jane.doe@example.com about the $2.5 million wire.");
    expect(r.text).toContain("[PHONE]");
    expect(r.text).toContain("[EMAIL]");
    expect(r.text).toContain("[AMOUNT]");
    expect(r.hard).toBe(false);
    expect(r.findings.map((f) => f.kind).sort()).toEqual(["dollar_amount", "email", "phone"]);
  });

  test("honorific names become [CLIENT]", () => {
    const r = redactPii("Mrs. Alvarez called; Dr. Van Patten wants the same treatment.");
    expect(r.text).not.toContain("Alvarez");
    expect(r.text).not.toContain("Van Patten");
    expect(r.text.match(/\[CLIENT\]/g)?.length).toBe(2);
    expect(r.hard).toBe(false);
  });

  test("an SSN is a HARD hit", () => {
    const r = redactPii("Her SSN is 123-45-6789.");
    expect(r.text).toContain("[SSN]");
    expect(r.text).not.toContain("123-45-6789");
    expect(r.hard).toBe(true);
  });

  test("an account-shaped digit run is a HARD hit", () => {
    const r = redactPii("Move it from account 4402918837 first.");
    expect(r.text).toContain("[ACCOUNT]");
    expect(r.hard).toBe(true);
  });

  test("clean role-shaped process text passes untouched", () => {
    const text = "The adviser calls the client back on a known number, then the custodian releases the wire before the 3pm cutoff.";
    const r = redactPii(text);
    expect(r.text).toBe(text);
    expect(r.findings).toEqual([]);
    expect(r.hard).toBe(false);
  });

  test("idempotent: placeholders never re-match", () => {
    const once = redactPii("Mail jane@example.com about the $5,000 fee.");
    const twice = redactPii(once.text);
    expect(twice.text).toBe(once.text);
    expect(twice.findings).toEqual([]);
  });

  test("an SSN is not double-counted as a phone or account run", () => {
    const r = redactPii("SSN 123-45-6789 on file.");
    expect(r.findings.filter((f) => f.kind === "ssn").length).toBe(1);
    expect(r.findings.filter((f) => f.kind === "phone").length).toBe(0);
    expect(r.findings.filter((f) => f.kind === "account_number").length).toBe(0);
  });
});
