# Sample PLAN.md: Gear Train Workbench

A complete plan in the required shape. It is an original example; copy the STRUCTURE, not the topic.

---

# PLAN: Gear Train Workbench

## 1. Goal

The learner leaves knowing that when two gears mesh, the turns they make are in the inverse ratio of their
tooth counts, so a small gear driving a big one turns the big one slower, and a big one driving a small one
turns it faster.

## 2. Audience and levels

- **Younger (ages 8 to 9):** counts teeth, sees "big gear turns slower", compares with "faster / slower /
  same". Whole-number ratios only (12 and 24, 10 and 30).
- **Older (ages 10 to 12):** writes the ratio as a fraction in lowest terms, computes output turns as a
  mixed number, meets idler gears and two-stage (compound) trains.
- Prior knowledge: counting to 60, multiplication facts; the older level uses fractions and simplifying.

## 3. The idea and misconceptions

- **Idea:** teeth pass the meeting point one for one, so (turns of A) x (teeth of A) = (turns of B) x (teeth
  of B).
- **Misconception 1:** "A bigger gear is stronger, so it spins faster." Chapter 1 shows it turning slower.
- **Misconception 2:** "Adding a gear in the middle changes the speed." Chapter 3 shows an idler only flips
  direction.
- **Misconception 3:** "Gears of any size and tooth shape can mesh." Chapter 2 shows that meshing gears share
  one tooth size (the module); only the tooth COUNT changes.

## 4. Chapters

