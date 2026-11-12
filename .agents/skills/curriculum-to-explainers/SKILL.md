---
name: curriculum-to-explainers
description: "Turn a child's school-year curriculum (a private mirror of course guides, or a syllabus) into a dated curriculum map, an original topic-level backlog in your own words, and a wave of interactive 3D explainers built in parallel by subagents and audited at every screen size. Use this skill whenever a parent or teacher asks to plan content for the school year, to build explainers that match what a child is studying, to pick which topics deserve an interactive model, or to fan out explainer builds to subagents, even if they only say 'make stuff for what she's learning next month'. Pair it with curriculum-guide-mirror (the input) and explainer-studio (the build bar)."
---

# Curriculum to Explainers

The school calendar decides what to build next. This skill turns a curriculum into a map, the map into a
backlog of original work, and the backlog into a wave of explainers that are built in parallel, integrated
once, and audited at real screen sizes.

## The rule that never bends

The curriculum's source material is usually someone else's copyrighted work. Topics, skills, vocabulary,
order, and dates are facts about what is taught, and you may use them. Text, problems, worked examples,
images, characters, and mascots are not yours: never copy them into the map's committed parts, the backlog,
or any explainer. Everything derived from private source text stays in the private dir.

## Step 1: the curriculum map (private)

Parse the private mirror locally (PyMuPDF or pypdf for PDFs) into private text, then build
`curriculum-map.json` in the private dir. One record per lesson:

- grade, subject, course, unit, the source's own code, a short descriptive title, and the schedule week
  (from course start and end dates and school days);
- learning objectives, written in your own words;
- key vocabulary (single words and short terms);
- your app's canonical skill ids, when it has a skill list.

Check: every course and unit in the inventory appears in the map, and weeks run in order.

## Step 2: the backlog (committable, your own words)

One backlog file per grade, at topic level, for example `docs/curriculum/G5-backlog.md`. Per topic:

| column | content |
|---|---|
| unit | the unit number and a short descriptive topic name |
| topic | what is taught, in your own words |
| week | the target week |
| have | what already exists in the app for it |
| build | explainer, study helper, practice set, story, or podcast |
| priority | P1 to P3 |

The backlog carries no source text, problems, or images, and no brand. A reader should not be able to
reconstruct the source's lessons from it.

## Step 3: the selection rule

A topic earns a premium 3D explainer only when all three hold:

1. **Spatial or dynamic:** it can be manipulated or animated (fractions as areas, arrays, volume, a cycle, a
   map, time on a clock). A list of facts is not.
2. **Upcoming:** it is taught within the next 8 weeks of the calendar.
3. **Not covered:** no existing explainer already teaches it.

Everything else becomes a study helper, a practice set, a story, or a podcast. Record the decision in the
backlog so the next pass does not re-argue it.

## Step 4: the build wave

1. **Plan the wave as the lead.** List the chosen explainers, one id each (kebab-case), with the topic, both
   levels (for example a younger and an older child), and the target week. Write the shared contract once:
   the kit or framework, the quality bar (explainer-studio), the folder rule, and what each builder reports.
2. **One subagent per explainer, one folder each.** Each builder edits only its own new folder (for example
   `public/explainers/<id>/**`). Shared files (the catalog, the hub list, docs, status files) belong to the
   lead alone. A builder that needs a shared change reports it instead of making it.
3. **Each builder** writes PLAN.md first, builds both levels, writes an honest write-up and a challenge,
   follows the screen-layout rules, and reports chapter ids, files, and anything it could not verify.
4. **Integrate once.** The lead adds every finished explainer to the shared catalog in one pass, runs the
   tests once, and runs the audit below. Builders do not run the full test suite mid-flight.

## Step 5: the overlay audit matrix

Load every new explainer in headless Chromium and measure every overlay rectangle (title, tabs, toolbar,
caption, console, mascot or bubble, own panels).

| size | stands for |
|---|---|
| 1084x740 | the app's embedded frame (hub stage) |
| 1024x768 | tablet, landscape |
| 768x1024 | tablet, portrait |
| 844x390 | phone held sideways |
| 667x375 | small phone held sideways |

Cover every chapter at both levels at every size. Pass means:

- no two overlays overlap, and nothing is off screen;
- chapter tabs and tools each stay on one row (a swipeable row is fine; wrapping is not);
- the caption sits clear of the console and panels, or uses the kit's documented fallback;
- no scene labels overlap;
- zero page errors.

Report counts (explainers x sizes x chapters x levels), failures with screenshots, and fixes. See
`references/wave-and-audit.md` for the subagent brief and the audit script outline.

## What you never do

- Copy source text, problems, images, or characters into anything, or name the source's brand in content.
- Let two builders edit the same file, or let a builder edit shared catalogs.
- Pick explainer topics that fail the selection rule because they are fun to build.
- Call a wave done without the audit matrix at both levels.

## References

- `references/wave-and-audit.md`: the subagent brief template and the audit script outline.
