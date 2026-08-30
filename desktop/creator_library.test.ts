// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, test } from "bun:test";
import {
  MAX_TRACK_BYTES, addTrack, extensionOf, foldLibrary, libraryAudioDir, libraryLedger, libraryStats,
  lineageOf, normalizeTags, removeTrack, trackAudio, updateTrack, type LibraryIo,
} from "./creator_library.ts";

function fakeIo(files: Record<string, string> = {}): LibraryIo & { files: Record<string, string>; ledger(): string } {
  let seq = 0;
  let clock = 1_700_000_000_000;
  const store: Record<string, string> = { ...files };
  return {
    files: store,
    ledger: () => store[libraryLedger("/data")] ?? "",
    ensureDir: () => {},
    readText: (p) => store[p] ?? "",
    appendLine: (p, line) => { store[p] = (store[p] ?? "") + line + "\n"; },
    copyIn: (src, dest) => { if (!(src in store)) throw new Error("missing"); store[dest] = store[src]!; return store[src]!.length; },
    readBase64: (p) => Buffer.from(store[p] ?? "", "utf8").toString("base64"),
    removeFile: (p) => { delete store[p]; },
    exists: (p) => p in store,
    now: () => (clock += 1000),
    id: () => `trk${++seq}`,
  };
}

const withSong = () => fakeIo({ "/downloads/Neon Skyline.mp3": "ID3-bytes", "/downloads/notes.txt": "nope" });

