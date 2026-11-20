// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/preview_bridge.ts — P-PREVIEW.6b (ADR-0153): a tiny READ-ONLY DOM-inspect bridge injected into the
// served preview HTML. The preview iframe is opaque-origin sandboxed (the renderer can't touch its DOM), so
// this script — running INSIDE the frame — answers `postMessage` inspect queries from its parent (the LUCID
// renderer) and posts a compact, redacted snapshot back. It only READS (query text/attributes/roles/rects,
// headings, buttons, captured console errors) — there is NO arbitrary eval and NO mutation. Inline JS is
// allowed by the frame CSP (`script-src 'unsafe-inline'`), and `connect-src 'none'` still blocks all egress.

// ── P-PREVIEW.13: the EARLY shim (runs before any page script) ──────────────────────────────────────
//
// THE DEFECT. The preview frame is deliberately sandboxed `allow-scripts allow-forms` with NO
// `allow-same-origin`, which gives it an OPAQUE origin. In an opaque origin the `localStorage` and
// `sessionStorage` GETTERS THROW a SecurityError. So a page whose first statement is
//
//     const best = Number(localStorage.getItem('best') || 0);
//
// dies on line 1. The browser still applies the HTML and CSS, so the user sees a styled but DEAD page:
// a canvas with its border and background painted and nothing drawn in it. That is the "preview panel
// doesn't work" report, and it hits most model-built games and apps, because storing a high score, a
// todo list, or a theme preference is the first thing they reach for. Confirmed by isolating the single
// line: the identical game with the storage read removed animates correctly in the same sandbox.
//
// THE FIX, AND WHY NOT THE OBVIOUS ONE. Adding `allow-same-origin` would make storage work and is the
// wrong answer: the frame would then share OUR origin, which is the origin holding the per-launch
// capability token and every /api route. Previewed code is UNTRUSTED (invariant 5) and must never sit
// inside the trust boundary. So the origin stays opaque and we hand the page an in-memory Storage
// instead. That is also semantically right: a preview is ephemeral, so preview state SHOULD die with
// the frame rather than persist into the next thing the user previews.
//
// It must be the FIRST script in the document, so it is injected after `<head>` rather than before
// `</body>` like the inspect bridge below. Installing the error capture here too means an early throw
// is recorded (the bridge's own listener is registered too late to see one) and, crucially, becomes
// VISIBLE: a page that dies gets a banner saying so instead of rendering blank in silence.

