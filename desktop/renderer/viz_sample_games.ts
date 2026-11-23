// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/viz_sample_games.ts - P-WORLDS.BUILD2 (ADR-0653): the host's two generic sample games, the
// `sample` of viz_build_model.DEFAULT_MINI_GAMES. Each is ONE self-contained HTML document (inline CSS and JS, no
// network, no external assets, no storage, plain ASCII) under 12 KB, drawn on a canvas that fills its frame at any
// size (device pixel ratio aware), with a score, juicy feedback (particle bursts, floating points, a combo, a shake
// that reduced motion turns off), keyboard and pointer play, a Play overlay and a Restart button (R restarts).
// Text is light on a dark field (AA contrast). They pass the same security gate and sandbox as agent-built games.
// For the real-UI demos each sets body[data-ready] once its script ran, body[data-state] (ready, play, over) and
// body[data-score]. The strings hold no backtick, no "${" and no backslash, so they are the bytes the frame gets.

/** Target tap: hit targets before they fade; chained hits build a combo, gold targets score five. */
export const SAMPLE_TARGET_TAP = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Target tap (sample)</title><style>
html,body{margin:0;height:100%;overflow:hidden;background:#070b18;color:#f1f5ff;font:15px system-ui,sans-serif;user-select:none;-webkit-user-select:none}
canvas{display:block;width:100%;height:100%;touch-action:none;cursor:crosshair;outline:none}
.ov{position:absolute;inset:0;display:grid;place-items:center;text-align:center;background:rgba(5,8,20,.74);cursor:pointer}
.ov[hidden]{display:none}
.card{padding:16px 22px;max-width:86%}
h1{margin:0 0 8px;font-size:clamp(22px,6vmin,40px);color:#ffd166;letter-spacing:.02em}
p{margin:0 0 16px;color:#dfe6f7;font-size:clamp(13px,2.8vmin,17px);line-height:1.45}
button{font:inherit;font-weight:700;border:0;border-radius:10px;cursor:pointer}
#start{padding:10px 26px;background:#ffd166;color:#17130a;font-size:clamp(14px,3vmin,19px);box-shadow:0 6px 20px rgba(255,209,102,.35)}
#restart{position:absolute;right:10px;bottom:10px;padding:6px 12px;background:#1a2547;color:#f1f5ff;border:1px solid #4a5f99}
button:focus-visible{outline:3px solid #8fe3ff;outline-offset:2px}
</style></head><body>
<canvas id="c" tabindex="0" aria-label="Target tap game"></canvas>
<button id="restart" type="button" aria-label="Restart (R)">Restart</button>
<div class="ov" id="ov"><div class="card"><h1 id="hd">Target tap</h1><p id="msg">Hit the targets before they fade. Chain hits for a combo; gold ones score 5.<br>Click or tap, or aim with the arrow keys and press Space. R restarts.</p><button id="start" type="button">Play</button></div></div>
<script>
(function(){
"use strict";
var d=document,B=d.body,c=d.getElementById("c"),x=c.getContext("2d"),ov=d.getElementById("ov"),hd=d.getElementById("hd"),msg=d.getElementById("msg"),st=d.getElementById("start");
var calm=!!(window.matchMedia&&matchMedia("(prefers-reduced-motion: reduce)").matches);
var W=1,H=1,R=1,S=1,ROUND=30,ts=[],ps=[],fx=[],keys={},score=0,best=0,combo=0,maxc=0,left=ROUND,next=0,idle=0,shake=0,flash=0,state="",last=0,aim={x:.5,y:.55,on:false};
function size(){R=Math.min(2,window.devicePixelRatio||1);W=Math.max(1,c.clientWidth);H=Math.max(1,c.clientHeight);c.width=Math.round(W*R);c.height=Math.round(H*R);S=Math.max(.6,Math.min(W,H)/420);}
function set(s){state=s;B.setAttribute("data-state",s);}
function start(){score=0;combo=0;maxc=0;left=ROUND;next=.25;ts.length=0;fx.length=0;B.setAttribute("data-score","0");ov.hidden=true;set("play");c.focus();}
function over(){set("over");best=Math.max(best,score);hd.textContent="Time!";msg.textContent="Score "+score+", best combo x"+maxc+". Best this session: "+best+".";st.textContent="Play again";ov.hidden=false;st.focus();
for(var i=0;i<70;i++)spark(W/2,H/2,i%2?"#ffd166":"#7ee0ff",1.5);}
function spark(px,py,col,k){var a=Math.random()*6.283,v=(80+Math.random()*260)*S*(k||1);ps.push({x:px,y:py,vx:Math.cos(a)*v,vy:Math.sin(a)*v-60*S,t:0,l:.45+Math.random()*.45,c:col,r:(2+Math.random()*3)*S});}
function spawn(deco){var g=!deco&&Math.random()<.12,el=ROUND-left;ts.push({x:.08+Math.random()*.84,y:.2+Math.random()*.72,t:0,life:deco?2.2:Math.max(.85,1.9-el*.035),r:(g?22:30)+Math.random()*10,g:g});}
function grow(t){var k=t.t/t.life;return k<.12?1-Math.pow(1-k/.12,3):k>.8?Math.max(0,(1-k)/.2):1;}
function hit(px,py){if(state!=="play")return;
for(var i=ts.length-1;i>=0;i--){var t=ts[i],r=t.r*S*Math.max(.6,grow(t))+6,dx=px-t.x*W,dy=py-t.y*H;if(dx*dx+dy*dy>r*r)continue;
ts.splice(i,1);combo++;maxc=Math.max(maxc,combo);var m=Math.min(5,1+Math.floor(combo/5)),p=(t.g?5:1)*m;score+=p;B.setAttribute("data-score",String(score));
for(var j=0;j<(t.g?40:22);j++)spark(t.x*W,t.y*H,j%3?(t.g?"#ffd166":"#ff5d7a"):"#ffffff");
fx.push({x:t.x*W,y:t.y*H,t:0,s:"+"+p+(m>1?"  x"+m:""),c:t.g?"#ffd166":"#ffffff"});shake=t.g?10:4;flash=t.g?.35:0;return;}
combo=0;shake=5;fx.push({x:px,y:py,t:0,s:"miss",c:"#ff9db0"});}
function disc(cx,cy,r,col){x.fillStyle=col;x.beginPath();x.arc(cx,cy,r,0,6.283);x.fill();}
function draw(){x.setTransform(R,0,0,R,0,0);
var g=x.createRadialGradient(W/2,H*.42,0,W/2,H*.42,Math.max(W,H)*.8);g.addColorStop(0,"#1d2c58");g.addColorStop(1,"#070b18");x.fillStyle=g;x.fillRect(0,0,W,H);
if(flash>0){x.fillStyle="rgba(255,209,102,"+(flash*.45)+")";x.fillRect(0,0,W,H);}
x.save();if(shake>0&&!calm)x.translate((Math.random()-.5)*shake*S,(Math.random()-.5)*shake*S);
x.fillStyle="rgba(150,180,255,.12)";var sp=34*S,i,gx,gy;for(gx=sp/2;gx<W;gx+=sp)for(gy=sp/2;gy<H;gy+=sp)x.fillRect(gx-1,gy-1,2,2);
for(i=0;i<ts.length;i++){var t=ts[i],k=grow(t),r=t.r*S*k,cx=t.x*W,cy=t.y*H;if(r<1)continue;
x.globalAlpha=state==="play"?1:.45;x.shadowColor=t.g?"#ffd166":"#ff4d6d";x.shadowBlur=20*S;disc(cx,cy,r,t.g?"#ffd166":"#ff4d6d");x.shadowBlur=0;
disc(cx,cy,r*.74,"#ffffff");disc(cx,cy,r*.5,t.g?"#ffad0a":"#ff4d6d");disc(cx,cy,r*.24,"#ffffff");
x.strokeStyle="rgba(255,255,255,.85)";x.lineWidth=3*S;x.beginPath();x.arc(cx,cy,r+6*S,-1.5708,-1.5708+6.283*(1-t.t/t.life));x.stroke();x.globalAlpha=1;}
for(i=0;i<ps.length;i++){var p=ps[i];x.globalAlpha=Math.max(0,1-p.t/p.l);disc(p.x,p.y,p.r,p.c);}x.globalAlpha=1;
var fs=Math.max(13,Math.round(16*S));x.textAlign="center";x.textBaseline="middle";
for(i=0;i<fx.length;i++){var f=fx[i];x.globalAlpha=Math.max(0,1-f.t/.8);x.font="800 "+Math.round(fs*1.25)+"px system-ui,sans-serif";x.fillStyle="#070b18";x.fillText(f.s,f.x+1,f.y-f.t*70*S+2);x.fillStyle=f.c;x.fillText(f.s,f.x,f.y-f.t*70*S);}x.globalAlpha=1;
if(aim.on&&state==="play"){var ax=aim.x*W,ay=aim.y*H,ar=14*S;x.strokeStyle="#8fe3ff";x.lineWidth=2.5;x.beginPath();x.arc(ax,ay,ar,0,6.283);x.moveTo(ax-ar*1.6,ay);x.lineTo(ax-ar*.5,ay);x.moveTo(ax+ar*.5,ay);x.lineTo(ax+ar*1.6,ay);x.moveTo(ax,ay-ar*1.6);x.lineTo(ax,ay-ar*.5);x.moveTo(ax,ay+ar*.5);x.lineTo(ax,ay+ar*1.6);x.stroke();}
x.restore();
var hb=fs*2.3;x.fillStyle="rgba(5,8,20,.78)";x.fillRect(0,0,W,hb);
x.fillStyle=left<6&&state==="play"?"#ff5d7a":"#7ee0ff";x.fillRect(0,hb,W*Math.max(0,left)/ROUND,Math.max(3,4*S));
x.font="700 "+fs+"px system-ui,sans-serif";x.textAlign="left";x.fillStyle="#f1f5ff";x.fillText("Score "+score,12,hb/2);
x.textAlign="right";x.fillText(Math.ceil(left)+" s",W-12,hb/2);
if(combo>1){x.textAlign="center";x.fillStyle="#ffd166";x.fillText("Combo x"+combo,W/2,hb/2);}
x.textAlign="left";x.font="700 "+Math.max(11,Math.round(11*S))+"px system-ui,sans-serif";x.fillStyle="#ffb86b";x.fillText("SAMPLE",12,H-16);}
function frame(now){var dt=last?Math.min(.05,(now-last)/1000):0,i;last=now;
var kx=(keys.ArrowRight?1:0)-(keys.ArrowLeft?1:0),ky=(keys.ArrowDown?1:0)-(keys.ArrowUp?1:0);
if(kx||ky){aim.on=true;aim.x=Math.min(.98,Math.max(.02,aim.x+kx*dt*.8));aim.y=Math.min(.97,Math.max(.12,aim.y+ky*dt*.8));}
if(state==="play"){left-=dt;next-=dt;if(next<=0){spawn(false);next=Math.max(.28,.75-(ROUND-left)*.015);}}
else{idle-=dt;if(idle<=0&&ts.length<4){spawn(true);idle=.9;}}
for(i=ts.length-1;i>=0;i--){ts[i].t+=dt;if(ts[i].t>=ts[i].life){ts.splice(i,1);if(state==="play")combo=0;}}
if(state==="play"&&left<=0){left=0;over();}
for(i=ps.length-1;i>=0;i--){var p=ps[i];p.t+=dt;p.x+=p.vx*dt;p.y+=p.vy*dt;p.vy+=520*S*dt;p.vx*=.98;if(p.t>=p.l)ps.splice(i,1);}
for(i=fx.length-1;i>=0;i--){fx[i].t+=dt;if(fx[i].t>.8)fx.splice(i,1);}
shake=Math.max(0,shake-dt*40);flash=Math.max(0,flash-dt*1.5);draw();requestAnimationFrame(frame);}
c.addEventListener("pointerdown",function(e){var b=c.getBoundingClientRect();aim.on=false;hit(e.clientX-b.left,e.clientY-b.top);});
ov.addEventListener("click",start);
d.getElementById("restart").addEventListener("click",start);
d.addEventListener("keydown",function(e){var k=e.key;
if(k==="r"||k==="R"){start();e.preventDefault();return;}
if(k.indexOf("Arrow")===0){keys[k]=1;e.preventDefault();return;}
if(k===" "||k==="Enter"){if(e.target&&e.target.tagName==="BUTTON")return;e.preventDefault();if(state==="play"){aim.on=true;hit(aim.x*W,aim.y*H);}else start();}});
d.addEventListener("keyup",function(e){delete keys[e.key];});
window.addEventListener("blur",function(){keys={};});
window.addEventListener("resize",size);
size();set("ready");B.setAttribute("data-score","0");requestAnimationFrame(frame);
B.setAttribute("data-ready","1");
})();
</script></body></html>`;

/** Memory cards: find the eight pairs in a 4 by 4 grid; a run of matches multiplies the points. */
export const SAMPLE_MEMORY_CARDS = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Memory cards (sample)</title><style>
html,body{margin:0;height:100%;overflow:hidden;background:#0a0f22;color:#f1f5ff;font:15px system-ui,sans-serif;user-select:none;-webkit-user-select:none}
canvas{display:block;width:100%;height:100%;touch-action:none;cursor:pointer;outline:none}
.ov{position:absolute;inset:0;display:grid;place-items:center;text-align:center;background:rgba(6,9,24,.74);cursor:pointer}
.ov[hidden]{display:none}
.card{padding:16px 22px;max-width:86%}
h1{margin:0 0 8px;font-size:clamp(22px,6vmin,40px);color:#c9b6ff;letter-spacing:.02em}
p{margin:0 0 16px;color:#dfe6f7;font-size:clamp(13px,2.8vmin,17px);line-height:1.45}
button{font:inherit;font-weight:700;border:0;border-radius:10px;cursor:pointer}
#start{padding:10px 26px;background:#c9b6ff;color:#160f2e;font-size:clamp(14px,3vmin,19px);box-shadow:0 6px 20px rgba(201,182,255,.35)}
#restart{position:absolute;right:10px;bottom:10px;padding:6px 12px;background:#1d1f4a;color:#f1f5ff;border:1px solid #5a5fa8}
button:focus-visible{outline:3px solid #8fe3ff;outline-offset:2px}
</style></head><body>
<canvas id="c" tabindex="0" aria-label="Memory cards game"></canvas>
<button id="restart" type="button" aria-label="Restart (R)">Restart</button>
<div class="ov" id="ov"><div class="card"><h1 id="hd">Memory cards</h1><p id="msg">Flip two cards at a time and find all 8 pairs. Matches in a row score more.<br>Click or tap, or move with the arrow keys and flip with Space. R restarts.</p><button id="start" type="button">Play</button></div></div>
<script>
(function(){
"use strict";
var d=document,B=d.body,c=d.getElementById("c"),x=c.getContext("2d"),ov=d.getElementById("ov"),hd=d.getElementById("hd"),msg=d.getElementById("msg"),st=d.getElementById("start");
var calm=!!(window.matchMedia&&matchMedia("(prefers-reduced-motion: reduce)").matches);
var COL=["#ff6b8b","#6cc4ff","#7ee081","#ffd166","#c39bff","#ff9f5a","#5ef2d6","#f1f5ff"];
var W=1,H=1,R=1,S=1,cards=[],ps=[],fx=[],first=-1,lock=0,miss=null,cur=0,keyed=false,moves=0,pairs=0,streak=0,score=0,best=0,time=0,state="",last=0,G={x:0,y:0,s:1,gap:1};
function size(){R=Math.min(2,window.devicePixelRatio||1);W=Math.max(1,c.clientWidth);H=Math.max(1,c.clientHeight);c.width=Math.round(W*R);c.height=Math.round(H*R);S=Math.max(.6,Math.min(W,H)/420);
var top=Math.max(13,16*S)*2.3+10,gap=Math.max(6,10*S),avail=Math.min(W-24,H-top-44);G.s=Math.max(10,(avail-gap*3)/4);G.gap=gap;G.x=(W-(G.s*4+gap*3))/2;G.y=top+(H-top-34-(G.s*4+gap*3))/2;}
function set(s){state=s;B.setAttribute("data-state",s);}
function deal(){var s=[],i,j,t;for(i=0;i<16;i++)s.push(i>>1);for(i=15;i>0;i--){j=Math.floor(Math.random()*(i+1));t=s[i];s[i]=s[j];s[j]=t;}
cards=[];for(i=0;i<16;i++)cards.push({s:s[i],up:false,done:false,f:0,sh:0,gl:0,in:-(i*.04)});}
function start(){deal();first=-1;lock=0;miss=null;moves=0;pairs=0;streak=0;score=0;time=0;fx.length=0;B.setAttribute("data-score","0");ov.hidden=true;set("play");c.focus();}
function win(){set("over");best=Math.max(best,score);hd.textContent="All pairs found!";msg.textContent="Score "+score+" in "+moves+" moves and "+Math.round(time)+" s. Best this session: "+best+".";st.textContent="Play again";
setTimeout(function(){if(state==="over"){ov.hidden=false;st.focus();}},700);for(var i=0;i<90;i++)spark(Math.random()*W,-10,COL[i%8],1.2,true);}
function spark(px,py,col,k,rain){var a=rain?1.2+Math.random()*.7:Math.random()*6.283,v=(80+Math.random()*240)*S*(k||1);ps.push({x:px,y:py,vx:Math.cos(a)*v,vy:Math.sin(a)*v-(rain?0:60*S),t:0,l:rain?1.6:.5+Math.random()*.4,c:col,r:(2+Math.random()*3)*S});}
function box(i){return{x:G.x+(i%4)*(G.s+G.gap),y:G.y+Math.floor(i/4)*(G.s+G.gap)};}
function pick(i){if(state!=="play"||i<0||i>15)return;var k=cards[i];if(k.up||k.done)return;
if(lock>0&&miss){cards[miss[0]].up=cards[miss[1]].up=false;miss=null;lock=0;}
k.up=true;if(first<0){first=i;return;}
moves++;var a=cards[first],pa=box(first),pb=box(i),h=G.s/2;
if(a.s===k.s){a.done=k.done=true;a.gl=k.gl=1;pairs++;streak++;var p=100*Math.min(4,streak);score+=p;B.setAttribute("data-score",String(score));
for(var j=0;j<24;j++){spark(pa.x+h,pa.y+h,COL[k.s]);spark(pb.x+h,pb.y+h,j%3?COL[k.s]:"#ffffff");}
fx.push({x:pb.x+h,y:pb.y+h,t:0,s:"+"+p+(streak>1?"  x"+Math.min(4,streak):"")});if(pairs===8)win();}
else{streak=0;lock=.8;miss=[first,i];a.sh=k.sh=1;}
first=-1;}
function rr(x0,y0,w,h,r){x.beginPath();x.moveTo(x0+r,y0);x.arcTo(x0+w,y0,x0+w,y0+h,r);x.arcTo(x0+w,y0+h,x0,y0+h,r);x.arcTo(x0,y0+h,x0,y0,r);x.arcTo(x0,y0,x0+w,y0,r);x.closePath();}
function sym(n,cx,cy,r){x.fillStyle=COL[n];x.strokeStyle=COL[n];x.lineWidth=r*.28;x.beginPath();var i,a;
if(n===0)x.arc(cx,cy,r,0,6.283);
else if(n===1)x.rect(cx-r*.85,cy-r*.85,r*1.7,r*1.7);
else if(n===2){x.moveTo(cx,cy-r);x.lineTo(cx+r,cy+r*.8);x.lineTo(cx-r,cy+r*.8);}
else if(n===3){for(i=0;i<10;i++){a=-1.5708+i*.6283;var q=i%2?r*.45:r;x.lineTo(cx+Math.cos(a)*q,cy+Math.sin(a)*q);}}
else if(n===4){x.moveTo(cx,cy-r);x.lineTo(cx+r*.8,cy);x.lineTo(cx,cy+r);x.lineTo(cx-r*.8,cy);}
else if(n===5){for(i=0;i<6;i++){a=i*1.0472;x.lineTo(cx+Math.cos(a)*r,cy+Math.sin(a)*r);}}
else if(n===6){x.arc(cx,cy,r*.8,0,6.283);x.closePath();x.stroke();return;}
else{x.rect(cx-r,cy-r*.3,r*2,r*.6);x.rect(cx-r*.3,cy-r,r*.6,r*2);}
x.closePath();x.fill();}
function draw(){x.setTransform(R,0,0,R,0,0);
var g=x.createLinearGradient(0,0,0,H);g.addColorStop(0,"#151c40");g.addColorStop(1,"#070a18");x.fillStyle=g;x.fillRect(0,0,W,H);
var i,s=G.s,rad=Math.max(6,s*.12);
for(i=0;i<cards.length;i++){var k=cards[i],b=box(i),sc=Math.min(1,Math.max(0,k.in*5));if(sc<=0)continue;
var ox=k.sh>0&&!calm?Math.sin(k.sh*40)*6*k.sh*S:0,w=s*Math.abs(1-2*k.f)*sc,hh=s*sc,cx=b.x+s/2+ox,cy=b.y+s/2;
x.save();if(k.gl>0){x.shadowColor=COL[k.s];x.shadowBlur=26*S*k.gl;}
rr(cx-w/2,cy-hh/2,Math.max(1,w),hh,Math.min(rad,w/2));
if(k.f<.5){var bg=x.createLinearGradient(cx-w/2,cy-hh/2,cx+w/2,cy+hh/2);bg.addColorStop(0,"#4560e0");bg.addColorStop(1,"#7a45d8");x.fillStyle=bg;x.fill();x.shadowBlur=0;
x.strokeStyle="rgba(255,255,255,.35)";x.lineWidth=2;x.stroke();if(w>s*.3){x.fillStyle="rgba(255,255,255,.22)";x.beginPath();x.arc(cx,cy,s*.16*(w/s),0,6.283);x.fill();}}
else{x.fillStyle=k.done?"#232c58":"#1b2247";x.fill();x.shadowBlur=0;x.strokeStyle=k.done?COL[k.s]:k.sh>0?"#ff6b8b":"rgba(255,255,255,.5)";x.lineWidth=k.done?3:2;x.stroke();
if(w>s*.2){x.save();x.translate(cx,cy);x.scale(w/s,1);sym(k.s,0,0,s*.27);x.restore();}}
x.restore();
if(keyed&&i===cur&&state==="play"){x.strokeStyle="#8fe3ff";x.lineWidth=3;rr(b.x-5,b.y-5,s+10,s+10,rad+4);x.stroke();}}
for(i=0;i<ps.length;i++){var p=ps[i];x.globalAlpha=Math.max(0,1-p.t/p.l);x.fillStyle=p.c;x.beginPath();x.arc(p.x,p.y,p.r,0,6.283);x.fill();}x.globalAlpha=1;
var fs=Math.max(13,Math.round(16*S));x.textAlign="center";x.textBaseline="middle";x.font="800 "+Math.round(fs*1.25)+"px system-ui,sans-serif";
for(i=0;i<fx.length;i++){var f=fx[i],fy=f.y-f.t*70*S;x.globalAlpha=Math.max(0,1-f.t/.9);x.fillStyle="#070a18";x.fillText(f.s,f.x+1,fy+2);x.fillStyle="#ffffff";x.fillText(f.s,f.x,fy);}x.globalAlpha=1;
var hb=fs*2.3;x.fillStyle="rgba(5,8,20,.78)";x.fillRect(0,0,W,hb);x.font="700 "+fs+"px system-ui,sans-serif";x.fillStyle="#f1f5ff";
x.textAlign="left";x.fillText("Score "+score,12,hb/2);x.textAlign="center";x.fillText("Pairs "+pairs+"/8   Moves "+moves,W/2,hb/2);x.textAlign="right";x.fillText(Math.floor(time)+" s",W-12,hb/2);
if(streak>1){x.fillStyle="#ffd166";x.fillRect(0,hb,W*Math.min(4,streak)/4,Math.max(3,4*S));}
x.textAlign="left";x.font="700 "+Math.max(11,Math.round(11*S))+"px system-ui,sans-serif";x.fillStyle="#ffb86b";x.fillText("SAMPLE",12,H-16);}
function frame(now){var dt=last?Math.min(.05,(now-last)/1000):0,i;last=now;if(state==="play")time+=dt;
if(lock>0){lock-=dt;if(lock<=0&&miss){cards[miss[0]].up=cards[miss[1]].up=false;miss=null;}}
for(i=0;i<cards.length;i++){var k=cards[i],to=k.up||k.done?1:0;k.in=Math.min(1,k.in+dt);k.f+=(to-k.f)*Math.min(1,dt*(calm?60:12));if(Math.abs(to-k.f)<.01)k.f=to;k.sh=Math.max(0,k.sh-dt*2);k.gl=Math.max(k.done?.35:0,k.gl-dt*1.2);}
for(i=ps.length-1;i>=0;i--){var p=ps[i];p.t+=dt;p.x+=p.vx*dt;p.y+=p.vy*dt;p.vy+=420*S*dt;p.vx*=.98;if(p.t>=p.l)ps.splice(i,1);}
for(i=fx.length-1;i>=0;i--){fx[i].t+=dt;if(fx[i].t>.9)fx.splice(i,1);}
draw();requestAnimationFrame(frame);}
c.addEventListener("pointerdown",function(e){var b=c.getBoundingClientRect(),px=e.clientX-b.left,py=e.clientY-b.top;keyed=false;
for(var i=0;i<16;i++){var q=box(i);if(px>=q.x&&px<=q.x+G.s&&py>=q.y&&py<=q.y+G.s){cur=i;pick(i);return;}}});
ov.addEventListener("click",start);
d.getElementById("restart").addEventListener("click",start);
d.addEventListener("keydown",function(e){var k=e.key;
if(k==="r"||k==="R"){start();e.preventDefault();return;}
var m={ArrowLeft:-1,ArrowRight:1,ArrowUp:-4,ArrowDown:4}[k];
if(m){keyed=true;var n=cur+m;if(n>=0&&n<16&&!((m===1&&n%4===0)||(m===-1&&cur%4===0)))cur=n;e.preventDefault();return;}
if(k===" "||k==="Enter"){if(e.target&&e.target.tagName==="BUTTON")return;e.preventDefault();if(state==="play"){keyed=true;pick(cur);}else start();}});
window.addEventListener("resize",size);
deal();for(var i=0;i<16;i++)cards[i].in=1;size();set("ready");B.setAttribute("data-score","0");requestAnimationFrame(frame);
B.setAttribute("data-ready","1");
})();
</script></body></html>`;
