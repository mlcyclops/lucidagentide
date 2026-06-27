// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/splash.ts - tiny first-run setup window.
//
// Shown only when ensureRuntimes() has work to do (installing omp / provisioning
// the scanner interpreter), so a provisioned machine never sees it. Reuses the
// brand mark; status text is pushed in from main via setStatus().

import { BrowserWindow } from "electron";

const HTML = `<!doctype html><meta charset="utf-8"><style>
  :root{color-scheme:dark}
  html,body{margin:0;height:100%;background:#0a0b0f;color:#e7e3ef;
    font:14px/1.5 -apple-system,Segoe UI,Roboto,system-ui,sans-serif;overflow:hidden}
  .wrap{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;
    background:radial-gradient(420px 280px at 70% 12%,#16101f 0%,transparent 60%),#0a0b0f}
  .mark{width:96px;height:96px;animation:float 4.5s ease-in-out infinite}
  @keyframes float{0%,100%{transform:translateY(0)}50%{transform:translateY(-5px)}}
  .pi{stroke:none}
  .ring{transform-origin:512px 520px;animation:spin 7s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
  h1{margin:0;font-size:16px;font-weight:600;letter-spacing:.3px}
  .accent{background:linear-gradient(90deg,#e07bf0,#c64bd6,#46c8dc);-webkit-background-clip:text;background-clip:text;color:transparent}
  #status{min-height:18px;color:#9a93ad;font-size:13px}
  .bar{width:200px;height:3px;border-radius:3px;background:#1b1f2b;overflow:hidden}
  .bar i{display:block;height:100%;width:40%;border-radius:3px;
    background:linear-gradient(90deg,#c64bd6,#46c8dc);animation:slide 1.3s ease-in-out infinite}
  @keyframes slide{0%{transform:translateX(-120%)}100%{transform:translateX(320%)}}
</style>
<div class="wrap">
  <svg class="mark" viewBox="0 0 1024 1024">
    <defs>
      <linearGradient id="b" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#e07bf0"/><stop offset="52%" stop-color="#c64bd6"/><stop offset="100%" stop-color="#46c8dc"/>
      </linearGradient>
    </defs>
    <g class="ring" fill="none" stroke="url(#b)" stroke-width="16" stroke-linecap="round">
      <path d="M512 272 a248 248 0 1 1 -175.4 72.6"/>
    </g>
    <g class="pi" fill="url(#b)">
      <rect x="360" y="428" width="304" height="50" rx="22"/>
      <rect x="416" y="478" width="50" height="152" rx="18"/>
      <rect x="558" y="478" width="50" height="152" rx="18"/>
    </g>
  </svg>
  <h1>Setting up <span class="accent">LucidAgentIDE</span></h1>
  <div id="status">Preparing…</div>
  <div class="bar"><i></i></div>
</div>
<script>window.setStatus = (m) => { document.getElementById('status').textContent = m; };</script>`;

export function createSplash(): BrowserWindow {
  const win = new BrowserWindow({
    width: 420, height: 320, frame: false, resizable: false, show: false,
    backgroundColor: "#0a0b0f", center: true, title: "LucidAgentIDE",
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  win.once("ready-to-show", () => win.show());
  win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(HTML));
  return win;
}

export function setSplashStatus(win: BrowserWindow | null, msg: string): void {
  win?.webContents.executeJavaScript(`window.setStatus && window.setStatus(${JSON.stringify(msg)})`).catch(() => {});
}
