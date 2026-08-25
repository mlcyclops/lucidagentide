# v1.13.1 screenshot placeholders - LUCID Agent in Fleet Mode

Drop the real captures here. The top-level README's "What's new in v1.13.1" holds a commented-out
gallery block that references exactly these three filenames: uncomment it once the files exist, so the
README never ships a broken image to the remote.

| File | What to capture |
|---|---|
| `fleet-mode-grid.png` | The Fleet dock open with **3 or more lanes in different states** at once: one cyan working, one amber awaiting-input, one red needs-approval with its Allow/Deny bar showing. Header HUD visible so `CPU / MEM / N lanes` reads (no `4/4` cap any more). |
| `fleet-mode-spawn.png` | The **New lane** form with a repo URL pasted (use a GitHub, GitLab, **or** Azure DevOps https remote), so the provider line, the resolved clone path, the token field, and the "remember this token for `<host>`" checkbox are all legible. `Folder` should read **Clone into**, with the Browse button beside it. |
| `fleet-mode-pill.png` | The **minimized** pill in the status bar, cropped tight to the lower-right, with several colored dots + counts and one hover tooltip open naming the lanes in that state. This is the shot that shows the per-state snapshot replacing the old single dot. |

Notes for the capture:

- Suggested width about 1600px, PNG, no scaling artifacts. For `fleet-mode-pill.png` a tight crop of
  roughly 520x90 reads better than a full-window shot.
- Blur or use a throwaway repo for anything sensitive: lane names, folder paths, and repo URLs are all
  visible in these frames. Never capture a frame with a token value on screen (the field is a password
  input, but the "remember" label names the host).
- Dark theme, default zoom, so the frames match the rest of the README's captures.
