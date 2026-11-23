// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/viz_world_character_lineup.ts - P-WORLDS.KIT2 (ADR-0654): a dev-only lineup of the character kit
// for the real-UI demo (desktop/scripts/demo_p_worlds_kit_2.mjs), reached only through the read-only
// window.__vizProbe.kitLineup that ?vizDemo=1 / ?vizScript=1 expose. It builds figures the way a world pack would (the
// host's WorldKit, soccer's template rig and dimensions) in its own offscreen WebGL renderer, never the scene's, and
// frees every GPU resource before it returns:
//   lineup:   16 figures, one per hair style, cycling all 12 body presets (3 presentations x 4 builds), short and long
//             sleeves alternating, faces painted with the kit's features.
//   heads:    the 16 styles, and under them the capSafe variants under a cap shell (soccer's keeper cap).
//   coverage: the sleeve check in flat colors (the upper arm above the hem red, sleeves and caps green, the torso blue,
//             black ground), every preset at three shoulder lifts, seen from the front and from above, counted from
//             a render target. Soccer's old sleeve (top at +0.02, no cap) runs as the control: it must show red.

import * as THREE from "three";
import { HAIR_COLORS, SKIN_RAMP } from "./viz_cast.ts";
import type { WorldAppearance, WorldBipedSpec, WorldBodyShape, WorldFacePainter, WorldKit, WorldTier } from "./viz_world_api.ts";
import { createWorldHost } from "./viz_world_kit.ts";

type G = THREE.BufferGeometry;

const TIERS: readonly WorldTier[] = ["minimal", "reduced", "full", "ultra", "cinematic"];
const PRESENTATIONS = ["feminine", "masculine", "neutral"] as const;
const SHIRTS: readonly string[] = ["#3b82f6", "#ef4444", "#10b981", "#f59e0b", "#8b5cf6", "#ec4899", "#14b8a6", "#f97316"];
const CLOTHS: readonly string[] = ["#7c3aed", "#0f766e", "#be123c", "#1d4ed8"];
/** The shoulder lifts (rig Z: out to the side) the coverage pass checks: at rest, half out, level. */
export const LINEUP_ARM_ANGLES: readonly number[] = [0.15, 0.9, 1.6];
/** Soccer's 3D ink width, the head center above the head joint and the arm capsules (player.ts). */
const INK = 0.0065;
const HC = 0.105;
const UPPER = { r: 0.042, len: 0.11 } as const;
const FORE = { r: 0.038, len: 0.115 } as const;

export interface KitLineupReport {
  gl: string;
  ms: number;
  tier: WorldTier;
  presets: { presentation: string; body: number; shoulder: number; chest: number; waist: number; hip: number; height: number; limb: number }[];
  hair: { style: string; vertices: Record<WorldTier, number>; cards: Record<WorldTier, number>; capSafe: number }[];
  /** Red (skin above the sleeve) pixels summed over the 12 presets and both views, per shoulder lift. */
  coverage: { angle: number; kitShort: number; kitLong: number; soccer: number }[];
  /** PNG data URLs. */
  lineup: string;
  heads: string;
  coverageShot: string;
}

/** Everything one lineup builds, freed at the end (the kit's shared ink materials are not ours to free). */
class Bag {
  readonly geos = new Set<G>();
  readonly mats = new Set<THREE.Material>();
  readonly texs = new Set<THREE.Texture>();
  dispose(): void {
    for (const g of this.geos) g.dispose();
    for (const m of this.mats) m.dispose();
    for (const t of this.texs) t.dispose();
  }
}

interface Rig {
  root: THREE.Group; spine: THREE.Group; head: THREE.Group;
  shL: THREE.Group; elL: THREE.Group; handL: THREE.Group; shR: THREE.Group; elR: THREE.Group; handR: THREE.Group;
  hipL: THREE.Group; knL: THREE.Group; footL: THREE.Group; hipR: THREE.Group; knR: THREE.Group; footR: THREE.Group;
}

