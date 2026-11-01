# Skill provenance manifest

Every skill in this folder records where it came from, when, and its trust basis.
This is a security project: untrusted `.md` is a prompt-injection vector, so no
skill enters here without a recorded, vendor-trusted source.

> **Pull rule (set by the operator):** only pull `SKILL.md` from official repos /
> vendor-trusted sites — never random GitHub pages unless redirected from an
> official source, and ask before fetching. Until the Unicode scanner lands
> (increment P2.1), skills are inspected manually; afterward, every file added
> here MUST pass `scanner-sidecar` with zero findings before it is trusted.

| Skill | Source (official) | Commit | Fetched | Trust | Scanned |
|-------|-------------------|--------|---------|-------|---------|
| `semantic-compression` | `github.com/can1357/oh-my-pi` → `.omp/skills/semantic-compression/SKILL.md` | `faa96a81` | 2026-06-18 | vendor (omp author `can1357`) | manual review — clean; pending automated P2.1 scan |
| `system-prompts` | `github.com/can1357/oh-my-pi` → `.omp/skills/system-prompts/SKILL.md` | `faa96a81` | 2026-06-18 | vendor (omp author `can1357`) | manual review — clean; pending automated P2.1 scan |
| `mascot-stage` | FIRST-PARTY - authored in-repo (P-MASCOT.1 session, ADR-0251 pivot). Replaces the same-day `threejs-stage` skill, RETIRED when the user killed the talking-head + particles direction (three.js removed from the repo); the preview QA workflow section carried over | n/a | 2026-08-01 | first-party | first-party authorship, plain ASCII; no external file entered the repo |
| `jev-browser` | FIRST-PARTY - authored in-repo (P-JEV.4 session, ADR-0379) for the `browser_run` tool, whose policy is a TypeScript port of `https://github.com/browser-use/jev-ultrafast` (MIT, ported to TypeScript in `harness/browser_policy.ts` + `desktop/browser_snapshot.ts`); no upstream `.md` was fetched | n/a | 2026-09-20 | trusted | first-party authorship, plain ASCII; no external file entered the repo |
| `lucid-hub` | FIRST-PARTY - authored in-repo (P-TUI.3 skill session) against the `lucid hub` control-CLI contract that P-TUI.3 implements; structure modeled on the herdr agent skill (`herdr --skill`), no upstream `.md` copied | n/a | 2026-10-04 | trusted | first-party authorship, plain ASCII; no external file entered the repo |
| `explainer-studio` | FIRST-PARTY - authored in-repo (CREATOR-EXPLAINER session, ADR-0460). Quality bar distilled from a live Chromium profile of twelve `https://sael.net/explainers` pages (Ryan Sael, credited as the inspiration): observed sizes and structure only, no code, text, or layout copied; all recipes, the math module, the capture scripts, and the sample plan are original. Ships built in to the Creator flavor as a distilled `INSTALLED_SKILLS` prompt (`desktop/renderer/skills.ts`) | n/a | 2026-10-28 | trusted | first-party authorship, plain ASCII; no external file entered the repo; `desktop/renderer/skills.test.ts` pins no em/en dash and no hidden unicode in every file |
| `explainer-assets-gpu` | FIRST-PARTY - authored in-repo (CREATOR-EXPLAINER session, ADR-0460) against `DGX-FLEET-INTEGRATION.md`, the `lucid-voice-endpoint` / `lucid-creator-endpoint` v1 contracts, and the agent tools registered under `harness/omp/`; no upstream `.md` fetched. Ships built in to the Creator flavor as a distilled `INSTALLED_SKILLS` prompt | n/a | 2026-10-28 | trusted | first-party authorship, plain ASCII; no external file entered the repo; `desktop/renderer/skills.test.ts` pins no em/en dash and no hidden unicode in every file |
| `curriculum-guide-mirror` | FIRST-PARTY - authored in-repo (CREATOR-CURRICULUM session, ADR-0467), generalized from a family homeschool project's private-mirror decision; generic, no school, portal, endpoint, or brand named, and no portal material copied. Ships built in to the Creator flavor as a distilled `INSTALLED_SKILLS` prompt | n/a | 2026-10-31 | trusted | first-party authorship, plain ASCII; no external file entered the repo; `desktop/renderer/skills.test.ts` pins no em/en dash and no hidden unicode in every file |
| `curriculum-to-explainers` | FIRST-PARTY - authored in-repo (CREATOR-CURRICULUM session, ADR-0467), generalized from the same project's curriculum-map decision and its measured overlay audit; no curriculum text copied. Ships built in to the Creator flavor as a distilled `INSTALLED_SKILLS` prompt | n/a | 2026-10-31 | trusted | first-party authorship, plain ASCII; no external file entered the repo; `desktop/renderer/skills.test.ts` pins no em/en dash and no hidden unicode in every file |
| `notebooklm-podcast-studio` | FIRST-PARTY - authored in-repo (CREATOR-CURRICULUM session, ADR-0467), from the same project's user-present NotebookLM decision and observed NotebookLM behaviour (rolling cap, m4a names cut at the first period, tile reordering); user-present only, ADR-0070 unchanged. Ships built in to the Creator flavor as a distilled `INSTALLED_SKILLS` prompt | n/a | 2026-10-31 | trusted | first-party authorship, plain ASCII; no external file entered the repo; `desktop/renderer/skills.test.ts` pins no em/en dash and no hidden unicode in every file |

## Notes

- Both files were copied from the official oh-my-pi repository clone in
  `vendor/oh-my-pi/` (cloned with explicit operator authorization), not fetched
  from an arbitrary page. They are the framework's own skills — the most
  vendor-trusted source available for this project.
- The omp repo also contains `packages/coding-agent/test/fixtures/skills/*` —
  these are **deliberately malformed** test fixtures (missing frontmatter,
  invalid name chars, etc.). They are NOT trusted skills and were NOT copied
  here. Some may later be reused as adversarial fixtures for the scanner (P2.1).
