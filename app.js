import { clamp, wrapPi, WORLD, DOCK, RADIUS, OBSTACLES, DEFAULTS, normalizeConfig, validateConfig, clearPoint, planRoute, raycast, parseOdom, parseScan, validMission } from './core.js';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const ZERO = Object.freeze({ lin: 0, ang: 0 });
const storage = {
  read(key, fallback) { try { return JSON.parse(localStorage.getItem('robotpilot.' + key)) ?? fallback; } catch { return fallback; } },
  write(key, value) { try { localStorage.setItem('robotpilot.' + key, JSON.stringify(value)); return true; } catch { return false; } },
};
let cfg = normalizeConfig(storage.read('cfg', {}));
const presetMissions = [
  { id: 'patrol', name: 'Arena patrol', points: [{x:1.2,y:1.2},{x:1.2,y:4.8},{x:8.8,y:4.8},{x:8.8,y:3.2},{x:6,y:1.2},{x:1.2,y:1.2}], loop: false, preset: true },
  { id: 'explore', name: 'Discovery run', points: [{x:2,y:3.5},{x:5.5,y:4.9},{x:8.8,y:4.8},{x:8.8,y:3.1},{x:6,y:1.1},{x:2,y:1.2}], loop: false, preset: true },
];
const storedMissions = storage.read('missions', null);
let missions = Array.isArray(storedMissions) ? storedMissions.filter(validMission).slice(0, 50) : presetMissions.map(m => structuredClone(m));
let events = storage.read('events', []);
if (!Array.isArray(events)) events = [];
events = events.filter(e => e && typeof e.message === 'string' && typeof e.time === 'string' && ['info','warn','error','voice'].includes(e.kind)).slice(0, 250);
let sessions = storage.read('sessions', []);
if (!Array.isArray(sessions)) sessions = [];
sessions = sessions.filter(s => s && typeof s.id === 'string' && Number.isFinite(s.started) && Number.isFinite(s.duration) && Number.isFinite(s.distance) && Number.isFinite(s.peak)).slice(0,30);
let session;
const robot = { x:2.2, y:2, th:.3, v:0, w:0, battery:92, charging:false, trail:[] };
const state = {
  page:'dashboard', estop:false, reason:'', mission:null, timed:null, cruise:false,
  ws:null, wanted:false, retry:0, retryTimer:null, connectTimer:null, openedAt:0,
  lastOdom:0, lastBattery:0, lastScan:0, lastImu:0, lastDiagnostics:0, count:0, rate:0, rateAt:performance.now(),
  scan:null, tilt:null, faults:[], topicMessages:{}, sent:ZERO, lastBump:0,
  recording:false, record:[], pendingSave:null, draft:[], editing:false,
  follow:false, zoom:1, chart:'speed', nearest:Infinity, forward:Infinity,
  samples:[], archive:[], lastSample:0, autoDockAttempted:false, batteryWarned:false,
};
const keys = new Set(), joy = { x:0, y:0 };
let padId = null, configWriteTimer, eventWriteTimer;
const pad = $('#pad'), knob = $('#knob');
const speed = () => cfg.speed / 100;
const maximum = () => cfg.profile === 'precision' ? .45 * speed() : speed();
const maximumTurn = () => (cfg.profile === 'precision' ? 1 : 2) * speed();
const text = (id, value) => { const el = $(id); if (el.textContent !== String(value)) el.textContent = value; };
function node(tag, className, content) {
  const el = document.createElement(tag); if (className) el.className = className;
  if (content !== undefined) el.textContent = content; return el;
}
function saveConfig() { storage.write('cfg', cfg); }
function queueConfig() { clearTimeout(configWriteTimer); configWriteTimer = setTimeout(saveConfig, 300); }
function toast(message, kind = 'info') {
  const el = node('div', 'toast ' + kind, message); $('#toasts').append(el);
  while ($('#toasts').children.length > 3) $('#toasts').firstChild.remove();
  setTimeout(() => el.remove(), 4500);
}
function log(message, kind = 'info', notify = true) {
  events.unshift({ time:new Date().toISOString(), message, kind });
  events = events.slice(0,250); renderEvents();
  clearTimeout(eventWriteTimer); eventWriteTimer = setTimeout(() => storage.write('events',events),400);
  if (notify) toast(message, kind);
}
function renderEvents() {
  const search = $('#logSearch').value.toLowerCase(), filter = $('#logFilter').value;
  const list = events.filter(e => (filter === 'all' || e.kind === filter) && e.message.toLowerCase().includes(search));
  const fragment = document.createDocumentFragment();
  for (const e of list) {
    const li = node('li', e.kind), time = node('time', '', new Date(e.time).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'}));
    time.dateTime = e.time; li.append(node('i','event-dot'),node('span','event-msg',e.message),time); fragment.append(li);
  }
  if (!list.length) fragment.append(node('li','log-empty','No matching events.'));
  $('#log').replaceChildren(fragment);
}
$('#logSearch').addEventListener('input',renderEvents);
$('#logFilter').addEventListener('change',renderEvents);

function beginSession() {
  session = { id:crypto.randomUUID(), started:Date.now(), mode:cfg.mode, duration:0, distance:0, peak:0, missions:0 };
  state.samples = []; state.archive = []; state.lastSample = 0;
}
function persistSession() {
  if (!session) return;
  session.duration = (Date.now() - session.started) / 1000;
  sessions = [{...session}, ...sessions.filter(s => s.id !== session.id)].slice(0,30);
  storage.write('sessions',sessions);
}
const duration = seconds => {
  const n = Math.floor(seconds); return String(Math.floor(n / 60)).padStart(2,'0') + ':' + String(n % 60).padStart(2,'0');
};
function renderSessions() {
  persistSession();
  const fragment = document.createDocumentFragment();
  for (const s of sessions) {
    const row = node('tr');
    [new Date(s.started).toLocaleString(),s.mode === 'sim' ? 'Simulator' : 'Robot',duration(s.duration),s.distance.toFixed(2)+' m',s.peak.toFixed(2)+' m/s',s.missions ?? 0].forEach(v => row.append(node('td','',v)));
    fragment.append(row);
  }
  $('#sessionHistory').replaceChildren(fragment);
}
function download(filename, content, type) {
  const url = URL.createObjectURL(new Blob([content],{type}));
  const link = node('a'); link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url),1000); toast('Export downloaded');
}
$('#exportLogsBtn').addEventListener('click',() => download('robotpilot-events.json',JSON.stringify(events,null,2),'application/json'));
$('#exportTelemetryBtn').addEventListener('click',() => {
  const header = 'time,mode,x_m,y_m,speed_m_s,turn_rad_s,heading_deg,battery_pct';
  const rows = state.archive.map(s => [s.time,cfg.mode,s.x,s.y,s.speed,s.turn,s.heading,s.battery ?? ''].join(','));
  download('robotpilot-telemetry.csv',[header,...rows].join('\n'),'text/csv');
});