/** The early shim (inline JS). Self-contained IIFE, idempotent, no egress (connect-src stays 'none'). */
export const PREVIEW_SHIM_JS = `(function(){
  if (window.__lucidShim) return; window.__lucidShim = 1;
  // Links cannot navigate the opaque preview or its host. Ask the host to confirm an external
  // HTTP(S) open; a postMessage is only a request, never permission to bypass the egress gate.
  function link(e){
    if ((e.type==='click' && e.button!==0) || (e.type==='auxclick' && e.button!==1)) return;
    var node=e.target, a=null;
    if (node && node.nodeType===3) node=node.parentElement;
    if (node && node.closest) a=node.closest('a[href],area[href]');
    if (!a) return;
    var raw=a.getAttribute('href') || '', base=document.querySelector('base[target]');
    var target=(a.getAttribute('target') || (base && base.getAttribute('target')) || '').toLowerCase();
    var url=null;
    try { url=new URL(raw,document.baseURI); } catch(_) {}
    // Ordinary in-document TOC links still scroll. Targets cannot turn a fragment into a popup
    // or a parent navigation, and empty hrefs cannot reload the frame.
    if ((!target || target==='_self') && e.type==='click' && !e.ctrlKey && !e.metaKey && !e.shiftKey
      && raw.indexOf('#')!==-1 && url && url.href.split('#')[0]===window.location.href.split('#')[0]) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (target && target!=='_self' && target!=='_blank') return;
    if (!url || !raw || /[\\u0000-\\u0020\\u007f\\\\]/.test(raw)
      || (url.protocol!=='http:' && url.protocol!=='https:') || !url.hostname || url.username || url.password) return;
    // A relative local resource is not an external website. Do not open the host's API endpoints.
    try { if (url.origin===new URL(window.location.href).origin) return; } catch(_) { return; }
    try { window.parent.postMessage({__lucid:'preview-external-link',url:url.href},'*'); } catch(_) {}
  }
  window.addEventListener('click',link,true);
  window.addEventListener('auxclick',link,true);

  // Shared, bounded error buffer. The inspect bridge ADOPTS this array, so preview_inspect's
  // { what: 'errors' } reports failures that happened before the bridge existed.
  var errs = window.__lucidErrs = window.__lucidErrs || [];
  function push(s){ try{ errs.push(String(s)); if(errs.length>60) errs.shift(); }catch(_){} }
  window.addEventListener('error', function(e){ push('error: ' + ((e && e.message) || e)); flag(); });
  window.addEventListener('unhandledrejection', function(e){ push('unhandledrejection: ' + (e && e.reason)); flag(); });

  // In-memory Storage, used ONLY when the real one is unreachable (opaque origin). Implements the
  // surface real code uses; index access (storage[0]) is not emulated, which no practical page needs.
  function memStorage(){
    var m = Object.create(null);
    var api = {
      getItem: function(k){ k=String(k); return Object.prototype.hasOwnProperty.call(m,k) ? m[k] : null; },
      setItem: function(k,v){ m[String(k)] = String(v); },
      removeItem: function(k){ delete m[String(k)]; },
      clear: function(){ m = Object.create(null); },
      key: function(i){ var ks=Object.keys(m); return i>=0 && i<ks.length ? ks[i] : null; }
    };
    Object.defineProperty(api, 'length', { get: function(){ return Object.keys(m).length; } });
    return api;
  }
  ['localStorage','sessionStorage'].forEach(function(name){
    var ok = false;
    // Touching the getter is what throws, so the probe itself has to be guarded.
    try { var s = window[name]; if (s) { s.getItem('__lucid_probe'); ok = true; } } catch(_) { ok = false; }
    if (ok) return; // a real Storage is available (top-level open, or a future allow-same-origin): leave it
    try {
      Object.defineProperty(window, name, { value: memStorage(), configurable: true, writable: false });
      push('note: ' + name + ' is in-memory for this preview (the frame is sandboxed, so nothing persists)');
    } catch(e) { push('error: could not polyfill ' + name + ': ' + ((e && e.message) || e)); }
  });

  // A dead page must SAY it is dead. One compact banner, first error only, dismissible, inline-styled
  // (no stylesheet reaches this frame). Invariant 11: the text is ONE block child, and the close button
  // is positioned, so nothing shatters a sentence into flex slivers.
  var shown = false;
  function flag(){
    if (shown) return; shown = true;
    var first = null;
    for (var i=0;i<errs.length;i++){ if (errs[i].indexOf('error:')===0 || errs[i].indexOf('unhandledrejection:')===0){ first = errs[i]; break; } }
    if (!first) { shown = false; return; }
    function paint(){
      if (!document.body || document.getElementById('lucid-script-error')) return;
      var d = document.createElement('div');
      d.id = 'lucid-script-error';
      d.setAttribute('style','position:fixed;left:0;right:0;top:0;z-index:2147483647;padding:9px 34px 9px 12px;'
        + 'background:#2b1116;color:#ffd9df;border-bottom:1px solid #7d2233;font:12px/1.5 ui-sans-serif,system-ui,sans-serif;'
        + 'text-align:left');
      var p = document.createElement('div');
      p.textContent = 'This preview stopped early: ' + String(first).slice(0,180)
        + ' - the page rendered but its script did not finish, so parts of it may be blank.';
      var x = document.createElement('button');
      x.textContent = '\\u00d7';
      x.setAttribute('style','position:absolute;right:6px;top:5px;width:22px;height:22px;cursor:pointer;'
        + 'background:transparent;border:0;color:#ffd9df;font-size:16px;line-height:1');
      x.onclick = function(){ d.remove(); };
      d.appendChild(p); d.appendChild(x);
      document.body.appendChild(d);
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', paint); else paint();
  }
})();`;

