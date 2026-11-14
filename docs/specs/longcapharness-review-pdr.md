<!-- Copyright (c) 2026 TechLead 187 LLC -->
<!-- SPDX-License-Identifier: BUSL-1.1 -->

# Paper review and PDR: LongCapHarness (arXiv 2611.10463v1) applied to LUCID

Reviewed 2026-11-14. Paper: Tao Zhang and Yuhang He (Microsoft Research Asia), "LongCapHarness:
Capability-Guided Auto-Harnessing for Long-Context Reasoning", submitted 7 Nov 2026, cs.CL.

This document is a review plus a proposal. Nothing here is decided. Each proposed ADR below gets
its number only when it is accepted and appended to DECISIONS.md (one branch, one allocation, see
`harness/adr_numbering.test.ts`). Each proposed increment is one session.

## 1. What the paper does

The paper improves long-context reasoning of small models (Llama3-8B at an 8K window, Qwen2.5-3B at
32K) without data synthesis and without post-training. It wraps the small "execution model" in a
code harness built by a strong "harnessing agent" (GPT-5.6-Sol) from a development set:

- **Capability.** An abstract transformation from input to output (for example Reranking). Two
  questions share a capability if they need the same transformation.
- **Capability primitives.** The capability decomposed into sub-transforms with declared inputs and
  outputs. Each is implemented either as code (assignment, counting, sorting, keyword match) or as a
  bounded LLM call (relevance judgement, rule inference, evidence integration).
- **Control logic.** Code that schedules the primitives, moves intermediate results between them, and
  decides the stop condition.
- **Capability state.** The reusable protocol for a capability: how a new input is converted into the
  form the primitives need and which intermediate outputs are retained. Per-input runtime state is
  created fresh each run and is explicitly not capability state.
- **Recursive self-improvement (RSI).** The harnessing agent runs the harness on a dev question,
  compares the answer to the reference, and revises implementation, control logic and state until the
  gap is "small enough". The stop criterion is left to the harnessing agent.
- **Library and test-time selection.** Frozen harnesses are saved with a short text description. At
  test time the small execution model picks a harness by matching the description to the question,
  then the harness runs as a program. Intermediate results live outside the model's context; each LLM
  primitive gets a bounded prompt built from a template.

Primitives found for HELMET and RULER: keyword matching, lookup, relation following, state tracking,
counting, ordering, relevance judgement, rule inference, classification, evidence selection, evidence
integration (Appendix A).

### Headline numbers (Table 1, HELMET plus RULER average)

| Execution model | Zero-shot | Trained 128K baseline | RRSI | LongCapHarness |
|---|---|---|---|---|
| Llama3-8B (8K) | 15.14 | 70.15 (NExtLong) | 39.67 | 79.32 |
| Qwen2.5-3B (32K) | 61.91 | 64.10 (PolicyLong) | 38.46 | 78.73 |

Development cost: about 541 USD of GPT-5.6-Sol tokens (814M input, 3.35M output) against an estimated
3,696 USD of H100 time for NExtLong. Inference uses far fewer output tokens than RRSI but 73 to 87
percent more input tokens.

## 2. Critical read: what holds and what does not

**Holds.**

1. **Code beats context for mechanical operations.** Recall is 100.00 for both models and RULER is
   above 94. These tasks reduce to keyword matching, lookup, counting and state tracking, which code
   executes exactly at any length. The paper's own explanation is the right one: the model no longer
   has to hold the whole task state in its window.
2. **Code primitives transfer; semantic primitives do not.** Swapping Llama for Qwen moved the average
   by 0.59 points, but reranking rose 16.61 and LongQA fell 10.39. Whatever is code is portable;
   whatever is a judgement call belongs to the model.
3. **Decomposition gives the optimizer structure.** RRSI (the undirected baseline) spent its rounds on
   token limits and character chunking and lost by 30 to 40 points. Declaring inputs and outputs for
   each primitive is what made the search productive.
4. **Pairwise comparison plus merge beat independent scoring at long lengths** (Table 3, V1 to V2).
   Relative judgements over small groups degrade more gracefully than absolute scores over many items.