function clearInputs() {
  keys.clear(); joy.x = joy.y = 0; padId = null;
  pad.classList.remove('active'); knob.style.transform = 'translate(0,0)';
}
function cancelMotion(reason = '') {
  const active = state.mission || state.cruise || state.timed;
  state.mission = null; state.timed = null; state.cruise = false;
  $('#cruiseBtn').setAttribute('aria-pressed','false');
  if (active && reason) log(reason,'info',false);
}
function stopAll(reason = '', notify = false) {
  clearInputs(); cancelMotion(); state.sent = ZERO;
  if (cfg.mode === 'sim') robot.v = robot.w = 0;
  publishVelocity(ZERO);
  if (reason) log(reason,'info',notify);
}
function emergency(reason = 'Emergency stop engaged') {
  stopAll();
  if (state.estop && state.reason === reason) return;
  state.estop = true; state.reason = reason;
  $('#estopBtn').classList.add('latched');
  $('#estopBtn span').textContent = 'Release emergency stop';
  log(reason,'error'); updateUI();
}
function connected() { return state.ws?.readyState === WebSocket.OPEN; }
function freshOdom() { return state.lastOdom > 0 && performance.now() - state.lastOdom < cfg.timeout * 1000; }
function hardwareFault() {
  return (state.lastImu && performance.now() - state.lastImu < cfg.timeout*1000 && state.tilt >= 30) ||
    (state.lastDiagnostics && performance.now() - state.lastDiagnostics < 5000 && state.faults.length > 0);
}
function releaseEmergency() {
  if (cfg.mode === 'ws' && (!connected() || !freshOdom())) { toast('Wait for a connected robot with fresh odometry.','warn'); return; }
  if (hardwareFault()) { toast('Resolve the robot fault or tilt condition first.','warn'); return; }
  stopAll(); state.estop = false; state.reason = '';
  $('#estopBtn').classList.remove('latched'); $('#estopBtn span').textContent = 'Emergency stop';
  $('#resetDialog').close(); log('Emergency stop released. Controls ready.'); updateUI();
}
$('#estopBtn').addEventListener('click',() => {
  if (state.estop) { stopAll(); $('#resetDialog').showModal(); } else emergency();
});
$('#confirmReset').addEventListener('click',releaseEmergency);
$('#stopBtn').addEventListener('click',() => stopAll('Motion stopped',true));
function canDrive(allowDock = false) {
  if (state.estop) return false;
  if (cfg.mode === 'ws' && (!connected() || !freshOdom())) return false;
  if (hardwareFault()) return false;
  if (Number.isFinite(robot.battery) && robot.battery <= 5 && !allowDock) return false;
  return true;
}
function requireDrive(allowDock = false) {
  if (canDrive(allowDock)) return true;
  toast(state.estop ? 'Release emergency stop before driving.' : robot.battery <= 5 ? 'Battery critical. Dock to recharge.' : 'Wait for a healthy robot connection.','warn'); return false;
}
function padMove(e) {
  const r = pad.getBoundingClientRect(), max = r.width/2 - knob.offsetWidth/2;
  let dx = e.clientX - r.left - r.width/2, dy = e.clientY - r.top - r.height/2;
  const distance = Math.hypot(dx,dy);
  if (distance > max) { dx *= max/distance; dy *= max/distance; }
  joy.x = dx/max; joy.y = dy/max; knob.style.transform = 'translate('+dx+'px,'+dy+'px)';
}
pad.addEventListener('pointerdown',e => {
  if (!requireDrive()) return;
  cancelMotion('Manual control took over'); padId = e.pointerId; pad.setPointerCapture(e.pointerId);
  pad.classList.add('active'); padMove(e);
});
pad.addEventListener('pointermove',e => { if (e.pointerId === padId) padMove(e); });
const endPad = e => {
  if (e.pointerId !== padId) return;
  clearInputs(); state.sent = ZERO; publishVelocity(ZERO);
};
['pointerup','pointercancel','lostpointercapture'].forEach(type => pad.addEventListener(type,endPad));
const KEYMAP = {ArrowUp:'up',w:'up',ArrowDown:'down',s:'down',ArrowLeft:'left',a:'left',ArrowRight:'right',d:'right'};
window.addEventListener('keydown',e => {
  if (e.key === 'Escape' && !e.target.closest('dialog')) { e.preventDefault(); emergency(); return; }
  if (e.target.closest('input,textarea,select,dialog') || document.querySelector('dialog[open]')) return;
  if (e.key === ' ') { e.preventDefault(); stopAll('Motion stopped',true); return; }
  const action = KEYMAP[e.key] || KEYMAP[e.key.toLowerCase()];
  if (action) { e.preventDefault(); if (!canDrive()) return; cancelMotion('Manual control took over'); keys.add(action); }
});
window.addEventListener('keyup',e => {
  const action = KEYMAP[e.key] || KEYMAP[e.key.toLowerCase()];
  if (action) { keys.delete(action); if (!keys.size) { state.sent = ZERO; publishVelocity(ZERO); } }
});
window.addEventListener('blur',() => stopAll('Window lost focus; motion stopped'));
document.addEventListener('visibilitychange',() => { if (document.hidden) { stopAll('App backgrounded; motion stopped'); stopVoice(); persistSession(); } else keepAwake(); });
function manualInput() {
  let x=joy.x,y=joy.y;
  if (keys.size) { x=Number(keys.has('right'))-Number(keys.has('left')); y=Number(keys.has('down'))-Number(keys.has('up')); }
  return Math.hypot(x,y) < .08 ? null : {lin:-clamp(y,-1,1)*maximum(),ang:-clamp(x,-1,1)*maximumTurn()};
}
function timedMove(lin,ang,ms) {
  if (!requireDrive()) return;
  clearInputs(); cancelMotion(); state.timed = {lin,ang,until:performance.now()+ms};
}
$('#spinBtn').addEventListener('click',() => { if (requireDrive()) { timedMove(0,maximumTurn()*.9,2200); log('Spinning in place'); } });
$('#speedRange').value = cfg.speed;
function syncSpeed() {
  $('#speedRange').value = cfg.speed; text('#speedLabel',cfg.speed+'%');
  $$('[data-profile]').forEach(b => { const active=b.dataset.profile===cfg.profile; b.classList.toggle('active',active); b.setAttribute('aria-pressed',String(active)); });
}
$('#speedRange').addEventListener('input',e => { cfg.speed=Number(e.target.value); syncSpeed(); queueConfig(); });
$$('[data-profile]').forEach(b => b.addEventListener('click',() => {
  cfg.profile=b.dataset.profile; cfg.speed={precision:35,normal:60,sport:100}[cfg.profile]; syncSpeed(); saveConfig(); log('Driving profile: '+cfg.profile,'info',false);
}));
$('#cruiseBtn').addEventListener('click',() => {
  if (cfg.mode !== 'sim') return;
  if (state.cruise) { stopAll('Cruise stopped',true); return; }
  if (!requireDrive()) return;
  clearInputs(); cancelMotion(); state.cruise=true; $('#cruiseBtn').setAttribute('aria-pressed','true'); log('Cruise enabled. Stop, manual input, or an obstacle cancels it.');
});

