const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');

const PORT = process.env.PORT || 8000;
const PUBLIC = path.join(__dirname, 'public');
const server = http.createServer((req,res)=>{
  let pathname = decodeURIComponent((req.url||'/').split('?')[0]);
  if (pathname === '/') pathname = '/index.html';
  const file = path.normalize(path.join(PUBLIC, pathname));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file,(err,data)=>{
    if (err) { res.writeHead(404,{'Content-Type':'text/plain'}); return res.end('Not found'); }
    const ext = path.extname(file);
    const types = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json'};
    res.writeHead(200,{'Content-Type':types[ext]||'application/octet-stream','Cache-Control':'no-store'}); res.end(data);
  });
});

const wss = new WebSocket.Server({server});
const rooms = new Map();
const JOINABLE_PHASES = new Set(['lobby','matchOver']);
const BUILDS = [
  {name:'Bruiser', attrs:[['Power',5],['Dash',1]]},
  {name:'Acrobat', attrs:[['Low Gravity',4],['Jump Boost',2]]},
  {name:'Survivor', attrs:[['Knockback Resistance',4],['Air Control',2]]},
  {name:'Striker', attrs:[['Speed',3],['Heavy Hitter',3]]}
];
const MAPS = ['classic','crosswind','towers','windmill','collapse'];
const COLORS = ['#ff6b6b','#5aa9ff','#72d572','#d59bff','#ffc857','#56d8d8','#ff8ac8','#b6e36a'];

