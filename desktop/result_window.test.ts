// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/result_window.test.ts - P-CTX.2b (ADR-0579): the tool-result window policy, its omp overlay, the
// chat model's context window, and omp's spill metadata on a settled tool call.

import { test, expect, describe } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgToolsArtifactHeadBytes, cfgToolsArtifactSpillThreshold, cfgToolsArtifactTailBytes, cfgToolsArtifactTailLines } from "@oh-my-pi/pi-coding-agent/tools/settings";
import {
  DEFAULT_LOCAL_CONTEXT_TOKENS,
  MIN_THRESHOLD_KB,
  OMP_DEFAULT_THRESHOLD_KB,
  chatModelContextWindow,
  humanBytes,
  parseResultWindowSetting,
  resolveResultWindow,
  resultWindowOverlayYaml,
  spillFromRawOutput,
  thresholdKbForContext,
  windowForThreshold,
  type ResultWindow,
  type WindowProvider,
} from "./result_window.ts";
import { writeResultWindowOverlay } from "./result_window_overlay.ts";
import { localProvidersCardBody, resultWindowControlHtml, resultWindowSummary, type ResultWindowControlView } from "./renderer/local_providers_ui.ts";
import { resultWindowLine } from "./renderer/result_window_view.ts";

describe("the rule: one result takes one sixteenth of the context window", () => {
  test("threshold in KB for the common context windows", () => {
    expect(thresholdKbForContext(8_192)).toBe(2);
    expect(thresholdKbForContext(16_384)).toBe(4);
    expect(thresholdKbForContext(32_768)).toBe(8);
    expect(thresholdKbForContext(65_536)).toBe(16);
    expect(thresholdKbForContext(131_072)).toBe(32);
    expect(thresholdKbForContext(200_000)).toBe(48.5); // half-KB steps, rounded down
  });

  test("never under the floor, never over omp's default", () => {
    expect(thresholdKbForContext(2_048)).toBe(MIN_THRESHOLD_KB);
    expect(thresholdKbForContext(4_096)).toBe(MIN_THRESHOLD_KB);
    expect(thresholdKbForContext(204_800)).toBe(OMP_DEFAULT_THRESHOLD_KB);
    expect(thresholdKbForContext(1_000_000)).toBe(OMP_DEFAULT_THRESHOLD_KB);
    expect(thresholdKbForContext(0)).toBe(MIN_THRESHOLD_KB);
    expect(thresholdKbForContext(Number.NaN)).toBe(MIN_THRESHOLD_KB);
    expect(thresholdKbForContext(-5)).toBe(MIN_THRESHOLD_KB);
  });

  test("head and tail keep omp's proportions, and the shown part always fits under the threshold", () => {
    expect(windowForThreshold(50)).toEqual({ thresholdKb: 50, headKb: 20, tailKb: 20, tailLines: 500 }); // omp's own defaults
    expect(windowForThreshold(8)).toEqual({ thresholdKb: 8, headKb: 3.2, tailKb: 3.2, tailLines: 80 });
    expect(windowForThreshold(2)).toEqual({ thresholdKb: 2, headKb: 0.8, tailKb: 0.8, tailLines: 25 }); // line floor
    for (const kb of [2, 2.5, 4, 8, 16, 32, 48.5]) {
      const w = windowForThreshold(kb);
      expect(w.headKb + w.tailKb).toBeLessThan(w.thresholdKb);
      expect(w.tailLines).toBeGreaterThanOrEqual(25);
    }
  });
});

describe("resolveResultWindow", () => {
  test("auto sizes a known small window and leaves omp's default for a large or unknown one", () => {
    expect(resolveResultWindow("auto", 8_192)).toEqual(windowForThreshold(2));
    expect(resolveResultWindow("auto", 32_768)).toEqual(windowForThreshold(8));
    expect(resolveResultWindow("auto", 524_288)).toBeNull(); // the measured GLM window (ADR-0367): omp's default stands
    expect(resolveResultWindow("auto", null)).toBeNull(); // not a model LUCID knows the window of
  });

  test("`omp` always leaves omp's default, whatever the model", () => {
    expect(resolveResultWindow("omp", 8_192)).toBeNull();
    expect(resolveResultWindow("omp", null)).toBeNull();
  });

  test("a fixed size applies to every model, and a size at omp's default writes nothing", () => {
    expect(resolveResultWindow(4, null)).toEqual(windowForThreshold(4));
    expect(resolveResultWindow(4, 1_000_000)).toEqual(windowForThreshold(4));
    expect(resolveResultWindow(50, 8_192)).toBeNull();
  });
});