function startMission(m) {
  if (cfg.mode !== 'sim') { toast('Autonomous missions run in the simulator.','warn'); return; }
  if (!requireDrive(m.id==='dock')) return;
  const path = planRoute(robot,m.points,cfg.fence);
  if (!path?.length) { log('Route blocked by an obstacle or boundary. Choose another destination.','warn'); return; }
  clearInputs(); cancelMotion();
  state.mission={...m,points:m.points.map(p=>({...p})),path,index:0,started:performance.now(),lastProgress:performance.now(),bestDistance:Infinity};
  log('Mission started: '+m.name); navigate('dashboard');
}
function startHome() { startMission({id:'dock',name:'Return to dock',points:[DOCK],loop:false}); }
$('#homeBtn').addEventListener('click',startHome);
function missionCommand() {
  const m=state.mission, goal=m.path[m.index], distance=Math.hypot(goal.x-robot.x,goal.y-robot.y);
  if (distance < .09) {
    m.index++; m.lastProgress=performance.now(); m.bestDistance=Infinity;
    if (m.index >= m.path.length) {
      session.missions++; log(m.id==='dock' ? 'Docked. Recharging for the next adventure.' : 'Mission complete: '+m.name);
      if (m.loop) {
        const path=planRoute(robot,m.points,cfg.fence);
        if (path?.length) { m.path=path;m.index=0;m.started=performance.now();return ZERO; }
      }
      state.mission=null; return ZERO;
    }
    return ZERO;
  }
  if (distance < m.bestDistance-.025) { m.bestDistance=distance;m.lastProgress=performance.now(); }
  if (performance.now()-m.lastProgress>18000 || performance.now()-m.started>300000) {
    state.mission=null; log('Mission stopped: no progress. Check the route and speed limit.','warn'); return ZERO;
  }
  const error=wrapPi(Math.atan2(goal.y-robot.y,goal.x-robot.x)-robot.th);
  return {lin:Math.abs(error)>.5 ? 0 : Math.min(maximum()*.7,distance*.95)*Math.max(0,Math.cos(error*2)),ang:clamp(error*3,-maximumTurn(),maximumTurn())};
}
function command() {
  if (document.hidden || !canDrive(state.mission?.id==='dock')) return ZERO;
  const manual=manualInput();
  if (manual) { if (state.mission||state.timed||state.cruise) cancelMotion(); return manual; }
  if (state.timed) { if (performance.now()<state.timed.until) return {lin:clamp(state.timed.lin,-maximum(),maximum()),ang:clamp(state.timed.ang,-maximumTurn(),maximumTurn())}; state.timed=null; }
  if (state.mission) return missionCommand();
  if (state.cruise) return {lin:maximum()*.55,ang:0};
  return ZERO;
}
function renderMissions() {
  text('#missionCount',missions.length);
  const fragment=document.createDocumentFragment();
  for (const m of missions) {
    const card=node('article','library-card'), icon=node('div','library-icon');
    icon.innerHTML='<svg><use href="#i-route"/></svg>';
    card.append(icon,node('h3','',m.name),node('p','',m.points.length+' destinations · '+(m.loop ? 'Looping route' : 'Single run')+' · Simulator'));
    const actions=node('div','library-actions'), run=node('button','btn small primary','Run mission'), edit=node('button','btn small','Load on map'), remove=node('button','btn small delete-mission','Delete');
    run.disabled=cfg.mode!=='sim'; run.addEventListener('click',()=>startMission(m));
    edit.addEventListener('click',()=>{ state.draft=m.points.map(p=>({...p})); navigate('map'); setEditing(true); });
    remove.setAttribute('aria-label','Delete '+m.name);
    remove.addEventListener('click',()=>{ missions=missions.filter(x=>x.id!==m.id);storage.write('missions',missions);renderMissions();toast('Mission removed from this device.'); });
    actions.append(run,edit,remove);card.append(actions);fragment.append(card);
  }
  if (!missions.length) fragment.append(node('div','empty-state','Your mission library is waiting. Plot a route or record a drive to get started.'));
  $('#missionLibrary').replaceChildren(fragment);
}
$$('[data-preset]').forEach(b=>b.addEventListener('click',()=>startMission(presetMissions.find(m=>m.id===b.dataset.preset))));
function setEditing(on) {
  if (cfg.mode!=='sim' && on) {toast('Waypoints use the simulator arena.','warn');return;}
  state.editing=on; $('#waypointBtn').setAttribute('aria-pressed',String(on)); $('#waypointTray').hidden=!on;$('#mapHint').hidden=!on; updateWaypoints();
}
function updateWaypoints() {
  text('#waypointCount',state.draft.length+' waypoint'+(state.draft.length===1?'':'s'));
  $('#runWaypoints').disabled=$('#saveWaypoints').disabled=!state.draft.length;
}
$('#waypointBtn').addEventListener('click',()=>setEditing(!state.editing));
$('#clearWaypoints').addEventListener('click',()=>{state.draft=[];updateWaypoints();});
$('#runWaypoints').addEventListener('click',()=>startMission({id:'custom',name:'Custom route',points:state.draft,loop:false}));
function openMissionSave(points, source) {
  if (!points.length) {toast('Add at least one destination first.','warn');return;}
  stopAll();state.pendingSave=points.map(p=>({...p}));$('#missionName').value='';$('#missionLoop').checked=false;
  text('#missionSaveDetail',points.length+' destinations from '+source+'. Stored on this device.');
  $('#missionDialog').showModal();
}
$('#saveWaypoints').addEventListener('click',()=>openMissionSave(state.draft,'your map'));
$('#missionForm').addEventListener('submit',e=>{
  e.preventDefault();const name=$('#missionName').value.trim();
  if (!name || !state.pendingSave?.length) return;
  if (missions.length>=50) {toast('Your library is full. Remove a mission before saving.','warn');return;}
  const m={id:crypto.randomUUID(),name,points:state.pendingSave,loop:$('#missionLoop').checked};
  if (!validMission(m)) {toast('The route could not be saved.','error');return;}
  missions.push(m);const saved=storage.write('missions',missions);renderMissions();$('#missionDialog').close();
  log(saved?'Mission saved: '+name:'Mission available this session; device storage is unavailable.',saved?'info':'warn');
});
$('#recordBtn').addEventListener('click',()=>{
  if (cfg.mode!=='sim') return;
  if (!state.recording) {
    if (!requireDrive()) return;
    state.recording=true;state.record=[{x:robot.x,y:robot.y}];log('Route recording started');
  }
  else {
    state.recording=false;
    if (state.record.length<2) toast('Drive a little farther before saving a route.','warn');
    else openMissionSave(state.record,'your recorded drive');
  }
  $('#recordBtn').setAttribute('aria-pressed',String(state.recording));$('#recordBtn').lastChild.textContent=state.recording?' Stop recording':'Record route';
});
function planNew() {navigate('map');setEditing(true);toast('Tap the map to add destinations, then save or run your route.');}
$('#newMissionBtn').addEventListener('click',planNew);$('#planRouteBtn').addEventListener('click',planNew);$('#allMissionsBtn').addEventListener('click',()=>navigate('missions'));

function setLink(kind,label) {
  const pill=$('#linkPill');pill.className='pill '+kind;pill.replaceChildren(node('i'),document.createTextNode(label));text('#sidebarStatus',label);
}
function wsSend(message) {
  if (!connected()) return;
  try {state.ws.send(JSON.stringify(message));} catch {
    const failed = state.ws;
    state.ws = null;
    try { failed.close(); } catch {}
    emergency('Command transport failed. Controls locked.');
    setLink('off', 'Robot offline');
    if (state.wanted) {
      clearTimeout(state.retryTimer);
      state.retryTimer = setTimeout(connectWS, 1000);
    }
  }
}
function publishVelocity(c) {
  if (connected()) wsSend({op:'publish',topic:cfg.cmdTopic,msg:{linear:{x:c.lin,y:0,z:0},angular:{x:0,y:0,z:c.ang}}});
}
function closeWS() {
  state.wanted=false;clearTimeout(state.retryTimer);clearTimeout(state.connectTimer);
  publishVelocity(ZERO);
  const ws=state.ws;state.ws=null;
  if (ws) {ws.onclose=null;ws.onmessage=null;ws.onopen=null;try{ws.close();}catch{}}
}
function connectWS() {
  clearTimeout(state.retryTimer);state.wanted=true;setLink('wait',state.retry?'Reconnecting':'Connecting');
  let ws;
  try {ws=new WebSocket(cfg.wsUrl);} catch {setLink('off','Blocked');log('The browser blocked this robot connection. Check the address and secure connection settings.','error');state.wanted=false;return;}
  state.ws=ws;
  state.connectTimer=setTimeout(()=>{if(state.ws===ws && ws.readyState!==WebSocket.OPEN) ws.close();},5000);
  ws.onopen=()=>{
    if(state.ws!==ws)return;
    clearTimeout(state.connectTimer);state.retry=0;state.openedAt=performance.now();state.lastOdom=0;state.lastBattery=0;state.lastScan=0;state.scan=null;
    setLink('on','Robot connected');log('Robot connected. Waiting for odometry and a deliberate emergency-stop release.');
    wsSend({op:'advertise',topic:cfg.cmdTopic,type:'geometry_msgs/Twist'});publishVelocity(ZERO);
    const topics=[[cfg.odomTopic,'nav_msgs/Odometry',100],[cfg.batteryTopic,'sensor_msgs/BatteryState',1000],[cfg.scanTopic,'sensor_msgs/LaserScan',200],[cfg.imuTopic,'sensor_msgs/Imu',250],[cfg.diagnosticsTopic,'diagnostic_msgs/DiagnosticArray',1000]];
    topics.forEach(([topic,type,throttle_rate])=>{if(topic)wsSend({op:'subscribe',topic,type,throttle_rate,queue_length:1});});
  };
  ws.onmessage=event=>{
    if(state.ws!==ws || typeof event.data!=='string' || event.data.length>1000000)return;
    let m;try{m=JSON.parse(event.data);}catch{return;}
    if(m.op!=='publish'||!m.msg||typeof m.topic!=='string')return;
    if(![cfg.odomTopic,cfg.batteryTopic,cfg.scanTopic,cfg.imuTopic,cfg.diagnosticsTopic].includes(m.topic))return;
    const now=performance.now();
    state.topicMessages[m.topic]={received:new Date().toISOString(),msg:m.msg};
    if(m.topic===cfg.odomTopic){
      const odom=parseOdom(m.msg);if(!odom)return;
      const d=Math.hypot(odom.x-robot.x,odom.y-robot.y);
      if(state.lastOdom && d<5)session.distance+=d;
      Object.assign(robot,odom);state.lastOdom=now;state.count++;session.peak=Math.max(session.peak,Math.abs(robot.v));pushTrail();
    }else if(m.topic===cfg.batteryTopic){
      if(Number.isFinite(m.msg.percentage)&&m.msg.percentage>=0&&m.msg.percentage<=1){robot.battery=m.msg.percentage*100;robot.charging=m.msg.power_supply_status===1;state.lastBattery=now;}
    }else if(m.topic===cfg.scanTopic){
      const scan=parseScan(m.msg);if(scan){state.scan=scan;state.lastScan=now;}
    }else if(m.topic===cfg.imuTopic){
      const q=m.msg.orientation;
      if(q&&[q.x,q.y,q.z,q.w].every(Number.isFinite)){
        const n=Math.hypot(q.x,q.y,q.z,q.w);
        if(n>.001){const x=q.x/n,y=q.y/n,z=q.z/n,w=q.w/n;const roll=Math.atan2(2*(w*x+y*z),1-2*(x*x+y*y));const pitch=Math.asin(clamp(2*(w*y-z*x),-1,1));state.tilt=Math.max(Math.abs(roll),Math.abs(pitch))*180/Math.PI;state.lastImu=now;if(state.tilt>=30)emergency('Robot tilt exceeded 30°. Check the robot.');}
      }
    }else if(m.topic===cfg.diagnosticsTopic&&Array.isArray(m.msg.status)){
      state.faults=m.msg.status.filter(s=>s&&Number.isFinite(s.level)&&s.level>=2).slice(0,5).map(s=>String(s.name||'Robot fault')+': '+String(s.message||'Error'));
      state.lastDiagnostics=now;if(state.faults.length)emergency('Robot diagnostic fault: '+state.faults[0]);
    }
  };
  ws.onerror=()=>{};
  ws.onclose=()=>{
    if(state.ws!==ws)return;
    clearTimeout(state.connectTimer);state.ws=null;state.lastOdom=0;state.scan=null;
    emergency('Robot connection lost. Controls locked until reconnection and reset.');setLink('off','Robot offline');
    if(!state.wanted)return;
    const delay=Math.min(10000,1000*2**Math.min(state.retry++,4));
    log('Reconnecting in '+Math.round(delay/1000)+' seconds.','warn',false);state.retryTimer=setTimeout(connectWS,delay);
  };
}
function commsTick() {
  if(cfg.mode!=='ws')return;
  if(connected() && performance.now()-(state.lastOdom||state.openedAt)>cfg.timeout*1000 && !state.estop)emergency('Odometry is stale. Robot controls locked.');
  const target=command(),dt=.1;
  if(!canDrive()||document.hidden){state.sent=ZERO;}
  else state.sent={lin:state.sent.lin+clamp(target.lin-state.sent.lin,-cfg.accel*dt,cfg.accel*dt),ang:state.sent.ang+clamp(target.ang-state.sent.ang,-4*dt,4*dt)};
  // An idle heartbeat also carries zero velocity; reconnect always starts stopped.
  publishVelocity(state.sent);
}