**Does not hold, or is weaker than the abstract suggests.**

1. **The +64 figure is against an 8K zero-shot base.** The honest deltas are +9.17 over NExtLong and
   +14.63 over PolicyLong. Still a win, and cheaper, but not the number in the figure.
2. **Dev and test share all 34 task families.** Every HELMET and RULER subtask appears in both splits
   (Table 8). The harnesses are per task family; "generalization" means unseen inputs of a known task
   type. An IDE's task distribution is open, so direct transfer of a harness library is limited to the
   mechanical sub-operations inside a coding task, not to the task as a whole.
3. **Semantic categories barely move.** On RAG the harness trails RRSI with both models; ICL and
   LongQA are mixed; LongBench-v2 Long trails PolicyLong by 3.65. The paper says so plainly in its Q1
   limitation.
4. **Transfer was not zero-touch.** The harnesses were reused "with adaptations to the model,
   tokenizer, evidence budget, and serving configuration".
5. **No fixed stop criterion and no dev-set-size ablation.** RSI stops when the harnessing agent says
   so. Overfitting to the 2,242 dev examples is not measured.
6. **A strong harnessing agent is still required.** Section 6 reports a sharp drop when the small
   models act as their own harnessing agent. The method moves cost from GPUs to frontier-model tokens;
   it does not remove the dependency on a frontier model.
7. **Inference input tokens rise.** Qwen inference cost 53.74 USD against 29.39 for RRSI. The design
   trades output tokens for input tokens, which only pays off where input is cheap or cached.

**Security read (absent from the paper).**

- The harness library is LLM-generated code executed at test time against untrusted documents. There
  is no sandbox, provenance or review step in the pipeline.
- Harness selection is done by the weak execution model from text descriptions. A document that
  mimics a description can steer which program runs. That is a prompt-injection route into control
  logic, which is exactly the class of failure LUCID's gate exists to block.
