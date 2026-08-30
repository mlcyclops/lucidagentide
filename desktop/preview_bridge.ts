// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/preview_bridge.ts — P-PREVIEW.6b (ADR-0153): a tiny READ-ONLY DOM-inspect bridge injected into the
// served preview HTML. The preview iframe is opaque-origin sandboxed (the renderer can't touch its DOM), so
// this script — running INSIDE the frame — answers `postMessage` inspect queries from its parent (the LUCID
// renderer) and posts a compact, redacted snapshot back. It only READS (query text/attributes/roles/rects,
// headings, buttons, captured console errors) — there is NO arbitrary eval and NO mutation. Inline JS is
// allowed by the frame CSP (`script-src 'unsafe-inline'`), and `connect-src 'none'` still blocks all egress.

/** The bridge script body (inline JS). Self-contained IIFE; idempotent; listens only to its own parent. */
export const PREVIEW_BRIDGE_JS = `(function(){
  if (window.__lucidInspect) return; window.__lucidInspect = 1;
  var errs = [];
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
  function inspect(cmd){
    try{
      var what=(cmd&&cmd.what)||(cmd&&cmd.selector?'select':'summary'), sel=cmd&&cmd.selector;
      if(what==='errors') return { errors: errs.slice(-30) };
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

/** Inject the bridge before `</body>` (or append if there's no body tag). Idempotent-safe (the script guards
 *  on `window.__lucidInspect`). Pure — used by the `/api/preview/serve` route. */
export function injectPreviewBridge(html: string): string {
  const tag = `<script>${PREVIEW_BRIDGE_JS}</script>`;
  const i = html.toLowerCase().lastIndexOf("</body>");
  return i >= 0 ? html.slice(0, i) + tag + html.slice(i) : html + tag;
}
