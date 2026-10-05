// Pure geometry, planning, and validation shared by the UI and automated tests.
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export const wrapPi = a => Math.atan2(Math.sin(a), Math.cos(a));
export const WORLD = { w: 10, h: 6 };
export const DOCK = { x: 1.15, y: 1.15, r: 0.42 };
export const RADIUS = 0.28;
export const OBSTACLES = [
  { x: 4, y: 2, w: 0.9, h: 0.9 },
  { x: 6.5, y: 3.8, w: 1.2, h: 0.7 },
  { x: 3, y: 4.4, w: 0.7, h: 0.7 },
  { x: 8, y: 1.2, w: 0.7, h: 1.4 },
];
export const DEFAULTS = Object.freeze({
  mode: 'sim', name: 'Rover One', wsUrl: 'ws://localhost:9090',
  cmdTopic: '/cmd_vel', odomTopic: '/odom', batteryTopic: '/battery_state',
  scanTopic: '/scan', imuTopic: '/imu', diagnosticsTopic: '/diagnostics',
  cameraUrl: '', timeout: 2, accel: 1.2, fence: 0.3, autoDock: true,
  proximityBrake: true, theme: 'dark', reduceMotion: false, showTrail: true,
  showSensors: false, speed: 60, profile: 'normal',
});
export function validURL(value, protocols) {
  try {
    const url = new URL(value);
    return protocols.includes(url.protocol) && Boolean(url.hostname) && !url.username && !url.password;
  } catch { return false; }
}
export function validateConfig(c, secure = false) {
  if (!['sim', 'ws'].includes(c.mode)) return 'Choose a valid connection mode.';
  if (typeof c.name !== 'string' || !c.name.trim() || c.name.length > 32) return 'Enter a robot name, up to 32 characters.';
  if (c.mode === 'ws') {
    if (!validURL(c.wsUrl, ['ws:', 'wss:'])) return 'Enter a valid ws:// or wss:// address without embedded credentials.';
    if (secure && c.wsUrl.startsWith('ws:')) return 'This secure page needs a wss:// robot address.';
    const topics = ['cmdTopic', 'odomTopic', 'batteryTopic', 'scanTopic', 'imuTopic', 'diagnosticsTopic'];
    for (const key of topics) {
      if (!c[key] && !['cmdTopic', 'odomTopic'].includes(key)) continue;
      if (typeof c[key] !== 'string' || !/^\/[A-Za-z_][A-Za-z0-9_/]*$/.test(c[key])) return 'Use absolute ROS topics such as /cmd_vel. Optional sensor topics may be blank.';
    }
    const enabled = topics.map(k => c[k]).filter(Boolean);
    if (new Set(enabled).size !== enabled.length) return 'Each configured topic must be different.';
    if (c.cameraUrl && !validURL(c.cameraUrl, ['http:', 'https:'])) return 'Enter an HTTP(S) camera URL without embedded credentials.';
    if (secure && c.cameraUrl.startsWith('http:')) return 'This secure page needs an HTTPS camera URL.';
  }
  for (const [key, min, max] of [['timeout', 1, 5], ['accel', .3, 3], ['fence', .3, 1], ['speed', 10, 100]]) {
    if (!Number.isFinite(c[key]) || c[key] < min || c[key] > max) return 'A driving or timeout setting is outside its allowed range.';
  }
  if (!['dark', 'light', 'system'].includes(c.theme)) return 'Choose a valid theme.';
  if (!['precision', 'normal', 'sport'].includes(c.profile)) return 'Choose a valid driving profile.';
  return '';
}
export function normalizeConfig(value) {
  const c = { ...DEFAULTS };
  if (!value || typeof value !== 'object') return c;
  for (const key of Object.keys(c)) {
    if (typeof value[key] === typeof c[key]) c[key] = value[key];
  }
  if (validateConfig(c)) return { ...DEFAULTS };
  return c;
}
export function clearPoint(p, fence = .3, radius = RADIUS + .08) {
  if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return false;
  const inset = Math.max(fence, radius);
  if (p.x < inset || p.y < inset || p.x > WORLD.w - inset || p.y > WORLD.h - inset) return false;
  return !OBSTACLES.some(o => Math.hypot(p.x - clamp(p.x, o.x, o.x + o.w), p.y - clamp(p.y, o.y, o.y + o.h)) < radius);
}
export function clearSegment(a, b, fence = .3, radius = RADIUS + .08) {
  const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / .025));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    if (!clearPoint({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, fence, radius)) return false;
  }
  return true;
}
// A* on a clearance-aware grid, then collapse only collision-free segments.
export function planPath(start, goal, fence = .3) {
  if (!clearPoint(start, fence) || !clearPoint(goal, fence)) return null;
  if (clearSegment(start, goal, fence)) return [{ ...goal }];
  const step = .2, cols = 51, rows = 31;
  const point = id => ({ x: (id % cols) * step, y: Math.floor(id / cols) * step });
  const nearest = p => {
    let best = -1, distance = Infinity;
    for (let id = 0; id < cols * rows; id++) {
      const q = point(id), d = Math.hypot(p.x - q.x, p.y - q.y);
      if (d < distance && clearPoint(q, fence) && clearSegment(p, q, fence)) { best = id; distance = d; }
    }
    return best;
  };
  const from = nearest(start), to = nearest(goal);
  if (from < 0 || to < 0) return null;
  const open = new Set([from]), cost = new Map([[from, 0]]), parent = new Map(), closed = new Set();
  while (open.size) {
    let current = -1, score = Infinity;
    for (const id of open) {
      const p = point(id), h = Math.hypot(p.x - goal.x, p.y - goal.y);
      const f = cost.get(id) + h;
      if (f < score) { score = f; current = id; }
    }
    if (current === to) {
      const path = [goal];
      let id = to;
      while (id !== from) { path.unshift(point(id)); id = parent.get(id); }
      path.unshift(point(from));
      const smooth = [];
      let anchor = start, i = 0;
      while (i < path.length) {
        let j = path.length - 1;
        while (j > i && !clearSegment(anchor, path[j], fence)) j--;
        smooth.push({ ...path[j] }); anchor = path[j]; i = j + 1;
      }
      return smooth;
    }
    open.delete(current); closed.add(current);
    const x = current % cols, y = Math.floor(current / cols), a = point(current);
    for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]]) {
      if (x + dx < 0 || x + dx >= cols || y + dy < 0 || y + dy >= rows) continue;
      const next = (y + dy) * cols + x + dx;
      if (closed.has(next) || !clearSegment(a, point(next), fence)) continue;
      const g = cost.get(current) + Math.hypot(dx, dy) * step;
      if (g < (cost.get(next) ?? Infinity)) { parent.set(next, current); cost.set(next, g); open.add(next); }
    }
  }
  return null;
}
export function planRoute(start, goals, fence = .3) {
  const route = []; let from = start;
  for (const goal of goals) {
    const leg = planPath(from, goal, fence);
    if (!leg) return null;
    route.push(...leg); from = goal;
  }
  return route;
}
export function raycast(x, y, angle, max = 4) {
  const dx = Math.cos(angle), dy = Math.sin(angle);
  let best = max, obstacle = -1;
  const rectangles = [{ x: 0, y: 0, w: WORLD.w, h: WORLD.h }, ...OBSTACLES];
  rectangles.forEach((o, index) => {
    for (const edge of [o.x, o.x + o.w]) {
      const t = (edge - x) / dx, py = y + t * dy;
      if (t > 0 && t < best && py >= o.y && py <= o.y + o.h) { best = t; obstacle = index; }
    }
    for (const edge of [o.y, o.y + o.h]) {
      const t = (edge - y) / dy, px = x + t * dx;
      if (t > 0 && t < best && px >= o.x && px <= o.x + o.w) { best = t; obstacle = index; }
    }
  });
  return { distance: best, obstacle };
}
export function parseOdom(msg) {
  const p = msg?.pose?.pose, q = p?.orientation, t = msg?.twist?.twist;
  if (![p?.position?.x, p?.position?.y, q?.x, q?.y, q?.z, q?.w, t?.linear?.x, t?.angular?.z].every(Number.isFinite)) return null;
  const norm = Math.hypot(q.x, q.y, q.z, q.w);
  if (norm < .001) return null;
  const x = q.x / norm, y = q.y / norm, z = q.z / norm, w = q.w / norm;
  return { x: p.position.x, y: p.position.y, th: Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z)), v: t.linear.x, w: t.angular.z };
}
export function parseScan(msg) {
  if (!Array.isArray(msg?.ranges) || !Number.isFinite(msg.angle_min) || !Number.isFinite(msg.angle_increment) || msg.angle_increment === 0) return null;
  const max = Number.isFinite(msg.range_max) && msg.range_max > 0 ? Math.min(msg.range_max, 100) : 20;
  const min = Number.isFinite(msg.range_min) ? Math.max(0, msg.range_min) : 0;
  const stride = Math.max(1, Math.ceil(msg.ranges.length / 180));
  const rays = [];
  for (let i = 0; i < Math.min(msg.ranges.length, 20000); i += stride) {
    const d = msg.ranges[i];
    if (Number.isFinite(d) && d >= min && d <= max) rays.push({ angle: msg.angle_min + i * msg.angle_increment, distance: d });
  }
  return rays.length ? rays : null;
}
export function validMission(m) {
  return m && typeof m.id === 'string' && typeof m.name === 'string' && m.name.length > 0 && m.name.length <= 48 &&
    Array.isArray(m.points) && m.points.length > 0 && m.points.length <= 500 &&
    m.points.every(p => Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= 0 && p.x <= WORLD.w && p.y >= 0 && p.y <= WORLD.h);
}