describe("track import (CREATOR-0, ADR-0281)", () => {
  test("an mp3 lands in the library with its prompt, tags, and derived title", () => {
    const io = withSong();
    const r = addTrack(io, "/data", { sourcePath: "/downloads/Neon Skyline.mp3", origin: "suno", prompt: "synthwave, 100 bpm", tags: ["Synthwave", " synthwave ", "demo"] });
    expect(r.ok).toBe(true);
    expect(r.track).toMatchObject({ title: "Neon Skyline", origin: "suno", mime: "audio/mpeg", kind: "original", parentId: null, rating: null });
    expect(r.track!.tags).toEqual(["synthwave", "demo"]); // trimmed, lowercased, deduped
    expect(io.files[`${libraryAudioDir("/data")}/${r.track!.file}`]).toBe("ID3-bytes");
    expect(foldLibrary(io.ledger())).toHaveLength(1);
  });

  test("the destination comes from a generated id, so a hostile source name cannot steer the write", () => {
    const io = fakeIo({ "/x/../../etc/evil.wav": "bytes" });
    const r = addTrack(io, "/data", { sourcePath: "/x/../../etc/evil.wav" });
    expect(r.ok).toBe(true);
    expect(r.track!.file).toBe("trk1.wav");
    expect(Object.keys(io.files).some((p) => p.includes("etc/evil.wav") && p.startsWith("/data"))).toBe(false);
  });

  test("a non-audio file is refused by extension, and a missing file is refused honestly", () => {
    const io = withSong();
    expect(addTrack(io, "/data", { sourcePath: "/downloads/notes.txt" }).error).toContain("not an audio container");
    expect(addTrack(io, "/data", { sourcePath: "/downloads/gone.wav" }).error).toContain("not there any more");
    expect(addTrack(io, "/data", { sourcePath: "" }).error).toContain("Pick an audio file");
    expect(foldLibrary(io.ledger())).toHaveLength(0);
  });

  test("an oversized file is rolled back rather than half-imported", () => {
    const io = fakeIo({ "/big.wav": "x".repeat(MAX_TRACK_BYTES + 1) });
    const r = addTrack(io, "/data", { sourcePath: "/big.wav" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("library limit");
    expect(Object.keys(io.files).some((p) => p.startsWith(libraryAudioDir("/data")))).toBe(false);
    expect(foldLibrary(io.ledger())).toHaveLength(0);
  });

  test("a remix or re-prompt without a parent is refused", () => {
    const io = withSong();
    expect(addTrack(io, "/data", { sourcePath: "/downloads/Neon Skyline.mp3", kind: "remix" }).error).toContain("needs the track it came from");
  });

  test("extensionOf handles windows paths and dotless names", () => {
    expect(extensionOf("C:\\Users\\me\\Song.FLAC")).toBe("flac");
    expect(extensionOf("/music/song")).toBe("");
    expect(normalizeTags(["A", "a", 7, "  b  "])).toEqual(["a", "b"]);
  });
});

describe("review, remix, and lineage", () => {
  test("review, rating, and tags are editable; identity and bytes are not", () => {
    const io = withSong();
    const id = addTrack(io, "/data", { sourcePath: "/downloads/Neon Skyline.mp3", origin: "suno" }).track!.id;
    const up = updateTrack(io, "/data", id, { review: "chorus is too loud", rating: 9, tags: ["keep"], title: "Neon Skyline v1" });
    expect(up.ok).toBe(true);
    expect(up.track).toMatchObject({ review: "chorus is too loud", rating: 5, title: "Neon Skyline v1" }); // rating clamped to 1-5
    const folded = foldLibrary(io.ledger());
    expect(folded[0]).toMatchObject({ id, review: "chorus is too loud", rating: 5, bytes: 9 });
    expect(updateTrack(io, "/data", "nope", { review: "x" }).error).toContain("not in the library");
  });

  test("rating null clears it, and an empty title keeps the old one", () => {
    const io = withSong();
    const id = addTrack(io, "/data", { sourcePath: "/downloads/Neon Skyline.mp3" }).track!.id;
    updateTrack(io, "/data", id, { rating: 4 });
    const cleared = updateTrack(io, "/data", id, { rating: null, title: "   " });
    expect(cleared.track!.rating).toBeNull();
    expect(cleared.track!.title).toBe("Neon Skyline");
  });

  test("a remix chain keeps its lineage oldest first and is cycle-safe", () => {
    const io = fakeIo({ "/a.wav": "a", "/b.wav": "b", "/c.wav": "c" });
    const a = addTrack(io, "/data", { sourcePath: "/a.wav", origin: "suno", title: "Take 1" }).track!;
    const b = addTrack(io, "/data", { sourcePath: "/b.wav", origin: "suno", title: "Take 2", kind: "remix", parentId: a.id }).track!;
    const c = addTrack(io, "/data", { sourcePath: "/c.wav", origin: "suno", title: "Take 3", kind: "reprompt", parentId: b.id }).track!;
    const chain = lineageOf(foldLibrary(io.ledger()), c.id);
    expect(chain.map((t) => t.title)).toEqual(["Take 1", "Take 2", "Take 3"]);
    expect(lineageOf([{ ...a, parentId: a.id }], a.id)).toHaveLength(1); // self-parent cannot loop
  });

  test("remove drops the row and the file, and the ledger keeps folding", () => {
    const io = withSong();
    const t = addTrack(io, "/data", { sourcePath: "/downloads/Neon Skyline.mp3" }).track!;
    expect(removeTrack(io, "/data", t.id).ok).toBe(true);
    expect(foldLibrary(io.ledger())).toHaveLength(0);
    expect(io.files[`${libraryAudioDir("/data")}/${t.file}`]).toBeUndefined();
    expect(removeTrack(io, "/data", t.id).error).toContain("not in the library");
  });

  test("playback returns base64 plus the mime, and a missing file says so instead of throwing", () => {
    const io = withSong();
    const t = addTrack(io, "/data", { sourcePath: "/downloads/Neon Skyline.mp3" }).track!;
    const audio = trackAudio(io, "/data", t.id);
    expect(audio.ok).toBe(true);
    expect(audio.mime).toBe("audio/mpeg");
    expect(Buffer.from(audio.audioB64!, "base64").toString("utf8")).toBe("ID3-bytes");
    io.removeFile(`${libraryAudioDir("/data")}/${t.file}`);
    expect(trackAudio(io, "/data", t.id).error).toContain("missing");
  });
});

describe("the ledger is append-only and torn-tail safe", () => {
  test("a torn or unknown line costs one record, never the library", () => {
    const io = withSong();
    const t = addTrack(io, "/data", { sourcePath: "/downloads/Neon Skyline.mp3" }).track!;
    const ledger = io.ledger() + '{"op":"add","at":1,"trac\n' + '{"op":"frobnicate","at":2}\n' + "not json at all\n";
    const folded = foldLibrary(ledger);
    expect(folded).toHaveLength(1);
    expect(folded[0]!.id).toBe(t.id);
  });

  test("an update for an unknown id is ignored, and a fresh library folds to empty", () => {
    expect(foldLibrary('{"op":"update","at":1,"id":"ghost","patch":{"review":"x"}}')).toEqual([]);
    expect(foldLibrary("")).toEqual([]);
  });

  test("stats count remixes, reviews, bytes, and origins", () => {
    const io = fakeIo({ "/a.wav": "aaaa", "/b.wav": "bb" });
    const a = addTrack(io, "/data", { sourcePath: "/a.wav", origin: "suno" }).track!;
    addTrack(io, "/data", { sourcePath: "/b.wav", origin: "elevenlabs", kind: "remix", parentId: a.id });
    updateTrack(io, "/data", a.id, { rating: 5 });
    const s = libraryStats(foldLibrary(io.ledger()));
    expect(s).toMatchObject({ tracks: 2, remixes: 1, reviewed: 1, bytes: 6 });
    expect(s.origins).toMatchObject({ suno: 1, elevenlabs: 1 });
  });
});
