// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { ARCADE_GAMES } from "./arcade_games.ts";
import { readPreviewFile } from "./preview_file.ts";

const root = join(import.meta.dir, "renderer", "games");

describe("packaged arcade games", () => {
  for (const [id, game] of Object.entries(ARCADE_GAMES)) {
    test(`${id} is a self-contained Preview document`, () => {
      const path = join(root, game.file);
      const preview = readPreviewFile(path);
      expect(preview.ok).toBe(true);
      if (!preview.ok) return;
      expect(preview.kind).toBe("html");
      const html = preview.html;
      expect(html).toContain("SPDX-License-Identifier: BUSL-1.1");
      expect(html).toContain("<canvas");
      const script = html.match(/<script>([\s\S]*?)<\/script>/i)?.[1];
      expect(script).toBeTruthy();
      expect(() => new Function(script!)).not.toThrow();
      expect(html).not.toMatch(/<script[^>]+src\s*=|<link[^>]+rel\s*=\s*["']?stylesheet|<img[^>]+src\s*=\s*["']?https?:/i);
      expect(html).not.toContain("\u2014");
    });
  }
});
