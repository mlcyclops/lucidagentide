# Wave brief and audit outline

## Subagent brief template (one per explainer)

```
# Target
Build the explainer <id> in <explainers dir>/<id>/ (a new folder). Edit nothing outside it.

# Topic
<topic in your own words>, for <grade or age>, taught in week <n>.
Levels: younger (<age>) and older (<age>). Both levels are required.

# Bar
Follow the explainer-studio skill and the kit's guide, including Screen layout:
measured header, caption clear of console and panels, own panels on the layout variables and docked.
Write PLAN.md first. Honest write-up and one challenge per level.
No source text, problems, images or characters. Original only.

# Report
Chapter ids per level, files written, shared changes the lead must make (catalog entry, hub list),
and anything you could not verify.
```

## Audit script outline

1. Start the app on an isolated port with temporary data.
2. For each explainer id, each level, each chapter, and each size in the matrix (1084x740, 1024x768,
   768x1024, 844x390, 667x375):
   - open the page at that viewport over the DevTools protocol;
   - switch to the chapter and wait for the layout event;
   - read `getBoundingClientRect()` for every overlay and every scene label;
   - record overlaps (intersection area above 0), off-screen rectangles, the row count of tabs and tools,
     and page errors;
   - save a screenshot when anything fails.
3. Print a summary table: checks run, failures, and the worst overlay cover per size.
4. Stop the app.