/** Soccer's buildBiped (rig.ts), from the kit's spec. */
function buildRig(parent: THREE.Object3D, s: WorldBipedSpec): Rig {
  const j = (p: THREE.Object3D, x: number, y: number, z: number): THREE.Group => {
    const g = new THREE.Group();
    g.position.set(x, y, z);
    p.add(g);
    return g;
  };
  const root = j(parent, 0, s.hipY, 0), spine = j(root, 0, s.spineUp, 0), head = j(spine, 0, s.headY, 0);
  const shL = j(spine, s.shX, s.shY, 0), elL = j(shL, 0, -s.upper, 0), handL = j(elL, 0, -s.fore, 0);
  const shR = j(spine, -s.shX, s.shY, 0), elR = j(shR, 0, -s.upper, 0), handR = j(elR, 0, -s.fore, 0);
  const hipL = j(root, s.hipX, 0, 0), knL = j(hipL, 0, -s.thigh, 0), footL = j(knL, 0, -s.shin, 0);
  const hipR = j(root, -s.hipX, 0, 0), knR = j(hipR, 0, -s.thigh, 0), footR = j(knR, 0, -s.shin, 0);
  return { root, spine, head, shL, elL, handL, shR, elR, handR, hipL, knL, footL, hipR, knR, footR };
}

/** Figure i of the lineup: presentation cycles fastest, then the build, so 0 to 11 hold all 12 presets. */
function appearanceAt(i: number, styles: readonly string[]): WorldAppearance {
  const skinIndex = (i * 3) % SKIN_RAMP.length, sk = SKIN_RAMP[skinIndex]!;
  return {
    presentation: PRESENTATIONS[i % 3]!, body: (Math.floor(i / 3) % 4) as WorldAppearance["body"],
    skin: sk.hex, skinIndex, skinBand: sk.band, hair: styles[i % styles.length]!, hairColor: HAIR_COLORS[(i * 5) % HAIR_COLORS.length]!, face: i % 8,
  };
}

/** The lower half of the head (and of the face cap over it) at the shape's jaw width. */
function jawed(g: G, jaw: number): G {
  const p = g.getAttribute("position");
  for (let i = 0; i < p.count; i++) if (p.getY(i) < 0) p.setX(i, p.getX(i) * jaw);
  return g;
}

/** The template face (soccer face.ts, neutral): skin, the kit's under pass, eyes with a catch light and a soft mouth,
 *  the kit's over pass. */