function pushTrail() {
  const last=robot.trail.at(-1);
  if(!last||Math.hypot(robot.x-last.x,robot.y-last.y)>.07){robot.trail.push({x:robot.x,y:robot.y});if(robot.trail.length>700)robot.trail.shift();}
}
function sensorRays() {
  if(cfg.mode==='ws')return state.lastScan && performance.now()-state.lastScan<cfg.timeout*1000 ? state.scan : null;
  return Array.from({length:72},(_,i)=>{const angle=i*Math.PI*2/72;return{angle,distance:raycast(robot.x,robot.y,robot.th+angle,4).distance};});
}
function updateSensors() {
  const rays=sensorRays();state.nearest=rays?.length?Math.max(0,Math.min(...rays.map(r=>r.distance))-RADIUS):Infinity;
  state.forward=cfg.mode==='sim'?Math.min(...[-.22,0,.22].map(a=>raycast(robot.x,robot.y,robot.th+a,4).distance))-RADIUS:Infinity;
}
function collide() {
  const oldX=robot.x,oldY=robot.y,inset=Math.max(RADIUS,cfg.fence);
  robot.x=clamp(robot.x,inset,WORLD.w-inset);robot.y=clamp(robot.y,inset,WORLD.h-inset);
  for(const o of OBSTACLES){
    let cx=clamp(robot.x,o.x,o.x+o.w),cy=clamp(robot.y,o.y,o.y+o.h),dx=robot.x-cx,dy=robot.y-cy,d=Math.hypot(dx,dy);
    if(d<RADIUS){
      if(d===0){
        const edges=[{d:robot.x-o.x,x:o.x-RADIUS,y:robot.y},{d:o.x+o.w-robot.x,x:o.x+o.w+RADIUS,y:robot.y},{d:robot.y-o.y,x:robot.x,y:o.y-RADIUS},{d:o.y+o.h-robot.y,x:robot.x,y:o.y+o.h+RADIUS}].sort((a,b)=>a.d-b.d);
        robot.x=edges[0].x;robot.y=edges[0].y;
      }else{robot.x=cx+dx/d*RADIUS;robot.y=cy+dy/d*RADIUS;}
    }
  }
  if(Math.hypot(robot.x-oldX,robot.y-oldY)>.00001){
    robot.v=0;if(state.cruise)cancelMotion();
    if(performance.now()-state.lastBump>2000){state.lastBump=performance.now();log('Boundary or bumper contact. Motion stopped.','warn',false);}
  }
}
function stepSim(dt) {
  updateSensors();let c=command();
  if(robot.battery<=0)c=ZERO;
  if(cfg.proximityBrake && c.lin>0){
    if(state.forward<.32 && state.cruise){cancelMotion();c=ZERO;log('Cruise stopped at an obstacle.','warn');}
    else c={...c,lin:c.lin*clamp((state.forward-.07)/.35,0,1)};
  }
  if(state.estop||document.hidden){robot.v=robot.w=0;}
  else{
    robot.v+=clamp(c.lin-robot.v,-cfg.accel*dt,cfg.accel*dt);robot.w+=clamp(c.ang-robot.w,-4*dt,4*dt);
    robot.th=wrapPi(robot.th+robot.w*dt);
    const from={x:robot.x,y:robot.y};
    robot.x+=Math.cos(robot.th)*robot.v*dt;robot.y+=Math.sin(robot.th)*robot.v*dt;collide();
    session.distance+=Math.hypot(robot.x-from.x,robot.y-from.y);session.peak=Math.max(session.peak,Math.abs(robot.v));
  }
  pushTrail();
  robot.charging=Math.hypot(robot.x-DOCK.x,robot.y-DOCK.y)<.25 && Math.abs(robot.v)<.04 && Math.abs(robot.w)<.05;
  robot.battery=clamp(robot.battery+(robot.charging?2.5:-(.018+.13*Math.abs(robot.v)+.025*Math.abs(robot.w)))*dt,0,100);
  if(robot.battery>20){state.autoDockAttempted=false;state.batteryWarned=false;}
  if(robot.battery<=20&&!state.batteryWarned){state.batteryWarned=true;log('Battery below 20%. Time to think about docking.','warn');}
  if(robot.battery<=15&&cfg.autoDock&&!state.autoDockAttempted&&!robot.charging&&canDrive(true)){
    state.autoDockAttempted=true;startHome();
  }
  if(state.recording){
    const p=state.record.at(-1);
    if(Math.hypot(robot.x-p.x,robot.y-p.y)>.3 && state.record.length<500)state.record.push({x:robot.x,y:robot.y});
  }
}

