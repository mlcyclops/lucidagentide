// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/viz_sample_games.ts - P-WORLDS.BUILD2 (ADR-0653), P-WORLDS.GAMES3 (ADR-0691): the host's three
// built-in sample games, the `sample` of viz_build_model.DEFAULT_MINI_GAMES. Each is ONE self-contained HTML document
// (inline CSS and JS, no network, no external assets, no storage, plain ASCII) under SAMPLE_MAX_BYTES, drawn on a
// canvas that fills its frame at any size (device pixel ratio aware, checked every frame), smooth at 60 fps
// (requestAnimationFrame, delta time capped). They share one kit (KIT_CSS, KIT_JS): a start screen with a how-to, an
// end screen with stats and the session best (in memory only), pause (P, Esc, the Pause button, or the frame losing
// focus), WebAudio blips created on the first input with an M / Sound toggle, R / Restart, particles, floating text,
// banners and a shake that reduced motion turns off. They pass the same security gate and sandbox as agent-built
// games. For the real-UI demos each sets body[data-ready] once its script ran, body[data-state] (ready, play,
// paused, clear, over) and body[data-score], and window.__sampleProbe() answers { state, score, points } where
// points are CSS-pixel spots worth clicking (live targets, face-down cards, the runner's lanes). The strings hold no
// backtick, no "${" and no backslash, so they are the bytes the frame gets.

interface SampleSpec { title: string; bg: string; accent: string; ink: string; css?: string; buttons?: string; js: string }

/** One whole sample document: the kit (stylesheet in the game's colors, the bar, the overlay, KIT_JS) around a
 *  game's script. */