describe("parseResultWindowSetting", () => {
  test("keeps `omp` and a size from 1 to 50 KB; everything else is auto", () => {
    expect(parseResultWindowSetting("omp")).toBe("omp");
    expect(parseResultWindowSetting(8)).toBe(8);
    expect(parseResultWindowSetting(2.5)).toBe(2.5);
    expect(parseResultWindowSetting("auto")).toBe("auto");
    expect(parseResultWindowSetting(undefined)).toBe("auto");
    expect(parseResultWindowSetting(0)).toBe("auto");
    expect(parseResultWindowSetting(51)).toBe("auto");
    expect(parseResultWindowSetting(Number.NaN)).toBe("auto");
    expect(parseResultWindowSetting("8")).toBe("auto"); // a string size is not a size
    expect(parseResultWindowSetting({ kb: 8 })).toBe("auto");
  });
});

describe("chatModelContextWindow", () => {
  const providers: WindowProvider[] = [
    { ompProvider: "dgx-spark", enabled: true, models: [{ id: "glm-5.3-flash", contextWindow: 524_288 }, { id: "bespoke-merge" }] },
    { ompProvider: "ollama-box", enabled: true, models: [{ id: "llama3.1:8b", contextWindow: 8_192 }, { id: "qwen2.5:3b", contextWindow: 32_768 }] },
    { ompProvider: "parked", enabled: false, models: [{ id: "llama3.1:8b", contextWindow: 8_192 }] },
  ];

  test("returns the window the provider declares for the model", () => {
    expect(chatModelContextWindow("ollama-box/llama3.1:8b", providers)).toBe(8_192);
    expect(chatModelContextWindow("ollama-box/qwen2.5:3b", providers)).toBe(32_768);
    expect(chatModelContextWindow("dgx-spark/glm-5.3-flash", providers)).toBe(524_288);
  });

  test("a local model with no declared window gets the default omp is given for it", () => {
    expect(chatModelContextWindow("dgx-spark/bespoke-merge", providers)).toBe(DEFAULT_LOCAL_CONTEXT_TOKENS);
  });

  test("a model id containing a slash is matched whole after the provider", () => {
    const p: WindowProvider[] = [{ ompProvider: "vllm", models: [{ id: "Qwen/Qwen3-Coder-30B", contextWindow: 262_144 }] }];
    expect(chatModelContextWindow("vllm/Qwen/Qwen3-Coder-30B", p)).toBe(262_144);
  });

  test("null for a cloud model, an unknown model, a disabled provider, and a malformed model string", () => {
    expect(chatModelContextWindow("anthropic/claude-fable-5-2", providers)).toBeNull();
    expect(chatModelContextWindow("ollama-box/not-served", providers)).toBeNull();
    expect(chatModelContextWindow("parked/llama3.1:8b", providers)).toBeNull();
    expect(chatModelContextWindow("", providers)).toBeNull();
    expect(chatModelContextWindow("no-slash", providers)).toBeNull();
    expect(chatModelContextWindow("/leading-slash", providers)).toBeNull();
  });
});

/** Flatten a parsed overlay (`{ tools: { artifactSpillThreshold: 8 } }`) to omp setting ids. */
function flatten(obj: unknown, prefix = ""): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof obj !== "object" || obj === null) return out;
  for (const [k, v] of Object.entries(obj)) {
    const id = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "object" && v !== null && !Array.isArray(v)) Object.assign(out, flatten(v, id));
    else out[id] = v;
  }
  return out;
}

