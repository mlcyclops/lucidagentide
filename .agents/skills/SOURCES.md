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

## Notes

- Both files were copied from the official oh-my-pi repository clone in
  `vendor/oh-my-pi/` (cloned with explicit operator authorization), not fetched
  from an arbitrary page. They are the framework's own skills — the most
  vendor-trusted source available for this project.
- The omp repo also contains `packages/coding-agent/test/fixtures/skills/*` —
  these are **deliberately malformed** test fixtures (missing frontmatter,
  invalid name chars, etc.). They are NOT trusted skills and were NOT copied
  here. Some may later be reused as adversarial fixtures for the scanner (P2.1).
