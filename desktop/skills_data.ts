// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/skills_data.ts
//
// Surfaces omp's discovered skills (AskSage has no skills API - these are omp's,
// discovered from project/user/agent skill dirs). Each is invokable in a turn via
// `/skill:<name>`. Read-only; uses omp's own discoverSkills() so the list matches
// exactly what the agent loads.

import { currentWorkspace } from "./workspace.ts";

export interface SkillInfo { name: string; description: string; source: string }

export async function listSkills(): Promise<SkillInfo[] | null> {
  try {
    const mod: any = await import("@oh-my-pi/pi-coding-agent");
    if (typeof mod.discoverSkills !== "function") return null;
    const r = await mod.discoverSkills(currentWorkspace());
    return (r?.skills ?? [])
      .filter((s: any) => !s?.hide && s?.name)
      .map((s: any) => ({ name: String(s.name), description: String(s.description ?? ""), source: String(s.source ?? "") }));
  } catch {
    return null;
  }
}
