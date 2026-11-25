# Scripted demo fleet (QA and video footage)

A real, isolated Lucid engine whose agents are the house fake ACP agent replaying JSON scripts. Six lanes and
the main chat stream believable, security-first production work (prose, thinking, reads, edits, test and
scan runs, one approval ask per session, background subagents, usage), so QA can drive every fleet surface and
footage can be recorded without a model, a key or a network. Nothing here is used by the product at runtime.

## Run it

From the repo root, two terminals (Bun required, plus git on PATH):

```sh
# 1. the isolated engine on port 7811 (any free port works)
bun desktop/scripts/fleet_demo/start_qa_fleet.mjs 7811

# 2. six lanes + the main chat, a fresh round every 150 s for whatever is idle
bun desktop/scripts/fleet_demo/seed_fleet.mjs http://127.0.0.1:7811/ --every 150
```

Open the printed URL (`http://127.0.0.1:7811/`) in a browser. Leave `--every` out for a single round; the
seeder then exits once every turn has finished. `--lanes N` (1 to 7) changes the lane count and
`--workspace <path>` points the lanes at another folder. `--no-main` leaves the main chat alone, for a walkthrough
that types into the composer itself. Keep the seeder running while turns stream: it reads
each prompt's stream to its end. Ctrl+C in the engine terminal stops every lane, then the engine.

Approval asks wait for a person: answer them in the UI (Allow runs the command and the script continues,
Deny takes the script's deny path and the turn still finishes). Each session asks once; later turns of the
same lane run as already approved.

## What `start_qa_fleet.mjs` does

- Wipes and recreates `<tmp>/lucid-qa-fleet-<port>/` with `home/` (HOME and USERPROFILE), `data/`
  (LUCID_DATA_ROOT), `shim/` and `workspace/sample-platform/` (a git repo with a few sample files; the mini
  game's HTML is materialized so the Preview panel can open it).
- Builds the omp shim with `../demo_fake_omp.ts` (bun's `omp.exe` launcher plus a `dist/cli.js` on Windows, a
  bun shebang script on POSIX), the same pattern as `desktop/acp_backend_recovery.test.ts`.
- Starts `desktop/dev.ts` with every caller `LUCID_*`, `PI_*`, `OMP_*` and `FAKE_*` variable removed, then
  sets only `PORT`, `HOME`, `USERPROFILE`, `LUCID_DATA_ROOT`, `LUCID_GUI_SETTINGS_FILE` (workspace = the
  sample repo), `LUCID_OMP_BIN` (the shim), `FAKE_ACP_MODE=script` and `FAKE_ACP_SCRIPT_DIR` (`./scripts`).
- Waits for the page to serve its `lucid-token` meta, writes `fleet.json` (URL, workspace) for the seeder and
  prints the URL. Engine logs go to `engine.out.log` and `engine.err.log` in the temp root.

## How the fake agent replays a script

`FAKE_ACP_MODE=script` in `harness/mcp/testing/fake_acp_agent.ts`; the pure picker and replay live in
`harness/mcp/testing/fake_acp_script.ts`.

- **Picking:** `[script <id>]` in the prompt selects that script; otherwise the script whose `keywords`
  (whole words, case-insensitive) match the most text wins; otherwise the `default` script (release notes).
- **Session file:** like real omp, each session keeps `~/.omp/agent/sessions/<cwd>/<stamp>_<id>.jsonl`
  (under the temp HOME), so the engine's `sessionPathById` finds it.
- **Subagents:** a `task` step sends omp's batch-shaped `task` tool call and writes each run's
  `<Name>.jsonl` (session header, model, assignment, thinking / toolCall / text messages) and, when the run
  ends, `<Name>.md` into the sibling `<stamp>_<id>/` folder, which is what `/api/subagents` reads.
- **Cancel:** a `session/cancel` stops the replay at the next step and answers the prompt `cancelled`.

## Script format (`scripts/*.json`)

```json
{ "id": "pci-checkout", "title": "...", "prompt": "Ship a PCI-safe checkout microservice",
  "keywords": ["pci", "checkout"], "default": false, "steps": [ ... ] }
```

| Step | Fields | Emits |
|---|---|---|
| `say` / `think` | `text` | `agent_message_chunk` / `agent_thought_chunk` in natural chunks with small delays |
| `read` | `path`, `output`, `i?`, `ms?` | read `tool_call` (pending) then `tool_call_update` (completed, output) |
| `search` | `pattern`, `paths?`, `output` | search tool call |
| `edit` | `path`, `edits: [{ old_text, new_text }]` | edit tool call (`rawInput.path` + `edits`) |
| `create` | `path`, `content` | write tool call (`rawInput.content`) |
| `bash` | `command`, `output` | execute tool call with its output |
| `ask` | `command`, `output`, `deny: [steps]` | `session/request_permission`; allowed runs it, denied fails the call and replays `deny` |
| `task` | `context`, `tasks: [{ name, task, steps, result }]` | `task` tool call plus background subagent transcripts |
| `join` | | waits for the background subagents (omp's hub wait) |
| `usage` | `used`, `size`, `cost` | `usage_update` |
| `pause` | `ms` | nothing |

Each shipped script runs 40 to 90 seconds on either approval path; the test enforces it on a virtual clock.

## Test

```sh
bun test harness/mcp/testing/fake_acp_script.test.ts
```

Covers the picker, chunking, permission outcomes, validation, the replay (allow, deny, delegation transcripts
read back through `listSubagentRuns`, join ordering, cancel) and every shipped script (parses, its own prompt
selects it, 40 to 90 seconds, one ask, a delegation, usage, no em dashes, the mini game's fenced HTML).