function paintFace(g: CanvasRenderingContext2D, p: WorldFacePainter, skin: string, scale: number): void {
  g.setTransform(scale, 0, 0, scale, 0, 0);
  g.fillStyle = skin;
  g.fillRect(0, 0, 256, 168);
  p.under(g, scale, {});
  g.setTransform(scale, 0, 0, scale, 0, 0);
  for (const side of [-1, 1]) {
    const x = 128 + side * 46;
    g.fillStyle = "#2b1d14";
    g.beginPath();
    g.ellipse(x, 73, 11, 16, 0, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = "#ffffff";
    g.beginPath();
    g.arc(x - 3.5, 67, 4, 0, Math.PI * 2);
    g.fill();
  }
  g.strokeStyle = "#5a1f1f";
  g.lineWidth = 4.5;
  g.lineCap = "round";
  g.beginPath();
  g.moveTo(116, 128);
  g.quadraticCurveTo(128, 136, 140, 128);
  g.stroke();
  p.over(g, scale, {});
}

/** The pieces every lineup figure shares. */
interface Shared { upper: G; fore: G; hand: G; thigh: G; shin: G; shoe: G; shorts: G; shortLeg: G; head: G }

function shared(bag: Bag): Shared {
  const add = <T extends G>(g: T): T => { bag.geos.add(g); return g; };
  const limb = (r: number, len: number): G => add(new THREE.CapsuleGeometry(r, len, 4, 16).translate(0, -len / 2, 0));
  const shortsProfile: [number, number][] = [[0, -0.1], [0.075, -0.095], [0.106, -0.065], [0.112, -0.02], [0.113, 0.03], [0.11, 0.075]];
  return {
    upper: limb(UPPER.r, UPPER.len),
    fore: limb(FORE.r, FORE.len),
    hand: add(new THREE.SphereGeometry(0.041, 12, 8).scale(0.85, 1.15, 0.72).translate(0, -0.022, 0.004)),
    thigh: limb(0.052, 0.17),
    shin: limb(0.044, 0.165),
    shoe: add(new THREE.BoxGeometry(0.062, 0.044, 0.13).translate(0, -0.042, 0.026)),
    shorts: add(new THREE.LatheGeometry(shortsProfile.map(([r, y]) => new THREE.Vector2(r, y)), 22).scale(1, 1, 0.8)),
    shortLeg: add(new THREE.CylinderGeometry(0.07, 0.074, 0.1, 16).translate(0, -0.05, 0)),
    head: add(new THREE.SphereGeometry(0.112, 26, 18)),
  };
}

function figure(kit: WorldKit, bag: Bag, sh0: Shared, i: number, styles: readonly string[], tier: WorldTier, armAngle: number): THREE.Group {
  const ch = kit.character, a = appearanceAt(i, styles), sh = ch.bodyShape(a), sp = sh.spec;
  const g = new THREE.Group();
  const r = buildRig(g, sp);
  const toon = (color: string, side?: THREE.Side): THREE.MeshToonMaterial => {
    const m = kit.toon(side === undefined ? { color } : { color, side }, false);
    bag.mats.add(m);
    return m;
  };
  const put = (geo: G, m: THREE.Material, parent: THREE.Object3D, ink = true): THREE.Mesh => {
    bag.geos.add(geo);
    const me = new THREE.Mesh(geo, m);
    parent.add(me);
    if (ink) kit.outline(me, INK);
    return me;
  };
  const skinM = toon(a.skin), shirtM = toon(SHIRTS[i % SHIRTS.length]!), shortsM = toon("#2b3445"), shoeM = toon("#1b1b20");
  const cloth = a.hair === "headscarf" || a.hair === "hijab";
  const hairC = cloth ? CLOTHS[i % CLOTHS.length]! : a.hairColor;

  put(ch.torso({ shape: sh, tier }), shirtM, r.spine);
  put(new THREE.CylinderGeometry(sh.neck, sh.neck * 1.14, 0.08 * sh.height, 14).translate(0, 0.29 * sh.height, 0), skinM, r.spine);

  const hc = new THREE.Group();
  hc.position.y = HC;
  r.head.add(hc);
  put(jawed(sh0.head.clone(), sh.jaw), skinM, hc);
  const tex = kit.canvasTexture(512, 336, (ctx) => paintFace(ctx, ch.face(a), a.skin, 2));
  bag.texs.add(tex);
  const faceM = kit.toon({ color: "#ffffff", map: tex }, false);
  bag.mats.add(faceM);
  put(jawed(new THREE.SphereGeometry(0.1145, 24, 14, Math.PI / 2 - 0.95, 1.9, 0.9, 1.25), sh.jaw), faceM, hc, false);
  const hr = ch.hair(a.hair, { tier, seed: i + 1 });
  put(hr.geometry, toon(hairC), hc);
  if (hr.cards) put(hr.cards, toon(hairC, THREE.DoubleSide), hc, false);

  const length = i % 2 ? "long" : "short";
  for (const side of [1, -1]) {
    const s = side > 0 ? r.shL : r.shR, el = side > 0 ? r.elL : r.elR, hd = side > 0 ? r.handL : r.handR;
    s.rotation.z = side * armAngle;
    el.rotation.x = -0.25;
    const sl = ch.sleeve({ length, shape: sh, tier, ink: INK });
    put(sl.cap, shirtM, s);
    put(sl.upper, shirtM, s);
    if (sl.fore) put(sl.fore, shirtM, el);
    put(sh0.upper, skinM, s).scale.set(sh.limb, 1, sh.limb);
    put(sh0.fore, skinM, el).scale.set(sh.limb, 1, sh.limb);
    put(sh0.hand, skinM, hd);
  }
  put(sh0.shorts, shortsM, r.root).scale.set(sh.hip / 0.113, 1, sh.hip / 0.113);
  for (const side of [1, -1]) {
    const hip = side > 0 ? r.hipL : r.hipR, kn = side > 0 ? r.knL : r.knR, ft = side > 0 ? r.footL : r.footR;
    put(sh0.shortLeg, shortsM, hip).scale.set(sh.limb, 1, sh.limb);
    put(sh0.thigh, skinM, hip).scale.set(sh.limb, 1, sh.limb);
    put(sh0.shin, skinM, kn).scale.set(sh.limb, 1, sh.limb);
    put(sh0.shoe, shoeM, ft);
  }
  return g;
}

function lights(scene: THREE.Scene): void {
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8f9a, 1.6));
  const d = new THREE.DirectionalLight(0xffffff, 1.8);
  d.position.set(1.5, 3, 4);
  scene.add(d);
}

