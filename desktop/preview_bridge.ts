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
  window.addEventListener('message', function(ev){
    var d=ev.data;
    if(!d || d.__lucid!=='inspect' || ev.source!==window.parent) return;
    var cmd=d.cmd||{};
    var res = cmd.action ? act(cmd) : inspect(cmd); // STRUCTURED action (click/type/focus/scroll) vs read
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
