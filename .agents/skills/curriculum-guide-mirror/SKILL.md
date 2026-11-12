---
name: curriculum-guide-mirror
description: "Mirror a parent's own school-portal course materials (lesson guides, answer keys, course PDFs, lesson notes) into a private, read-only local archive with a sha256 manifest and a fixed naming scheme. Use this skill whenever a parent asks to download, back up, archive, organize, or inventory their child's homeschool or online-school materials from a portal they are signed in to, even if they only say 'grab all the worksheets' or 'save the lesson PDFs'. Read it before opening the portal or writing any crawl script. Pair it with curriculum-to-explainers to turn the mirror into original content."
---

# Curriculum Guide Mirror

A parent who pays for an online school can usually see every lesson guide, but only one click at a time. This
skill turns that into one private, dated, searchable archive on the parent's own machine. It is a reading
aid for one family. It is never a way to share, sell, or republish the school's work.

## Ground rules (read first)

1. **The parent's own session, the parent's own browser.** Work only in the browser window the parent has
   already opened and signed in to, and only after the parent asks. The window stays visible. Never ask for,
   store, or type the parent's password. Never use a second account, a headless browser, or someone else's
   login.
2. **Read-only endpoints only.** Use the requests the portal itself makes to show pages. NEVER call an
   endpoint whose name or effect assigns, unassigns, enrolls, excuses, re-enrolls, finalizes, submits,
   grades, sets, saves, deletes, or changes anything. When in doubt, it is not read-only: leave it out.
3. **Go slowly.** One request at a time, with a pause (about 100 to 250 ms) between requests, and a longer
   pause between large downloads. No parallel bursts. Human-like volume.
4. **Stop on any warning.** A captcha, a rate-limit response (429), an unusual-activity notice, a logout, or a
   terms notice means stop, save what you have, and tell the parent. Do not retry around it.
5. **The material is copyrighted.** It belongs to the school. The mirror is never committed, packaged,
   uploaded to a shared drive, served by an app, shown in a public video, or sent to any service the parent
   did not name. Anything you later make from it must be original (see Use).

## Step 1: discover the read-only endpoints

Do not guess URLs. Learn them from the portal's own traffic:

1. With the parent watching, open one course page, one unit, and one lesson in their browser.
2. Read the requests the page made. Two ways, both read-only:
   - the browser's network panel (filter to Fetch/XHR), or
   - `performance.getEntriesByType('resource')` in the page, which lists every URL the page loaded.
3. For each candidate, write down the method, path, query or body shape, and what it returns. Keep only GET
   requests, or POSTs that the portal uses purely to read (a "get" or "list" style name and no change on
   screen after the call).
4. Write the endpoint list into the private dir as `endpoints.md`, with the reason each one is read-only.
   Show it to the parent before crawling.

Typical shape: a "list enrolled courses" call, a "list units of a course" call, a "list lessons of a unit"
call, and per-lesson metadata with links to downloadable files. Files are often plain links on a content host
that need no login.

## Step 2: build the inventory

Walk courses, then units, then lessons, with the pause between calls, from inside the parent's signed-in page
(so the portal's own cookies apply and no secret leaves the browser). Save one `inventory.json`:

- per child: grade, and courses with id, title, subject, start and end dates, description, full-course file
  link, school days;
- per course: units with id and title;
- per unit: lessons with id, name, a short parent note if the portal has one, and the file links (student
  guide, answer key, reference sheets).

Check the counts against what the portal shows (courses per child, units per course) before downloading.

## Step 3: the private dir

- **Outside the repo** and **outside any cloud-synced folder** (OneDrive, Dropbox, iCloud Drive, Google
  Drive). Copyrighted bulk files must not sync. A good default on Windows is
  `%LOCALAPPDATA%\<AppName>\private\<portal>\`; on macOS `~/Library/Application Support/<AppName>/private/`;
  on Linux `~/.local/share/<appname>/private/`.
- Outside backups that are shared, and outside any installer or package.
- Add the folder name to `.gitignore` anyway if any tool might create it near a repo.

## Step 4: download and name

Folders: `<GRADE>/<SUBJECT>/U<nn>-<Unit-Title-Words>/`, for example `G5/MATH/U03-Fraction-Foundations/`.

Files: `GRADE_SUBJECT_SHORTTITLE_SERIESNUMBERS_YYYY.<ext>`

| part | rule | example |
|---|---|---|
| `GRADE` | `G` plus the grade number, `K` for kindergarten | `G5` |
| `SUBJECT` | one fixed code per subject: `ELA`, `READING`, `MATH`, `SCIENCE`, `SOCIAL`, `ART`, `MUSIC`, `LANG`, `COMPUTERS`, `LIFE`, `BIBLE` (extend the list once and keep it) | `MATH` |
| `SHORTTITLE` | the lesson title in PascalCase, ASCII only, plus a kind suffix such as `-Student`, `-AnswerKey`, `-Reference`, `-FullCourse` | `PlaceValueToTheMillions-Student` |
| `SERIESNUMBERS` | the portal's own unit-lesson-item code, dots written as hyphens | `1-1-1` |
| `YYYY` | the start year of the school year | `2026` |

Example: `G5_MATH_PlaceValueToTheMillions-Student_1-1-1_2026.pdf`.

- A grade with two courses in one subject keeps them apart by course folder.
- A course shared by two children is stored once under `SHARED/` and listed under both in the manifest.
- Download sequentially. Write to a `.part` file, then rename when complete. Skip a file whose sha256
  already matches the manifest.

## Step 5: the manifest

`manifest.json` has one record per file: source URL, local path, sha256, bytes, grade, subject, course,
unit, lesson, kind, and the download time. Re-running the mirror later compares sha256 values, so changed
guides show up as changes, not duplicates. Report totals: files, bytes, failures (with URLs), and skipped.

## Use (what the mirror is for)

- **Allowed:** reading it locally, parsing it with local tools (PyMuPDF or pypdf) into private text, and
  uploading it only to the parent's own private tools when the parent asks (for example their own notebook
  app).
- **Allowed for original work:** topics, skills, vocabulary lists in your own words, and the sequence and
  dates. Those are facts about what is taught.
- **Never:** copying text, problems, worked examples, images, characters, or mascots into anything you build;
  redistributing any file; quoting it in a repo, a commit, a public video, or a shared document.

## What you never do

- Use an endpoint that changes anything, or guess one that is not in the portal's own traffic.
- Crawl in parallel, crawl without the parent's request, or keep going after a warning.
- Store the mirror in a repo, a synced folder, or anything that ships.
- Put the portal's name, text, or brand into derived content.

## References

- `references/crawl-checklist.md`: the step-by-step checklist with the checks to run at each stage.
