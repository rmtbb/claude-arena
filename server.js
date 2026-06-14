#!/usr/bin/env node
/*
 * Claude Arena — server.
 *
 * Responsibilities:
 *   1. Tail the NDJSON event log that the capture hook appends to.
 *   2. Normalize each raw hook payload into a small, stable event shape.
 *   3. Maintain persistent per-project ("faction") aggregates so a project's
 *      world keeps growing across sessions — the "living thing you curate".
 *   4. Serve the static front-end + a live SSE stream + a state snapshot.
 *
 * Zero external dependencies (Node built-ins only) so it runs with `node server.js`.
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = Number(process.env.CLAUDE_ARENA_PORT || 4787); // 4787 = "ICUR" vibes / arbitrary
const HOST = process.env.CLAUDE_ARENA_HOST || '127.0.0.1'; // localhost-only by default (project names + tool labels stay on your machine)
const HOME = process.env.CLAUDE_ARENA_HOME || path.join(os.homedir(), '.claude', 'claude-arena');
const LOG_FILE = path.join(HOME, 'events.ndjson');
const OVERRIDES_FILE = path.join(HOME, 'overrides.json'); // user curation (names/colors/crests)
const PUBLIC_DIR = path.join(__dirname, 'public');
const DEMO = process.argv.includes('--demo');

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function ensureDir(d) {
  try { fs.mkdirSync(d, { recursive: true }); } catch (_) {}
}

// Deterministic 32-bit hash → used for stable per-project colors/crests.
function hash32(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

// Turn a directory basename into a readable faction name.
function prettifyName(base) {
  if (!base) return 'Unknown';
  let s = base.replace(/[-_]+/g, ' ');           // kebab / snake → spaces
  s = s.replace(/([a-z0-9])([A-Z])/g, '$1 $2');  // camelCase → spaced
  s = s.replace(/\s+/g, ' ').trim();
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

function deriveProject(cwd) {
  if (!cwd || typeof cwd !== 'string') return { key: 'unknown', name: 'The Unknown', base: 'unknown' };
  const parts = cwd.split('/').filter(Boolean);
  const base = parts[parts.length - 1] || cwd;
  return { key: cwd, name: prettifyName(base), base };
}

// ---------------------------------------------------------------------------
// Normalization — schema-agnostic. We read whatever fields are present and fall
// back gracefully so a wrong/renamed field can never crash the pipeline.
// ---------------------------------------------------------------------------

function normalize(line) {
  let obj;
  try { obj = JSON.parse(line); } catch (_) { return null; }
  if (!obj || typeof obj !== 'object') return null;

  const tSec = Number(obj.t) || Math.floor(Date.now() / 1000);
  const ev = obj.ev && typeof obj.ev === 'object' ? obj.ev : obj; // tolerate un-wrapped lines

  const event = ev.hook_event_name || ev.event || ev.eventName || 'Unknown';
  const cwd = ev.cwd || ev.project_dir || ev.workingDirectory || null;
  const proj = deriveProject(cwd);

  const toolInput = ev.tool_input && typeof ev.tool_input === 'object' ? ev.tool_input : null;

  // Error detection is best-effort across possible field shapes.
  const rawOut = ev.tool_output || ev.tool_response || ev.error || null;
  let isError = false;
  if (/Failure/i.test(event) || ev.error) isError = true;
  if (typeof rawOut === 'string' && /^error[:\s]|\berror\b.*\b(failed|exception)\b/i.test(rawOut)) isError = true;
  if (rawOut && typeof rawOut === 'object' && (rawOut.is_error || rawOut.error)) isError = true;

  return {
    ts: tSec * 1000,
    event,
    sessionId: ev.session_id || ev.sessionId || null,
    projectKey: proj.key,
    projectName: proj.name,
    cwd,
    tool: ev.tool_name || (toolInput && toolInput.tool) || null,
    // For Task tool, surface the subagent type / description for nicer drones.
    subagentType:
      ev.agent_type ||
      (toolInput && (toolInput.subagent_type || toolInput.subagentType)) ||
      null,
    agentId: ev.agent_id || ev.agentId || null,
    source: ev.source || null,
    // NOTE: we deliberately do NOT forward prompt text / tool I/O to the browser.
    // The arena only needs *that* something happened, not *what*. Keeps your
    // actual work private even though the server is localhost-only.
    isError,
  };
}

// ---------------------------------------------------------------------------
// World aggregates (persistent-ish, in memory; rebuilt by replaying the log)
// ---------------------------------------------------------------------------

const RESOURCE_TOOLS = {
  Bash: 'gas', Read: 'scout', Grep: 'scout', Glob: 'scout',
  Edit: 'mineral', Write: 'mineral', NotebookEdit: 'mineral', MultiEdit: 'mineral',
  WebFetch: 'expedition', WebSearch: 'expedition',
  Task: 'spawn', Agent: 'spawn', Workflow: 'spawn',
};

const factions = new Map();   // projectKey -> aggregate
const sessions = new Map();   // sessionId -> { projectKey, lastSeen }
const recent = [];            // ring buffer of normalized events (for ticker + catch-up)
const RECENT_MAX = 300;

function ensureFaction(key, name) {
  let f = factions.get(key);
  if (!f) {
    const h = hash32(key);
    f = {
      key,
      name: name || 'Unknown',
      hue: h % 360,
      crest: h % 12,              // index into renderer crest sets
      firstSeen: null,
      lastSeen: null,
      totalEvents: 0,
      totalTools: 0,
      totalSubagents: 0,
      totalSessions: 0,
      resources: 0,              // lifetime "harvest"
      preCompacts: 0,            // memory storms survived (milestone)
      toolCounts: {},            // per-tool lifetime counts → "skyline fingerprint"
      sessionsSeen: new Set(),
    };
    factions.set(key, f);
  }
  return f;
}

function applyToAggregate(n) {
  if (!n.projectKey) return;
  const f = ensureFaction(n.projectKey, n.projectName);
  if (n.projectName && n.projectName !== 'Unknown') f.name = n.projectName;
  if (f.firstSeen == null) f.firstSeen = n.ts;
  f.lastSeen = n.ts;
  f.totalEvents++;

  if (n.sessionId && !f.sessionsSeen.has(n.sessionId)) {
    f.sessionsSeen.add(n.sessionId);
    f.totalSessions++;
  }
  if (n.sessionId) sessions.set(n.sessionId, { projectKey: n.projectKey, lastSeen: n.ts });

  if (n.event === 'PreToolUse') {
    f.totalTools++;
    if (n.tool) f.toolCounts[n.tool] = (f.toolCounts[n.tool] || 0) + 1;
    if (n.tool === 'Task' || n.tool === 'Agent' || n.tool === 'Workflow') f.totalSubagents++;
  }
  if (n.event === 'PostToolUse' && !n.isError) f.resources++;
  if (n.event === 'PreCompact') f.preCompacts++;

  // Faction "level" — visible grandeur grows sub-linearly so it never explodes.
  f.level = 1 + Math.floor(Math.sqrt(f.totalTools + f.totalSubagents * 3) / 3);
}

function pushRecent(n) {
  recent.push(n);
  if (recent.length > RECENT_MAX) recent.shift();
}

// Apply user curation overrides on top of computed faction data.
let overrides = {};
function loadOverrides() {
  try { overrides = JSON.parse(fs.readFileSync(OVERRIDES_FILE, 'utf8')) || {}; } catch (_) { overrides = {}; }
}
function saveOverrides() {
  try { fs.writeFileSync(OVERRIDES_FILE, JSON.stringify(overrides, null, 2)); } catch (_) {}
}

function factionView(f) {
  const o = overrides[f.key] || {};
  const ACTIVE_MS = 5 * 60 * 1000;
  const now = Date.now();
  let liveSessions = 0;
  for (const sid of f.sessionsSeen) {
    const s = sessions.get(sid);
    if (s && now - s.lastSeen < ACTIVE_MS) liveSessions++;
  }
  return {
    key: f.key,
    name: o.name || f.name,
    hue: o.hue != null ? o.hue : f.hue,
    crest: o.crest != null ? o.crest : f.crest,
    motto: o.motto || null,
    level: f.level || 1,
    firstSeen: f.firstSeen,
    lastSeen: f.lastSeen,
    totalEvents: f.totalEvents,
    totalTools: f.totalTools,
    totalSubagents: f.totalSubagents,
    totalSessions: f.totalSessions,
    resources: f.resources,
    preCompacts: f.preCompacts || 0,
    toolCounts: f.toolCounts || {},
    liveSessions,
  };
}

function snapshot() {
  return {
    now: Date.now(),
    factions: Array.from(factions.values()).map(factionView),
    recent: recent.slice(-120),
    resourceTools: RESOURCE_TOOLS,
  };
}

// ---------------------------------------------------------------------------
// SSE clients
// ---------------------------------------------------------------------------

const clients = new Set();
function broadcast(n) {
  const data = `data: ${JSON.stringify(n)}\n\n`;
  for (const res of clients) {
    try { res.write(data); } catch (_) {}
  }
}

function ingest(n) {
  if (!n) return;
  applyToAggregate(n);
  pushRecent(n);
  broadcast(n);
}

// ---------------------------------------------------------------------------
// Log tailing
// ---------------------------------------------------------------------------

let readOffset = 0;
let pending = '';

function processChunk(text) {
  pending += text;
  let idx;
  while ((idx = pending.indexOf('\n')) >= 0) {
    const line = pending.slice(0, idx);
    pending = pending.slice(idx + 1);
    if (line.trim()) ingest(normalize(line));
  }
}

function initialReplay() {
  try {
    const stat = fs.statSync(LOG_FILE);
    const fd = fs.openSync(LOG_FILE, 'r');
    const buf = Buffer.alloc(stat.size);
    fs.readSync(fd, buf, 0, stat.size, 0);
    fs.closeSync(fd);
    processChunk(buf.toString('utf8'));
    if (pending) { ingest(normalize(pending)); pending = ''; }
    readOffset = stat.size;
  } catch (_) {
    readOffset = 0;
  }
}

function readAppended() {
  let stat;
  try { stat = fs.statSync(LOG_FILE); } catch (_) { return; }
  if (stat.size < readOffset) { readOffset = 0; pending = ''; } // file truncated/rotated
  if (stat.size === readOffset) return;
  try {
    const fd = fs.openSync(LOG_FILE, 'r');
    const len = stat.size - readOffset;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, readOffset);
    fs.closeSync(fd);
    readOffset = stat.size;
    processChunk(buf.toString('utf8'));
  } catch (_) {}
}

function watchLog() {
  ensureDir(HOME);
  if (!fs.existsSync(LOG_FILE)) { try { fs.writeFileSync(LOG_FILE, ''); } catch (_) {} }
  initialReplay();
  // fs.watch can miss events on some platforms; pair it with a light poll.
  try {
    fs.watch(LOG_FILE, { persistent: true }, () => readAppended());
  } catch (_) {}
  setInterval(readAppended, 400);
}

// ---------------------------------------------------------------------------
// Demo generator — synthesizes plausible events so the world is alive instantly,
// even before any real hooks fire. Never writes to the log; feeds the pipeline.
// ---------------------------------------------------------------------------

const DEMO_PROJECTS = [
  '/demo/null-pointers', '/demo/the-refactory', '/demo/async-armada', '/demo/heap-overlords',
];
const DEMO_TOOLS = ['Bash', 'Read', 'Edit', 'Write', 'Grep', 'WebFetch', 'Task', 'Bash', 'Read', 'Edit'];
let demoSeed = 1234567;
function demoRand() { demoSeed = (demoSeed * 1103515245 + 12345) & 0x7fffffff; return demoSeed / 0x7fffffff; }
function pick(arr) { return arr[Math.floor(demoRand() * arr.length)]; }

const demoSessions = []; // { sid, cwd }
function demoTick() {
  const r = demoRand();
  // Reuse an existing session most of the time; otherwise birth a new one.
  let s = demoSessions.length && r < 0.72 ? pick(demoSessions) : null;
  if (!s) {
    const cwd = pick(DEMO_PROJECTS);
    s = { sid: 'demo-' + Math.floor(demoRand() * 1e6), cwd };
    demoSessions.push(s);
    if (demoSessions.length > 7) {
      const old = demoSessions.shift();
      feed(old.cwd, old.sid, { hook_event_name: 'SessionEnd' }); // retire like a real session
    }
    feed(s.cwd, s.sid, { hook_event_name: 'SessionStart', source: 'startup' });
    return;
  }
  const { sid, cwd } = s;
  const tool = pick(DEMO_TOOLS);
  feed(cwd, sid, { hook_event_name: 'PreToolUse', tool_name: tool,
    tool_input: tool === 'Task' ? { subagent_type: pick(['Explore', 'Plan', 'general-purpose']), description: 'scout sector' } : {} });
  setTimeout(() => {
    feed(cwd, sid, { hook_event_name: 'PostToolUse', tool_name: tool, tool_output: 'ok' });
    if (tool === 'Task') {
      // let subagents live a bit so they're visible patrolling
      setTimeout(() => feed(cwd, sid, { hook_event_name: 'SubagentStop', agent_type: 'Explore', agent_id: 'a' + Math.floor(demoRand() * 1e6) }), 2500 + demoRand() * 4000);
    }
    if (demoRand() < 0.18) feed(cwd, sid, { hook_event_name: 'Stop', assistant_message: 'done' });
  }, 300 + demoRand() * 900);
}
function feed(cwd, sid, ev) {
  ev.cwd = cwd; ev.session_id = sid;
  ingest(normalize(JSON.stringify({ t: Math.floor(Date.now() / 1000), ev })));
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, urlPath) {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  rel = rel.split('?')[0];
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); });
    req.on('end', () => resolve(b));
    req.on('error', () => resolve(''));
  });
}

const server = http.createServer(async (req, res) => {
  const url = req.url || '/';

  if (url === '/api/state') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(snapshot()));
  }

  if (url === '/api/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    res.write(`retry: 2000\n\n`);
    res.write(`event: hello\ndata: ${JSON.stringify({ now: Date.now() })}\n\n`);
    clients.add(res);
    const hb = setInterval(() => { try { res.write(`: hb\n\n`); } catch (_) {} }, 15000);
    req.on('close', () => { clearInterval(hb); clients.delete(res); });
    return;
  }

  if (url === '/api/curate' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      const { key, name, hue, crest, motto } = JSON.parse(body || '{}');
      if (key) {
        overrides[key] = { ...(overrides[key] || {}) };
        if (name !== undefined) overrides[key].name = name;
        if (hue !== undefined) overrides[key].hue = hue;
        if (crest !== undefined) overrides[key].crest = crest;
        if (motto !== undefined) overrides[key].motto = motto;
        saveOverrides();
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, faction: key ? factionView(ensureFaction(key)) : null }));
    } catch (_) {
      res.writeHead(400); return res.end('bad request');
    }
  }

  if (url === '/api/demo' && req.method === 'POST') {
    for (let i = 0; i < 12; i++) setTimeout(demoTick, i * 120);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }

  serveStatic(req, res, url);
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

ensureDir(HOME);
loadOverrides();
watchLog();

server.listen(PORT, HOST, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\n  ⚔  Claude Arena running at ${url}`);
  console.log(`     watching ${LOG_FILE}`);
  console.log(`     factions loaded: ${factions.size}${DEMO ? '   [DEMO MODE]' : ''}\n`);
});

if (DEMO) setInterval(demoTick, 700);