function sampleDoc({ title, bg, accent, ink, css = "", buttons = "", js }: SampleSpec): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} (sample)</title><style>
html,body{margin:0;height:100%;overflow:hidden;background:${bg};color:#f1f5ff;font:15px system-ui,sans-serif;user-select:none;-webkit-user-select:none}
canvas{display:block;width:100%;height:100%;touch-action:none;outline:none;cursor:pointer}
.ov{position:absolute;inset:0;display:grid;place-items:center;text-align:center;background:rgba(5,8,20,.8)}
.ov[hidden]{display:none}
.card{padding:10px 18px;max-width:94%;max-height:96%;overflow:auto;box-sizing:border-box}
h1{margin:0 0 6px;font-size:clamp(20px,6vmin,40px);color:${accent};letter-spacing:.02em}
#msg{margin:0 0 12px;color:#dfe6f7;font-size:clamp(12px,2.7vmin,16px);line-height:1.4}
#msg p{margin:0 0 6px}
#msg ul{display:inline-block;margin:0 0 6px;padding:0 0 0 18px;text-align:left}
#msg b{color:${accent}}
.st{display:inline-grid;grid-template-columns:auto auto;gap:2px 18px;margin:4px 0 6px;text-align:left}
.st span:nth-child(2n){text-align:right;font-weight:700;color:#ffffff}
button{font:inherit;font-weight:700;border:0;border-radius:10px;cursor:pointer}
#start{padding:9px 26px;background:${accent};color:${ink};font-size:clamp(14px,3vmin,19px);box-shadow:0 6px 20px rgba(0,0,0,.35)}
.bar{position:absolute;right:8px;bottom:8px;display:flex;gap:6px}
.bar button{padding:5px 10px;background:#1a2547;color:#f1f5ff;border:1px solid #4a5f99;font-size:12px;white-space:nowrap}
.bar button:disabled{opacity:.45;cursor:default}
button:focus-visible{outline:3px solid #8fe3ff;outline-offset:2px}${css}
</style></head><body>
<canvas id="c" tabindex="0" aria-label="${title} game"></canvas>
<div class="bar">${buttons}<button id="pause" type="button" aria-label="Pause (P)">Pause</button><button id="mute" type="button" aria-pressed="false" aria-label="Mute (M)">Sound on</button><button id="restart" type="button" aria-label="Restart (R)">Restart</button></div>
<div class="ov" id="ov"><div class="card"><h1 id="hd">${title}</h1><div id="msg"></div><button id="start" type="button">Play</button></div></div>
<script>
(function(){
${KIT_JS}
${js}
size();set("ready");setScore(0);intro();requestAnimationFrame(frame);
B.setAttribute("data-ready","1");
})();
</script></body></html>`;
}

/** The shared runtime. A game defines layout, intro, start, step, draw, hud, key, keyup, tap, untap and points. */
const KIT_JS = `"use strict";
var d=document,B=d.body,c=d.getElementById("c"),x=c.getContext("2d"),ov=d.getElementById("ov"),hd=d.getElementById("hd"),msg=d.getElementById("msg"),st=d.getElementById("start"),pb=d.getElementById("pause"),mb=d.getElementById("mute");
var calm=!!(window.matchMedia&&matchMedia("(prefers-reduced-motion: reduce)").matches);
var W=1,H=1,R=1,S=1,state="",last=0,ps=[],fx=[],bn=null,shake=0,flash=0,flashC="255,209,102",AC=null,muted=false,act=null,best=0;
function size(){R=Math.min(2,window.devicePixelRatio||1);W=Math.max(1,c.clientWidth);H=Math.max(1,c.clientHeight);c.width=Math.round(W*R);c.height=Math.round(H*R);S=Math.max(.55,Math.min(W/1.6,H)/400);layout();}
function set(s){state=s;B.setAttribute("data-state",s);pb.textContent=s==="paused"?"Resume":"Pause";pb.disabled=s!=="play"&&s!=="paused";}
function setScore(n){B.setAttribute("data-score",String(n));}
function sound(){var A,p;if(AC){if(AC.state==="suspended"){p=AC.resume();if(p&&p.catch)p.catch(function(){});}return;}A=window.AudioContext||window.webkitAudioContext;if(!A)return;try{AC=new A();}catch(e){AC=null;}}
function tone(f,dur,type,vol,to,dl){if(!AC||muted)return;try{var t=AC.currentTime+(dl||0),o=AC.createOscillator(),g=AC.createGain();o.type=type||"sine";o.frequency.setValueAtTime(f,t);if(to)o.frequency.exponentialRampToValueAtTime(to,t+dur);g.gain.setValueAtTime(.0001,t);g.gain.exponentialRampToValueAtTime(vol||.08,t+.012);g.gain.exponentialRampToValueAtTime(.0001,t+dur);o.connect(g);g.connect(AC.destination);o.start(t);o.stop(t+dur+.05);}catch(e){}}
function arp(n,step,type,vol){for(var i=0;i<n.length;i++)tone(n[i],step*1.8,type,vol,0,i*step);}
function mute(){muted=!muted;mb.textContent=muted?"Sound off":"Sound on";mb.setAttribute("aria-pressed",muted?"true":"false");if(!muted)tone(660,.08,"square",.05);}
function spark(px,py,col,k){if(ps.length>420)ps.splice(0,60);var a=Math.random()*6.283,v=(70+Math.random()*250)*S*(k||1);ps.push({x:px,y:py,vx:Math.cos(a)*v,vy:Math.sin(a)*v-60*S,t:0,l:.4+Math.random()*.45,c:col,r:(1.6+Math.random()*2.6)*S,g:520});}
function burst(px,py,n,cols,k){if(calm)n=Math.ceil(n/3);for(var i=0;i<n;i++)spark(px,py,cols[i%cols.length],k);}
function rain(n,cols){if(calm)n=Math.ceil(n/3);for(var i=0;i<n;i++)ps.push({x:Math.random()*W,y:-10-Math.random()*H*.4,vx:(Math.random()-.5)*60*S,vy:(50+Math.random()*120)*S,t:0,l:2+Math.random()*1.2,c:cols[i%cols.length],r:(2+Math.random()*2.6)*S,g:90});}
function say(px,py,s,col,k){if(fx.length>24)fx.shift();fx.push({x:px,y:py,t:0,s:s,c:col||"#ffffff",k:k||1});}
function banner(s,u,col){bn={s:s,u:u||"",c:col||"#ffd166",t:0};}
function jolt(n,col){if(!calm)shake=Math.max(shake,n);if(col){flash=.5;flashC=col;}}
function stepFx(dt){var i,p;for(i=ps.length-1;i>=0;i--){p=ps[i];p.t+=dt;p.x+=p.vx*dt;p.y+=p.vy*dt;p.vy+=p.g*S*dt;p.vx*=.985;if(p.t>=p.l)ps.splice(i,1);}for(i=fx.length-1;i>=0;i--){fx[i].t+=dt;if(fx[i].t>.9)fx.splice(i,1);}if(bn){bn.t+=dt;if(bn.t>2.2)bn=null;}shake=Math.max(0,shake-dt*40);flash=Math.max(0,flash-dt*1.6);}
function disc(cx,cy,r,col){x.fillStyle=col;x.beginPath();x.arc(cx,cy,Math.max(0,r),0,6.283);x.fill();}
function rr(x0,y0,w,h,r){r=Math.max(0,Math.min(r,w/2,h/2));x.beginPath();x.moveTo(x0+r,y0);x.arcTo(x0+w,y0,x0+w,y0+h,r);x.arcTo(x0+w,y0+h,x0,y0+h,r);x.arcTo(x0,y0+h,x0,y0,r);x.arcTo(x0,y0,x0+w,y0,r);x.closePath();}
function fsz(k){return Math.max(11,Math.round(16*S*(k||1)));}
function font(w,k){x.font=w+" "+fsz(k)+"px system-ui,sans-serif";}
function hb(){return Math.round(fsz()*2.3);}
function txt(s,px,py,col,al){x.textAlign=al||"center";x.textBaseline="middle";x.fillStyle="rgba(5,8,20,.85)";x.fillText(s,px+1,py+2);x.fillStyle=col;x.fillText(s,px,py);}
function band(l,c1,c2,r,cc,rc){var h=hb(),side,cs;x.fillStyle="rgba(5,8,20,.8)";x.fillRect(0,0,W,h);font("700");side=Math.max(x.measureText(l).width,x.measureText(r).width)+28;cs=x.measureText(c1).width<=W-2*side?c1:c2;txt(l,12,h/2,"#f1f5ff","left");txt(r,W-12,h/2,rc||"#f1f5ff","right");if(x.measureText(cs).width<=W-2*side)txt(cs,W/2,h/2,cc||"#ffd166");return h;}
function tag(){if(W<440)return;font("700",.7);txt("SAMPLE",12,H-14,"#ffb86b","left");}
function drawFx(){var i,p,f;for(i=0;i<ps.length;i++){p=ps[i];x.globalAlpha=Math.max(0,1-p.t/p.l);disc(p.x,p.y,p.r,p.c);}x.globalAlpha=1;for(i=0;i<fx.length;i++){f=fx[i];x.globalAlpha=Math.max(0,1-f.t/.9);font("800",1.15*f.k);txt(f.s,f.x,f.y-f.t*70*S,f.c);}x.globalAlpha=1;}
function drawTop(){var a,yy;if(flash>0){x.fillStyle="rgba("+flashC+","+(flash*.3).toFixed(3)+")";x.fillRect(0,0,W,H);}if(bn){a=bn.t<.25?bn.t/.25:bn.t>1.8?Math.max(0,(2.2-bn.t)/.4):1;yy=H*.42;x.globalAlpha=a;x.fillStyle="rgba(5,8,20,.62)";x.fillRect(0,yy-fsz(1.9),W,fsz(bn.u?3.7:2.6));font("900",2);txt(bn.s,W/2,yy-fsz(bn.u?.45:.6),bn.c);if(bn.u){font("700");txt(bn.u,W/2,yy+fsz(1),"#dfe6f7");}x.globalAlpha=1;}}
function show(t,h,b,fn){hd.textContent=t;msg.innerHTML=h;st.textContent=b;act=fn;ov.hidden=false;if(d.hasFocus())st.focus();}
function hide(){ov.hidden=true;act=null;if(d.hasFocus())c.focus();}
function pause(){if(state==="play"){set("paused");tone(330,.12,"triangle",.06);show("Paused","<p>Press <b>P</b> or <b>Esc</b> to resume. <b>M</b> toggles sound, <b>R</b> restarts.</p>","Resume",resume);}else if(state==="paused")resume();}
function resume(){hide();set("play");tone(520,.1,"triangle",.06);}
function stats(rows){var h="<div class=st>",i;for(i=0;i<rows.length;i++)h+="<span>"+rows[i][0]+"</span><span>"+rows[i][1]+"</span>";return h+"</div>";}
function frame(now){var dt=last?Math.min(.05,(now-last)/1000):0,g;last=now;if(Math.max(1,c.clientWidth)!==W||Math.max(1,c.clientHeight)!==H)size();g=state==="paused"?0:dt;step(g);stepFx(g);x.setTransform(R,0,0,R,0,0);x.save();if(shake>0&&!calm&&g>0)x.translate((Math.random()-.5)*shake*S,(Math.random()-.5)*shake*S);draw();drawFx();x.restore();drawTop();hud();requestAnimationFrame(frame);}
c.addEventListener("pointerdown",function(e){var b=c.getBoundingClientRect();sound();if(d.activeElement!==c)c.focus();try{c.setPointerCapture(e.pointerId);}catch(er){}tap(e.clientX-b.left,e.clientY-b.top);});
c.addEventListener("pointerup",function(e){var b=c.getBoundingClientRect();untap(e.clientX-b.left,e.clientY-b.top);});
st.addEventListener("click",function(){sound();if(act)act();});
pb.addEventListener("click",function(){sound();pause();});
mb.addEventListener("click",function(){sound();mute();});
d.getElementById("restart").addEventListener("click",function(){sound();start();});
d.addEventListener("keydown",function(e){var k=e.key;sound();
if(k==="r"||k==="R"){e.preventDefault();start();return;}
if(k==="m"||k==="M"){e.preventDefault();mute();return;}
if(k==="p"||k==="P"||k==="Escape"){e.preventDefault();pause();return;}
if(state!=="play"){if((k===" "||k==="Enter")&&!(e.target&&e.target.tagName==="BUTTON")){e.preventDefault();if(act)act();}return;}
if(key(k))e.preventDefault();});
d.addEventListener("keyup",function(e){keyup(e.key);});
window.addEventListener("blur",function(){keyup("");if(state==="play")pause();});
window.addEventListener("resize",size);
window.__sampleProbe=function(){return{state:state,score:Number(B.getAttribute("data-score")||0),points:points()};};`;

const TARGET_TAP_JS = `var ROUND=30,ts=[],keys={},aim={x:.5,y:.55,on:false},pts=0,left=ROUND,lvl=1,need=10,got=0,combo=0,maxc=0,meter=0,hits=0,shots=0,next=0,idle=0,frz=0,tick=0;
var TY={n:{c:"#ff4d6d",p:10,r:30},m:{c:"#3ad7ff",p:15,r:28},s:{c:"#b07cff",p:20,r:36},a:{c:"#c7d2e8",p:30,r:34},d:{c:"#2a2f45",p:0,r:30},g:{c:"#ffd166",p:50,r:22},f:{c:"#9ff3ff",p:0,r:25}};
var NEWS=["","","Movers and decoys","Shrinkers and the freeze","Armored targets: two hits"],MC=["","#7ee081","#ffd166","#ff9f5a","#ff6b8b","#ff4dd2"];
function layout(){}
function needFor(l){return 6+l*4;}
function mult(){return Math.min(5,1+Math.floor(combo/5));}
function intro(){show("Target tap","<p>Hit targets before they fade. Reach each level's goal to level up (+5 s); when the clock runs out the round ends.</p><ul><li><b>Red</b> 10, <b>blue</b> movers 15, <b>purple</b> shrinkers 20</li><li><b>Steel</b> armored targets take two hits for 30</li><li><b>Gold</b> 50 and +2 s; <b>ice</b> freezes the clock for 4 s</li><li><b>Dark X</b> decoys cost 3 s: let them fade</li><li>Keep the combo meter up for up to x5</li></ul><p>Click or tap, or aim with the arrow keys and press Space. P pauses, M sound, R restarts.</p>","Play",start);}
function start(){ts.length=0;fx.length=0;pts=0;left=ROUND;lvl=1;need=needFor(1);got=0;combo=0;maxc=0;meter=0;hits=0;shots=0;next=.3;frz=0;setScore(0);hide();set("play");banner("Level 1","Hit "+need+" targets","#ffd166");arp([440,660],.08,"square",.05);}
function has(k){for(var i=0;i<ts.length;i++)if(ts[i].k===k)return true;return false;}
function kind(){var r=Math.random(),w=[["n",4]],s=0,i;if(r<.07)return"g";if(lvl>=3&&r<.12&&frz<=0&&!has("f"))return"f";
if(lvl>=2){w.push(["m",2+lvl*.4]);w.push(["d",1.2+lvl*.25]);}if(lvl>=3)w.push(["s",1.5+lvl*.3]);if(lvl>=4)w.push(["a",1.2+lvl*.3]);
for(i=0;i<w.length;i++)s+=w[i][1];r=Math.random()*s;for(i=0;i<w.length;i++){r-=w[i][1];if(r<=0)return w[i][0];}return"n";}
function spawn(k){var tries=0,px=.5,py=.5,ok=false,i,dx,dy,a=Math.random()*6.283,sp=(.1+Math.random()*.12)*(1+lvl*.12),mn=70*S;
while(!ok&&tries++<10){px=.07+Math.random()*.86;py=.24+Math.random()*.6;ok=true;for(i=0;i<ts.length;i++){dx=(ts[i].x-px)*W;dy=(ts[i].y-py)*H;if(dx*dx+dy*dy<mn*mn){ok=false;break;}}}
ts.push({k:k,x:px,y:py,t:0,life:k==="d"?2.6:k==="g"?1.5:k==="f"?2.2:Math.max(.95,2.2-lvl*.14)*(k==="a"?1.5:1),hp:k==="a"?2:1,vx:k==="m"?Math.cos(a)*sp:0,vy:k==="m"?Math.sin(a)*sp:0,hit:0,sp:Math.random()*6.283});}
function grow(t){var k=t.t/t.life;return k<.12?1-Math.pow(1-k/.12,3):k>.82?Math.max(0,(1-k)/.18):1;}
function rad(t){var r=TY[t.k].r*S*grow(t);if(t.k==="s")r*=1-.6*Math.min(1,t.t/t.life);return r;}
function hit(px,py){if(state!=="play")return;shots++;var i,t,r,dx,dy,cx,cy,m,p;
for(i=ts.length-1;i>=0;i--){t=ts[i];r=rad(t)+6*S;dx=px-t.x*W;dy=py-t.y*H;if(r<8*S||dx*dx+dy*dy>r*r)continue;cx=t.x*W;cy=t.y*H;
if(t.k==="d"){ts.splice(i,1);left=Math.max(0,left-3);combo=0;meter=0;jolt(12,"255,60,90");say(cx,cy,"-3 s","#ff6b8b",1.3);burst(cx,cy,24,["#ff4d6d","#5b6785","#ffffff"]);tone(160,.25,"sawtooth",.07,70);return;}
hits++;combo++;maxc=Math.max(maxc,combo);meter=Math.min(1,meter+.34);
if(combo%10===0){left+=1;say(W/2,hb()+34*S,"Combo "+combo+"  +1 s","#7ee081",1.1);tone(1046,.12,"square",.04,0,.08);}
if(t.k==="a"&&t.hp>1){t.hp=1;t.hit=1;burst(cx,cy,14,["#c7d2e8","#ffffff","#8fa3c8"],.8);say(cx,cy-r,"crack","#c7d2e8");tone(900,.06,"square",.05);jolt(3);return;}
ts.splice(i,1);got++;
if(t.k==="f"){frz=4;jolt(4,"120,220,255");say(cx,cy,"Freeze!","#9ff3ff",1.3);burst(cx,cy,34,["#9ff3ff","#ffffff","#3ad7ff"]);tone(1400,.4,"sine",.07,500);}
else{m=mult();p=TY[t.k].p*m;pts+=p;setScore(pts);say(cx,cy,"+"+p+(m>1?"  x"+m:""),t.k==="g"?"#ffd166":"#ffffff",t.k==="g"?1.4:1);burst(cx,cy,t.k==="g"?44:22,[TY[t.k].c,"#ffffff",TY[t.k].c]);
if(t.k==="g"){left+=2;say(cx,cy+30*S,"+2 s","#7ee081");jolt(9,"255,209,102");arp([880,1175,1568],.06,"triangle",.06);}else{jolt(4);tone(520+Math.min(combo,20)*30,.08,"triangle",.07);}}
if(got>=need)levelUp();return;}
meter=Math.max(0,meter-.3);if(meter<=0)combo=0;jolt(3);say(px,py,"miss","#ff9db0",.9);tone(220,.08,"triangle",.05,160);}
function levelUp(){lvl++;got=0;need=needFor(lvl);left+=5;banner("Level "+lvl,(NEWS[lvl]||"Faster and busier")+"  +5 s","#ffd166");arp([523,659,784,1046],.08,"square",.05);burst(W/2,H*.45,50,["#ffd166","#7ee0ff","#ff4d6d","#b07cff"],1.3);}
function over(){var nb=pts>best&&pts>0,acc=shots?Math.round(100*hits/shots):0;set("over");best=Math.max(best,pts);ts.length=0;frz=0;arp([523,392,330,262],.12,"triangle",.07);rain(80,["#ffd166","#7ee0ff","#ff4d6d","#b07cff"]);
show(nb?"New best!":"Time!",stats([["Score",pts],["Level reached",lvl],["Accuracy",acc+"%"],["Best combo",maxc],["Targets hit",hits],["Session best",best]]),"Play again",start);}
function step(dt){var i,t,kx=(keys.ArrowRight?1:0)-(keys.ArrowLeft?1:0),ky=(keys.ArrowDown?1:0)-(keys.ArrowUp?1:0),fz=state==="play"&&frz>0;tick+=dt;
if(kx||ky){aim.on=true;aim.x=Math.min(.98,Math.max(.02,aim.x+kx*dt*.8));aim.y=Math.min(.97,Math.max(.14,aim.y+ky*dt*.8));}
if(state==="play"){if(frz>0)frz=Math.max(0,frz-dt);else{left-=dt;meter=Math.max(0,meter-dt*(.3+lvl*.03));if(meter<=0&&combo>0){if(combo>=5)say(W/2,hb()+34*S,"combo lost","#ff9db0");combo=0;}}
next-=dt;if(next<=0){if(ts.length<3+lvl)spawn(kind());next=Math.max(.3,.85-lvl*.07)*(.7+Math.random()*.6);}}
else if(state==="ready"||state==="over"){idle-=dt;if(idle<=0&&ts.length<4){spawn("n");idle=.9;}}
for(i=ts.length-1;i>=0;i--){t=ts[i];t.hit=Math.max(0,t.hit-dt*3);if(fz)continue;t.t+=dt;
if(t.vx||t.vy){t.x+=t.vx*dt;t.y+=t.vy*dt;if(t.x<.05||t.x>.95){t.vx=-t.vx;t.x=Math.min(.95,Math.max(.05,t.x));}if(t.y<.22||t.y>.86){t.vy=-t.vy;t.y=Math.min(.86,Math.max(.22,t.y));}}
if(t.t>=t.life){ts.splice(i,1);if(state==="play"&&t.k!=="d"&&t.k!=="f"){meter=Math.max(0,meter-.2);say(t.x*W,t.y*H,"missed","#8fa3c8",.8);}}}
if(state==="play"&&left<=0){left=0;over();}}
function ring(cx,cy,r,a,b,glow){if(glow){x.shadowColor=a;x.shadowBlur=glow;}disc(cx,cy,r,a);x.shadowBlur=0;disc(cx,cy,r*.74,"#ffffff");disc(cx,cy,r*.5,b);disc(cx,cy,r*.24,"#ffffff");}
function drawT(t){var r=rad(t),cx=t.x*W,cy=t.y*H,k=t.k,col=TY[k].c,A=state==="play"||state==="paused"?1:.45,i,a,ex,ey,q;if(r<1)return;x.globalAlpha=A;
if(k==="m"){x.globalAlpha=A*.22;disc(cx-t.vx*W*.12,cy-t.vy*H*.12,r*.9,col);disc(cx-t.vx*W*.24,cy-t.vy*H*.24,r*.75,col);x.globalAlpha=A;}
if(k==="d"){disc(cx,cy,r,"#1a1e30");x.strokeStyle="#ff4d6d";x.lineWidth=Math.max(2,r*.16);x.lineCap="round";x.beginPath();x.moveTo(cx-r*.42,cy-r*.42);x.lineTo(cx+r*.42,cy+r*.42);x.moveTo(cx+r*.42,cy-r*.42);x.lineTo(cx-r*.42,cy+r*.42);x.stroke();x.strokeStyle="rgba(255,77,109,.55)";x.lineWidth=2;x.beginPath();x.arc(cx,cy,r,0,6.283);x.stroke();}
else if(k==="f"){x.shadowColor=col;x.shadowBlur=16*S;disc(cx,cy,r,"#123a52");x.shadowBlur=0;x.strokeStyle=col;x.lineWidth=Math.max(1.5,r*.1);x.lineCap="round";x.beginPath();for(i=0;i<6;i++){a=i*1.0472+t.sp+tick*.8;ex=Math.cos(a);ey=Math.sin(a);x.moveTo(cx,cy);x.lineTo(cx+ex*r*.8,cy+ey*r*.8);x.moveTo(cx+ex*r*.45+ey*r*.2,cy+ey*r*.45-ex*r*.2);x.lineTo(cx+ex*r*.6,cy+ey*r*.6);x.lineTo(cx+ex*r*.45-ey*r*.2,cy+ey*r*.45+ex*r*.2);}x.stroke();}
else if(k==="a"){x.shadowColor="#8fa3c8";x.shadowBlur=12*S;disc(cx,cy,r,"#5b6785");x.shadowBlur=0;disc(cx,cy,r*.84,"#c7d2e8");for(i=0;i<6;i++){a=i*1.0472+.5;disc(cx+Math.cos(a)*r*.92,cy+Math.sin(a)*r*.92,r*.07,"#2a3350");}
ring(cx,cy,r*.62,t.hp>1?"#8fa3c8":"#ff4d6d",t.hp>1?"#5b6785":"#ff4d6d",0);
if(t.hp<2){x.strokeStyle="#1a1e30";x.lineWidth=Math.max(1.5,r*.06);x.beginPath();x.moveTo(cx-r*.8,cy-r*.3);x.lineTo(cx-r*.45,cy-r*.05);x.lineTo(cx-r*.6,cy+r*.45);x.moveTo(cx+r*.7,cy-r*.55);x.lineTo(cx+r*.45,cy-r*.15);x.lineTo(cx+r*.75,cy+r*.2);x.stroke();}}
else{ring(cx,cy,r,col,k==="g"?"#ffad0a":col,16*S);
if(k==="g"){x.save();x.translate(cx,cy);x.rotate(tick*2);x.fillStyle="#ffffff";x.beginPath();for(i=0;i<8;i++){a=i*.7854;q=i%2?r*.12:r*.36;x.lineTo(Math.cos(a)*q,Math.sin(a)*q);}x.closePath();x.fill();x.restore();}
if(k==="s"){x.setLineDash([4*S,4*S]);x.strokeStyle=col;x.lineWidth=2;x.beginPath();x.arc(cx,cy,TY.s.r*S*grow(t)+4*S,0,6.283);x.stroke();x.setLineDash([]);}}
if(t.hit>0){x.globalAlpha=A*t.hit*.7;disc(cx,cy,r*1.08,"#ffffff");x.globalAlpha=A;}
if(k!=="d"){x.strokeStyle="rgba(255,255,255,.85)";x.lineWidth=3*S;x.beginPath();x.arc(cx,cy,r+6*S,-1.5708,-1.5708+6.283*Math.max(0,1-t.t/t.life));x.stroke();}
x.globalAlpha=1;}
function draw(){var g=x.createRadialGradient(W/2,H*.45,0,W/2,H*.45,Math.max(W,H)*.8),sp=34*S,o=(tick*8*S)%sp,gx,gy,i,ax,ay,ar;g.addColorStop(0,["#1d2c58","#1d2c58","#1f3158","#2a2458","#2a1d58"][Math.min(4,lvl)]);g.addColorStop(1,"#070b18");x.fillStyle=g;x.fillRect(-20,-20,W+40,H+40);
x.fillStyle="rgba(150,180,255,.12)";for(gx=sp/2;gx<W;gx+=sp)for(gy=o;gy<H;gy+=sp)x.fillRect(gx-1,gy-1,2,2);
for(i=0;i<ts.length;i++)drawT(ts[i]);
if(aim.on&&state==="play"){ax=aim.x*W;ay=aim.y*H;ar=14*S;x.strokeStyle="#8fe3ff";x.lineWidth=2.5;x.beginPath();x.arc(ax,ay,ar,0,6.283);x.moveTo(ax-ar*1.6,ay);x.lineTo(ax-ar*.5,ay);x.moveTo(ax+ar*.5,ay);x.lineTo(ax+ar*1.6,ay);x.moveTo(ax,ay-ar*1.6);x.lineTo(ax,ay-ar*.5);x.moveTo(ax,ay+ar*.5);x.lineTo(ax,ay+ar*1.6);x.stroke();}}
function hud(){var tl=Math.max(0,left),warn=tl<6&&state==="play",h=band("Score "+pts,"Level "+lvl+"  "+got+"/"+need,"L"+lvl+" "+got+"/"+need,(frz>0?"Frozen ":"")+tl.toFixed(1)+" s","#ffd166",frz>0?"#9ff3ff":warn?"#ff5d7a":"#f1f5ff"),bw=Math.max(3,Math.round(4*S)),m=mult();
if(frz>0){x.fillStyle="rgba(120,220,255,.1)";x.fillRect(0,h,W,H-h);x.strokeStyle="rgba(159,243,255,.7)";x.lineWidth=4*S;x.strokeRect(2,h+2,W-4,H-h-4);}
x.fillStyle=frz>0?"#9ff3ff":warn?"#ff5d7a":"#7ee0ff";x.fillRect(0,h,W*Math.min(1,tl/ROUND),bw);
x.fillStyle="rgba(255,255,255,.08)";x.fillRect(0,h+bw,W,bw);x.fillStyle=MC[m];x.fillRect(0,h+bw,W*meter,bw);
if(combo>1){font("800",.9);txt("Combo "+combo+"  x"+m,W/2,h+bw*2+fsz(.9),MC[m]);}
tag();}
function key(k){if(k.indexOf("Arrow")===0){keys[k]=1;return true;}if(k===" "||k==="Enter"){aim.on=true;hit(aim.x*W,aim.y*H);return true;}return false;}
function keyup(k){if(!k)keys={};else delete keys[k];}
function tap(px,py){aim.on=false;hit(px,py);}
function untap(){}
function points(){var o=[],i,t;for(i=0;i<ts.length;i++){t=ts[i];if(t.k!=="d"&&t.t<t.life*.75&&rad(t)>8*S)o.push([Math.round(t.x*W),Math.round(t.y*H)]);}return o;}`;

const MEMORY_CARDS_JS = `var COL=["#ff6b8b","#6cc4ff","#7ee081","#ffd166","#c39bff","#ff9f5a","#5ef2d6","#f1f5ff"],MUL=["","#7ee081","#ffd166","#ff9f5a","#ff6b8b","#ff4dd2"];
var LV=[{c:4,r:3,peek:1,shuf:false,name:"Shapes",back:["#4560e0","#7a45d8"],sky:"#151c40"},{c:4,r:4,peek:1,shuf:false,name:"Code",back:["#0f8f8a","#2563c9"],sky:"#0f2a3a"},{c:6,r:5,peek:2,shuf:true,name:"Agent ops",back:["#c2387a","#6a3bd8"],sky:"#2a1240"}];
var cards=[],L=0,lv=LV[0],first=-1,lock=0,miss=null,cur=0,keyed=false,moves=0,pairs=0,need=6,streak=0,bstreak=0,pts=0,time=0,ttime=0,tmoves=0,tpairs=0,peeks=0,peekT=0,later=0,then=null,idle=0,stars=[],G={x:0,y:0,w:1,h:1,gap:1},tick=0,pk=d.getElementById("peek");
function mix(a){for(var i=a.length-1;i>0;i--){var j=Math.floor(Math.random()*(i+1)),t=a[i];a[i]=a[j];a[j]=t;}return a;}
function span(a,b){var o=[];for(var i=a;i<b;i++)o.push(i);return o;}
function slotXY(i){return{x:G.x+(i%lv.c)*(G.w+G.gap),y:G.y+Math.floor(i/lv.c)*(G.h+G.gap)};}
function at(s){for(var i=0;i<cards.length;i++)if(cards[i].slot===s)return i;return -1;}
function layout(){var top=hb()+fsz(1.6),bot=Math.max(40,46*S),gap=Math.max(5,9*S),aw=W-24,ah=Math.max(40,H-top-bot),cw=(aw-gap*(lv.c-1))/lv.c,ch=(ah-gap*(lv.r-1))/lv.r,i,b;
if(cw/ch>.8)cw=ch*.8;else ch=cw/.8;G.w=Math.max(8,cw);G.h=Math.max(10,ch);G.gap=gap;G.x=(W-(G.w*lv.c+gap*(lv.c-1)))/2;G.y=top+(ah-(G.h*lv.r+gap*(lv.r-1)))/2;
for(i=0;i<cards.length;i++){b=slotXY(cards[i].slot);cards[i].px=b.x;cards[i].py=b.y;}}
function deal(){var ids,s=[],i;lv=LV[L];need=lv.c*lv.r/2;ids=L===0?mix(span(0,8)).slice(0,6):L===1?span(8,16):span(16,24).concat(mix(span(8,16)).slice(0,7));
for(i=0;i<need;i++){s.push(ids[i]);s.push(ids[i]);}mix(s);cards=[];for(i=0;i<s.length;i++)cards.push({s:s[i],slot:i,px:0,py:0,up:false,done:false,f:0,sh:0,gl:0,mv:0,ap:-(i*.035)});layout();}
function upPeek(){pk.textContent="Peek "+peeks;pk.disabled=state!=="play"||peeks<=0||peekT>0;}
function intro(){L=0;deal();for(var i=0;i<cards.length;i++)cards[i].ap=1;show("Memory cards","<p>Flip two cards at a time and find every pair across three levels: <b>4 x 3</b> shapes, <b>4 x 4</b> code icons and <b>6 x 5</b> agent ops.</p><ul><li>Matches in a row multiply points, up to x5</li><li><b>Peek</b> (Q) shows every card for a moment; every streak of 3 earns another</li><li>Fewer moves and less time earn more stars</li><li>On level 3 a missed pair shuffles into the deck</li></ul><p>Click or tap, or move with the arrow keys and flip with Space. P pauses, M sound, R restarts.</p>","Play",start);upPeek();}
function start(){L=0;pts=0;ttime=0;tmoves=0;tpairs=0;bstreak=0;stars=[];setScore(0);begin();}
function begin(){deal();first=-1;lock=0;miss=null;moves=0;pairs=0;streak=0;time=0;peeks=lv.peek;peekT=0;later=0;then=null;cur=0;fx.length=0;hide();set("play");upPeek();banner("Level "+(L+1)+": "+lv.name,lv.c+" x "+lv.r+(lv.shuf?", missed pairs shuffle":""),"#c9b6ff");arp([392,523,659],.07,"triangle",.05);}
function peek(){if(state!=="play"||peeks<=0||peekT>0||miss)return;peeks--;peekT=1.3;upPeek();tone(880,.25,"sine",.06,1320);say(W/2,G.y,"Peek!","#8fe3ff",1.2);}
function settle(ex){var a=miss;miss=null;lock=0;cards[a[0]].up=cards[a[1]].up=false;if(lv.shuf)reshuffle(a,ex);}
function reshuffle(a,ex){var n,i,q,o,t,pool,moved=0;for(n=0;n<2;n++){pool=[];for(i=0;i<cards.length;i++){q=cards[i];if(i!==a[0]&&i!==a[1]&&i!==ex&&!q.done&&!q.up&&q.mv<=0)pool.push(i);}if(!pool.length)continue;o=cards[pool[Math.floor(Math.random()*pool.length)]];t=cards[a[n]].slot;cards[a[n]].slot=o.slot;o.slot=t;cards[a[n]].mv=o.mv=1;moved++;}
if(moved){say(W/2,G.y,"Shuffled!","#c39bff");tone(300,.25,"sine",.05,900);}}
function pick(s){if(state!=="play"||peekT>0)return;var i=at(s),k,a,h,v,m,p;if(i<0)return;k=cards[i];if(k.up||k.done||k.mv>0)return;
if(miss)settle(i);
k.up=true;tone(620+Math.random()*80,.05,"square",.035);if(first<0){first=i;return;}
moves++;a=cards[first];h=G.w/2;v=G.h/2;
if(a.s===k.s){a.done=k.done=true;a.gl=k.gl=1;pairs++;streak++;bstreak=Math.max(bstreak,streak);m=Math.min(5,streak);p=100*m;pts+=p;setScore(pts);
burst(a.px+h,a.py+v,18,[COL[k.s%8],"#ffffff"]);burst(k.px+h,k.py+v,18,[COL[k.s%8],"#ffffff"]);say(k.px+h,k.py+v,"+"+p+(m>1?"  x"+m:""),"#ffffff",1.1);
tone(660+streak*70,.12,"triangle",.07);tone(990+streak*70,.16,"triangle",.06,0,.08);
if(streak%3===0){peeks++;upPeek();say(W/2,G.y,"+1 Peek","#8fe3ff");}
if(pairs===need)clear();}
else{streak=0;lock=.8;miss=[first,i];a.sh=k.sh=1;tone(180,.18,"sawtooth",.05,120);jolt(3);}
first=-1;}
function starsHtml(n){var h="<div class=stars>",i;for(i=0;i<3;i++)h+="<i"+(i<n?"":" class=off")+"></i>";return h+"</div>";}
function clear(){var tb=Math.max(0,Math.round((need*5-time)*10)),r=moves/need,s=r<=1.5?3:r<=2.2?2:1,html;pts+=tb;setScore(pts);stars.push(s);ttime+=time;tmoves+=moves;tpairs+=need;set("clear");upPeek();arp([523,659,784,1046,1318],.07,"triangle",.06);rain(70,COL);
html=starsHtml(s)+stats([["Moves",moves+" for "+need+" pairs"],["Time",Math.round(time)+" s"],["Time bonus","+"+tb],["Score",pts]]);
later=1;then=L<LV.length-1?function(){show("Level "+(L+1)+" clear!",html,"Next level",function(){L++;begin();});}:finish;}
function finish(){var tot=0,i,nb=pts>best;for(i=0;i<stars.length;i++)tot+=stars[i];best=Math.max(best,pts);set("over");upPeek();arp([523,659,784,1046,1318,1568],.08,"square",.05);
show(nb?"New best!":"All levels clear!",starsHtml(Math.round(tot/stars.length))+stats([["Score",pts],["Stars",tot+" of "+stars.length*3],["Moves",tmoves],["Time",Math.round(ttime)+" s"],["Accuracy",(tmoves?Math.round(100*tpairs/tmoves):0)+"%"],["Best streak","x"+bstreak],["Session best",best]]),"Play again",start);}
function step(dt){var i,k,b,to,r;tick+=dt;if(state==="play")time+=dt;
if(later>0){later-=dt;if(later<=0&&then){r=then;then=null;r();}}
if(peekT>0){peekT-=dt;if(peekT<=0){peekT=0;upPeek();}}
if(lock>0){lock-=dt;if(lock<=0&&miss)settle(-1);}
if(state==="ready"){idle-=dt;if(idle<=0&&cards.length){idle=.6;k=cards[Math.floor(Math.random()*cards.length)];k.up=!k.up;}}
for(i=0;i<cards.length;i++){k=cards[i];b=slotXY(k.slot);k.px+=(b.x-k.px)*Math.min(1,dt*9);k.py+=(b.y-k.py)*Math.min(1,dt*9);k.mv=Math.max(0,k.mv-dt*1.4);
to=k.up||k.done||peekT>0?1:0;k.ap=Math.min(1,k.ap+dt*1.6);k.f+=(to-k.f)*Math.min(1,dt*(calm?60:11));if(Math.abs(to-k.f)<.01)k.f=to;k.sh=Math.max(0,k.sh-dt*2);k.gl=Math.max(k.done?.3:0,k.gl-dt*1.2);}}
function poly(n,r,q,a0){x.beginPath();for(var i=0;i<n;i++){var a=a0+i*6.2832/n,l=i%2?r*q:r;x.lineTo(Math.cos(a)*l,Math.sin(a)*l);}x.closePath();}
function icon(n,r,bg){var c0=COL[n%8],i,a,l;x.fillStyle=c0;x.strokeStyle=c0;x.lineWidth=Math.max(1.5,r*.16);x.lineCap="round";x.lineJoin="round";x.beginPath();
switch(n){
case 0:x.arc(0,0,r,0,6.283);x.fill();break;
case 1:x.rect(-r*.85,-r*.85,r*1.7,r*1.7);x.fill();break;
case 2:x.moveTo(0,-r);x.lineTo(r,r*.8);x.lineTo(-r,r*.8);x.closePath();x.fill();break;
case 3:poly(10,r,.45,-1.5708);x.fill();break;
case 4:x.moveTo(0,-r);x.lineTo(r*.8,0);x.lineTo(0,r);x.lineTo(-r*.8,0);x.closePath();x.fill();break;
case 5:poly(6,r,1,0);x.fill();break;
case 6:x.lineWidth=r*.28;x.arc(0,0,r*.78,0,6.283);x.stroke();break;
case 7:x.rect(-r,-r*.3,r*2,r*.6);x.rect(-r*.3,-r,r*.6,r*2);x.fill();break;
case 8:x.font="800 "+Math.round(r*1.5)+"px ui-monospace,Menlo,Consolas,monospace";x.textAlign="center";x.textBaseline="middle";x.fillText("{ }",0,r*.05);break;
case 9:for(i=0;i<32;i++){a=i*.19635;l=i%4===1||i%4===2?r:r*.74;x.lineTo(Math.cos(a)*l,Math.sin(a)*l);}x.closePath();x.fill();disc(0,0,r*.32,bg);break;
case 10:for(i=-1;i<=1;i++){x.moveTo(-r*.9,i*r*.45);x.lineTo(r*.9,i*r*.45);}x.moveTo(-r*.15,-r*.6);x.lineTo(-r*.4,-r*.95);x.moveTo(r*.15,-r*.6);x.lineTo(r*.4,-r*.95);x.stroke();x.beginPath();x.ellipse(0,r*.1,r*.5,r*.68,0,0,6.283);x.fill();disc(0,-r*.55,r*.3,c0);x.strokeStyle=bg;x.lineWidth=r*.08;x.beginPath();x.moveTo(0,-r*.3);x.lineTo(0,r*.72);x.stroke();break;
case 11:x.lineWidth=r*.14;rr(-r,-r*.78,r*2,r*1.56,r*.2);x.stroke();x.beginPath();x.moveTo(-r*.6,-r*.3);x.lineTo(-r*.2,0);x.lineTo(-r*.6,r*.3);x.moveTo(0,r*.32);x.lineTo(r*.55,r*.32);x.stroke();break;
case 12:x.lineWidth=r*.16;x.moveTo(-r*.45,-r*.75);x.lineTo(-r*.45,r*.75);x.moveTo(-r*.45,r*.2);x.quadraticCurveTo(r*.45,r*.1,r*.45,-r*.45);x.stroke();disc(-r*.45,-r*.75,r*.22,c0);disc(-r*.45,r*.75,r*.22,c0);disc(r*.45,-r*.45,r*.22,c0);break;
case 13:disc(-r*.45,r*.15,r*.42,c0);disc(r*.1,-r*.15,r*.55,c0);disc(r*.6,r*.2,r*.38,c0);x.fillRect(-r*.45,r*.15,r*1.05,r*.43);break;
case 14:x.lineWidth=r*.2;x.arc(0,-r*.2,r*.45,3.1416,0);x.stroke();x.fillRect(-r*.7,-r*.2,r*1.4,r*1.1);disc(0,r*.3,r*.16,bg);break;
case 15:x.fillRect(-r*.75,-r*.6,r*1.5,r*1.2);x.beginPath();x.ellipse(0,r*.6,r*.75,r*.25,0,0,6.283);x.fill();x.beginPath();x.ellipse(0,-r*.6,r*.75,r*.25,0,0,6.283);x.fill();x.strokeStyle=bg;x.lineWidth=r*.1;x.beginPath();x.ellipse(0,-r*.6,r*.75,r*.25,0,0,6.283);x.stroke();x.beginPath();x.ellipse(0,0,r*.75,r*.25,0,0,3.1416);x.stroke();break;
case 16:x.lineWidth=r*.12;x.moveTo(0,-r*.55);x.lineTo(0,-r*.88);x.stroke();disc(0,-r*.92,r*.13,c0);rr(-r*.8,-r*.55,r*1.6,r*1.3,r*.3);x.fillStyle=c0;x.fill();disc(-r*.32,0,r*.17,bg);disc(r*.32,0,r*.17,bg);x.fillStyle=bg;x.fillRect(-r*.35,r*.38,r*.7,r*.1);break;
case 17:x.moveTo(0,-r);x.quadraticCurveTo(r*.55,-r*.4,r*.4,r*.55);x.lineTo(-r*.4,r*.55);x.quadraticCurveTo(-r*.55,-r*.4,0,-r);x.fill();x.beginPath();x.moveTo(-r*.4,r*.1);x.lineTo(-r*.75,r*.75);x.lineTo(-r*.3,r*.55);x.closePath();x.moveTo(r*.4,r*.1);x.lineTo(r*.75,r*.75);x.lineTo(r*.3,r*.55);x.closePath();x.fill();disc(0,-r*.2,r*.18,bg);x.fillStyle="#ffd166";x.beginPath();x.moveTo(-r*.22,r*.6);x.lineTo(0,r*(1+.15*Math.sin(tick*20)));x.lineTo(r*.22,r*.6);x.closePath();x.fill();break;
case 18:disc(0,0,r*.6,c0);x.lineWidth=r*.12;x.beginPath();x.ellipse(0,0,r*1.02,r*.3,-.4,0,6.283);x.stroke();break;
case 19:x.moveTo(r*.2,-r);x.lineTo(-r*.55,r*.1);x.lineTo(-r*.05,r*.1);x.lineTo(-r*.2,r);x.lineTo(r*.55,-r*.15);x.lineTo(r*.05,-r*.15);x.closePath();x.fill();break;
case 20:x.moveTo(0,r*.85);x.bezierCurveTo(-r*1.3,0,-r*.6,-r*1.05,0,-r*.4);x.bezierCurveTo(r*.6,-r*1.05,r*1.3,0,0,r*.85);x.fill();break;
case 21:disc(0,0,r*.85,c0);disc(r*.38,-r*.25,r*.7,bg);break;
case 22:x.lineWidth=r*.14;x.moveTo(-r*.6,r);x.lineTo(-r*.6,-r);x.stroke();x.beginPath();x.moveTo(-r*.6,-r*.9);x.quadraticCurveTo(0,-r*1.2,r*.8,-r*.75);x.lineTo(r*.8,r*.05);x.quadraticCurveTo(0,-r*.35,-r*.6,-r*.05);x.closePath();x.fill();break;
default:x.moveTo(-r,0);x.quadraticCurveTo(0,-r*.95,r,0);x.quadraticCurveTo(0,r*.95,-r,0);x.fill();disc(0,0,r*.38,bg);disc(0,0,r*.18,c0);}}
function drawCard(k){var sc=Math.min(1,Math.max(0,k.ap*3)),e=k.f,lift=Math.sin(e*3.1416),ox,w,hh,cx,cy,rad=Math.max(5,G.w*.1),face,bg,m;if(sc<=0)return;
ox=k.sh>0&&!calm?Math.sin(k.sh*40)*6*k.sh*S:0;w=G.w*Math.abs(Math.cos(e*3.1416))*sc*(1+lift*.08);hh=G.h*sc*(1+lift*.08);cx=k.px+G.w/2+ox;cy=k.py+G.h/2-lift*6*S-k.mv*8*S;
x.fillStyle="rgba(0,0,0,.35)";rr(cx-w/2+3*S,cy-hh/2+(4+lift*8)*S,Math.max(1,w),hh,rad);x.fill();
if(k.gl>0){x.shadowColor=COL[k.s%8];x.shadowBlur=22*S*k.gl;}
rr(cx-w/2,cy-hh/2,Math.max(1,w),hh,rad);
if(e<.5){bg=x.createLinearGradient(cx-w/2,cy-hh/2,cx+w/2,cy+hh/2);bg.addColorStop(0,lv.back[0]);bg.addColorStop(1,lv.back[1]);x.fillStyle=bg;x.fill();x.shadowBlur=0;x.strokeStyle=k.mv>0?"#c39bff":"rgba(255,255,255,.35)";x.lineWidth=2;x.stroke();
if(w>G.w*.3){m=Math.min(G.w,G.h)*.2;x.save();x.translate(cx,cy);x.scale(w/G.w,1);x.strokeStyle="rgba(255,255,255,.28)";x.lineWidth=2;x.beginPath();x.moveTo(0,-m);x.lineTo(m,0);x.lineTo(0,m);x.lineTo(-m,0);x.closePath();x.stroke();disc(0,0,m*.35,"rgba(255,255,255,.3)");x.restore();}}
else{face=k.done?"#232c58":"#1b2247";x.fillStyle=face;x.fill();x.shadowBlur=0;x.strokeStyle=k.done?COL[k.s%8]:k.sh>0?"#ff6b8b":"rgba(255,255,255,.5)";x.lineWidth=k.done?3:2;x.stroke();
if(w>G.w*.2){x.save();x.translate(cx,cy);x.scale(w/G.w,1);icon(k.s,Math.min(G.w,G.h)*.3,face);x.restore();}}
x.shadowBlur=0;}
function draw(){var g=x.createLinearGradient(0,0,0,H),i,b;g.addColorStop(0,lv.sky);g.addColorStop(1,"#070a18");x.fillStyle=g;x.fillRect(-20,-20,W+40,H+40);
for(i=0;i<14;i++)disc((i*97+tick*12*(1+i%3))%(W+40)-20,(i*53+Math.sin(tick*.7+i)*12)%H,(3+i%4)*S,"rgba(201,182,255,.12)");
for(i=0;i<cards.length;i++)if(cards[i].mv<=0)drawCard(cards[i]);for(i=0;i<cards.length;i++)if(cards[i].mv>0)drawCard(cards[i]);
if(keyed&&state==="play"){b=slotXY(cur);x.strokeStyle="#8fe3ff";x.lineWidth=3;rr(b.x-5,b.y-5,G.w+10,G.h+10,Math.max(6,G.w*.1)+4);x.stroke();}}
function hud(){var h=band("Score "+pts,"Level "+(L+1)+"  Pairs "+pairs+"/"+need+"  Moves "+moves,pairs+"/"+need+"  "+moves+" mv",Math.floor(time)+" s","#c9b6ff"),bw=Math.max(3,Math.round(4*S)),m=Math.min(5,streak);
x.fillStyle="rgba(255,255,255,.08)";x.fillRect(0,h,W,bw);if(m>0){x.fillStyle=MUL[m];x.fillRect(0,h,W*m/5,bw);font("800",.85);txt("Streak x"+m,W/2,h+bw+fsz(.85)*.8,MUL[m]);}
if(peekT>0){x.strokeStyle="rgba(143,227,255,.6)";x.lineWidth=4*S;x.strokeRect(2,h+2,W-4,H-h-4);}
tag();}
function key(k){var n=cards.length,c0=lv.c,m=k==="ArrowLeft"?-1:k==="ArrowRight"?1:k==="ArrowUp"?-c0:k==="ArrowDown"?c0:0,t;
if(m){keyed=true;t=cur+m;if(t>=0&&t<n&&!(m===1&&t%c0===0)&&!(m===-1&&cur%c0===0))cur=t;return true;}
if(k===" "||k==="Enter"){keyed=true;pick(cur);return true;}
if(k==="q"||k==="Q"){peek();return true;}return false;}
function keyup(){}
function tap(px,py){var s,b;keyed=false;for(s=0;s<cards.length;s++){b=slotXY(s);if(px>=b.x&&px<=b.x+G.w&&py>=b.y&&py<=b.y+G.h){cur=s;pick(s);return;}}}
function untap(){}
function points(){var o=[],i,k;for(i=0;i<cards.length;i++){k=cards[i];if(!k.done&&!k.up&&k.mv<=0)o.push([Math.round(k.px+G.w/2),Math.round(k.py+G.h/2)]);}return o;}
pk.addEventListener("click",function(){sound();peek();});`;

const AGENT_RUNNER_JS = `var Z=70,F=6,HZ=1,BASE=1,LW=1,objs=[],lane=0,plx=0,jy=0,jv=0,lives=3,inv=0,shield=0,mag=0,slow=0,dist=0,scroll=0,v=6,sprint=1,coins=0,streak=0,bstreak=0,bonus=0,pts=0,nextRow=12,dodged=0,tick=0,down=null,stars=[],sky=[],i0;
for(i0=0;i0<60;i0++)stars.push([Math.random(),Math.random()*.3,Math.random()*6.28]);
for(i0=0;i0<24;i0++)sky.push([i0/24,.03+Math.random()*.09]);
var SPR=["","Dodge or jump the bugs","Firewalls: change lanes","Merge conflicts: jump them","More of everything","Bugs on the move"];
var OBS={bug:1,wall:1,conf:1},NAME={bug:"Bug",wall:"Firewall",conf:"Merge conflict"},PUN={shield:"Review shield",mag:"Commit magnet",slow:"Focus mode"},PUC={shield:"#6cc4ff",mag:"#c39bff",slow:"#5ef2d6",build:"#7ee081"};
function layout(){HZ=H*.34;BASE=H*.9;LW=Math.min(W*.2,H*.34);}
function zk(z){return F/(F+Math.max(-F*.6,z));}
function sy(z){return HZ+(BASE-HZ)*zk(z);}
function sx(l,z){return W/2+l*LW*zk(z);}
function mult(){return Math.min(5,1+Math.floor(streak/10));}
function mix(a){for(var i=a.length-1;i>0;i--){var j=Math.floor(Math.random()*(i+1)),t=a[i];a[i]=a[j];a[j]=t;}return a;}
function intro(){show("Agent runner","<p>Your agent sprints down the build pipeline. Dodge what breaks the build, grab commits and see how far you get.</p><ul><li><b>Left / Right</b> (A / D, or tap a side) switch lanes</li><li><b>Up / Space</b> (or tap the middle) jumps bugs and merge conflicts</li><li><b>Firewalls</b> cannot be jumped: change lanes</li><li>Commits in a row score up to x5</li><li>Power-ups: <b>shield</b>, <b>magnet</b>, <b>focus</b> slow motion; a <b>green build</b> restores a life</li></ul><p>Swipes work too. P pauses, M sound, R restarts.</p>","Run",start);}
function start(){objs.length=0;fx.length=0;lane=0;plx=0;jy=0;jv=0;lives=3;inv=0;shield=0;mag=0;slow=0;dist=0;sprint=1;coins=0;streak=0;bstreak=0;bonus=0;pts=0;dodged=0;nextRow=10;setScore(0);hide();set("play");banner("Sprint 1",SPR[1],"#7ee081");arp([392,523,659],.07,"square",.04);}
function speed(){return(12+sprint*1.7+Math.min(6,dist/700))*(slow>0?.6:1);}
function add(t,l,z,wd){objs.push({t:t,l:l,x:l,z:z,tl:l,wd:wd?1:0,done:false,gone:false,ph:Math.random()*6.28});}
function coinLine(l,z,n){for(var i=0;i<n;i++)add("c",l,z+i*2.2);}
function goodie(l,z){if(Math.random()<.13)add(["shield","mag","slow","build"][Math.floor(Math.random()*4)],l,z+2);else coinLine(l,z,5);}
function row(){var z=Z,r=Math.random(),ls=mix([-1,0,1]),a;
if(sprint>=3&&r<.25){a=Math.random()<.5?-1:0;add("conf",a,z);goodie(a===-1?1:-1,z-3);}
else if(sprint>=2&&r<.6){add("wall",ls[0],z);if(sprint>=4&&Math.random()<.5)add("bug",ls[1],z);else if(Math.random()<.5)coinLine(ls[1],z-3,4);goodie(ls[2],z-3);}
else{add("bug",ls[0],z,sprint>=5&&Math.random()<.45);goodie(ls[1],z-4);}}
function hurt(b,px,py){if(shield>0){shield=0;inv=.8;say(px,py-LW*.9,"Shield saved you","#6cc4ff",1.1);burst(px,py-LW*.3,26,["#6cc4ff","#ffffff"]);tone(700,.2,"sine",.07,300);jolt(6,"108,196,255");return;}
lives--;inv=1.6;streak=0;jolt(14,"255,60,90");tone(140,.35,"sawtooth",.08,60);burst(px,py-LW*.3,30,["#ff4d6d","#ffd166","#ffffff"]);say(px,py-LW*.9,NAME[b.t]+"!","#ff6b8b",1.2);if(lives<=0)over();}
function over(){var nb=pts>best&&pts>0;set("over");best=Math.max(best,pts);objs.length=0;arp([523,392,330,262],.12,"triangle",.07);
show(nb?"New best!":"Build broken!",stats([["Score",pts],["Distance",Math.floor(dist)+" m"],["Sprint reached",sprint],["Commits",coins],["Best streak",bstreak],["Obstacles cleared",dodged],["Session best",best]]),"Run again",start);}
function jump(){if(state==="play"&&jy<=0){jv=9.5;jy=.001;tone(520,.12,"square",.04,880);}}
function go(n){if(state!=="play")return;n=Math.max(-1,Math.min(1,lane+n));if(n!==lane){lane=n;tone(420,.05,"triangle",.04);}}
function touch(b){var on=b.t==="conf"?Math.abs(b.x+.5-plx)<1.1:Math.abs(b.x-plx)<.6,px,py,m;if(!on||state!=="play")return;px=sx(plx,0);py=sy(0);
if(OBS[b.t]){if(b.t!=="wall"&&jy>.45){b.done=true;dodged++;bonus+=25;say(px,py-LW*1.1,"Jump +25","#7ee0ff");tone(880,.08,"triangle",.05);return;}if(inv>0)return;b.done=true;hurt(b,px,py);return;}
b.done=true;b.gone=true;
if(b.t==="c"){coins++;streak++;bstreak=Math.max(bstreak,streak);m=mult();bonus+=10*m;burst(px,py-LW*.5,6,["#7ee081","#ffffff"],.6);tone(988+Math.min(streak,24)*22,.05,"square",.03);if(streak%10===0)say(px,py-LW*1.1,"Streak "+streak+"  x"+mult(),"#ffd166",1.1);}
else if(b.t==="build"){if(lives<3){lives++;say(px,py-LW*1.1,"+1 life","#7ee081",1.2);}else{bonus+=100;say(px,py-LW*1.1,"Green build +100","#7ee081",1.2);}arp([659,880,1175],.06,"triangle",.06);burst(px,py-LW*.4,24,["#7ee081","#ffffff"]);}
else{if(b.t==="shield")shield=12;else if(b.t==="mag")mag=8;else slow=5;say(px,py-LW*1.1,PUN[b.t],PUC[b.t],1.1);arp([523,784,1046],.05,"sine",.06);burst(px,py-LW*.4,24,[PUC[b.t],"#ffffff"]);}}
function step(dt){var i,b,ns,s2,run=state==="play";tick+=dt;
if(run){v=speed();dist+=v*dt;s2=1+Math.floor(dist/400);if(s2>sprint){sprint=s2;bonus+=100;banner("Sprint "+sprint,(SPR[sprint]||"Faster")+"  +100","#7ee081");arp([523,659,784,1046],.07,"square",.05);}
nextRow-=v*dt;if(nextRow<=0){row();nextRow=Math.max(8,15-sprint*1.3)+Math.random()*4;}
inv=Math.max(0,inv-dt);shield=Math.max(0,shield-dt);mag=Math.max(0,mag-dt);slow=Math.max(0,slow-dt);}
else if(state!=="paused")v=6;
scroll+=v*dt;plx+=(lane-plx)*Math.min(1,dt*14);
if(jy>0){jv-=30*dt;jy+=jv*dt;if(jy<=0){jy=0;jv=0;if(run)burst(sx(plx,0),sy(0),6,["#7ee0ff","#8fa3c8"],.4);}}
if(run&&jy<=0&&Math.random()<.35)ps.push({x:sx(plx,0)+(Math.random()-.5)*LW*.2,y:sy(0),vx:(Math.random()-.5)*40*S,vy:-(20+Math.random()*40)*S,t:0,l:.35,c:"rgba(126,224,255,.6)",r:1.6*S,g:120});
for(i=objs.length-1;i>=0;i--){b=objs[i];if(!b)continue;if(run)b.z-=v*dt;
if(b.wd){if(Math.abs(b.x-b.tl)<.03)b.tl=Math.max(-1,Math.min(1,b.tl+(Math.random()<.5?-1:1)));b.x+=(b.tl-b.x)*Math.min(1,dt*1.6);}
if(mag>0&&b.t==="c"&&!b.gone&&b.z<7&&Math.abs(b.x-plx)<1.8)b.x+=(plx-b.x)*Math.min(1,dt*10);
if(run&&!b.done&&b.z<.9&&b.z>-.9)touch(b);
if(state==="play"&&!b.done&&b.z<=-.9){b.done=true;if(OBS[b.t])dodged++;}
if(b.z<-3)objs.splice(i,1);}
if(state==="play"){ns=Math.floor(dist)+bonus;if(ns!==pts){pts=ns;setScore(pts);}}}
function quad(l1,l2,za,zb){x.beginPath();x.moveTo(sx(l1,za),sy(za));x.lineTo(sx(l2,za),sy(za));x.lineTo(sx(l2,zb),sy(zb));x.lineTo(sx(l1,zb),sy(zb));x.closePath();x.fill();}
function drawBug(cx,y0,u){var y=y0-u*.22,w=Math.sin(tick*18)*u*.05,i;x.strokeStyle="#ff9db0";x.lineWidth=Math.max(1,u*.04);x.beginPath();for(i=-1;i<=1;i++){x.moveTo(cx-u*.2,y+i*u*.09);x.lineTo(cx-u*.42,y+i*u*.12+(i%2?w:-w)+u*.08);x.moveTo(cx+u*.2,y+i*u*.09);x.lineTo(cx+u*.42,y+i*u*.12+(i%2?-w:w)+u*.08);}x.stroke();
x.fillStyle="#ff4d6d";x.beginPath();x.ellipse(cx,y,u*.3,u*.2,0,0,6.283);x.fill();x.fillStyle="#b3264a";x.fillRect(cx-u*.015,y-u*.2,u*.03,u*.4);
disc(cx,y-u*.2,u*.12,"#2a0f1c");disc(cx-u*.05,y-u*.23,u*.035,"#ffffff");disc(cx+u*.05,y-u*.23,u*.035,"#ffffff");
x.beginPath();x.moveTo(cx-u*.05,y-u*.3);x.lineTo(cx-u*.12,y-u*.42);x.moveTo(cx+u*.05,y-u*.3);x.lineTo(cx+u*.12,y-u*.42);x.stroke();}
function drawWall(cx,y0,u){var w=u*.9,h=u*1.05,l=cx-w/2,t=y0-h,i,j,yy,xx,fl,g=x.createLinearGradient(0,t,0,y0);g.addColorStop(0,"#ff7a2f");g.addColorStop(1,"#a8231d");x.fillStyle=g;x.fillRect(l,t,w,h);
x.strokeStyle="rgba(60,10,10,.55)";x.lineWidth=Math.max(1,u*.02);x.beginPath();for(i=1;i<=5;i++){yy=t+h*i/5;if(i<5){x.moveTo(l,yy);x.lineTo(l+w,yy);}for(j=1;j<3;j++){xx=l+w*(j+(i%2?.5:0))/3;if(xx<l+w){x.moveTo(xx,yy-h/5);x.lineTo(xx,yy);}}}x.stroke();
x.fillStyle="#ffd166";x.beginPath();for(i=0;i<6;i++){fl=u*(.1+.07*Math.sin(tick*12+i*1.7));x.moveTo(l+w*i/6,t);x.lineTo(l+w*(i+.5)/6,t-fl);x.lineTo(l+w*(i+1)/6,t);}x.fill();
if(u>55){x.font="800 "+Math.round(u*.12)+"px system-ui,sans-serif";x.textAlign="center";x.textBaseline="middle";x.fillStyle="#fff3e0";x.fillText("FIREWALL",cx,t+h*.5);}}
function drawConf(cx,y0,u){var w=u*1.9,h=u*.5,l=cx-w/2,t=y0-h,i,s0,off=(tick*40*S)%(w/5);x.fillStyle="#6a3bd8";x.fillRect(l,t,w,h);x.save();x.beginPath();x.rect(l,t,w,h);x.clip();x.fillStyle="rgba(255,209,102,.85)";for(i=-2;i<12;i++){s0=l+i*w/10+off;x.beginPath();x.moveTo(s0,t);x.lineTo(s0+w/20,t);x.lineTo(s0+w/20-h*.6,y0);x.lineTo(s0-h*.6,y0);x.closePath();x.fill();}x.restore();
x.fillStyle="#2a0f4a";x.fillRect(l,t+h*.28,w,h*.44);x.fillStyle="#3a4470";x.fillRect(l-u*.04,t-u*.06,u*.06,h+u*.06);x.fillRect(l+w-u*.02,t-u*.06,u*.06,h+u*.06);
if(u>40){x.font="800 "+Math.round(u*.13)+"px system-ui,sans-serif";x.textAlign="center";x.textBaseline="middle";x.fillStyle="#ffffff";x.fillText("MERGE CONFLICT",cx,t+h*.5);}}
function drawCoin(cx,cy,u,ph){var r=u*.15,s=Math.abs(Math.cos(tick*4+ph));x.shadowColor="#7ee081";x.shadowBlur=10*S;x.fillStyle="#7ee081";x.beginPath();x.ellipse(cx,cy,Math.max(1,r*s),r,0,0,6.283);x.fill();x.shadowBlur=0;x.fillStyle="#0f3b1f";x.beginPath();x.ellipse(cx,cy,Math.max(.5,r*.45*s),r*.45,0,0,6.283);x.fill();}
function drawPU(t,cx,cy,u){var r=u*.24,col=PUC[t];x.shadowColor=col;x.shadowBlur=14*S;disc(cx,cy,r,col);x.shadowBlur=0;disc(cx,cy,r*.78,"#0b1030");x.strokeStyle=col;x.fillStyle=col;x.lineWidth=Math.max(1.5,r*.16);x.lineCap="round";x.beginPath();
if(t==="shield"){x.moveTo(cx,cy-r*.55);x.lineTo(cx+r*.45,cy-r*.35);x.lineTo(cx+r*.4,cy+r*.1);x.quadraticCurveTo(cx+r*.3,cy+r*.45,cx,cy+r*.6);x.quadraticCurveTo(cx-r*.3,cy+r*.45,cx-r*.4,cy+r*.1);x.lineTo(cx-r*.45,cy-r*.35);x.closePath();x.fill();}
else if(t==="mag"){x.moveTo(cx-r*.38,cy-r*.45);x.lineTo(cx-r*.38,cy);x.arc(cx,cy,r*.38,3.1416,0,true);x.lineTo(cx+r*.38,cy-r*.45);x.stroke();}
else if(t==="slow"){x.arc(cx,cy,r*.45,0,6.283);x.moveTo(cx,cy);x.lineTo(cx,cy-r*.32);x.moveTo(cx,cy);x.lineTo(cx+r*.25,cy);x.stroke();}
else{x.moveTo(cx-r*.35,cy);x.lineTo(cx-r*.08,cy+r*.3);x.lineTo(cx+r*.4,cy-r*.3);x.stroke();}}
function drawObj(b){if(b.gone||b.z>Z+12||b.z<-2.5)return;var kk=zk(b.z),cx=sx(b.t==="conf"?b.x+.5:b.x,b.z),gy=sy(b.z),u=LW*kk;
x.globalAlpha=Math.max(0,Math.min(1,(Z+10-b.z)/14));
x.fillStyle="rgba(0,0,0,.35)";x.beginPath();x.ellipse(cx,gy,u*(b.t==="conf"?1:.36),u*.09,0,0,6.283);x.fill();
if(b.t==="bug")drawBug(cx,gy,u);else if(b.t==="wall")drawWall(cx,gy,u);else if(b.t==="conf")drawConf(cx,gy,u);else if(b.t==="c")drawCoin(cx,gy-u*(.42+.06*Math.sin(tick*5+b.ph)),u,b.ph);else drawPU(b.t,cx,gy-u*(.5+.08*Math.sin(tick*4+b.ph)),u);
x.globalAlpha=1;}
function drawBot(){var u=LW*.8,px=sx(plx,0),gy=sy(0),y=gy-jy*u*.55,run=state==="play"?Math.sin(tick*16):Math.sin(tick*4)*.3;
x.fillStyle="rgba(0,0,0,.4)";x.beginPath();x.ellipse(px,gy,u*.28*(1-Math.min(.5,jy*.3)),u*.07,0,0,6.283);x.fill();
if(inv>0&&Math.floor(inv*12)%2===0)x.globalAlpha=.35;
x.strokeStyle="#8fa3c8";x.lineWidth=u*.07;x.lineCap="round";x.beginPath();
if(jy>0){x.moveTo(px-u*.1,y-u*.25);x.lineTo(px-u*.14,y-u*.08);x.moveTo(px+u*.1,y-u*.25);x.lineTo(px+u*.14,y-u*.08);}
else{x.moveTo(px-u*.1,y-u*.25);x.lineTo(px-u*.1+run*u*.07,y-u*.02);x.moveTo(px+u*.1,y-u*.25);x.lineTo(px+u*.1-run*u*.07,y-u*.02);}
x.moveTo(px-u*.2,y-u*.52);x.lineTo(px-u*.3,y-u*.38-run*u*.05);x.moveTo(px+u*.2,y-u*.52);x.lineTo(px+u*.3,y-u*.38+run*u*.05);x.stroke();
rr(px-u*.2,y-u*.62,u*.4,u*.4,u*.08);x.fillStyle="#d8e1f5";x.fill();
disc(px,y-u*.42,u*.05,mag>0?"#c39bff":slow>0?"#5ef2d6":"#7ee081");
rr(px-u*.17,y-u*.9,u*.34,u*.26,u*.08);x.fillStyle="#eef3ff";x.fill();
rr(px-u*.13,y-u*.84,u*.26,u*.12,u*.05);x.fillStyle="#1a2547";x.fill();
disc(px-u*.06,y-u*.78,u*.025,"#7ee0ff");disc(px+u*.06,y-u*.78,u*.025,"#7ee0ff");
x.strokeStyle="#8fa3c8";x.lineWidth=u*.03;x.beginPath();x.moveTo(px,y-u*.9);x.lineTo(px,y-u*1.02);x.stroke();disc(px,y-u*1.05,u*.035,"#ffd166");
x.globalAlpha=1;
if(shield>0){x.strokeStyle="rgba(108,196,255,"+(.5+.3*Math.sin(tick*8)).toFixed(2)+")";x.lineWidth=3*S;x.beginPath();x.arc(px,y-u*.5,u*.62,0,6.283);x.fillStyle="rgba(108,196,255,.12)";x.fill();x.stroke();}}
function draw(){var i,j,q,g,bw,bh,z0,ph,kk,yy,hgt,px2,sd,list;
g=x.createLinearGradient(0,0,0,HZ);g.addColorStop(0,"#070a1c");g.addColorStop(1,slow>0?"#14385a":"#2b1a55");x.fillStyle=g;x.fillRect(-20,-20,W+40,HZ+21);
x.fillStyle="#cfe0ff";for(i=0;i<stars.length;i++){q=stars[i];x.globalAlpha=.35+.35*Math.sin(tick*2+q[2]);x.fillRect(q[0]*W,q[1]*H,1.5,1.5);}x.globalAlpha=1;
bw=W/sky.length;for(i=0;i<sky.length;i++){q=sky[i];bh=q[1]*H;x.fillStyle="#120f2e";x.fillRect(q[0]*W,HZ-bh,bw-2,bh);x.fillStyle=Math.sin(tick*3+i*1.7)>.3?"#7ee0ff":"#34407a";for(j=0;j<3;j++)x.fillRect(q[0]*W+3,HZ-bh+4+j*bh/3.4,Math.max(2,bw*.3),2);}
x.fillStyle="rgba(126,224,255,.45)";x.fillRect(0,HZ-1,W,2);
g=x.createLinearGradient(0,HZ,0,H);g.addColorStop(0,"#0d0b24");g.addColorStop(1,"#050611");x.fillStyle=g;x.fillRect(-20,HZ,W+40,H-HZ+20);
x.fillStyle="#141a3a";quad(-1.5,1.5,-2.5,Z);
ph=scroll%8;x.fillStyle="rgba(120,140,255,.06)";for(z0=-ph;z0<Z;z0+=8)quad(-1.5,1.5,Math.max(-2.5,z0),z0+4);
ph=scroll%6;x.fillStyle="rgba(200,215,255,.55)";for(z0=-ph-2;z0<Z;z0+=6){quad(-.53,-.47,Math.max(-2.5,z0),z0+3);quad(.47,.53,Math.max(-2.5,z0),z0+3);}
x.strokeStyle=slow>0?"#5ef2d6":"#7ee0ff";x.lineWidth=Math.max(2,3*S);x.beginPath();x.moveTo(sx(-1.5,Z),sy(Z));x.lineTo(sx(-1.5,-2.5),sy(-2.5));x.moveTo(sx(1.5,Z),sy(Z));x.lineTo(sx(1.5,-2.5),sy(-2.5));x.stroke();
ph=scroll%10;for(z0=Z-ph;z0>-2;z0-=10){kk=zk(z0);yy=sy(z0);hgt=LW*1.1*kk;for(sd=-1;sd<=1;sd+=2){px2=sx(sd*1.95,z0);x.fillStyle="#2a3160";x.fillRect(px2-2*kk*S,yy-hgt,4*kk*S+1,hgt);disc(px2,yy-hgt,4*kk*S+1,sd<0?"#ff6b8b":"#7ee0ff");}}
list=objs.slice().sort(function(p,o){return o.z-p.z;});
for(i=0;i<list.length;i++)if(list[i].z>=0)drawObj(list[i]);
drawBot();
for(i=0;i<list.length;i++)if(list[i].z<0)drawObj(list[i]);}
function heart(cx,cy,r,col){x.fillStyle=col;x.beginPath();x.moveTo(cx,cy+r*.85);x.bezierCurveTo(cx-r*1.3,cy,cx-r*.6,cy-r*1.05,cx,cy-r*.4);x.bezierCurveTo(cx+r*.6,cy-r*1.05,cx+r*1.3,cy,cx,cy+r*.85);x.fill();}
function hud(){var h=band("Score "+pts,"Sprint "+sprint+"  x"+mult(),"S"+sprint,Math.floor(dist)+" m","#7ee081"),bw=Math.max(3,Math.round(4*S)),i,yy=h+bw+fsz(.9),r=fsz(.5),cy2=yy,items=[[shield,12,"Shield","#6cc4ff"],[mag,8,"Magnet","#c39bff"],[slow,5,"Focus","#5ef2d6"]],len;
x.fillStyle="rgba(255,255,255,.08)";x.fillRect(0,h,W,bw);x.fillStyle="#7ee081";x.fillRect(0,h,W*((dist%400)/400),bw);
for(i=0;i<3;i++)heart(16+r+i*r*2.6,yy,r,i<lives?"#ff4d6d":"rgba(255,255,255,.2)");
font("700",.75);for(i=0;i<3;i++)if(items[i][0]>0){txt(items[i][2]+" "+Math.ceil(items[i][0])+" s",W-12,cy2,items[i][3],"right");len=80*S*items[i][0]/items[i][1];x.fillStyle=items[i][3];x.fillRect(W-12-len,cy2+fsz(.5),len,2);cy2+=fsz(1.4);}
if(streak>=2){font("800",.85);txt("Streak "+streak,W/2,yy,"#ffd166");}
tag();}
function key(k){if(k==="ArrowLeft"||k==="a"||k==="A"){go(-1);return true;}if(k==="ArrowRight"||k==="d"||k==="D"){go(1);return true;}if(k==="ArrowUp"||k===" "||k==="w"||k==="W"||k==="Enter"){jump();return true;}return false;}
function keyup(){}
function tap(px,py){down=[px,py];}
function untap(px,py){var p0=down,dx,dy,ax,ay;down=null;if(!p0||state!=="play")return;dx=px-p0[0];dy=py-p0[1];ax=Math.abs(dx);ay=Math.abs(dy);
if(Math.max(ax,ay)>30*S){if(ax>ay)go(dx>0?1:-1);else if(dy<0)jump();return;}
if(p0[0]<W/3)go(-1);else if(p0[0]>W*2/3)go(1);else jump();}
function points(){var y=Math.round(H*.6);return[[Math.round(W/6),y],[Math.round(W/2),y],[Math.round(W*5/6),y]];}`;

/** Target tap: levels of rising speed; normal, moving, shrinking, armored, decoy, golden and freeze targets; a
 *  decaying combo meter (x5), time bonuses, accuracy and best combo on the end screen. */
export const SAMPLE_TARGET_TAP = sampleDoc({ title: "Target tap", bg: "#070b18", accent: "#ffd166", ink: "#17130a", js: TARGET_TAP_JS });

/** Memory cards: three levels (4 x 3, 4 x 4, 6 x 5) with procedurally drawn themes, flip animation, a streak
 *  multiplier, Peek charges, star ratings from moves and time, and shuffle-on-mistake on the last level. */
export const SAMPLE_MEMORY_CARDS = sampleDoc({
  title: "Memory cards", bg: "#0a0f22", accent: "#c9b6ff", ink: "#160f2e",
  css: `
.stars{margin:2px 0 8px}
.stars i{display:inline-block;width:clamp(20px,6vmin,32px);height:clamp(20px,6vmin,32px);margin:0 3px;background:#ffd166;clip-path:polygon(50% 0,61% 35%,98% 35%,68% 57%,79% 91%,50% 70%,21% 91%,32% 57%,2% 35%,39% 35%)}
.stars i.off{background:#3a4470}`,
  buttons: `<button id="peek" type="button" aria-label="Peek (Q)">Peek 0</button>`,
  js: MEMORY_CARDS_JS,
});

/** Agent runner: a three-lane perspective runner down a build pipeline; bugs, firewalls and merge conflicts,
 *  commits with a streak multiplier, shield, magnet, focus and green-build pickups, three lives, 400 m sprints. */
export const SAMPLE_AGENT_RUNNER = sampleDoc({ title: "Agent runner", bg: "#070a1c", accent: "#7ee081", ink: "#0b1a10", js: AGENT_RUNNER_JS });
