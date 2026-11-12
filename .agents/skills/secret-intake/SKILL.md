---
name: secret-intake
description: Getting an API key, token, password, PEM key or service-account JSON from the user with request_secret (P-SECRET-INTAKE.1, ADR-0476), the LUCID masked dialog that stores the value straight into the encrypted vault without you ever seeing it. Use whenever a task needs a credential the user has not stored yet; never ask the user to paste a secret into chat, a file, a terminal or a config you write.
---

# Secret intake - request_secret

First-party skill, authored in-repo (2026-11-03, P-SECRET-INTAKE.1 session). `request_secret` opens a
LUCID dialog in front of the user, they paste the secret (or pick a key file, or use a private text file
that LUCID wipes after reading), and the engine stores it in its encrypted vault. You get back only
where it went.

## Rule

Prefer `request_secret` over every other way of obtaining a secret:

- Do NOT ask the user to paste a key, token or password into the chat.
- Do NOT ask them to put it in a `.env`, a config file, a script or a terminal command for you.
- Do NOT write a secret you somehow received into any file, commit, log or message.
- If the user already pasted a secret into chat, do not copy it anywhere. Call `request_secret` so they
  can enter it safely, and suggest they rotate the exposed one, since chat history keeps it.

## The call

```
request_secret({
  name: "OpenAI API key",                       // what it is, for the user
  purpose: "To run the embedding script in tools/embed.ts against your OpenAI account.",
  kind: "apikey",                               // apikey token bearer pat oauth password basic pem jwt saml json other
  envName: "OPENAI_API_KEY",                    // optional: the variable programs read it from
  workspaceScoped: true                         // optional: only for this project (needs envName)
})
```

- `purpose` is shown to the user verbatim. One plain sentence: what you will do with it. Never include
  the value, a guess at it, or instructions to the user beyond why.
- Pick the narrowest scope: `workspaceScoped: true` for a project's own key, omit it for a key the user
  uses everywhere (a provider key).
- `kind: "pem"` or `"json"` gives the user a multi-line field and a key-file picker.

## The result

- `{"stored":true,"ref":"key:OPENAI_API_KEY","envName":"OPENAI_API_KEY"}`: the secret is in the vault.
  Refer to it by `envName` or `ref` from now on. Never print, echo, `cat` or `env`-dump it to check.
- `{"stored":false,"reason":"cancelled"}`: the user said no. Do not ask again in the same turn; explain
  what the task needed and continue without it or stop.
- `{"stored":false,"reason":"timeout"}`: nobody answered within 10 minutes. Tell the user and wait for
  them to come back.
- `{"stored":false,"reason":"invalid request: ..."}`: fix the arguments (for example a missing purpose,
  a bad env name, or a name that looked like a secret value) and call once more.

Never loop on `request_secret`. One call per secret, one retry only after fixing an invalid request.

## What the user sees

A LUCID dialog naming you as the requester, your purpose quoted, a masked field with show/hide, plain
help ("Copy the key (Ctrl+C), click the box, then paste it (Ctrl+V)"; Cmd on macOS), a key-file picker,
and "Use a text file instead", which opens an empty private file in Notepad (TextEdit on macOS) outside
the workspace and outside synced folders; LUCID reads it on save, overwrites it with zeros and deletes it.
After storing, the user may say which other secrets manager they keep; that is their choice and needs
nothing from you.