// Canvas surfaces resize with their panels and use CSS pixels for all drawing.
const surfaces={};
function surface(id) {
  if(!surfaces[id]){
    const canvas=$(id),ctx=canvas.getContext('2d');
    const s={canvas,ctx,w:0,h:0,dpr:1};
    const resize=()=>{s.w=canvas.clientWidth;s.h=canvas.clientHeight;s.dpr=Math.min(window.devicePixelRatio||1,2);canvas.width=Math.round(s.w*s.dpr);canvas.height=Math.round(s.h*s.dpr);};
    new ResizeObserver(resize).observe(canvas);resize();surfaces[id]=s;
  }
  const s=surfaces[id];s.ctx.setTransform(s.dpr,0,0,s.dpr,0,0);return s;
}
let colors={};
function applyAppearance() {
  const light=cfg.theme==='light'||(cfg.theme==='system'&&matchMedia('(prefers-color-scheme: light)').matches);
  document.documentElement.dataset.theme=light?'light':'dark';document.body.classList.toggle('reduce-motion',cfg.reduceMotion);
  const style=getComputedStyle(document.documentElement);
  for(const key of ['bg','panel','raised','line','text','muted','accent','cyan','ok','warn','danger','map','grid'])colors[key]=style.getPropertyValue('--'+key).trim();
  $('meta[name="theme-color"]').content=colors.bg;
}
$('#themeBtn').addEventListener('click',()=>{cfg.theme=document.documentElement.dataset.theme==='light'?'dark':'light';applyAppearance();saveConfig();});
matchMedia('(prefers-color-scheme: light)').addEventListener('change',()=>{if(cfg.theme==='system')applyAppearance();});
const mapTransform={scale:1,ox:0,oy:0};
function mapPoint(x,y){return[mapTransform.ox+x*mapTransform.scale,mapTransform.oy-y*mapTransform.scale];}
function drawMap(now) {
  const {ctx:c,w:W,h:H}=surface('#stage');if(!W||!H)return;
  c.clearRect(0,0,W,H);c.fillStyle=colors.map;c.fillRect(0,0,W,H);
  const scale=(cfg.mode==='sim'?Math.min((W-45)/WORLD.w,(H-65)/WORLD.h):55)*state.zoom;
  mapTransform.scale=scale;
  mapTransform.ox=cfg.mode==='sim'&&!state.follow?(W-WORLD.w*scale)/2:W/2-robot.x*scale;
  mapTransform.oy=cfg.mode==='sim'&&!state.follow?(H+WORLD.h*scale)/2:H/2+robot.y*scale;
  const to=mapPoint;
  c.strokeStyle=colors.grid;c.lineWidth=.6;c.beginPath();
  const x0=cfg.mode==='sim'?0:Math.floor(robot.x-W/scale),x1=cfg.mode==='sim'?WORLD.w:Math.ceil(robot.x+W/scale);
  const y0=cfg.mode==='sim'?0:Math.floor(robot.y-H/scale),y1=cfg.mode==='sim'?WORLD.h:Math.ceil(robot.y+H/scale);
  for(let x=x0;x<=x1;x+=.5){const a=to(x,y0),b=to(x,y1);c.moveTo(...a);c.lineTo(...b);}
  for(let y=y0;y<=y1;y+=.5){const a=to(x0,y),b=to(x1,y);c.moveTo(...a);c.lineTo(...b);}c.stroke();
  if(cfg.mode==='sim'){
    const a=to(0,WORLD.h);c.strokeStyle=colors.line;c.lineWidth=1.5;c.strokeRect(...a,WORLD.w*scale,WORLD.h*scale);
    const f=to(cfg.fence,WORLD.h-cfg.fence);c.setLineDash([3,5]);c.strokeStyle=colors.muted;c.globalAlpha=.35;c.strokeRect(...f,(WORLD.w-2*cfg.fence)*scale,(WORLD.h-2*cfg.fence)*scale);c.globalAlpha=1;c.setLineDash([]);
    for(let i=0;i<OBSTACLES.length;i++){
      const o=OBSTACLES[i],p=to(o.x,o.y+o.h);
      c.fillStyle=colors.raised;c.strokeStyle=colors.line;c.lineWidth=1;
      c.beginPath();c.roundRect(p[0],p[1],o.w*scale,o.h*scale,4);c.fill();c.stroke();
      c.fillStyle=colors.muted;c.font='6px ui-monospace,monospace';c.textAlign='center';c.fillText('OBS 0'+(i+1),p[0]+o.w*scale/2,p[1]+o.h*scale/2+2);
    }
    const dp=to(DOCK.x,DOCK.y);
    c.fillStyle=colors.ok;c.globalAlpha=.07;c.beginPath();c.arc(...dp,DOCK.r*scale+3,0,Math.PI*2);c.fill();c.globalAlpha=1;
    c.setLineDash([3,3]);c.strokeStyle=colors.ok;c.beginPath();c.arc(...dp,DOCK.r*scale,0,Math.PI*2);c.stroke();c.setLineDash([]);
    c.fillStyle=colors.ok;c.font='bold 14px system-ui';c.textAlign='center';c.fillText('ϟ',dp[0],dp[1]+5);
    c.font='6px ui-monospace,monospace';c.fillText('CHARGING DOCK',dp[0],dp[1]+DOCK.r*scale+13);
  }
  function path(points,color,dashed=false){
    if(points.length<2)return;c.strokeStyle=color;c.lineWidth=1.5;c.setLineDash(dashed?[4,5]:[]);c.beginPath();
    points.forEach((p,i)=>{const s=to(p.x,p.y);i?c.lineTo(...s):c.moveTo(...s);});c.stroke();c.setLineDash([]);
  }
  if(cfg.showTrail){c.globalAlpha=.5;path(robot.trail,colors.cyan);c.globalAlpha=1;}
  if(state.mission)path([robot,...state.mission.path.slice(state.mission.index)],colors.accent,true);
  if(state.draft.length)path(state.draft,colors.cyan,true);
  state.draft.forEach((p,i)=>{const s=to(p.x,p.y);c.fillStyle=colors.map;c.strokeStyle=colors.cyan;c.beginPath();c.arc(...s,8,0,Math.PI*2);c.fill();c.stroke();c.fillStyle=colors.cyan;c.font='7px monospace';c.textAlign='center';c.fillText(String(i+1),s[0],s[1]+2.5);});
  const rp=to(robot.x,robot.y),r=Math.max(9,RADIUS*scale),rays=sensorRays();
  if(cfg.showSensors&&rays){c.globalAlpha=.15;c.strokeStyle=colors.cyan;c.lineWidth=.7;c.beginPath();rays.forEach(ray=>{const p=to(robot.x+Math.cos(robot.th+ray.angle)*ray.distance,robot.y+Math.sin(robot.th+ray.angle)*ray.distance);c.moveTo(...rp);c.lineTo(...p);});c.stroke();c.globalAlpha=1;}
  const decor=!cfg.reduceMotion&&!matchMedia('(prefers-reduced-motion: reduce)').matches;
  c.strokeStyle=state.estop?colors.danger:colors.accent;c.globalAlpha=.13;c.lineWidth=1;c.beginPath();c.arc(...rp,r+8+(decor?Math.sin(now/750)*2:0),0,Math.PI*2);c.stroke();c.globalAlpha=1;
  c.save();c.translate(...rp);c.rotate(-robot.th);
  c.fillStyle=colors.raised;c.strokeStyle=colors.line;c.beginPath();c.roundRect(-r*.55,-r*1.15,r*1.1,r*.35,2);c.roundRect(-r*.55,r*.8,r*1.1,r*.35,2);c.fill();c.stroke();
  c.fillStyle=state.estop?colors.danger:colors.accent;c.shadowColor=c.fillStyle;c.shadowBlur=14;c.beginPath();c.arc(0,0,r,0,Math.PI*2);c.fill();c.shadowBlur=0;
  c.fillStyle=colors.bg;c.beginPath();c.moveTo(r*.65,0);c.lineTo(-r*.3,-r*.35);c.lineTo(-r*.3,r*.35);c.closePath();c.fill();c.restore();
  c.fillStyle=colors.text;c.font='7px ui-monospace,monospace';c.textAlign='center';c.fillText(cfg.name.toUpperCase(),rp[0],rp[1]+r+21);
  if(cfg.mode==='ws'&&!freshOdom()){c.fillStyle=colors.muted;c.font='11px system-ui';c.fillText('Waiting for fresh robot odometry',W/2,H-35);}
  $('.map-scale span').style.width=scale+'px';
}
$('#stage').addEventListener('pointerdown',e=>{
  if(!state.editing||cfg.mode!=='sim')return;
  const r=e.currentTarget.getBoundingClientRect(),p={x:(e.clientX-r.left-mapTransform.ox)/mapTransform.scale,y:(mapTransform.oy-(e.clientY-r.top))/mapTransform.scale};
  if(!clearPoint(p,cfg.fence)){toast('Choose a point clear of obstacles and the boundary.','warn');return;}
  if(state.draft.length>=50){toast('A map route can have up to 50 destinations.','warn');return;}
  state.draft.push(p);updateWaypoints();
});
$('#followBtn').addEventListener('click',()=>{state.follow=!state.follow;$('#followBtn').setAttribute('aria-pressed',String(state.follow));});
function zoom(delta){state.zoom=clamp(Math.round((state.zoom+delta)*10)/10,.7,2.5);text('#zoomLabel',Math.round(state.zoom*100)+'%');}
$('#zoomIn').addEventListener('click',()=>zoom(.2));$('#zoomOut').addEventListener('click',()=>zoom(-.2));
$('#fullscreenBtn').addEventListener('click',async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else await $('.map-panel').requestFullscreen();}catch{toast('Fullscreen is unavailable in this browser.','warn');}});