function code(){ let c; do { c = Math.random().toString(36).slice(2,6).toUpperCase(); } while(rooms.has(c)); return c; }
function send(ws,obj){ if(ws && ws.readyState===WebSocket.OPEN) ws.send(JSON.stringify(obj)); }
function roomOf(ws){ return ws.__room ? rooms.get(ws.__room) : null; }
function createRoom(){
  const r={code:code(),hostId:null,settings:{players:4,bestOf:1,time:60,map:null},phase:'lobby',clients:new Map(),slots:Array(8).fill(null),draft:{pick:0,used:[],turns:[]},match:{round:1,wins:Array(8).fill(0)},fight:null};
  rooms.set(r.code,r); return r;
}
function publicState(r,ws){
  const slot=ws.__slot ?? null;
  return {room:r.code,host:ws.__id===r.hostId,slot,phase:r.phase,settings:r.settings,map:r.settings.map,match:{round:r.match.round,wins:r.match.wins.slice()},players:Array.from({length:r.settings.players},(_,i)=>({slot:i,name:r.slots[i]?.name||`CPU ${i+1}`,human:!!r.slots[i],build:r.fight?undefined:r.slots[i]?.build??null,wins:r.match.wins[i]||0})),draft:r.draft,fight:r.fight?{elapsed:r.fight.elapsed,arenaHalf:r.fight.arenaHalf,entities:r.fight.entities.map(e=>({id:e.id,x:e.x,y:e.y,vx:e.vx,vy:e.vy,alive:e.alive,falling:e.falling,rotation:e.rotation,hits:e.hits,launch:e.launch,attack:e.attack?{kind:e.attack.kind,t:e.attack.t,total:e.attack.total,dir:e.attack.dir}:null,build:e.build,flash:e.flash}))}:null};
}
function broadcast(r,extra={}){ for(const c of r.clients.values()) send(c,{type:'state',...publicState(r,c),...extra}); }
function assignSlot(r, client){ for(let i=0;i<r.settings.players;i++) if(!r.slots[i]){r.slots[i]=client;client.__slot=i;return i;} return -1; }
function lobbyReset(r){ r.phase='lobby'; r.draft={pick:0,used:[],turns:[]}; r.fight=null; r.match.round=1; r.match.wins=Array(8).fill(0); for(let i=0;i<r.settings.players;i++) if(r.slots[i]) r.slots[i].build=null; }
function firstHumanTurn(r){
  return Array.isArray(r.draft.turns) ? (r.draft.turns[r.draft.pick] ?? null) : null;
}
function buildOrder(r){
  // Only connected clients participate in the unique-build draft.
  // CPU fighters never block a human pick. At most four humans receive
  // unique picks because there are four unique builds. Extra human players
  // (5-8) receive duplicates automatically after the unique draft.
  const humans=[];
  for(let i=0;i<r.settings.players;i++) if(r.slots[i] && r.slots[i].ws) humans.push(i);
  const order=humans.slice(0,4);
  if(r.match.round%2===0) order.reverse();
  return order;
}
function assignDuplicateBuilds(r){
  const counts=[0,0,0,0];
  for(const slot of r.slots.slice(0,r.settings.players)){
    if(slot && Number.isInteger(slot.build) && slot.build>=0 && slot.build<4) counts[slot.build]++;
  }
  for(let i=0;i<r.settings.players;i++){
    const slot=r.slots[i];
    if(!slot || slot.build!=null) continue;
    // Balance duplicates while preserving the unique picks already made.
    let choice=0;
    for(let b=1;b<4;b++) if(counts[b]<counts[choice]) choice=b;
    slot.build=choice;
    counts[choice]++;
  }
}
function autoDraft(r){
  if(!Array.isArray(r.draft.turns)) r.draft.turns=buildOrder(r);
  const current=firstHumanTurn(r);
  if(current!=null && !r.slots[current]){
    // A client disconnected during the draft. Skip that human pick safely.
    r.draft.pick++;
  }
  if(r.draft.pick>=r.draft.turns.length){
    assignDuplicateBuilds(r);
    r.phase='draftDone';
  }
}
function startDraft(r){
  if(!r.settings.map) return false;
  r.phase='draft'; r.draft={pick:0,used:[],turns:buildOrder(r)};
  for(let i=0;i<r.settings.players;i++) if(r.slots[i]) r.slots[i].build=null;
  autoDraft(r); broadcast(r);
}
function inBounds(x,half){return x>500-half-60 && x<500+half+60;}
function makeFight(r){
  const xs=[150,270,390,510,630,750,210,790];
  r.fight={elapsed:0,arenaHalf:410,ended:false,roundWinner:null,lastEvent:'Fight!',entities:Array.from({length:r.settings.players},(_,i)=>({id:i,x:xs[i],y:360,vx:0,vy:0,w:28,h:64,alive:true,falling:false,fade:1,rotation:0,ground:true,jumpLatch:false,dashLatch:false,attack:null,prevLight:false,prevHeavy:false,prevDash:false,hits:0,launch:0,flash:0,aiT:0,facing:i<4?1:-1,build:r.slots[i]?.build??(i%4)}))};
}
function startRound(r){ if(!MAP_PLATFORMS[r.settings.map]) r.settings.map='classic'; r.phase='fight'; makeFight(r); broadcast(r,{event:{kind:'roundStart',round:r.match.round,map:r.settings.map,players:r.fight.entities.length}}); }
function inputFor(r,e){ const cl=r.slots[e.id]; return cl?.input || {left:false,right:false,jump:false,light:false,heavy:false,dash:false}; }
function cpuInput(r,e,dt){
  const alive=r.fight.entities.filter(o=>o.alive&&!o.falling&&o.id!==e.id); const t=alive.sort((a,b)=>Math.abs(a.x-e.x)-Math.abs(b.x-e.x))[0];
  const out={left:false,right:false,jump:false,light:false,heavy:false,dash:false}; if(!t)return out;
  out.left=t.x<e.x-28; out.right=t.x>e.x+28; e.aiT=Math.max(0,e.aiT-dt);
  if(e.aiT<=0){ if(Math.abs(t.x-e.x)<70){out.light=Math.random()<.7;out.heavy=Math.random()<.45;} if(Math.abs(t.x-e.x)>100&&Math.random()<.35)out.jump=true; if(!e.ground&&Math.abs(t.x-e.x)>100&&Math.random()<.18)out.dash=true; e.aiT=.24+Math.random()*.38; }
  return out;
}
function attrs(e,name){return BUILDS[e.build]?.attrs.some(a=>a[0]===name);}
function doHit(r,attacker,kind){
  const dir=attacker.facing||1; const range=kind==='heavy'?88:64; const base=kind==='heavy'?740:380;
  let targets=[];
  for(const o of r.fight.entities){
    if(o.id===attacker.id||!o.alive||o.falling)continue;
    const dx=o.x-attacker.x,dy=o.y-attacker.y;
    if(dx*dir>0 && Math.abs(dx)<range && Math.abs(dy)<60) targets.push(o);
  }
  for(const o of targets){
    o.hits += 1; o.launch=Math.min(220, o.launch+12); const scale=1+Math.min(o.hits,14)*0.13; const resist=attrs(o,'Knockback Resistance')?.56:1;
    let mult=1; if(attrs(attacker,'Power'))mult*=1.65; if(attrs(attacker,'Heavy Hitter')&&kind==='heavy')mult*=1.5;
    const impulse=base*mult*scale*resist; o.vx += dir*impulse/62; o.vy -= kind==='heavy'?205:105; o.flash=.18;
    broadcast(r,{event:{kind:'hit',attacker:attacker.id,target:o.id,attack:kind,hits:o.hits,launch:Math.round(o.launch)}});
  }
}
function eliminate(r,e){ if(e.falling||!e.alive)return; e.falling=true; e.vy=Math.max(e.vy,120); e.vx*=1.12; r.fight.lastEvent=`Player ${e.id+1} knocked out!`; broadcast(r,{event:{kind:'eliminated',player:e.id}}); }
function updatePlayer(r,e,dt){
  let inp=r.slots[e.id]?.input; if(!r.slots[e.id])inp=cpuInput(r,e,dt); else inp=inp||{left:false,right:false,jump:false,light:false,heavy:false,dash:false};
  const speed=attrs(e,'Speed')?315:235; const grav=attrs(e,'Low Gravity')?760:1250; const jump=attrs(e,'Jump Boost')?650:520; const air=attrs(e,'Air Control')?.9:.56;
  const accel=e.ground?1100:720*air;
  if(inp.left){e.vx-=accel*dt;e.facing=-1} if(inp.right){e.vx+=accel*dt;e.facing=1} if(!inp.left&&!inp.right)e.vx*=Math.pow(e.ground?.0006:.05,dt); e.vx=Math.max(-speed,Math.min(speed,e.vx));
  if(inp.jump&&!e.jumpLatch&&e.ground){e.vy=-jump;e.ground=false}
  e.jumpLatch=inp.jump;
  if(!e.ground && inp.jump){e.vy+=-(grav*.62)*dt; e.vy=Math.min(e.vy,150)} // hold jump = glide, including Space on default client
  if(inp.dash&&!e.dashLatch){ const dir=inp.right?1:inp.left?-1:e.facing||1; e.vx=dir*650; e.vy=Math.min(e.vy,90); e.dashLatch=true; broadcast(r,{event:{kind:'dash',player:e.id}}); }
  if(!inp.dash)e.dashLatch=false;
  e.vy+=grav*dt;e.x+=e.vx*dt;e.y+=e.vy*dt;
  const floor=450;
  // main floor
  if(e.y+e.h/2>=floor && e.vy>=0){e.y=floor-e.h/2;e.vy=0;e.ground=true}
  else e.ground=false;
  // simple platform geometry
  const half=r.fight.arenaHalf; const platforms=MAP_PLATFORMS[r.settings.map]||MAP_PLATFORMS.classic; for(const p of platforms){let x=(500-half)+p.x*(half*2); let w=p.w*(half*2); let yy=p.y; if(p.moving) x+=Math.sin(r.fight.elapsed*1.2)*60; if(e.vy>=0 && e.y+e.h/2>=yy && e.y+e.h/2<=yy+24 && e.x+e.w/2>x && e.x-e.w/2<x+w){e.y=yy-e.h/2;e.vy=0;e.ground=true}}
  if(inp.light&&!e.prevLight){e.attack={kind:'light',t:0,total:.25,did:false,dir:e.facing};broadcast(r,{event:{kind:'attack',player:e.id,attack:'light'}})}
  if(inp.heavy&&!e.prevHeavy){e.attack={kind:'heavy',t:0,total:.42,did:false,dir:e.facing};broadcast(r,{event:{kind:'attack',player:e.id,attack:'heavy'}})}
  e.prevLight=!!inp.light;e.prevHeavy=!!inp.heavy;e.flash=Math.max(0,e.flash-dt);
  if(e.attack){e.attack.t+=dt;const active=e.attack.kind==='heavy'?.18:.10;if(e.attack.t>=active&&!e.attack.did){e.attack.did=true;doHit(r,e,e.attack.kind)}if(e.attack.t>=e.attack.total)e.attack=null}
  const bL=500-half,bR=500+half; if(e.x<bL-75||e.x>bR+75||e.y>535)eliminate(r,e);
}
const MAP_PLATFORMS={
  classic:[{x:.08,y:390,w:.18},{x:.74,y:390,w:.18}],
  crosswind:[{x:.07,y:355,w:.22},{x:.36,y:305,w:.28},{x:.71,y:355,w:.22}],
  towers:[{x:.12,y:345,w:.15},{x:.73,y:345,w:.15},{x:.35,y:308,w:.30},{x:.22,y:258,w:.12},{x:.66,y:258,w:.12}],
  windmill:[{x:.12,y:370,w:.20},{x:.68,y:370,w:.20},{x:.34,y:305,w:.32,moving:true}],
  collapse:[{x:.06,y:360,w:.16},{x:.29,y:325,w:.15},{x:.56,y:360,w:.15},{x:.79,y:320,w:.15}]
};
function updateHazard(r){ const f=r.fight,half=f.arenaHalf; if(!f)return; if(r.settings.map==='crosswind'){for(const e of f.entities)if(e.alive&&!e.falling)e.vx+=Math.sin(f.elapsed*2.5)*10/30;} if(r.settings.map==='classic'){const x=500+Math.sin(f.elapsed*1.4)*130;for(const e of f.entities)if(e.alive&&!e.falling&&Math.abs(e.x-x)<32&&Math.abs(e.y-360)<55)e.vx+=Math.sign(e.x-x||1)*180/30;} if(r.settings.map==='windmill'){const a=f.elapsed*3,cx=500,cy=350,rx=Math.cos(a)*110,ry=Math.sin(a)*110;for(const e of f.entities)if(e.alive&&!e.falling&&Math.hypot(e.x-(cx+rx),e.y-(cy+ry))<36){e.vx+=Math.sign(e.x-cx||1)*7;e.vy-=2}} }
function updateFight(r){
  const f=r.fight; if(!f||!Array.isArray(f.entities)) return; const dt=1/30; f.elapsed+=dt; const q=Math.min(1,f.elapsed/r.settings.time); f.arenaHalf=410*(1-.68*q); updateHazard(r); for(const e of f.entities){if(e.falling){e.vy+=1500*dt;e.x+=e.vx*dt;e.y+=e.vy*dt;e.rotation+=e.vx*.012;e.fade=Math.max(0,e.fade-dt*.5);if(e.y>700)e.alive=false;} else if(e.alive)updatePlayer(r,e,dt)}
  const alive=f.entities.filter(e=>e.alive&&!e.falling); if(alive.length<=1){if(alive.length===1&&!f.roundWinner) {f.roundWinner=alive[0].id; r.match.wins[alive[0].id]++;} if(!f.ended){f.ended=true;f.endAt=Date.now()+900;}}
  if(f.ended&&Date.now()>=f.endAt){
    const matchDone=r.match.wins.some(w=>w>=Math.ceil(r.settings.bestOf/2))||r.match.round>=r.settings.bestOf;
    if(matchDone){ r.phase='matchOver'; }
    else { r.match.round++; r.phase='draft'; r.draft={pick:0,used:[],turns:buildOrder(r)}; for(let i=0;i<r.settings.players;i++) if(r.slots[i]) r.slots[i].build=null; autoDraft(r); }
    broadcast(r,{event:{kind:'roundEnd',winner:f.roundWinner,matchOver:matchDone,nextRound:r.match.round}});
  }
  if(Math.floor(f.elapsed*10)%10===0){};
}
setInterval(()=>{for(const r of rooms.values())if(r.phase==='fight'){updateFight(r);broadcast(r)}} ,1000/30);

