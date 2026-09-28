// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-REPO.1 (ADR-0406 amendment, 2026-09-27): repo discovery in the spawn forms is opt-in. Opening a form
// fetches nothing, Search runs exactly the checked sources, and a slow GitHub list never holds the local
// one back.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { GithubRepoList, LocalRepoChoice } from "./bridge.ts";
import { mountRepoPicker, parseFindChecks, REPO_FIND_KEY, runFind, type RepoPickerDeps } from "./repo_picker.ts";

/** Just enough of an element for mountRepoPicker: attribute-selector lookup, events, and the props it sets. */
class FakeEl {
  hidden = false; disabled = false; checked = false; value = ""; innerHTML = "";
  dataset: Record<string, string> = {};
  #on = new Map<string, (() => void)[]>();
  constructor(readonly kids: Record<string, FakeEl[]> = {}) {}
  querySelector(sel: string): FakeEl | null { return this.kids[sel]?.[0] ?? null; }
  querySelectorAll(sel: string): FakeEl[] { return this.kids[sel] ?? []; }
  addEventListener(type: string, fn: () => void): void { this.#on.set(type, [...(this.#on.get(type) ?? []), fn]); }
  fire(type: string): void { for (const fn of this.#on.get(type) ?? []) fn(); }
}

function mountForm(deps: RepoPickerDeps): { go: FakeEl; list: FakeEl; box: (s: string) => FakeEl } {
  const boxes = ["local", "github"].map((s) => { const b = new FakeEl(); b.dataset.repoFind = s; return b; });
  const go = new FakeEl(), list = new FakeEl();
  const pick = new FakeEl({ "[data-repo-list]": [list], "[data-repo-q]": [new FakeEl()], "[data-repo-search]": [new FakeEl()], "[data-repo-go]": [go], "[data-repo-find]": boxes });
  const root = new FakeEl({ "[data-repo-pick]": [pick] });
  mountRepoPicker(root as unknown as HTMLElement, deps, () => "C:/work", () => {});
  return { go, list, box: (s) => boxes.find((b) => b.dataset.repoFind === s)! };
}

function recordingDeps(github: () => Promise<GithubRepoList | null> = async () => ({ repos: [], via: "gh" })): { deps: RepoPickerDeps; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      repoChoices: async () => { calls.push("choices"); return []; },
      repoGithub: (refresh) => { calls.push(refresh ? "github:refresh" : "github"); return github(); },
    },
  };
}

let store: Map<string, string>;
const saved = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
beforeEach(() => {
  store = new Map();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) },
  });
});
afterEach(() => {
  if (saved) Object.defineProperty(globalThis, "localStorage", saved);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

describe("the spawn forms' repo discovery is opt-in", () => {
  test("opening a form fetches nothing and cannot search until a source is checked", () => {
    const { deps, calls } = recordingDeps();
    const f = mountForm(deps);
    expect(calls).toEqual([]);
    expect(f.list.innerHTML).toBe(""); // nothing listed, not even a loading line
    expect(f.go.disabled).toBe(true);
    f.go.fire("click");
    expect(calls).toEqual([]);
  });

  test("Search runs exactly the checked sources", () => {
    const { deps, calls } = recordingDeps();
    const f = mountForm(deps);
    f.box("github").checked = true;
    f.box("github").fire("change");
    expect(f.go.disabled).toBe(false);
    f.go.fire("click");
    expect(calls).toEqual(["github"]);
    f.box("local").checked = true;
    f.box("local").fire("change");
    f.go.fire("click");
    expect(calls).toEqual(["github", "choices", "github"]);
  });

  test("remembered boxes come back checked but still wait for the button", () => {
    const first = recordingDeps();
    const a = mountForm(first.deps);
    a.box("local").checked = true;
    a.box("local").fire("change");
    expect(parseFindChecks(store.get(REPO_FIND_KEY) ?? null)).toEqual({ local: true, github: false });

    const second = recordingDeps();
    const b = mountForm(second.deps);
    expect(b.box("local").checked).toBe(true);
    expect(b.box("github").checked).toBe(false);
    expect(second.calls).toEqual([]);
    b.go.fire("click");
    expect(second.calls).toEqual(["choices"]);
  });

  test("a stored value that is missing or malformed reads as nothing checked", () => {
    for (const raw of [null, "", "not json", "[]", "null", `{"local":"yes","github":1}`]) {
      expect(parseFindChecks(raw)).toEqual({ local: false, github: false });
    }
  });
});

describe("runFind", () => {
  test("the local list lands while a slow GitHub list is still pending", async () => {
    const landed: string[] = [];
    const gh = Promise.withResolvers<GithubRepoList | null>();
    const localIn = Promise.withResolvers<void>(), githubIn = Promise.withResolvers<void>();
    const { deps } = recordingDeps(() => gh.promise);
    runFind(deps, ["local", "github"], {
      local: (r: LocalRepoChoice[] | null) => { landed.push(`local:${r?.length}`); localIn.resolve(); },
      github: (r) => { landed.push(`github:${r?.via}`); githubIn.resolve(); },
    });
    await localIn.promise;
    expect(landed).toEqual(["local:0"]);
    gh.resolve({ repos: [], via: "gh" });
    await githubIn.promise;
    expect(landed).toEqual(["local:0", "github:gh"]);
  });

  test("a failed request lands as null instead of throwing", async () => {
    const localIn = Promise.withResolvers<unknown>(), githubIn = Promise.withResolvers<unknown>();
    const deps: RepoPickerDeps = { repoChoices: () => Promise.reject(new Error("offline")), repoGithub: () => Promise.reject(new Error("offline")) };
    runFind(deps, ["local", "github"], { local: localIn.resolve, github: githubIn.resolve });
    expect(await Promise.all([localIn.promise, githubIn.promise])).toEqual([null, null]);
  });
});