describe("the omp overlay", () => {
  test("a window writes omp's four spill settings under `tools`", () => {
    const yaml = resultWindowOverlayYaml(windowForThreshold(8));
    expect(Bun.YAML.parse(yaml)).toEqual({ tools: { artifactSpillThreshold: 8, artifactHeadBytes: 3.2, artifactTailBytes: 3.2, artifactTailLines: 80 } });
    expect(yaml.startsWith("# Written by LUCID at every omp spawn (P-CTX.2b).")).toBe(true);
  });

  test("no window writes an empty map, so an earlier window never lingers", () => {
    expect(Bun.YAML.parse(resultWindowOverlayYaml(null))).toEqual({});
  });

  test("every key and value in the overlay is a setting the installed omp accepts and reads back", () => {
    for (const kb of [2, 4, 8, 16, 32, 48.5]) {
      const win = windowForThreshold(kb);
      const flat = flatten(Bun.YAML.parse(resultWindowOverlayYaml(win)));
      expect(Object.keys(flat).sort()).toEqual(["tools.artifactHeadBytes", "tools.artifactSpillThreshold", "tools.artifactTailBytes", "tools.artifactTailLines"]);
      const settings = Settings.isolated(flat); // throws on an unknown id or a value omp rejects
      expect(cfgToolsArtifactSpillThreshold.get(settings)).toBe(win.thresholdKb); // read the way omp's spill reads it
      expect(cfgToolsArtifactHeadBytes.get(settings)).toBe(win.headKb);
      expect(cfgToolsArtifactTailBytes.get(settings)).toBe(win.tailKb);
      expect(cfgToolsArtifactTailLines.get(settings)).toBe(win.tailLines);
    }
  });

  test("an id omp does not know is refused by omp, which is what makes the test above mean something", () => {
    expect(() => Settings.isolated({ "tools.artifactSpillThresholdTypo": 8 })).toThrow();
  });

  test("writeResultWindowOverlay writes the file and overwrites a previous window", () => {
    const dir = mkdtempSync(join(tmpdir(), "lucid-window-"));
    try {
      const file = join(dir, "lucid-result-window.yml");
      writeResultWindowOverlay(file, windowForThreshold(2));
      expect(Bun.YAML.parse(readFileSync(file, "utf8"))).toEqual({ tools: { artifactSpillThreshold: 2, artifactHeadBytes: 0.8, artifactTailBytes: 0.8, artifactTailLines: 25 } });
      writeResultWindowOverlay(file, null);
      expect(Bun.YAML.parse(readFileSync(file, "utf8"))).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a write to a path that cannot be opened throws, so the spawn that calls it is refused", () => {
    expect(() => writeResultWindowOverlay(join(tmpdir(), "no-such-dir-lucid-window", "x.yml"), null)).toThrow();
  });
});

describe("spillFromRawOutput", () => {
  const truncation = { direction: "middle", truncatedBy: "middle", totalLines: 40000, totalBytes: 2068889, outputLines: 805, outputBytes: 40898, maxBytes: 40960, artifactId: "0" };

  test("reads stored bytes, shown bytes and the artifact id from omp's truncation metadata", () => {
    expect(spillFromRawOutput({ content: [], details: { meta: { truncation } } })).toEqual({ storedBytes: 2068889, shownBytes: 40898, artifactId: "0" });
  });

  test("a cut result whose artifact was not saved reports no artifact id", () => {
    const { artifactId: _dropped, ...rest } = truncation;
    expect(spillFromRawOutput({ details: { meta: { truncation: rest } } })).toEqual({ storedBytes: 2068889, shownBytes: 40898 });
    expect(spillFromRawOutput({ details: { meta: { truncation: { ...truncation, artifactId: "../1" } } } })).toEqual({ storedBytes: 2068889, shownBytes: 40898 });
  });

  test("null for an uncut result and for metadata that is not two sane sizes", () => {
    expect(spillFromRawOutput(undefined)).toBeNull();
    expect(spillFromRawOutput({ content: [{ type: "text", text: "ok" }] })).toBeNull();
    expect(spillFromRawOutput({ details: { serverName: "github" } })).toBeNull();
    expect(spillFromRawOutput({ details: { meta: {} } })).toBeNull();
    expect(spillFromRawOutput({ details: { meta: { truncation: { totalBytes: "2068889", outputBytes: 40898 } } } })).toBeNull();
    expect(spillFromRawOutput({ details: { meta: { truncation: { totalBytes: 100, outputBytes: 200 } } } })).toBeNull(); // shown cannot exceed stored
    expect(spillFromRawOutput({ details: { meta: { truncation: { totalBytes: 0, outputBytes: 0 } } } })).toBeNull();
    expect(spillFromRawOutput({ details: { meta: { truncation: { totalBytes: Number.POSITIVE_INFINITY, outputBytes: 1 } } } })).toBeNull();
  });
});

describe("what the user reads", () => {
  test("humanBytes", () => {
    expect(humanBytes(0)).toBe("0 B");
    expect(humanBytes(812)).toBe("812 B");
    expect(humanBytes(3769)).toBe("3.7 KB");
    expect(humanBytes(2068889)).toBe("2.0 MB");
    expect(humanBytes(-1)).toBe("0 B");
    expect(humanBytes(Number.NaN)).toBe("0 B");
  });

  test("the tool chip line names shown, stored and the artifact", () => {
    expect(resultWindowLine({ storedBytes: 2068889, shownBytes: 3769, artifactId: "0" })).toBe("Output: 3.7 KB shown to the model of 2.0 MB · rest stored as artifact 0");
    expect(resultWindowLine({ storedBytes: 60000, shownBytes: 40000 })).toBe("Output: 39.1 KB shown to the model of 58.6 KB · rest not stored");
  });

  const view = (over: Partial<ResultWindowControlView> = {}): ResultWindowControlView => ({ setting: "auto", model: "ollama-box/llama3.1:8b", contextTokens: 8_192, window: windowForThreshold(2), ...over });

  test("the summary says what the choice does for the current model", () => {
    expect(resultWindowSummary(view())).toBe("ollama-box/llama3.1:8b has a 8,192 token context window, so it gets 2 KB.");
    expect(resultWindowSummary(view({ model: "anthropic/claude-fable-5-2", contextTokens: null, window: null }))).toBe("anthropic/claude-fable-5-2 is not a local provider model, so it gets 50 KB (omp's default).");
    expect(resultWindowSummary(view({ model: "", contextTokens: null, window: null }))).toBe("No local model is selected, so the window is 50 KB (omp's default).");
    expect(resultWindowSummary(view({ setting: "omp", window: null }))).toBe("Every model gets omp's default of 50 KB.");
    expect(resultWindowSummary(view({ setting: 4, window: windowForThreshold(4) }))).toBe("Every model gets 4 KB.");
  });

  test("the control lists auto, omp and the fixed sizes, with the stored choice selected", () => {
    const h = resultWindowControlHtml(view({ setting: 8, window: windowForThreshold(8) }));
    expect(h).toContain('id="lpResultWindow"');
    expect(h).toContain('<option value="auto">Automatic (sized to the model)</option>');
    expect(h).toContain('<option value="omp">omp default (50 KB)</option>');
    expect(h).toContain('<option value="8" selected>8 KB (about 2,048 tokens)</option>');
    for (const kb of [2, 4, 16, 32]) expect(h).toContain(`<option value="${kb}">`);
    expect(h.split(" selected>").length - 1).toBe(1);
  });

  test("a size stored by hand that is not in the list still shows as the selected option", () => {
    const h = resultWindowControlHtml(view({ setting: 12, window: windowForThreshold(12) }));
    expect(h).toContain('<option value="12" selected>12 KB (about 3,072 tokens)</option>');
  });

  test("a model name is escaped, and the note is one text block, not a flex row of fragments", () => {
    const h = resultWindowControlHtml(view({ model: 'evil/<img src=x onerror="1">' }));
    expect(h).not.toContain("<img");
    expect(h).toContain("&lt;img");
    expect(h).toContain('<div class="set-note">');
    expect(h).toContain("A change applies after a restart.");
  });

  test("the card shows the control when given a view and omits it otherwise", () => {
    expect(localProvidersCardBody([], new Set(), true, view())).toContain('id="lpResultWindow"');
    expect(localProvidersCardBody([], new Set(), true)).not.toContain("lpResultWindow");
    expect(resultWindowControlHtml(null)).toBe("");
  });
});

// A window is only useful if omp honours it; the demo (`make demo-P-CTX.2b`) runs real omp sessions for that.
const _typecheck: ResultWindow = windowForThreshold(2);
void _typecheck;

describe("the Local Providers card keeps its card (the fill bug ADR-0579 closed)", () => {
  // fillSec swaps the section's outerHTML. Filling it with the bare card body dropped the card's title and
  // its data-sec, so the card lost its header on first load and every later refresh found nothing to fill.
  // That lives in app.ts (DOM code with no unit seam), so the wiring is pinned at the source.
  const app = readFileSync(join(import.meta.dir, "renderer", "app.ts"), "utf8");

  test("the fill passes the whole card, built with the same title as the skeleton", () => {
    expect(app).toContain('fillSec("localProviders", setCard("localProviders", LP_CARD_TITLE, LP_CARD_SUB, localProvidersCardBody(');
    expect(app).toContain('setSkel("localProviders", LP_CARD_TITLE, LP_CARD_SUB, true)');
    expect(app).not.toContain('fillSec("localProviders", localProvidersCardBody(');
  });

  test("the tool chip sets its window line through textContent, never markup", () => {
    expect(app).toContain("win.textContent = resultWindowLine(data.window)");
  });
});