function drawSensors(now) {
  const {ctx:c,w:W,h:H}=surface('#sensorCanvas');if(!W||!H)return;
  c.clearRect(0,0,W,H);const cx=W/2,cy=H/2,r=Math.min(W,H)/2-5;
  c.strokeStyle=colors.grid;c.lineWidth=1;
  for(let i=1;i<=3;i++){c.beginPath();c.arc(cx,cy,r*i/3,0,Math.PI*2);c.stroke();}
  c.beginPath();c.moveTo(cx-r,cy);c.lineTo(cx+r,cy);c.moveTo(cx,cy-r);c.lineTo(cx,cy+r);c.stroke();
  const rays=sensorRays();
  if(rays){
    c.fillStyle=colors.accent;
    for(const ray of rays){const angle=ray.angle-Math.PI/2,d=Math.min(ray.distance,4)/4*r;c.globalAlpha=.25+.6*(1-d/r);c.beginPath();c.arc(cx+Math.cos(angle)*d,cy+Math.sin(angle)*d,1.5,0,Math.PI*2);c.fill();}
    c.globalAlpha=1;c.fillStyle=colors.cyan;c.beginPath();c.arc(cx,cy,3,0,Math.PI*2);c.fill();
    if(!cfg.reduceMotion&&!matchMedia('(prefers-reduced-motion: reduce)').matches){const a=now/1200;c.globalAlpha=.2;c.strokeStyle=colors.accent;c.beginPath();c.moveTo(cx,cy);c.lineTo(cx+Math.cos(a)*r,cy+Math.sin(a)*r);c.stroke();c.globalAlpha=1;}
  }else{c.fillStyle=colors.muted;c.font='9px system-ui';c.textAlign='center';c.fillText('No scan data',cx,cy);}
}
function drawCamera() {
  if(cfg.mode!=='sim')return;
  const {ctx:c,w:W,h:H}=surface('#cameraCanvas');if(!W||!H)return;
  c.fillStyle=colors.map;c.fillRect(0,0,W,H);c.fillStyle=colors.raised;c.fillRect(0,H*.53,W,H*.47);
  const strips=80;
  for(let i=0;i<strips;i++){
    const offset=(i/strips-.5)*Math.PI*.65,hit=raycast(robot.x,robot.y,robot.th-offset,16),distance=Math.max(.08,hit.distance*Math.cos(offset));
    const h=Math.min(H,H*.6/distance),x=i*W/strips;
    c.fillStyle=hit.obstacle>0?colors.cyan:colors.muted;c.globalAlpha=clamp(.75-distance*.07,.12,.65);c.fillRect(x,(H-h)/2,W/strips+1,h);
  }
  c.globalAlpha=1;c.strokeStyle=colors.line;c.beginPath();c.moveTo(0,H*.53);c.lineTo(W,H*.53);c.stroke();
}
function drawChart() {
  const {ctx:c,w:W,h:H}=surface('#telemetryChart');if(!W||!H)return;
  c.clearRect(0,0,W,H);const metric=state.chart,max=metric==='battery'?100:metric==='heading'?360:Math.max(1,...state.samples.map(s=>s.speed));
  const left=38,right=W-18,top=6,bottom=H-23;
  c.font='7px ui-monospace,monospace';c.textAlign='right';
  for(let i=0;i<4;i++){const y=top+(bottom-top)*i/3;c.strokeStyle=colors.grid;c.beginPath();c.moveTo(left,y);c.lineTo(right,y);c.stroke();c.fillStyle=colors.muted;c.fillText((max*(1-i/3)).toFixed(metric==='speed'?1:0),left-8,y+3);}
  c.textAlign='center';for(let i=0;i<5;i++)c.fillText(i===4?'now':String(60-i*15)+'s',left+(right-left)*i/4,H-7);
  const now=Date.now(),points=state.samples.filter(s=>Number.isFinite(s[metric])).map(s=>({x:left+clamp(1-(now-s.stamp)/60000,0,1)*(right-left),y:bottom-clamp(s[metric]/max,0,1)*(bottom-top)}));
  if(points.length){
    const gradient=c.createLinearGradient(0,top,0,bottom);gradient.addColorStop(0,colors.accent+'35');gradient.addColorStop(1,colors.accent+'00');
    c.fillStyle=gradient;c.beginPath();c.moveTo(points[0].x,bottom);points.forEach(p=>c.lineTo(p.x,p.y));c.lineTo(points.at(-1).x,bottom);c.closePath();c.fill();
    c.strokeStyle=colors.accent;c.lineWidth=1.7;c.beginPath();points.forEach((p,i)=>i?c.lineTo(p.x,p.y):c.moveTo(p.x,p.y));c.stroke();
    c.fillStyle=colors.accent;c.beginPath();c.arc(points.at(-1).x,points.at(-1).y,2.5,0,Math.PI*2);c.fill();
  }
  const s=surface('#speedSpark');s.ctx.clearRect(0,0,s.w,s.h);s.ctx.strokeStyle=colors.accent;s.ctx.lineWidth=1.3;s.ctx.beginPath();
  state.samples.slice(-20).forEach((p,i,arr)=>{const x=i/Math.max(1,arr.length-1)*s.w,y=s.h-2-p.speed*(s.h-5);i?s.ctx.lineTo(x,y):s.ctx.moveTo(x,y);});s.ctx.stroke();
}
$$('[data-chart]').forEach(b=>b.addEventListener('click',()=>{state.chart=b.dataset.chart;$$('[data-chart]').forEach(x=>x.classList.toggle('active',x===b));updateUI();drawChart();}));