/** The upper arm split at `cut` (arm space): the triangles wholly above it, and the rest. */
function armSplit(bag: Bag, cut: number): [G, G] {
  const g = new THREE.CapsuleGeometry(UPPER.r, UPPER.len, 8, 32, 48).translate(0, -UPPER.len / 2, 0).toNonIndexed();
  const pos = g.getAttribute("position");
  const above: number[] = [], below: number[] = [];
  for (let t = 0; t + 2 < pos.count; t += 3) {
    const dst = Math.min(pos.getY(t), pos.getY(t + 1), pos.getY(t + 2)) >= cut ? above : below;
    for (let k = 0; k < 3; k++) dst.push(pos.getX(t + k), pos.getY(t + k), pos.getZ(t + k));
  }
  g.dispose();
  return [above, below].map((arr) => {
    const o = new THREE.BufferGeometry();
    o.setAttribute("position", new THREE.Float32BufferAttribute(arr, 3));
    bag.geos.add(o);
    return o;
  }) as [G, G];
}

type Variant = "short" | "long" | "soccer";
interface Flat { red: THREE.MeshBasicMaterial; green: THREE.MeshBasicMaterial; blue: THREE.MeshBasicMaterial; dark: THREE.MeshBasicMaterial }

/** One preset's shoulders in flat colors; returns the scene and the shoulder height to frame. */
function coverageScene(kit: WorldKit, bag: Bag, m: Flat, sh: WorldBodyShape, angle: number, v: Variant): { scene: THREE.Scene; cy: number } {
  const sp = sh.spec;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);
  const spine = new THREE.Group();
  spine.position.y = sp.hipY + sp.spineUp;
  scene.add(spine);
  const torso = kit.character.torso({ shape: sh, tier: "full" });
  bag.geos.add(torso);
  spine.add(new THREE.Mesh(torso, m.blue));
  for (const side of [1, -1]) {
    const s = new THREE.Group();
    s.position.set(side * sp.shX, sp.shY, 0);
    s.rotation.z = side * angle;
    spine.add(s);
    let cut: number;
    if (v === "soccer") {
      // player.ts: CylinderGeometry(0.056, 0.062, 0.1) moved down 0.03, scaled by the limb scale like the arm
      const old = new THREE.CylinderGeometry(0.056, 0.062, 0.1, 32, 1).translate(0, -0.03, 0);
      bag.geos.add(old);
      const me = new THREE.Mesh(old, m.green);
      me.scale.set(sh.limb, 1, sh.limb);
      s.add(me);
      cut = -0.08;
    } else {
      const sl = kit.character.sleeve({ length: v, shape: sh, tier: "full", ink: INK });
      for (const p of [sl.cap, sl.upper]) { bag.geos.add(p); s.add(new THREE.Mesh(p, m.green)); }
      if (sl.fore) {
        bag.geos.add(sl.fore);
        const el = new THREE.Group();
        el.position.y = -sp.upper;
        el.add(new THREE.Mesh(sl.fore, m.green));
        s.add(el);
      }
      cut = v === "short" ? sl.hem : -sp.upper;
    }
    const [above, below] = armSplit(bag, cut);
    for (const [geo, mat] of [[above, m.red], [below, m.dark]] as const) {
      const me = new THREE.Mesh(geo, mat);
      me.scale.set(sh.limb, 1, sh.limb);
      s.add(me);
    }
  }
  return { scene, cy: spine.position.y + sp.shY };
}