- "Preserving source identity" across primitives (the paper's phrase) is provenance without trust
  labels: outputs derived from untrusted passages are never marked as such.

These three gaps are LUCID's domain and are where LUCID can adopt the useful idea while fixing what
the paper leaves open.

## 3. Where LUCID stands today

Mapped from the current tree (see file references).

| Paper concept | LUCID today | Maturity |
|---|---|---|
| Intermediate results outside the context | `harness/memory/compaction.ts` archives raw spans with provenance and summarizes from sanitized parts; `harness/prompt/assembler.ts` keeps the tail after the cache breakpoint | Strong for security and cache, not aimed at reasoning |
| Bounded prompts per model call | Tool results reach the model whole; `harness/tools/output_minify_proto.ts` and `output_cmdaware_proto.ts` exist but are imported nowhere | Prototype only |
| Code primitives (match, lookup, count, track) | None exposed as tools; `harness/knowledge/chunk.ts` is fixed 800 char chunking for ingest | Missing |
| Capability state | `harness/memory/state.ts`, `memory.ts`, `turns.ts`, `promotion_gate.ts`: durable, auditable, trust-labelled | Strong, general purpose |
| Control logic | `desktop/model_roles.ts` (ADR-0448) sends plan and slow roles to a flagship and per-turn work to a flash model; `harness/agent/runner.ts` runs DAG workflows | Mature, rule based; nothing routes on the capability a query needs |
| Dev-set evaluation | `harness/bench/benchmark.ts` scores prompt versions on cache hit rate, tokens and security outcomes; no task accuracy, no fixed task set | Weak for this purpose |
| Self-improvement loop | /goal Pre-Flight and After-Action Report (ADR-0057) matures goals and criteria, human adopted; Skill Studio (ADR-0101) drafts skills behind scanner and review; ADR-0133 gates runtime self-modification of agent specs | Human-gated, never edits harness code |
| Small local models | `desktop/local_providers.ts` (ADR-0135), DGX and vLLM, measured windows (ADR-0367); local models strictly opt-in (ADR-0498) | Supported by avoidance, no graceful degradation |

The pattern: LUCID has the state, provenance and model-role machinery the paper's harness needs, and
lacks the two pieces that produced the paper's gains, namely bounded tool-result windows with code
primitives over stored artifacts, and an accuracy dev set to measure them against.

## 4. Why this matters for LUCID specifically

- **Sovereign and air-gapped deployments** (`docs/GEMINI-GOV-AIRGAP.md`, the Private AI Platform,
  DGX spokes) run local models with small windows. The paper shows that code primitives plus bounded
  prompts, not context extension, is the cheap route to competence there.
- **The gate gets stronger, not weaker.** A full tool result that never enters the model's context
  is a full tool result that cannot carry an injection into the model. Windowing is a security
  feature first and a context feature second.
- **Fleet lanes already split roles.** ADR-0448's flagship for plan and slow roles is the paper's
  harnessing agent; the per-turn flash or local model is the execution model. The shape is already
  in the product.
- **Cost showback** (`harness/bench`, the usage ledger) can measure the input-for-output token trade
  the paper reports, per run and per prefix version, which no published benchmark does.

## 5. Proposed ADRs

Numbers are allocated at acceptance. Each is its own increment and its own session.

### ADR-A. P-CTX.2: a tool result is a stored artifact; the model receives a bounded window and a handle

A post-tool hook stores every tool result over a size threshold as an archive chunk with `artifact_id`,
`run_id`, `session_id` and the source trust label, then replaces the content the model sees with a
bounded window (head, tail, match context) plus the handle and the total size. The frozen
`harness/tools/result_adapter.ts` is not changed: windowing happens in the hook that consumes its
output. Fail-closed: a result that cannot be stored is not windowed and is handled as the gate
handles it today (blocked), never passed through whole. The two unwired minify prototypes are either
folded in here or deleted; they do not stay as drift.

### ADR-B. P-CAP.1: code primitives over stored artifacts, with trust-label propagation

Custom tools `artifact_find` (keyword or regex match with record identity), `artifact_lookup`,
`artifact_count`, `artifact_slice` and `artifact_track` (apply ordered events to a state), each
implemented in TypeScript, operating only on handles from ADR-A. Every output inherits the most
severe trust label of its inputs; `suspicious` and `quarantined` inputs produce outputs the promotion
gate refuses, so a derived fact can never launder its source. Outputs are wrapped as untrusted
content and land after the cache breakpoint. These are exactly the paper's code-side primitives,
which transferred across models unchanged.

### ADR-C. P-BENCH.2: a fixed long-context dev set with accuracy scoring for local-model lanes

A checked-in dev set of LUCID-shaped tasks with reference answers (needle in a long build log, count
occurrences across a repo, follow a variable through a diff, rank candidate files for a bug report),
each at several input lengths, run through a lane against a chosen model, scored 0 to 100, and stored
through a numbered DuckDB migration keyed by model, prefix version, window policy and primitive set.
`harness/bench/benchmark.ts` keeps its cache and security dimensions and gains an accuracy dimension.
A dashboard view shows accuracy against input length per model. This is the control the paper's
Figure 5 provides and LUCID currently cannot produce.

### ADR-D. P-RSI.1: human-gated harness revision proposals scored on the dev set

After A to C are measured: the flagship role (ADR-0448) proposes revisions to a primitive's
implementation, a skill, or a window policy; the proposal is scored on the ADR-C dev set; the diff is
opened as a pull request with the before and after scores. Nothing auto-applies. Layers 1 to 4 of the
prompt prefix are out of scope by construction. Generated code passes the scanner and the gate like
any other untrusted input, and carries the BUSL header like any other first-party file. This is the
paper's RSI with the review step the paper omits, and it extends ADR-0133's dry-run posture rather
than relaxing it.

Not proposed: harness selection by the execution model from text descriptions. In LUCID a skill or
primitive is chosen by the trusted task text and the user's settings, never by retrieved content.
If a routing event is added it is a new `EventName`, which is a contract increment of its own.

## 6. PDR: sessions and subtasks

Preconditions for every session: `git fetch --all --prune`, baseline `make test` green, one increment,
three lines in PROGRESS.md at the end. Order matters: C can run in parallel with A, D waits for all.

### Session 1: ADR-A, P-CTX.2a, window hook and archive

- Add `harness/hooks/result_window_hook.ts` as a post-tool hook: threshold, head and tail window,
  handle format, archive write through `harness/memory/compaction.ts` chunk storage.
- Tests: large result windowed with correct handle; small result untouched; archive failure blocks
  rather than passes (the fail-closed case, modelled on `gate.failclosed.test.ts`); the window text is
  wrapped untrusted and sits after the breakpoint (`prefix_compaction.test.ts` pattern).
- `make demo-P-CTX.2a`: a 2 MB synthetic log through a lane, the model sees under 4 KB plus a handle.
- Decide the fate of `output_minify_proto.ts` and `output_cmdaware_proto.ts` in the ADR text.

### Session 2: ADR-A, P-CTX.2b, match-context windows and the desktop surface

- Window policy gains a query-aware mode (lines around a term the model named).
- Desktop: the chat shows "N bytes stored, M shown" with a click-through to the artifact.
  Renderer touched, so rebuild `app.bundle.js` and grep the served bytes for a new marker.
- `make demo-P-CTX.2b`.

### Session 3: ADR-B, P-CAP.1a, find, lookup, count, slice

- `harness/tools/artifact_primitives.ts`: four tools over handles, TypeScript only, no model call.
- Tests per primitive with fixtures at 8K, 64K, 512K characters; record identity preserved; unknown
  handle is an error, never an empty success.
- `make demo-P-CAP.1a`: RULER-style multikey needle at 512K characters answered by a tier-0 model
  through `artifact_find`, zero-shot same model fails.

### Session 4: ADR-B, P-CAP.1b, state tracking and trust propagation

- `artifact_track`; label propagation rule; `promotion_gate.ts` tests for derived facts from
  `suspicious` and `quarantined` inputs (this is the semantic-promotion keystone, over-test it).
- `make demo-P-CAP.1b`.

### Session 5: ADR-C, P-BENCH.2a, dev set and scorer

- `harness/bench/devset/` fixtures with reference answers and a scorer (exact match, substring,
  NDCG@10 for ranking); runner that drives a lane with `harness/testing/echo.ts` for hermetic tests.
- `make demo-P-BENCH.2a`: scores the echo model and one configured local model.

### Session 6: ADR-C, P-BENCH.2b, storage and dashboard

- Numbered migration under `harness/memory/migrations/` for the accuracy table; benchmark dimension;
  dashboard CSV and view. Schema freezes on first write (invariant 10).
- `make demo-P-BENCH.2b`.

### Session 7: ADR-D, P-RSI.1, proposal loop (after A to C have a month of numbers)

- Flagship proposes, dev set scores, PR opens with before and after; the ADR records the stop rule
  (a fixed minimum delta and a fixed round cap, the two things the paper left to the agent).
- `make demo-P-RSI.1` uses the echo model and a canned proposal; the real loop is opt-in.

## 7. What not to do

- Do not extend any model's context window setting to chase these results. ADR-0367's measured
  windows stay measured.
- Do not let generated harness code bypass the scanner, the gate or the license hook because it is
  "ours". It is model output and enters as untrusted.
- Do not make local models the default (ADR-0498 stands). The goal is that a user who must run a
  small model gets a competent lane, not that everyone does.
- Do not reimplement any primitive in Python. The scanner sidecar stays the only Python surface.

## Sources

- arXiv 2611.10463v1, PDF read in full on 2026-11-14 (sections 1 to 6, appendices A to C).
- Secondary: edgelesslab.com breakdown of the +64 figure, consistent with Table 1 as read here.
- Related harness papers the authors cite and LUCID should track: RRSI (arXiv 2609.24972),
  AutoHarness, Meta-Harness, TTHE (arXiv 2607.08124), HarnessX (arXiv 2606.14249), and "Stop
  Comparing LLM Agents Without Disclosing the Harness" (arXiv 2605.23950), which argues for exactly
  the per-run harness versioning LUCID's bench already keys on.