| # | Name | Learner does | Scene shows | Readouts | Success check |
|---|------|--------------|-------------|----------|---------------|
| 1 | Mesh | Turns the red driver by one full turn (drag the crank or press Space) | Two gears, 12 and 24 teeth; one marked tooth on each; teeth flash as they pass the meeting point | Teeth passed; driver turns; driven turns (exact, as a mixed number) | Driven gear shows 1/2 turn after 1 driver turn |
| 2 | Ratio | Changes either tooth count with steppers (8 to 60) | Gears rebuild at the same tooth size; radii grow with the count | Ratio driver:driven in lowest terms; driven turns per driver turn | Learner makes the driven gear turn 3 times per driver turn |
| 3 | Idler | Adds or removes a middle gear and changes its teeth | A third gear between them; rotation arrows on each gear | Direction of each gear; overall ratio (unchanged by the idler) | Learner states (picks) that the idler did not change the ratio |
| 4 | Compound | Builds two stages: a small and a big gear fixed on one shared axle | Four gears, two axles highlighted as rigid pairs | Stage 1 ratio, stage 2 ratio, product | Overall ratio equals the product of the stages |
| 5 | Challenge | Picks gears from a tray to hit a target (for example output 6 times faster) | The tray of gears (10, 12, 20, 30, 36, 60 teeth) and a target dial | Current ratio vs target | A finish card (and the host app's completion hook, if it has one) when the ratio equals the target exactly |

Chapter switching tweens camera and gears; under reduced motion it cuts.

## 5. Views

- **Workbench** (default): three-quarter view from above the bench.
- **Face-on:** looking along the axles, so meshing teeth line up like a diagram.
- **Top:** straight down, for counting teeth.
- **Cinematic:** slow orbit around the bench; any input cancels it.

## 6. Console and keyboard map

| Control | Range | Step | Default | Key |
|---------|-------|------|---------|-----|
| Driver teeth | 8 to 60 | 1 | 12 | `[` / `]` |
| Driven teeth | 8 to 60 | 1 | 24 | `;` / `'` |
| Idler on/off | on, off | n/a | off | `I` |
| Idler teeth | 8 to 60 | 1 | 16 | `-` / `=` |
| Turn driver one full turn | n/a | n/a | n/a | Space |
| Crank speed | 1 to 4 | 1 | 2 | `S` cycles |
| Chapter | 1 to 5 | 1 | 1 | `1` to `5` |
| View | Workbench, Face-on, Top | n/a | Workbench | `V` cycles, `C` cinematic |
| Labels | on, off | n/a | on | `L` |
| Replay chapter | n/a | n/a | n/a | `R` |
| Help | n/a | n/a | n/a | `?` |
| Write-up | n/a | n/a | n/a | `W` |
| Level | Younger, Older | n/a | Older | `Y` |

## 7. Math model

- Types: tooth counts are integers (BigInt in `math.js`); turns and ratios are rationals (`Q`).
- One mesh: `turnsB = turnsA x teethA / teethB`; direction flips.
- Idler between A and B: `turnsB = turnsA x teethA / teethB` (the idler's teeth cancel); direction of B is
  the same as A.
- Compound train: overall ratio = product of stage ratios, e.g. (12/36) x (10/40) = 1/12, so the output
  makes 1/12 turn per input turn.
- Display: ratios as `a : b` in lowest terms (`12 : 24` shows as `1 : 2`, with the unreduced form beside it in
  the older level); turns as mixed numbers (`7/3` shows as `2 1/3`); never a decimal unless it terminates.
- Edge cases: equal teeth (ratio 1 : 1); maximum 60 : 8 = 15 : 2 = 7 1/2 turns; steppers clamp to 8 to 60.
- Self-tests: 12 and 24 give 1/2; 36 and 12 give 3; idler 16 between 12 and 24 still gives 1/2; (12/36) x
  (10/40) = 1/12; 60 and 8 give 15/2 = 7 1/2.

## 8. Honesty table

| Kind | Claim |
|------|-------|
| Real | Meshing gears share one tooth size; turns are inversely proportional to tooth counts; each mesh reverses direction; an idler does not change the ratio; compound stages multiply. |
| Calculated | Every ratio, every turn count, and the direction arrows, from `math.js`. |
| Drawn to illustrate | The tooth shape (a rounded trapezoid, not a true involute profile), colours, the glowing meeting point, the crank speed. |
| Simplified | No friction, no backlash, no tooth wear; turning effort (torque) is mentioned only as "the slower gear pushes harder" in the older level and is not computed. |

## 9. Look

- Dusk workshop: warm horizon (`#f2a65a`) under a deep blue zenith (`#1d2b53`); a wooden bench on a dark
  ground disc that fades into fog.
- Accent colours: driver red `#e4572e`, driven teal `#17bebb`, idler amber `#ffc914`, compound pair violet
  `#7b5ea7`. The same colour names the gear in its label and its readout.
- Light: hemisphere fill plus one warm shadowed key light from the upper left.
- Type: the system UI font, tabular numerals for readouts.

## 10. Accessibility

- Every control is a real button or labelled range; full keyboard path in section 6; visible focus ring.
- `aria-live="polite"` on the main readout ("Teal gear: 1/2 turn, turning the opposite way").
- Canvas text alternative updated with each change.
- Reduced motion: no cinematic orbit, no auto-turning on chapter entry, tweens become cuts; the Calm switch
  in the console does the same.
- Contrast AA on the translucent console panel.

## 11. Performance budget

- Total transfer under 400 KB (three.js core plus two addons plus our code; no assets).
- Gears: `ExtrudeGeometry` from a `Shape` built per tooth count, cached by count, disposed when evicted;
  at most 6 gears on screen, under 40 draw calls.
- Tooth-pass sparks: one `InstancedMesh` of 64.
- Pixel ratio clamped to 2; render on demand; loop paused when hidden or off screen.

## 12. Assets

None. Everything is procedural.

## 13. Kid safety

Audience includes children: encouraging copy, hints after a wrong challenge answer, no links out, no
accounts, no data collection, no real child's name or likeness, a fictional mascot voice only in captions.

## 14. Verification plan

- `preview_open`, then `preview_inspect` `what: "errors"` = 0 errors.
- `preview_screenshot` for chapters 1 to 5 in Workbench view, and chapter 2 in Face-on and Top.
- `preview_click` the driver `+` stepper 12 times from 12 to 24 and confirm the readout shows `1 : 1`.
- Headless Chromium capture: `--chapters 5 --views workbench,face,top --clip 6`, `errorCount` 0,
  `transferKB` under 400.
- Posters: `poster.webp` (chapter 1 Workbench) and one per chapter; clip `preview.webm` plus `preview.mp4`,
  each about 25 to 260 KB.
- `bun test` on `math.test.js`: all self-tests pass.

## 15. Out of scope

Involute tooth geometry, gear strength, lubrication, bevel and worm gears, belt drives, and computing torque.