function updateCameraSource() {
  const sim=cfg.mode==='sim',feed=$('#cameraFeed');
  $('#cameraCanvas').hidden=!sim;feed.hidden=sim||!cfg.cameraUrl;$('#cameraEmpty').hidden=sim||Boolean(cfg.cameraUrl);
  text('#cameraSource',sim?'First-person simulator view':'Your configured camera stream');
  text('#cameraBadge',sim?'SIMULATED VIEW':'ROBOT CAMERA');
  feed.removeAttribute('src');if(!sim&&cfg.cameraUrl)feed.src=cfg.cameraUrl;
}
$('#cameraFeed').addEventListener('error',()=>{if(cfg.mode!=='ws'||!cfg.cameraUrl)return;$('#cameraFeed').hidden=true;$('#cameraEmpty').hidden=false;text('#cameraEmpty','Camera unavailable. Check its URL, connection, and image/MJPEG format.');log('Camera stream unavailable.','warn');});
function diagnosticsUI() {
  const now=performance.now();
  const items=[
    ['Control mode',cfg.mode==='sim'?'Simulator':'rosbridge'],
    ['Safety interlock',state.estop?'Emergency stop latched':'Ready'],
    ['Odometry',cfg.mode==='sim'?'Local physics':state.lastOdom?((now-state.lastOdom)/1000).toFixed(1)+' s ago':'Waiting for data'],
    ['Boundary',cfg.mode==='sim'?cfg.fence.toFixed(1)+' m inset':'Robot-side controller required'],
    ['Tilt / IMU',cfg.mode==='sim'?'Level (simulated)':state.lastImu&&now-state.lastImu<cfg.timeout*1000?state.tilt.toFixed(1)+'°':'No fresh IMU data'],
    ['Diagnostics',cfg.mode==='sim'?'Simulator ready':state.lastDiagnostics&&now-state.lastDiagnostics<5000?(state.faults.length?state.faults.length+' fault(s)':'No reported faults'):'No fresh diagnostics'],
  ];
  const fragment=document.createDocumentFragment();items.forEach(([k,v])=>{const d=node('div');d.append(node('dt','',k),node('dd','',v));fragment.append(d);});$('#diagnostics').replaceChildren(fragment);
  const bad=state.estop||hardwareFault();text('#healthBadge',bad?'Needs attention':'Healthy');$('#healthBadge').className='pill '+(bad?'off':'sim');
  if(Object.keys(state.topicMessages).length)text('#topicMonitor',JSON.stringify(state.topicMessages,null,2).slice(0,14000));
}
function updateUI() {
  const now=performance.now(),live=cfg.mode==='sim'||freshOdom(),heading=((robot.th*180/Math.PI)%360+360)%360;
  if(now-state.rateAt>=1000){state.rate=state.count*1000/(now-state.rateAt);state.count=0;state.rateAt=now;}
  if(cfg.mode==='ws' && state.lastBattery && now-state.lastBattery>10000){robot.battery=NaN;robot.charging=false;}
  if(cfg.mode==='ws')updateSensors();
  const b=robot.battery,known=Number.isFinite(b);
  text('#tSpeed',live?Math.abs(robot.v).toFixed(2):'—');text('#tTurn',live?Math.round(robot.w*180/Math.PI):'—');text('#tHeading',live?Math.round(heading):'—');
  text('#tPos',live?'X '+robot.x.toFixed(2)+' · Y '+robot.y.toFixed(2):'Waiting for odometry');$('#compass').style.transform='rotate('+heading+'deg)';
  text('#tBattery',known?Math.round(b):'—');$('#batBar').style.width=known?b+'%':'0%';$('#batBar').style.background=known&&b<=20?colors.warn:colors.accent;
  $('#chargingBadge').hidden=!robot.charging;
  text('#batteryStatus',!known?'Awaiting battery data':robot.charging?'Charging at the dock':b<=5?'Critical — dock to recharge':b<=20?'Low battery — return to dock':'Ready to explore');
  text('#tDistance',session.distance.toFixed(2));text('#maxSpeed','Peak '+session.peak.toFixed(2)+' m/s');text('#tRate',cfg.mode==='sim'?'10':Math.round(state.rate));
  text('#motionStatus',state.estop?'Safety stop':Math.abs(robot.v)>.02?'On the move':'Standing by');
  text('#linkDetail',cfg.mode==='sim'?'Local simulation':connected()?'rosbridge connected':'Disconnected');
  text('#telemetryAge',cfg.mode==='sim'?'Live':state.lastOdom?Math.round(now-state.lastOdom)+' ms ago':'No data');
  const status=state.estop?'E-stop':state.mission?(state.mission.id==='dock'?'Docking':'Mission'):state.cruise?'Cruise':state.timed?'Command':Math.abs(robot.v)>.02?'Driving':'Ready';
  text('#driveStatus',status);$('#driveStatus').className='pill '+(state.estop?'off':'neutral');text('#mapMode',status.toUpperCase()+(status==='Ready'?' · MANUAL CONTROL':''));
  if(state.mission){
    const m=state.mission;text('#activeMissionName',m.name);text('#activeMissionDetail','Route point '+(m.index+1)+' of '+m.path.length+(m.loop?' · Looping':''));$('#missionProgress').style.width=m.index/m.path.length*100+'%';
  }else{
    text('#activeMissionName',robot.charging?'A little rest. A fresh charge.':'Ready for an adventure');text('#activeMissionDetail',state.estop?'Release emergency stop to begin.':'Pick a mission or plot your own route.');$('#missionProgress').style.width='0%';
  }
  text('#recordStatus',state.recording?'Recording · '+state.record.length+' points':'Capture a drive to replay later');
  const near=state.nearest;text('#nearestObstacle',Number.isFinite(near)?near.toFixed(2)+' m':'—');
  text('#proximityStatus',!Number.isFinite(near)?'Waiting for scan data':near<.25?'Obstacle close by':near<.7?'Mind your surroundings':'Room to explore');
  text('#safetyStatus',state.estop?'Emergency stop active':cfg.mode==='sim'?'Boundary & bumper active':'Telemetry interlock active');
  text('#sensorSource',cfg.mode==='sim'?'Simulated proximity scanner':cfg.scanTopic?'LaserScan · '+cfg.scanTopic:'No scan topic configured');
  text('#sensorStatus',cfg.mode==='sim'?'Simulator':Number.isFinite(near)?'Live scan':'Awaiting scan');
  const warning=state.estop?state.reason:known&&b<=5?'Battery critical. Manual driving is locked; docking remains available.':'';
  $('#safetyBanner').hidden=!warning;text('#safetyBanner',warning);text('#footerStatus',state.estop?'Controls safely stopped':'All systems ready');
  text('#sessionClock','SESSION '+duration((Date.now()-session.started)/1000));
  const metric=state.chart,value=metric==='speed'?(live?Math.abs(robot.v).toFixed(2):'—'):metric==='battery'?(known?Math.round(b):'—'):(live?Math.round(heading):'—');
  const chartValue=$('#chartValue');chartValue.replaceChildren(document.createTextNode(value+' '),node('small','',metric==='speed'?'m/s':metric==='battery'?'%':'°'));
  if(now-state.lastSample>=1000){
    state.lastSample=now;const sample={time:new Date().toISOString(),stamp:Date.now(),x:live?robot.x:null,y:live?robot.y:null,speed:live?Math.abs(robot.v):null,turn:live?robot.w:null,heading:live?heading:null,battery:known?b:null};
    state.samples.push(sample);state.samples=state.samples.filter(s=>Date.now()-s.stamp<=60000);state.archive.push(sample);if(state.archive.length>3600)state.archive.shift();diagnosticsUI();
  }
}