/** Inject the early shim immediately after `<head>` (else after `<html>`, else prepend) so it is the
 *  FIRST script in the document and can repair the environment before page code runs. Pure. */
export function injectPreviewShim(html: string): string {
  const tag = `<script>${PREVIEW_SHIM_JS}</script>`;
  const head = /<head[^>]*>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + tag + html.slice(head.index + head[0].length);
  const htmlTag = /<html[^>]*>/i.exec(html);
  if (htmlTag) return html.slice(0, htmlTag.index + htmlTag[0].length) + tag + html.slice(htmlTag.index + htmlTag[0].length);
  return tag + html;
}

/** The bridge script body (inline JS). Self-contained IIFE; idempotent; listens only to its own parent. */
export const PREVIEW_BRIDGE_JS = `(function(){
  if (window.__lucidInspect) return; window.__lucidInspect = 1;
  // P-PREVIEW.13: ADOPT the early shim's buffer rather than starting a fresh one, so preview_inspect's
  // { what: 'errors' } also reports failures thrown before this script existed. That is the common case
  // for a dead page: the throw happens in the page's own first script, long before the body closes.
  // (Never spell a closing body tag anywhere in this string: a page with no body tag gets the bridge APPENDED,
  // and injectPreviewZoom's lastIndexOf would then land inside this script and cut it in half.)
  var errs = window.__lucidErrs = window.__lucidErrs || [];
  function push(s){ try{ errs.push(String(s)); if(errs.length>60) errs.shift(); }catch(_){} }
  window.addEventListener('error', function(e){ push('error: ' + (e && e.message || e)); });
  window.addEventListener('unhandledrejection', function(e){ push('unhandledrejection: ' + (e && e.reason)); });
  ['error','warn'].forEach(function(k){ var o=console[k]; console[k]=function(){ push(k+': '+Array.prototype.slice.call(arguments).join(' ')); return o.apply(console,arguments); }; });
  function clip(s,n){ s=String(s==null?'':s).replace(/\\s+/g,' ').trim(); return s.length>n ? s.slice(0,n)+'…' : s; }
  function el2o(el){ var r=el.getBoundingClientRect(); return {
    tag: el.tagName.toLowerCase(), text: clip(el.textContent,300), id: el.id||undefined,
    cls: (el.className && el.className.toString().slice(0,120))||undefined,
    role: el.getAttribute&&el.getAttribute('role')||undefined,
    name: el.getAttribute&&(el.getAttribute('name')||el.getAttribute('aria-label')||el.getAttribute('placeholder'))||undefined,
    visible: !!(r.width && r.height), rect:{x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)} }; }
  // P-PREVIEW-CURTAIN.1 (ADR-0621): a PAINT look for the loading curtain. The host decides whether an auto
  // preview is worth showing BEFORE the user sees it, from a hidden probe frame, so it asks the page what
  // it actually painted: visible text, loaded media, boxes that differ from the page background, and a
  // nearest-neighbor readback grid of the largest canvases (the host classifies the pixels; the
  // thresholds arrive with the command). LUCID's own banners are excluded, so a dead page carrying only
  // "This preview stopped early" does not count as content. Read-only: the readback draws into a canvas
  // this function creates, never into the page's own.
  function paint(cmd){
    try{
      var de=document.documentElement, b=document.body;
      var vw=window.innerWidth||(de&&de.clientWidth)||0, vh=window.innerHeight||(de&&de.clientHeight)||0;
      var area=Math.max(1,vw*vh), minPx=Number(cmd.minBoxPx)||64, full=Number(cmd.fullFrac)||0.9;
      var edge=Math.max(8,Math.min(96,Number(cmd.sampleEdge)||48));
      var skip=[document.getElementById('lucid-script-error'),document.getElementById('lucid-blocked-refs')].filter(Boolean);
      function skipped(el){ for(var i=0;i<skip.length;i++){ if(skip[i]===el||skip[i].contains(el)) return true; } return false; }
      var text=b?String(b.innerText||''):'';
      for(var s=0;s<skip.length;s++){ var t=String(skip[s].innerText||''); if(t) text=text.split(t).join(''); }
      function rgba(c){ var m=/rgba?\\(([^)]+)\\)/.exec(String(c||'')); if(!m) return null;
        var p=m[1].split(/[\\s,\\/]+/).filter(Boolean).map(function(x){ return parseFloat(x); });
        return { r:p[0], g:p[1], b:p[2], a:p.length>3?p[3]:1 }; }
      function same(x,y){ return !!(x&&y&&Math.abs(x.r-y.r)<=12&&Math.abs(x.g-y.g)<=12&&Math.abs(x.b-y.b)<=12); }
      var bg={ r:255, g:255, b:255, a:1 };
      [de,b].forEach(function(e){ if(!e) return; var c=rgba(getComputedStyle(e).backgroundColor); if(c&&c.a>0.5) bg=c; });
      var els=b?b.getElementsByTagName('*'):[], n=Math.min(els.length,2500), boxes=0, media=0, canv=[];
      for(var i=0;i<n;i++){
        var el=els[i]; if(skipped(el)) continue;
        var tag=String(el.tagName||'').toLowerCase();
        if(tag==='script'||tag==='style'||tag==='noscript'||tag==='template') continue;
        var r=el.getBoundingClientRect(), a=r.width*r.height;
        if(a<minPx||r.right<=0||r.bottom<=0) continue;
        var cs=getComputedStyle(el);
        if(cs.visibility==='hidden'||cs.opacity==='0') continue;
        if(tag==='canvas'){ canv.push(el); continue; }
        if(tag==='img'){ if(el.complete&&el.naturalWidth>0) media++; continue; }
        if(tag==='svg'){ if(el.childElementCount>0) media++; continue; }
        if(tag==='video'||tag==='iframe'||tag==='embed'||tag==='object'){ media++; continue; }
        var fill=rgba(cs.backgroundColor), img=cs.backgroundImage&&cs.backgroundImage!=='none';
        if(a>=area*full&&!img){ if(fill&&fill.a>0.5) bg=fill; continue; } // a full-viewport fill restates the background
        var bc=rgba(cs.borderTopColor), border=parseFloat(cs.borderTopWidth)>0&&cs.borderTopStyle!=='none'&&bc&&bc.a>0.3&&!same(bc,bg);
        if((fill&&fill.a>0.5&&!same(fill,bg))||img||border||(cs.boxShadow&&cs.boxShadow!=='none')) boxes++;
      }
      canv.sort(function(x,y){ return (y.width*y.height)-(x.width*x.height); });
      var canvases=[], sc=document.createElement('canvas'), sx=null;
      sc.width=edge; sc.height=edge;
      try{ sx=sc.getContext('2d',{ willReadFrequently:true }); }catch(_){ sx=null; }
      for(var k=0;k<canv.length&&k<3;k++){
        var cv=canv[k], px=null;
        if(sx&&cv.width>0&&cv.height>0){
          try{ sx.clearRect(0,0,edge,edge); sx.imageSmoothingEnabled=false; sx.drawImage(cv,0,0,edge,edge); px=Array.prototype.slice.call(sx.getImageData(0,0,edge,edge).data); }catch(_){ px=null; }
        }
        canvases.push({ w:cv.width|0, h:cv.height|0, px:px });
      }
      var thumb='';
      if(canv.length&&canv[0].width>0&&canv[0].height>0){
        try{ var tc=document.createElement('canvas'); tc.width=Math.max(16,Math.min(240,Number(cmd.thumbW)||112)); tc.height=Math.max(10,Math.min(160,Number(cmd.thumbH)||70));
          var tx=tc.getContext('2d'); if(tx){ tx.drawImage(canv[0],0,0,tc.width,tc.height); thumb=tc.toDataURL('image/png'); } }catch(_){ thumb=''; }
      }
      var bad=0; for(var j=0;j<errs.length;j++){ if(errs[j].indexOf('error:')===0||errs[j].indexOf('unhandledrejection:')===0) bad++; }
      return { title: clip(document.title,80), textChars: text.replace(/\\s+/g,'').length, media:media, boxes:boxes, canvases:canvases,
        errors:bad, scriptError: !!document.getElementById('lucid-script-error'), blockedRefs: !!document.getElementById('lucid-blocked-refs'), thumb:thumb };
    }catch(e){ return { error: String(e&&e.message||e) }; }
  }
  function inspect(cmd){
    try{
      var what=(cmd&&cmd.what)||(cmd&&cmd.selector?'select':'summary'), sel=cmd&&cmd.selector;
      if(what==='errors') return { errors: errs.slice(-30) };
      if(what==='paint') return paint(cmd);
      if(what==='title') return { title: document.title, url: location.href };
      if(sel){
        var q; try{ q=document.querySelectorAll(sel); }catch(e){ return { error:'bad selector: '+String(e&&e.message||e) }; }
        var els=Array.prototype.slice.call(q,0,20);
        if(!els.length) return { count:0, note:'no element matches '+clip(sel,80) };
        return { count:q.length, matches: els.map(el2o) };
      }
      return { title: document.title, url: location.href,
        text: clip(document.body?document.body.innerText:'',1400),
        headings: Array.prototype.slice.call(document.querySelectorAll('h1,h2,h3'),0,20).map(function(h){return clip(h.textContent,120);}),
        controls: Array.prototype.slice.call(document.querySelectorAll('button,a,[role="button"],input,select,textarea'),0,40).map(function(b){return clip(b.textContent||b.getAttribute('aria-label')||b.getAttribute('placeholder')||b.getAttribute('value'),60);}).filter(Boolean),
        errors: errs.slice(-10) };
    }catch(e){ return { error: String(e&&e.message||e) }; }
  }
  function act(cmd){
    try{
      var sel=cmd&&cmd.selector, action=String(cmd&&cmd.action||'').toLowerCase();
      if(!sel) return { error:'a CSS selector is required for '+action };
      var el; try{ el=document.querySelector(sel); }catch(e){ return { error:'bad selector: '+String(e&&e.message||e) }; }
      if(!el) return { error:'no element matches '+clip(sel,80) };
      if(el.scrollIntoView) try{ el.scrollIntoView({block:'center'}); }catch(_){}
      if(action==='click'){ el.click(); return { ok:true, action:'click', on: el2o(el) }; }
      if(action==='focus'){ if(el.focus) el.focus(); return { ok:true, action:'focus', on: el2o(el) }; }
      if(action==='scroll'){ return { ok:true, action:'scroll', on: el2o(el) }; }
      if(action==='type'){
        var v = cmd.value==null ? '' : String(cmd.value);
        if(el.focus) el.focus();
        if('value' in el){ el.value=v; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); return { ok:true, action:'type', value:clip(v,80), on: el2o(el) }; }
        if(el.isContentEditable){ el.textContent=v; el.dispatchEvent(new Event('input',{bubbles:true})); return { ok:true, action:'type', value:clip(v,80), on: el2o(el) }; }
        return { error:'element is not a text input/textarea/contenteditable' };
      }
      return { error:'unknown action: '+action+' (allowed: click, type, focus, scroll)' };
    }catch(e){ return { error:String(e&&e.message||e) }; }
  }
  // CREATOR-3b (ADR-0287 item 3): deterministic FRAME CAPTURE. The parent hands a plan of TIMES; for each
  // one this asks the page to render that time and reads its canvas back. Two honesty rules live here:
  //
  //   * A scene exposing window.lucidRenderAt(tMs) is DRIVEN: the times are LUCID's, so the capture is
  //     reproducible and a regression compare means something. A page without it can only be SAMPLED on its
  //     own clock, and the answer says "sampled", so nobody reads a wall-clock animation as a deterministic
  //     capture.
  //   * NOTHING HERE EVALUATES A STRING. lucidRenderAt is a function the PREVIEWED DOCUMENT defined, called
  //     only behind a typeof check; this block adds no dynamic-code primitive and no markup-writing path of
  //     any kind, and the read is the plain canvas API. A scene that throws is reported, never swallowed.
  //     The demo asserts that absence by scanning this very string, which is why the forbidden spellings do
  //     not appear even inside a comment.
  //
  // WebGL note, stated rather than left to be discovered: the readback happens in the SAME synchronous task
  // as the render call, before compositing can clear the drawing buffer. A WebGL scene with no
  // lucidRenderAt and no preserveDrawingBuffer reads back blank, which the audit surfaces as a stuck
  // capture rather than as a pass. Backticks are avoided in this comment on purpose: the whole bridge is a
  // template literal, so one would end the string.
  var CAP_MAX_FRAMES=64, CAP_MAX_EDGE=2048;
  function capture(cmd){
    try{
      var sel=cmd&&cmd.selector, cv=null;
      if(sel){ try{ cv=document.querySelector(sel); }catch(e){ return { error:'bad selector: '+String(e&&e.message||e) }; } }
      else { var all=document.querySelectorAll('canvas');
        for(var i=0;i<all.length;i++){ var c=all[i]; if(!cv || (c.width*c.height)>(cv.width*cv.height)) cv=c; } }
      if(!cv || String(cv.tagName||'').toLowerCase()!=='canvas') return { error: sel ? 'no canvas matches '+clip(sel,80) : 'this page has no canvas to capture' };
      var w=cv.width|0, h=cv.height|0;
      if(!w||!h) return { error:'that canvas is '+w+'x'+h+', so there are no pixels to read' };
      if(w>CAP_MAX_EDGE||h>CAP_MAX_EDGE) return { error:'that canvas is '+w+'x'+h+', over the '+CAP_MAX_EDGE+'px capture limit' };
      var plan=(cmd&&cmd.plan)||[];
      if(!plan.length) return { error:'a capture needs a frame plan' };
      if(plan.length>CAP_MAX_FRAMES) return { error:plan.length+' frames is over the '+CAP_MAX_FRAMES+'-frame limit for one capture pass' };
      var driven = typeof window.lucidRenderAt==='function';
      var frames=[];
      for(var j=0;j<plan.length;j++){
        var p=plan[j]||{}, t=Number(p.tMs);
        if(!isFinite(t)) return { error:'frame '+j+' carries no usable time' };
        if(driven){ try{ window.lucidRenderAt(t); }catch(e){ return { error:'the scene threw while rendering '+t+'ms: '+String(e&&e.message||e) }; } }
        var url; try{ url=cv.toDataURL('image/png'); }catch(e){ return { error:'this canvas refuses readback (it may be tainted): '+String(e&&e.message||e) }; }
        frames.push({ index: isFinite(Number(p.index))?Number(p.index):j, tMs:t, dataUrl:url });
      }
      return { ok:true, driven:driven, width:w, height:h, frames:frames };
    }catch(e){ return { error:String(e&&e.message||e) }; }
  }
  window.addEventListener('message', function(ev){
    var d=ev.data;
    if(!d || d.__lucid!=='inspect' || ev.source!==window.parent) return;
    var cmd=d.cmd||{};
    // CAPTURE first, then the structured action allowlist, then the read. Written as one chain so the routing
    // contract pinned by preview_bridge.test.ts stays a literal substring of this line.
    var res = cmd.capture ? capture(cmd) : cmd.action ? act(cmd) : inspect(cmd); // STRUCTURED action (click/type/focus/scroll) vs read
    try{ window.parent.postMessage({ __lucid:'inspect-result', id:d.id, result:res }, '*'); }catch(_){}
  });
  // P-PREVIEW.7 (ADR-0179): proactive HEALTH report - a page whose script died (e.g. an Electron
  // renderer hitting "require is not defined") typically paints NOTHING, leaving a silent white
  // pane. Shortly after load, tell the parent what happened so it can explain instead of staying
  // mute. Read-only, fire-once, same postMessage channel; still zero egress under the frame CSP.
  function bodyEmpty(){
    try{
      var b=document.body; if(!b) return true;
      if(b.querySelector('canvas,img,svg,video,iframe,embed,object')) return false;
      return (b.innerText||'').replace(/\\s+/g,'')==='';
    }catch(_){ return false; }
  }
  var healthSent=false;
  function health(){
    if(healthSent) return; healthSent=true;
    try{ window.parent.postMessage({ __lucid:'preview-health', emptyBody: bodyEmpty(), errors: errs.slice(-6) }, '*'); }catch(_){}
  }
  if(document.readyState==='complete') setTimeout(health,600);
  else window.addEventListener('load', function(){ setTimeout(health,600); });
  setTimeout(health,2500); // belt-and-braces: report even if the load event never fires
})();`;

