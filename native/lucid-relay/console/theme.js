// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

"use strict";
// Lucid Admin Console (AC-1, 7.1): sets data-theme before first paint. The choice lives in this browser only
// (localStorage "lucid-console-theme"); "system" follows prefers-color-scheme. Never sent to the relay.
(function () {
  var KEY = "lucid-console-theme";
  var IDS = ["lucid-dark", "midnight", "slate", "ember", "contrast", "lucid-light", "paper", "evergreen", "liberty",
    "honor", "gilded", "dawn", "rosewood", "shamrock", "blossom", "harbor", "jubilee", "heritage", "nightshade",
    "gridiron", "pitch", "podium", "pastel"];
  var media = window.matchMedia ? window.matchMedia("(prefers-color-scheme: light)") : null;
  function stored() { try { return window.localStorage.getItem(KEY) || ""; } catch (e) { return ""; } }
  function resolve(pick) {
    if (pick === "system") return media && media.matches ? "lucid-light" : "lucid-dark";
    return IDS.indexOf(pick) >= 0 ? pick : "lucid-dark";
  }
  function apply() { document.documentElement.setAttribute("data-theme", resolve(stored())); }
  apply();
  if (media && media.addEventListener) media.addEventListener("change", function () { if (stored() === "system") apply(); });
  window.LucidConsoleTheme = { key: KEY, ids: IDS, apply: apply, stored: stored };
})();
