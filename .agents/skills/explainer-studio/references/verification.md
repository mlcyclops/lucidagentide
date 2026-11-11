# Verification: zero errors, a screenshot per chapter, posters, and a preview clip

An explainer is done when the evidence says so. Collect all of it, and say plainly which parts you could not
run.

## 1. In LUCID's Preview panel

1. Keep the explainer inside the workspace (a page under the system temp dir does not render in Preview).
   Add `<link rel="icon" href="data:,">` to `index.html` so no favicon request can fail.
2. `preview_open` with the absolute path to `index.html`. The Preview frame has NO network and an opaque
   origin: every script, style, font, and texture must be local, and storage does not persist.
3. `preview_inspect` with `what: "errors"`. The answer must contain ZERO console errors. A module load
   error means the frame could not load a module file: bundle (`bun build main.js --minify --outfile=dist/main.js`)
   and point `index.html` at the bundle.
4. For each chapter: `preview_click` its tab (for example `[data-chapter="2"]`), `preview_screenshot`, and
   `preview_inspect` with `selector: "#readout"` to confirm the readout changed to the value the math module
   predicts. Repeat for each view button.
5. Drive at least one slider or stepper with `preview_click` / `preview_type` and confirm the readout.
6. `preview_screenshot` only works while the Preview is the front panel; when it returns nothing, call
   `preview_open` again, or rely on `preview_inspect`.

## 2. Headless Chromium over the DevTools protocol

The page supports a capture mode (`?capture=1`, see `scene-recipes.md`): the script owns time through
`window.__explainer.step(dt)`, so every screenshot and clip frame is deterministic.

### Loopback static server (`serve.ts`)

```ts
// serve.ts: bun serve.ts <dir> [port]. Loopback-only static server for verification runs.
import { resolve, sep } from "node:path";

const root = resolve(Bun.argv[2] ?? ".");
const port = Number(Bun.argv[3] ?? 8765);

Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(req) {
    let path: string;
    try { path = decodeURIComponent(new URL(req.url).pathname); } catch { return new Response("bad path", { status: 400 }); }
    const file = resolve(root, "." + (path.endsWith("/") ? path + "index.html" : path));
    if (file !== root && !file.startsWith(root + sep)) return new Response("forbidden", { status: 403 });
    const f = Bun.file(file);
    if (!(await f.exists())) return new Response("not found", { status: 404 });
    return new Response(f, { headers: { "cache-control": "no-store" } });
  },
});
console.log(`serving ${root} at http://127.0.0.1:${port}/`);
```

### Capture script (`capture.ts`)

```ts
// capture.ts: bun capture.ts <url> [outDir] [--chapters 3] [--views overview,close] [--clip 6]
// Fails (exit 1) on any exception, console error, error log entry, or failed request.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const [url, outDirArg = "verify-out", ...rest] = Bun.argv.slice(2);
if (!url) { console.error("usage: bun capture.ts <url> [outDir] [--chapters N] [--views a,b] [--clip seconds]"); process.exit(2); }
const opt = (name: string, dflt: string): string => { const i = rest.indexOf(`--${name}`); return i >= 0 && rest[i + 1] ? rest[i + 1]! : dflt; };
const chapters = Number(opt("chapters", "3"));
const views = opt("views", "overview").split(",");
const clipSeconds = Number(opt("clip", "6"));
const fps = 30;
const outDir = resolve(outDirArg);
mkdirSync(join(outDir, "frames"), { recursive: true });

// CHROME_PATH: the full path to chrome / chromium on this machine.
const chrome = process.env.CHROME_PATH ?? "chromium";
const port = 9333;
const proc = Bun.spawn([
  chrome, "--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${join(outDir, ".profile")}`,
  "--no-first-run", "--no-default-browser-check", "--window-size=1280,720",
  "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "about:blank",
], { stdout: "ignore", stderr: "ignore" });

async function pageSocketUrl(): Promise<string> {
  for (let i = 0; i < 50; i++) { // a local child process: a short bounded wait, not a network poll
    try {
      const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
      const page = list.find((t) => t.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* not listening yet */ }
    await Bun.sleep(200);
  }
  throw new Error("the Chromium DevTools endpoint never came up");
}

const ws = new WebSocket(await pageSocketUrl());
await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = fail; });

let nextId = 1;
const pending = new Map<number, { ok: (v: any) => void; fail: (e: Error) => void }>();
const waiters: { method: string; ok: (p: any) => void }[] = [];
const errors: string[] = [];
let transferBytes = 0;

ws.onmessage = (ev) => {
  const msg = JSON.parse(String(ev.data));
  if (msg.id) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) p?.fail(new Error(msg.error.message)); else p?.ok(msg.result);
    return;
  }
  const { method, params } = msg;
  if (method === "Runtime.exceptionThrown") errors.push(`exception: ${params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text}`);
  if (method === "Runtime.consoleAPICalled" && (params.type === "error" || params.type === "assert")) {
    errors.push(`console.${params.type}: ${params.args.map((a: any) => a.value ?? a.description ?? "").join(" ")}`);
  }
  if (method === "Log.entryAdded" && params.entry.level === "error") errors.push(`log: ${params.entry.text} ${params.entry.url ?? ""}`);
  if (method === "Network.loadingFailed") errors.push(`request failed: ${params.errorText}`);
  if (method === "Network.loadingFinished") transferBytes += params.encodedDataLength ?? 0;
  for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i]!.method === method) { waiters[i]!.ok(params); waiters.splice(i, 1); }
};