/** Preview-only wheel relay. No DOM access in the parent and no sandbox grant required. */
export const PREVIEW_ZOOM_JS = `(function(){
  if(window.__lucidPreviewZoom) return; window.__lucidPreviewZoom=1;
  var wheelZoom=false;
  window.addEventListener('message',function(ev){
    var d=ev.data;
    if(ev.source!==window.parent || !d || d.__lucid!=='preview-zoom-mode' || typeof d.enabled!=='boolean') return;
    wheelZoom=d.enabled;
  });
  window.addEventListener('wheel',function(ev){
    if(!(wheelZoom || ev.ctrlKey || ev.metaKey) || !Number.isFinite(ev.deltaY) || !ev.deltaY) return;
    ev.preventDefault();
    ev.stopPropagation();
    window.parent.postMessage({__lucid:'preview-zoom-wheel',deltaY:Math.max(-1000,Math.min(1000,ev.deltaY)),deltaMode:ev.deltaMode},'*');
  },{passive:false,capture:true});
  window.parent.postMessage({__lucid:'preview-zoom-ready'},'*');
})();`;

/** Preserve SVG's XML MIME and document while adding the same bounded wheel channel as HTML. */
export function injectPreviewZoom(document: string, svg = false): string {
  const tag = svg ? `<script xmlns="http://www.w3.org/2000/svg"><![CDATA[${PREVIEW_ZOOM_JS}]]></script>` : `<script>${PREVIEW_ZOOM_JS}</script>`;
  const close = document.toLowerCase().lastIndexOf(svg ? "</svg>" : "</body>");
  return close >= 0 ? document.slice(0, close) + tag + document.slice(close) : document + tag;
}

/** Inject the bridge before `</body>` (or append if there's no body tag). Idempotent-safe (the script guards
 *  on `window.__lucidInspect`). Pure — used by the `/api/preview/serve` route. */
export function injectPreviewBridge(html: string): string {
  const tag = `<script>${PREVIEW_BRIDGE_JS}</script>`;
  const i = html.toLowerCase().lastIndexOf("</body>");
  return i >= 0 ? html.slice(0, i) + tag + html.slice(i) : html + tag;
}