function navigate(page, hash=true) {
  if(page==='settings'){openSettings();return;}
  if(!['dashboard','map','drive','missions','logs'].includes(page))page='dashboard';
  if(state.page!==page){clearInputs();if(!state.mission)stopAll();}
  state.page=page;document.body.dataset.page=page;
  const names={dashboard:'Overview',map:'Live map',drive:'Drive control',missions:'Missions',logs:'Activity & logs'};
  text('#breadcrumbPage',names[page]);
  const titles={dashboard:['A little robot. ','Big possibilities.'],map:['A world to explore. ','One waypoint at a time.'],drive:['Take the wheel. ','Make your move.'],missions:['Small plans. ','Great adventures.'],logs:['Every move. ','Part of the story.']};
  $('#pageTitle').replaceChildren(document.createTextNode(titles[page][0]),node('span','',titles[page][1]));
  text('#pageSubtitle',page==='missions'?'Build, save, and replay your favorite routes.':page==='logs'?'Telemetry, activity, and sessions, saved on this device.':'Explore, drive, and build your next mission. You’re in control.');
  $$('[data-nav]').forEach(b=>{const active=b.dataset.nav===page;b.classList.toggle('active',active);if(active)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');});
  $('#missionsPage').hidden=page!=='missions';$('#historyPage').hidden=page!=='logs';
  if(page==='missions')renderMissions();if(page==='logs')renderSessions();
  if(hash)history.replaceState(null,'','#'+page);
}
$$('[data-nav]').forEach(b=>b.addEventListener('click',()=>navigate(b.dataset.nav)));
window.addEventListener('hashchange',()=>navigate(location.hash.slice(1),false));

function settingsTab(tab) {
  $$('[data-settings-tab]').forEach(b=>b.classList.toggle('active',b.dataset.settingsTab===tab));
  $$('[data-settings-panel]').forEach(p=>p.hidden=p.dataset.settingsPanel!==tab);
}
$$('[data-settings-tab]').forEach(b=>b.addEventListener('click',()=>settingsTab(b.dataset.settingsTab)));
function syncSettingsLabels() {
  text('#timeoutLabel',$('#timeoutRange').value+' seconds');text('#accelLabel',$('#accelRange').value+' m/s²');text('#fenceLabel',$('#fenceRange').value+' m');
  $('#wsFields').disabled=$('#settingsForm').elements.mode.value!=='ws';
}
function openSettings() {
  stopAll('Settings opened; motion stopped');stopVoice();
  const mapping={robotName:'name',wsUrl:'wsUrl',cmdTopic:'cmdTopic',odomTopic:'odomTopic',batteryTopic:'batteryTopic',scanTopic:'scanTopic',imuTopic:'imuTopic',diagnosticsTopic:'diagnosticsTopic',cameraUrl:'cameraUrl',timeoutRange:'timeout',accelRange:'accel',fenceRange:'fence',themeSelect:'theme'};
  for(const [id,key] of Object.entries(mapping))$('#'+id).value=cfg[key];
  for(const key of ['autoDock','proximityBrake','reduceMotion','showTrail','showSensors'])$('#'+key).checked=cfg[key];
  $('#settingsForm').elements.mode.value=cfg.mode;$('#settingsError').hidden=true;syncSettingsLabels();settingsTab('connection');$('#settings').showModal();
}
$('#settingsBtn').addEventListener('click',openSettings);$('#cameraSettingsBtn').addEventListener('click',openSettings);
$('#settingsForm').addEventListener('input',syncSettingsLabels);
$('#settingsForm').addEventListener('submit',e=>{
  e.preventDefault();
  const next={...cfg,mode:e.currentTarget.elements.mode.value,name:$('#robotName').value.trim(),timeout:Number($('#timeoutRange').value),accel:Number($('#accelRange').value),fence:Number($('#fenceRange').value),theme:$('#themeSelect').value};
  for(const key of ['wsUrl','cmdTopic','odomTopic','batteryTopic','scanTopic','imuTopic','diagnosticsTopic','cameraUrl'])next[key]=$('#'+key).value.trim();
  for(const key of ['autoDock','proximityBrake','reduceMotion','showTrail','showSensors'])next[key]=$('#'+key).checked;
  const error=validateConfig(next,location.protocol==='https:');
  if(error){settingsTab('connection');$('#settingsError').hidden=false;text('#settingsError',error);return;}
  const transportChanged=['mode','wsUrl','cmdTopic','odomTopic','batteryTopic','scanTopic','imuTopic','diagnosticsTopic'].some(key=>cfg[key]!==next[key]);
  if(transportChanged){stopAll();closeWS();persistSession();}
  cfg=next;saveConfig();applyAppearance();text('#robotNameSide',cfg.name);
  if(transportChanged){beginSession();applyMode();}
  else {if(cfg.mode==='sim')collide();updateCameraSource();}
  $('#settings').close();log('Workspace settings saved');renderMissions();
});
$$('[data-close]').forEach(b=>b.addEventListener('click',()=>$('#'+b.dataset.close).close()));
$('#resetSimBtn').addEventListener('click',()=>{
  if(cfg.mode!=='sim'){toast('Switch to simulator mode first.','warn');return;}
  stopAll();persistSession();beginSession();resetSim();log('Simulator reset. A fresh adventure awaits.');$('#settings').close();
});
function resetSim() {
  Object.assign(robot,{x:2.2,y:2,th:.3,v:0,w:0,battery:92,charging:false,trail:[]});
  state.recording=false;state.record=[];$('#recordBtn').setAttribute('aria-pressed','false');$('#recordBtn').lastChild.textContent='Record route';
  state.autoDockAttempted=false;state.batteryWarned=false;
}
function applyMode() {
  stopAll();closeWS();state.lastOdom=state.lastBattery=state.lastScan=state.lastImu=state.lastDiagnostics=0;state.scan=null;state.tilt=null;state.faults=[];state.topicMessages={};state.count=state.rate=0;
  state.follow=cfg.mode==='ws';$('#followBtn').setAttribute('aria-pressed',String(state.follow));state.recording=false;setEditing(false);robot.trail=[];
  for(const id of ['homeBtn','cruiseBtn','recordBtn','waypointBtn'])$('#'+id).disabled=cfg.mode!=='sim';
  $$('[data-preset]').forEach(b=>b.disabled=cfg.mode!=='sim');
  if(cfg.mode==='sim'){resetSim();setLink('sim','Simulator');text('#hudMode','Simulator · 10 × 6 meters');}
  else {Object.assign(robot,{x:0,y:0,th:0,v:0,w:0,battery:NaN,charging:false});emergency('Robot controls locked. Connect, receive odometry, then release emergency stop.');text('#hudMode','Robot odometry · follow view');connectWS();}
  updateCameraSource();renderMissions();text('#robotNameSide',cfg.name);
}

// Voice commands use bounded movements. A spoken reset opens the same release dialog.
const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
let recognition=null,listening=false;
function setListening(on) {
  listening=on;$('#micBtn').setAttribute('aria-pressed',String(on));$('#micBtn span').textContent=on?'Listening':'Voice';
}
function stopVoice() {setListening(false);try{recognition?.abort();}catch{}}
function handleVoice(words) {
  log('Heard: “'+words+'”','voice',false);
  if(/\b(emergency|e stop)\b/.test(words)){emergency();return;}
  if(/\b(reset|resume)\b/.test(words)){stopAll();if(state.estop)$('#resetDialog').showModal();return;}
  if(/\b(stop|halt|freeze|wait)\b/.test(words)){stopAll('Voice: motion stopped',true);return;}
  if(!requireDrive())return;
  if(/\b(home|dock|charge)\b/.test(words))startHome();
  else if(/\bspin\b|turn around/.test(words))timedMove(0,maximumTurn()*.8,2200);
  else if(/\bleft\b/.test(words))timedMove(0,maximumTurn()*.7,600);
  else if(/\bright\b/.test(words))timedMove(0,-maximumTurn()*.7,600);
  else if(/\b(back|backward|backwards|reverse)\b/.test(words))timedMove(-maximum()*.5,0,1200);
  else if(/\b(forward|forwards|ahead|go)\b/.test(words))timedMove(maximum()*.6,0,1500);
  else toast('Try “forward”, “turn left”, “go home”, or “stop”.','warn');
}
if(!SR){$('#micBtn').disabled=true;$('#micBtn').title='Voice input is unavailable in this browser.';}
else $('#micBtn').addEventListener('click',()=>{
  if(listening){stopVoice();return;}
  if(!requireDrive())return;
  recognition=new SR();recognition.lang='en-US';recognition.continuous=true;recognition.interimResults=false;
  recognition.onresult=e=>{for(let i=e.resultIndex;i<e.results.length;i++)if(e.results[i].isFinal)handleVoice(e.results[i][0].transcript.trim().toLowerCase());};
  recognition.onerror=e=>{if(e.error==='aborted')return;stopVoice();log('Voice input: '+e.error,'warn');};
  recognition.onend=()=>{setListening(false);};try{recognition.start();setListening(true);log('Voice control enabled');}catch{log('Microphone could not start.','warn');}
});
$('#helpBtn').addEventListener('click',()=>{stopAll();$('#welcome').showModal();});
$('#startExploring').addEventListener('click',()=>{$('#welcome').close();storage.write('welcomed',true);});
let installEvent=null;
window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();installEvent=e;$('#installBtn').hidden=false;});
$('#installBtn').addEventListener('click',async()=>{if(!installEvent)return;await installEvent.prompt();await installEvent.userChoice;installEvent=null;$('#installBtn').hidden=true;});
window.addEventListener('appinstalled',()=>{$('#installBtn').hidden=true;log('RobotPilot installed. Ready for your next adventure.');});
function network(){text('#networkState',navigator.onLine?'Local workspace':'Offline · cached workspace');}
window.addEventListener('online',()=>{network();log('Network back online','info',false);});
window.addEventListener('offline',()=>{network();log('Network offline. The simulator keeps working.','warn');});
let wake=null;
async function keepAwake(){try{if('wakeLock' in navigator&&!wake&&!document.hidden){wake=await navigator.wakeLock.request('screen');wake.addEventListener('release',()=>{wake=null;});}}catch{}}
document.addEventListener('pointerdown',keepAwake);
window.addEventListener('pagehide',()=>{stopAll();persistSession();saveConfig();storage.write('events',events);});
if('serviceWorker' in navigator)window.addEventListener('load',()=>navigator.serviceWorker.register('sw.js').catch(()=>log('Offline cache is unavailable in this browser.','warn',false)));

applyAppearance();beginSession();syncSpeed();applyMode();network();navigate(location.hash.slice(1)||'dashboard',false);renderEvents();updateUI();
if(!storage.read('welcomed',false)&&cfg.mode==='sim')$('#welcome').showModal();
log(cfg.mode==='sim'?'Workspace ready. Pick a mission, or take the wheel.':'Robot workspace ready.','info',false);
let lastFrame=performance.now(),lastDraw=0;
function frame(now){
  const dt=Math.min(.05,(now-lastFrame)/1000);lastFrame=now;
  if(cfg.mode==='sim')stepSim(dt);
  if(now-lastDraw>33&&!document.hidden){drawMap(now);drawSensors(now);drawCamera();lastDraw=now;}
  requestAnimationFrame(frame);
}
setInterval(()=>{commsTick();updateUI();},100);
setInterval(drawChart,500);setInterval(()=>{persistSession();if(state.page==='logs')renderSessions();},10000);
requestAnimationFrame(frame);