function send(method: string, params: Record<string, unknown> = {}): Promise<any> {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((ok, fail) => pending.set(id, { ok, fail }));
}
const once = (method: string) => new Promise<any>((ok) => waiters.push({ method, ok }));
async function js(expression: string): Promise<any> {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page threw: ${r.exceptionDetails.text}`);
  return r.result?.value;
}
async function shot(path: string): Promise<void> {
  const r = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(path, Buffer.from(r.data, "base64"));
}
const settle = (frames: number) => js(`for (let i = 0; i < ${frames}; i++) window.__explainer.step(${1 / fps})`);

const shots: string[] = [];
try {
  for (const d of ["Page", "Runtime", "Log", "Network"]) await send(`${d}.enable`);
  await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  const target = new URL(url);
  target.searchParams.set("capture", "1");
  target.searchParams.set("selftest", "1");
  const loaded = once("Page.loadEventFired");
  await send("Page.navigate", { url: target.toString() });
  await loaded;
  for (let i = 0; i < 50 && !(await js("!!window.__explainer")); i++) await Bun.sleep(100);
  if (!(await js("!!window.__explainer"))) throw new Error("window.__explainer never appeared (is capture mode wired?)");
  await settle(30);

  for (let c = 1; c <= chapters; c++) {
    await js(`window.__explainer.chapter(${c})`);
    for (const v of views) {
      await js(`window.__explainer.view(${JSON.stringify(v)})`);
      await settle(45); // let tweens and damping finish
      const p = join(outDir, `ch${c}-${v}.png`);
      await shot(p);
      shots.push(p);
    }
  }

  // Clip frames: chapter 1, first view, cinematic camera, deterministic steps.
  await js(`window.__explainer.chapter(1); window.__explainer.view(${JSON.stringify(views[0])}); window.__explainer.cinematic?.(true)`);
  await settle(15);
  const frames = Math.round(clipSeconds * fps);
  for (let f = 0; f < frames; f++) {
    await settle(1);
    await shot(join(outDir, "frames", `${String(f).padStart(4, "0")}.png`));
  }
} catch (e) {
  errors.push(`capture: ${(e as Error).message}`);
} finally {
  ws.close();
  proc.kill();
}

console.log(JSON.stringify({ errors, errorCount: errors.length, transferKB: Math.round(transferBytes / 1024), shots }, null, 2));
process.exit(errors.length ? 1 : 0);
```

The page's `window.__explainer` object (step, chapter, view, cinematic) is the one in `scene-recipes.md`;
capture mode also turns on `preserveDrawingBuffer` so screenshots always hold the last rendered frame. Run:

```bash
bun serve.ts ./my-explainer 8765          # in one terminal (or as a background job)
CHROME_PATH="/path/to/chrome" bun capture.ts http://127.0.0.1:8765/index.html verify-out --chapters 3 --views overview,close,top --clip 6
```

The JSON it prints is the evidence: `errorCount` must be 0, and `transferKB` is the measured transfer
(compare it to the 1 MB budget).

## 3. Poster frames and the preview clip (ffmpeg)

```bash
# poster from the chapter 1 overview shot (webp, plus a jpg fallback)
ffmpeg -y -i verify-out/ch1-overview.png -vf "scale=1280:-2:flags=lanczos" -c:v libwebp -quality 82 poster.webp
ffmpeg -y -i verify-out/ch1-overview.png -vf "scale=1280:-2:flags=lanczos" -q:v 3 poster.jpg

# one small poster per chapter for cards
ffmpeg -y -i verify-out/ch2-overview.png -vf "scale=640:-2:flags=lanczos" -c:v libwebp -quality 80 poster-ch2.webp

# muted preview clip: VP9 webm and an H.264 mp4 fallback
ffmpeg -y -framerate 30 -i verify-out/frames/%04d.png -vf "scale=640:-2:flags=lanczos,format=yuv420p" \
  -c:v libvpx-vp9 -b:v 0 -crf 40 -row-mt 1 -an preview.webm
ffmpeg -y -framerate 30 -i verify-out/frames/%04d.png -vf "scale=640:-2:flags=lanczos,format=yuv420p" \
  -c:v libx264 -preset slow -crf 28 -movflags +faststart -an preview.mp4

# a contact sheet to look at in Preview (one frame per second, 4 x 2)
ffmpeg -y -i verify-out/frames/%04d.png -vf "select='not(mod(n\,30))',scale=320:-2,tile=4x2" -frames:v 1 contact.png

# measure what you made
ffprobe -v error -show_entries format=size,duration -of default=nw=1 preview.webm
```

Target about 25 to 260 KB per clip. Over budget: raise `-crf` by 4, scale to 480 wide, or shorten to 4 s.
`scale=W:-2` keeps the height even, which H.264 and yuv420p require.

## 4. The report

State, with numbers: measured transfer (KB), console error count from Preview and from headless Chromium,
`renderer.info.render.calls` and triangles for the busiest chapter, and the paths of every screenshot, poster,
and clip. Open the contact sheet with `preview_open` and look at it. Anything you did not run (for example,
no Chromium on this machine) is listed as unverified, with the command that would verify it.
