# Session history transfer (lucid-history/1)

LUCID Agent IDE exports a project's session history (or one agent's) to one file and imports that file into
another LUCID Agent IDE, including the Tahiti edition, with no network, no account and no new runtime. The file
is built to pass a cross domain solution (CDS): a guard can inspect every byte of it, and the importer re-checks
everything the guard checked. Decision record: ADR-0682 (P-SESSXFER.1). Schema:
[`docs/schemas/lucid-history-1.schema.json`](schemas/lucid-history-1.schema.json).

## Using it

Sessions panel header, the download button:

- **Export history...** chooses the sessions (this project, or one agent's), an optional marking line, and
  whether to include images (off). The file is saved through the save dialog (desktop app) or downloaded
  (browser). Its name is `<project>-<YYYY-MM-DD>.lucidhistory.json`.
- **Import history...** picks a file from disk. A dialog reports how many sessions were imported, already
  present, in conflict, or quarantined. Imported sessions show **imported - untrusted** in the list, and opening
  one asks first, because its turns become the model's context.

## The file

| Property | Value |
| --- | --- |
| Type | JSON text, UTF-8, LF line endings, no byte order mark |
| Bytes | printable 7-bit ASCII (0x20-0x7E) and LF (0x0A) only; non-ASCII text is written as `\uXXXX` |
| Compression, encryption | none; archives and ciphertext are never produced |
| Executable content | none; tool calls are text (`name`, `arguments` as JSON text), never run on import |
| Binary content | none by default; images only when the user turns them on |
| Size | at most 64 MiB |
| Determinism | keys sorted at every level, sessions sorted by id, no volatile field beyond `created_at`: the same sessions exported with the same `created_at` are byte-identical |

Top level: `format` (`"lucid-history/1"`), `manifest`, `sessions`.

`manifest`: `marking` (the user's one-line marking, printable ASCII, empty when none), `created_at`, `app`,
`app_version`, `project` (the folder name only), `scope` (`project`, `lane` with the agent's name, or
`sessions`), `include_images`, `content` (the declared allowlist), `session_count`, `sessions` (per session:
`id`, `sha256`, `messages`), `payload_sha256`.

Each session: `id`, `title`, `created_at`, `model`, `messages`. Each message has a `role` (`user`, `assistant`,
`tool_result`), `at`, and `parts`:

| Part | Where | Carries |
| --- | --- | --- |
| `text` | all roles | what was typed or said; a tool's output (over 64 KiB is cut, with a marker saying how much) |
| `thinking` | assistant | the model's thinking text |
| `tool_call` | assistant | `id`, `name`, `arguments` (JSON object as text) |
| `image` | user, tool_result | `mime` (png, jpeg, webp), base64 `data`; only when `include_images` is true |
| `omitted` | user, tool_result | `what: "image"`: an image was there and was left out |

Nothing else is allowed: the importer refuses any unknown key, at any level.

### What is removed before export

- C0 and C1 control characters other than tab and newline; CR LF becomes LF.
- The exporting user's home folder path, in every spelling (raw, forward slashes, JSON-escaped), becomes `~`.
  The project is named by its folder name only, so no absolute path or account name is written by LUCID itself.
- Values shaped like keys, tokens or passwords become `[redacted]` (the same redactor Ask Lucid uses).
- The context LUCID injects into a user turn (profile, memory, skill blocks) is not exported; what the user
  typed is.

### Integrity

`manifest.sessions[i].sha256` is the SHA-256 (lowercase hex) of `sessions[i]` serialized as canonical JSON:
keys sorted, no whitespace, non-ASCII as `\uXXXX`. `manifest.payload_sha256` is the SHA-256 of the whole
`sessions` array serialized the same way. The file is not signed: it proves it was not changed after export,
not who made it. Origin is the transfer process's job (the CDS, two-person review), and both reviewers can
recompute every hash.

## The export gate

Every text field of every session (titles, messages, thinking, tool names, arguments and results, ids, model
ids, timestamps) passes LUCID's Unicode scanner (zero-width, bidi controls, tag characters, private use,
mixed-script homoglyphs, format characters) after the removals above.

- Any finding, even one below the blocking threshold, leaves that session out. The user sees which sessions
  were left out and why, and each is logged in the Security panel.
- If the scanner cannot run, nothing is exported (fail-closed).

So an exported file never carries a hidden-character payload a guard would reject.

## The import gate

In order; the first failure stops the import and nothing is written:

1. Size: at most 64 MiB.
2. Bytes: printable ASCII and LF only (a CR means the file was changed in transit).
3. JSON parse.
4. `format` is `lucid-history/1`, and the whole file matches the schema exactly (no unknown key, ids of
   letters, digits, `_` and `-` only, timestamps valid, images only when declared and only png, jpeg or webp
   whose bytes match their type).
5. Every session's SHA-256 and the payload SHA-256 match the manifest.
6. Every text field of every session passes the scanner. A finding quarantines that session (not written,
   logged in the Security panel); the others continue. If the scanner cannot run, nothing is imported.

Then each clean session is written as a new omp transcript in the current project's session folder, keeping
its id:

- a session with that id already here and identical (same hash) is skipped, so importing twice changes nothing;
- a different session with that id is reported as a conflict and is never overwritten;
- every written session carries a provenance entry: trust `untrusted`, the file's project, marking, export time,
  app version and hashes. omp keeps it out of the model's context; LUCID uses it to label the session.

## For an accreditor: a guard rule

A guard can accept a `*.lucidhistory.json` file when all of these hold:

- every byte is 0x0A or 0x20-0x7E;
- it validates against `lucid-history-1.schema.json`;
- `manifest.include_images` is `false` and `manifest.content` is exactly
  `["text","thinking","tool_call","tool_result","timestamp","model"]`;
- `manifest.marking` matches the marking the domain requires;
- recomputing the hashes above gives `manifest.sessions[i].sha256` and `manifest.payload_sha256`.

The file is human-readable JSON, so a reviewer can read every message before release.

## Offline and Tahiti

Export and import run entirely inside the local engine: the file is read in the window (an ordinary file pick)
and posted to the engine on the loopback interface; nothing is fetched or sent anywhere else, and no account,
key or service is involved. The feature adds no dependency. The Tahiti edition pins a core release, so it
inherits this feature, the same file format and the same gates from that release onward.

## Engine routes

UI token only (the agent's token cannot reach them):

- `GET /api/sessions/transfer`: the project name, its session count, and the running agents with theirs.
- `POST /api/sessions/export` `{ scope, marking, includeImages }`: the file text, its file name and a
  per-session report.
- `POST /api/sessions/import` `{ file }`: `imported`, `skipped`, `conflicts`, `blocked`, `failed`.