/** Red pixels: skin above a sleeve. */
function countRed(px: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < px.length; i += 4) if (px[i]! > 180 && px[i + 1]! < 80 && px[i + 2]! < 80) n++;
  return n;
}

export function kitLineup(o: { tier?: WorldTier } = {}): KitLineupReport {
  const t0 = performance.now();
  const tier: WorldTier = o.tier && TIERS.includes(o.tier) ? o.tier : "ultra";
  const kit = createWorldHost().kit, ch = kit.character;
  const styles = ch.HAIR_STYLES;
  const bag = new Bag();
  const canvas = document.createElement("canvas");
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  const rt = new THREE.WebGLRenderTarget(512, 280);
  try {
    const shot = (scene: THREE.Scene, camera: THREE.Camera, w: number, h: number): string => {
      renderer.setSize(w, h, false);
      renderer.render(scene, camera);
      return canvas.toDataURL("image/png");
    };

    // the presets and the hair library at every tier
    const presets = PRESENTATIONS.flatMap((presentation) => ([0, 1, 2, 3] as const).map((body) => ch.bodyShape({ presentation, body })));
    const hair = styles.map((style) => {
      const vertices = {} as Record<WorldTier, number>, cards = {} as Record<WorldTier, number>;
      for (const t of TIERS) {
        const h = ch.hair(style, { tier: t });
        vertices[t] = h.geometry.getAttribute("position").count;
        cards[t] = h.cards ? h.cards.getAttribute("position").count : 0;
        h.dispose();
      }
      const safe = ch.hair(style, { tier: "full", capSafe: true });
      const capSafe = safe.geometry.getAttribute("position").count;
      safe.dispose();
      return { style, vertices, cards, capSafe };
    });

    // the lineup: 16 figures in a row
    const shared0 = shared(bag);
    const lineScene = new THREE.Scene();
    lineScene.background = new THREE.Color(0xeef1f6);
    lights(lineScene);
    styles.forEach((_, i) => {
      const f = figure(kit, bag, shared0, i, styles, tier, LINEUP_ARM_ANGLES[0]!);
      f.position.x = (i - (styles.length - 1) / 2) * 0.42;
      lineScene.add(f);
    });
    const lineCam = new THREE.PerspectiveCamera(26, 2400 / 640, 0.1, 50);
    lineCam.position.set(0, 0.62, 4.2);
    lineCam.lookAt(0, 0.56, 0);
    const lineup = shot(lineScene, lineCam, 2400, 640);

    // the heads: every style, and under it the capSafe variant under a cap
    const headScene = new THREE.Scene();
    headScene.background = new THREE.Color(0xeef1f6);
    lights(headScene);
    const capGeo = new THREE.SphereGeometry(0.121, 24, 10, 0, Math.PI * 2, 0, ch.CAP_LINE + 0.05);
    bag.geos.add(capGeo);
    const capM = kit.toon({ color: "#1f2937" }, false);
    bag.mats.add(capM);
    styles.forEach((style, i) => {
      const a = appearanceAt(i, styles);
      const cloth = style === "headscarf" || style === "hijab";
      for (const safe of [false, true]) {
        const hc = new THREE.Group();
        hc.position.set((i - (styles.length - 1) / 2) * 0.34, safe ? -0.2 : 0.2, 0);
        headScene.add(hc);
        const skinM = kit.toon({ color: a.skin }, false), hairM = kit.toon({ color: cloth ? CLOTHS[i % CLOTHS.length]! : a.hairColor }, false);
        bag.mats.add(skinM);
        bag.mats.add(hairM);
        hc.add(new THREE.Mesh(shared0.head, skinM));
        const h = ch.hair(style, { tier, capSafe: safe, seed: i + 1 });
        bag.geos.add(h.geometry);
        hc.add(new THREE.Mesh(h.geometry, hairM));
        if (h.cards) {
          bag.geos.add(h.cards);
          const cm = kit.toon({ color: cloth ? CLOTHS[i % CLOTHS.length]! : a.hairColor, side: THREE.DoubleSide }, false);
          bag.mats.add(cm);
          hc.add(new THREE.Mesh(h.cards, cm));
        }
        if (safe) hc.add(new THREE.Mesh(capGeo, capM));
        hc.rotation.y = 0.5;
      }
    });
    const headCam = new THREE.OrthographicCamera(-2.8, 2.8, 0.45, -0.45, 0.1, 10);
    headCam.position.set(0, 0, 3);
    const heads = shot(headScene, headCam, 2400, 386);

    // the coverage pass
    const flat: Flat = {
      red: new THREE.MeshBasicMaterial({ color: 0xff0000 }), green: new THREE.MeshBasicMaterial({ color: 0x00ff00 }),
      blue: new THREE.MeshBasicMaterial({ color: 0x0000ff }), dark: new THREE.MeshBasicMaterial({ color: 0x202020 }),
    };
    for (const mm of Object.values(flat)) bag.mats.add(mm);
    const cam = new THREE.OrthographicCamera(-0.55, 0.55, 0.3, -0.3, 0.1, 10);
    const px = new Uint8Array(512 * 280 * 4);
    const sheet = document.createElement("canvas");
    sheet.width = 512 * LINEUP_ARM_ANGLES.length;
    sheet.height = 280 * 3;
    const sg = sheet.getContext("2d");
    const coverage = LINEUP_ARM_ANGLES.map((angle, ai) => {
      const row = { angle, kitShort: 0, kitLong: 0, soccer: 0 };
      (["soccer", "short", "long"] as const).forEach((v, vi) => {
        presets.forEach((sh) => {
          const { scene, cy } = coverageScene(kit, bag, flat, sh, angle, v);
          for (const view of ["front", "top"] as const) {
            if (view === "front") cam.position.set(0, cy, 3);
            else cam.position.set(0, cy + 2.4, 1.2);
            cam.lookAt(0, cy, 0);
            renderer.setRenderTarget(rt);
            renderer.render(scene, cam);
            renderer.readRenderTargetPixels(rt, 0, 0, 512, 280, px);
            renderer.setRenderTarget(null);
            const red = countRed(px);
            if (v === "soccer") row.soccer += red;
            else if (v === "short") row.kitShort += red;
            else row.kitLong += red;
            // the sheet: the masculine average build from the front, one column per lift, one row per sleeve
            if (sg && view === "front" && sh.presentation === "masculine" && sh.body === 1) {
              const img = sg.createImageData(512, 280);
              for (let y = 0; y < 280; y++) img.data.set(px.subarray((279 - y) * 512 * 4, (280 - y) * 512 * 4), y * 512 * 4);
              sg.putImageData(img, ai * 512, vi * 280);
            }
          }
        });
      });
      return row;
    });
    const coverageShot = sheet.toDataURL("image/png");

    const g = renderer.getContext();
    return {
      gl: String(g.getParameter(g.RENDERER)),
      ms: Math.round(performance.now() - t0),
      tier,
      presets: presets.map((s) => ({ presentation: s.presentation, body: s.body, shoulder: s.shoulder, chest: s.chest, waist: s.waist, hip: s.hip, height: s.height, limb: s.limb })),
      hair,
      coverage,
      lineup,
      heads,
      coverageShot,
    };
  } finally {
    bag.dispose();
    rt.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
  }
}