wss.on('connection',(ws)=>{
  ws.__id=crypto.randomUUID(); ws.input={};
  send(ws,{type:'hello',id:ws.__id});
  ws.on('message',raw=>{
    let m; try{m=JSON.parse(raw)}catch{return}
    try {
    let r=roomOf(ws);
    if(m.type==='create'){if(r)return; r=createRoom();ws.__room=r.code;r.hostId=ws.__id;const c={ws,id:ws.__id,name:String(m.name||'Player 1').slice(0,18),input:{}};ws.__client=c;r.clients.set(ws.__id,ws);r.slots[0]=c;ws.__slot=0;broadcast(r);return;}
    if(m.type==='join'){if(r)return; r=rooms.get(String(m.code||'').toUpperCase()); if(!r||!JOINABLE_PHASES.has(r.phase)){return send(ws,{type:'error',message:'Room unavailable or not joinable right now.'})}ws.__room=r.code;const c={ws,id:ws.__id,name:String(m.name||'Player').slice(0,18),input:{}};ws.__client=c;r.clients.set(ws.__id,ws);const slot=assignSlot(r,c);if(slot<0){r.clients.delete(ws.__id);ws.__room=null;return send(ws,{type:'error',message:'Room is full.'})} broadcast(r);return;}
    if(!r)return;
    const client=ws.__client;
    if(m.type==='name'){client.name=String(m.name||'Player').slice(0,18);broadcast(r);}
    else if(m.type==='settings'&&ws.__id===r.hostId&&r.phase==='lobby'){
      const players=Math.max(2,Math.min(8,Number(m.players)||4));
      const bestOf=[1,3,5,7].includes(Number(m.bestOf))?Number(m.bestOf):r.settings.bestOf;
      const time=[60,180,300,600].includes(Number(m.time))?Number(m.time):r.settings.time;
      if(players<r.clients.size) return send(ws,{type:'error',message:'Cannot set fewer fighters than connected players.',state:publicState(r,ws)});
      r.settings.players=players; r.settings.bestOf=bestOf; r.settings.time=time;
      broadcast(r);
    }
    else if(m.type==='map'&&ws.__id===r.hostId&&r.phase==='lobby'){if(MAPS.includes(m.map))r.settings.map=m.map;broadcast(r)}
    else if(m.type==='startDraft'&&ws.__id===r.hostId&&r.phase==='lobby'){if(!r.settings.map)return send(ws,{type:'error',message:'Select a map before starting the draft.'});startDraft(r);broadcast(r)}
    else if(m.type==='draft'&&r.phase==='draft'){
      const turn=firstHumanTurn(r);
      const b=Number(m.build);
      if(turn==null) return send(ws,{type:'error',message:'The unique draft is already complete.'});
      if(turn!==ws.__slot) return send(ws,{type:'error',message:'It is not your turn to draft.'});
      if(!Number.isInteger(b)||b<0||b>3) return send(ws,{type:'error',message:'Invalid build selection.'});
      if(r.draft.used.includes(b)) return send(ws,{type:'error',message:'That build was already drafted.'});
      const player=r.slots[turn];
      if(!player || player.id!==ws.__id) return send(ws,{type:'error',message:'Your draft slot is no longer available.'});
      r.draft.used.push(b);
      player.build=b;
      r.draft.pick++;
      autoDraft(r);
      broadcast(r);
    }
    else if(m.type==='startRound'&&ws.__id===r.hostId&&r.phase==='draftDone'){startRound(r)}
    else if(m.type==='input'&&typeof m.input==='object'){ws.input={left:!!m.input.left,right:!!m.input.right,jump:!!m.input.jump,light:!!m.input.light,heavy:!!m.input.heavy,dash:!!m.input.dash};if(client)client.input=ws.input;}
    else if(m.type==='newMatch'&&ws.__id===r.hostId&&(r.phase==='matchOver'||r.phase==='roundOver')){lobbyReset(r);broadcast(r)}
    else if(m.type==='restart'&&ws.__id===r.hostId){r.settings.players=Math.max(2,Math.min(8,Number(m.players)||r.settings.players));r.settings.bestOf=[1,3,5,7].includes(Number(m.bestOf))?Number(m.bestOf):r.settings.bestOf;r.settings.time=[60,180,300,600].includes(Number(m.time))?Number(m.time):r.settings.time;lobbyReset(r);broadcast(r)}
    else if(m.type==='leave'){ws.close()}
    } catch(err) {
      console.error('Client message error:',err);
      send(ws,{type:'error',message:'Game server error handled safely. Please retry that action.'});
    }
  });
  ws.on('close',()=>{const r=roomOf(ws);if(!r)return;const c=ws.__client;if(c&&r.slots[c.ws===ws?ws.__slot:ws.__slot]?.id===c.id)r.slots[ws.__slot]=null;r.clients.delete(ws.__id);if(r.hostId===ws.__id){const next=r.clients.values().next().value;r.hostId=next?next.__id:null;}if(r.clients.size===0)rooms.delete(r.code);else broadcast(r);});
});
server.listen(PORT,()=>console.log(`Stickdown listening on http://localhost:${PORT}`));
