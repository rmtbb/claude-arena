/* Claude Arena — bootstrap: canvas, camera, input, live data, HUD, curation.
 * Renderer-agnostic: drives the shared Sim and hands it to the active skin. */
(function () {
  'use strict';
  const U = Arena.util, TAU = U.TAU;
  const sim = new Arena.Sim();

  // ---- renderer registry ---------------------------------------------------
  const ORDER = ['rts']; // RTS-only build; aquarium/cyber return later
  let current = 'rts';

  // ---- canvas / DPR --------------------------------------------------------
  const canvas = document.getElementById('stage');
  const ctx = canvas.getContext('2d');
  let W = 0, H = 0, DPR = 1;
  function resize() {
    DPR = Math.min(2, window.devicePixelRatio || 1);
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = W * DPR; canvas.height = H * DPR;
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
  }
  window.addEventListener('resize', resize); resize();

  // ---- camera --------------------------------------------------------------
  const cam = { x: 640, y: 400, zoom: 0.7, tx: 640, ty: 400, tzoom: 0.7 };
  let userMoved = false;
  let autoFrame = true;

  function fitView(instant) {
    const b = sim.bounds();
    const cx = (b.minx + b.maxx) / 2, cy = (b.miny + b.maxy) / 2;
    const zw = W / (b.maxx - b.minx + 200), zh = H / (b.maxy - b.miny + 200);
    const z = Math.max(0.25, Math.min(1.1, Math.min(zw, zh)));
    cam.tx = cx; cam.ty = cy; cam.tzoom = z;
    if (instant) { cam.x = cx; cam.y = cy; cam.zoom = z; }
  }

  function screenToWorld(sx, sy) {
    return { x: (sx - W / 2) / cam.zoom + cam.x, y: (sy - H / 2) / cam.zoom + cam.y };
  }

  function focusFaction(f, z) { autoFrame = false; cam.tx = f.x; cam.ty = f.y - 30; cam.tzoom = z || 1.6; }
  // exposed for tooling / debugging (also powers click-to-focus)
  window.ArenaApp = { get cam() { return cam; }, sim, art: Arena.art, focusFaction };

  // ---- input ---------------------------------------------------------------
  let dragging = false, lastX = 0, lastY = 0, downX = 0, downY = 0, moved = 0;
  canvas.addEventListener('mousedown', (e) => { dragging = true; lastX = downX = e.clientX; lastY = downY = e.clientY; moved = 0; });
  window.addEventListener('mouseup', (e) => {
    if (dragging && moved < 6) handleClick(e.clientX, e.clientY);
    dragging = false;
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    moved += Math.abs(dx) + Math.abs(dy);
    cam.x -= dx / cam.zoom; cam.y -= dy / cam.zoom;
    cam.tx = cam.x; cam.ty = cam.y; autoFrame = false; followUnitId = null; lastX = e.clientX; lastY = e.clientY;
  });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const before = screenToWorld(e.clientX, e.clientY);
    const f = Math.exp(-e.deltaY * 0.0015);
    cam.zoom = Math.max(0.2, Math.min(2.5, cam.zoom * f)); cam.tzoom = cam.zoom;
    const after = screenToWorld(e.clientX, e.clientY);
    cam.x += before.x - after.x; cam.y += before.y - after.y; cam.tx = cam.x; cam.ty = cam.y; autoFrame = false;
  }, { passive: false });

  // touch (basic pan)
  canvas.addEventListener('touchstart', (e) => { const t = e.touches[0]; dragging = true; lastX = downX = t.clientX; lastY = downY = t.clientY; moved = 0; }, { passive: true });
  canvas.addEventListener('touchmove', (e) => { const t = e.touches[0]; const dx = t.clientX - lastX, dy = t.clientY - lastY; moved += Math.abs(dx) + Math.abs(dy); cam.x -= dx / cam.zoom; cam.y -= dy / cam.zoom; cam.tx = cam.x; cam.ty = cam.y; autoFrame = false; lastX = t.clientX; lastY = t.clientY; }, { passive: true });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'r' || e.key === 'R') { autoFrame = true; lastFactionCount = -1; }
    if (e.key === '?') document.getElementById('legend').classList.toggle('open');
    if (e.key === 'Escape') { document.getElementById('legend').classList.remove('open'); closeCurate(); }
  });

  function handleClick(sx, sy) {
    const w = screenToWorld(sx, sy);
    if (dropMode) { placeDrop(w.x, w.y); return; }
    let best = null, bd = 1e9;
    for (const f of sim.factions.values()) {
      const d = Math.hypot(f.x - w.x, f.y - w.y);
      const r = f.town ? f.town.territory : 90;
      if (d < r && d < bd) { bd = d; best = f; }
    }
    if (best) { focusFaction(best, Math.max(cam.zoom, 1.35)); openCurate(best); }
  }

  // ---- live data -----------------------------------------------------------
  async function loadState() {
    try {
      const r = await fetch('/api/state'); const s = await r.json();
      for (const meta of s.factions) {
        sim.applyFactionMeta(meta);
        const f = sim.factions.get(meta.key);
        // seed idle workers for currently-live sessions (visual presence on load)
        let have = 0;
        for (const u of sim.units.values()) if (u.factionKey === f.key && u.kind === 'worker' && !u.dead) have++;
        for (let i = have; i < (meta.liveSessions || 0); i++) sim.spawnWorker(f, 'seed-' + meta.key + '-' + i);
      }
      // seed ticker from recent events
      (s.recent || []).slice(-10).forEach((n) => {
        const f = sim.factions.get(n.projectKey);
        if (f && n.event === 'PreToolUse') sim.log(`· ${f.name} — ${n.tool || 'works'}`, f.hue);
      });
      computeReturnBeat(s.factions || []);
      syncDrops();
      stateLoaded = true;
      fitView(true);
      updateHud();
    } catch (e) { /* server may not be ready */ }
  }

  // ---- "since you last looked" return beat ---------------------------------
  function fmtAway(ms) {
    const s = ms / 1000;
    if (s < 3600) return Math.max(1, Math.round(s / 60)) + ' min';
    if (s < 86400) return Math.round(s / 3600) + ' hr';
    return Math.round(s / 86400) + ' days';
  }
  function computeReturnBeat(metas) {
    const KEY = 'arena.lastVisit';
    let prev = null; try { prev = JSON.parse(localStorage.getItem(KEY)); } catch (_) {}
    const now = Date.now();
    const snap = { ts: now, towns: {} };
    for (const m of metas) snap.towns[m.key] = { tools: m.totalTools || 0, sessions: m.totalSessions || 0, subagents: m.totalSubagents || 0, era: Arena.lore.eraIndex(m), lastSeen: m.lastSeen || 0, name: m.name };
    const lines = [];
    let anyChange = false;
    if (!prev || !prev.towns) {
      lines.push(`⚑ <b>First muster</b> — ${metas.length} ${metas.length === 1 ? 'tribe' : 'tribes'} assembled.`);
    } else {
      for (const m of metas) {
        const p = prev.towns[m.key]; const f = sim.factions.get(m.key);
        if (!p) { lines.push(`✦ <b>${esc(m.name)}</b> founded.`); if (f) f._grewAt = now; anyChange = true; continue; }
        const dt = (m.totalTools || 0) - (p.tools || 0), ds = (m.totalSessions || 0) - (p.sessions || 0), dsub = (m.totalSubagents || 0) - (p.subagents || 0);
        const eNow = Arena.lore.eraIndex(m);
        if (eNow > (p.era || 0)) { lines.push(`▲ <b>${esc(m.name)}</b> rose to ${Arena.lore.ERAS[eNow]}.`); if (f) f._grewAt = now; anyChange = true; }
        else if (dt > 0 || ds > 0) { const pr = []; if (ds > 0) pr.push(`+${ds} session${ds > 1 ? 's' : ''}`); if (dt > 0) pr.push(`+${dt} tools`); if (dsub > 0) pr.push(`+${dsub} subagents`); lines.push(`• <b>${esc(m.name)}</b>: ${pr.join(', ')}`); if (f) f._grewAt = now; anyChange = true; }
      }
      for (const m of metas) { const p = prev.towns[m.key]; if (!p) continue; const idleNow = (now - (m.lastSeen || 0)) > 2 * 86400000; const wasActive = (prev.ts - (p.lastSeen || 0)) < 86400000; if (idleNow && wasActive) lines.push(`◌ <b>${esc(m.name)}</b> fell quiet.`); }
      if (!anyChange) lines.push('All quiet — nothing stirred since you last looked.');
      lines.unshift(`<span class="crier-h">${fmtAway(now - prev.ts)} away</span>`);
    }
    try { localStorage.setItem(KEY, JSON.stringify(snap)); } catch (_) {}
    // offer to WATCH the away period unfold (better than reading the deltas)
    const watchFrom = (anyChange && prev && prev.ts) ? prev.ts : null;
    showCrier(lines.slice(0, 7), watchFrom);
  }
  function esc(s) { return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
  function showCrier(lines, watchFrom) {
    const body = document.getElementById('crier-body');
    let html = lines.map((l) => `<div>${l}</div>`).join('');
    if (watchFrom) html += `<button id="crier-watch" class="crier-watch">▶ Watch it unfold</button>`;
    body.innerHTML = html;
    if (watchFrom) document.getElementById('crier-watch').onclick = () => { document.getElementById('crier').classList.remove('open'); enterReplay({ startAt: watchFrom, fast: true }); };
    document.getElementById('crier').classList.add('open');
  }
  document.getElementById('crier-x').onclick = () => document.getElementById('crier').classList.remove('open');

  let es = null;
  function connect() {
    if (es) { try { es.close(); } catch (_) {} }
    es = new EventSource('/api/stream');
    es.onmessage = (e) => {
      if (replay) return; // ignore live events while scrubbing history
      try { const n = JSON.parse(e.data); sim.applyEvent(n); if (n.event === 'Stop') growDropsOnStop(n.projectKey); flashLive(); } catch (_) {}
    };
    es.addEventListener('hello', () => {});
    es.onerror = () => { /* EventSource auto-reconnects */ };
  }

  // periodic resync of authoritative faction stats (level/resources/name)
  setInterval(async () => {
    if (replay) return;
    try { const r = await fetch('/api/state'); const s = await r.json(); for (const m of s.factions) sim.applyFactionMeta(m); updateHud(); } catch (_) {}
  }, 8000);

  // ---- time-lapse replay ---------------------------------------------------
  let replay = null;
  const FULL_PLAY_SEC = 28;            // at 1× the watched span plays in ~28 real seconds
  function fmtWhen(ms) { const d = new Date(ms); return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' · ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }); }
  // start the time-lapse. opts.startAt = where to begin (default: whole history,
  // or the last ~3 days if longer). The "watched span" sets an ADAPTIVE base
  // speed so it always plays in a comfortable ~28s at 1× — never a blink.
  async function enterReplay(opts) {
    opts = opts || {};
    if (replay) { replay.reset && replay.reset(); replay = null; }
    document.getElementById('btn-history').classList.add('on');
    const r = new Arena.Replay(sim);
    await r.load();
    if (!r.events.length) { sim.log('No history yet — go do some work!', 200); document.getElementById('btn-history').classList.remove('on'); return; }
    replay = r;
    document.getElementById('replay').classList.add('open');
    const span = r.to - r.from;
    let startAt = opts.startAt != null ? Math.max(r.from, opts.startAt) : (span > 3 * 86400000 ? r.to - 3 * 86400000 : r.from);
    if (r.to - startAt < 60000) startAt = r.from;   // guard against a near-empty window
    r.viewFrom = startAt;                            // scrubber spans the WATCHED window
    r.baseSpeed = Math.max(1000, (r.to - startAt) / FULL_PLAY_SEC); // sim-ms advanced per real second
    r.mult = opts.fast ? 4 : 1;                      // the recap catches you up FAST
    r.speed = r.baseSpeed * r.mult;
    r.seek(startAt); r.playing = true;
    setReplayMultUI(String(r.mult));
    document.getElementById('rp-play').textContent = '❚❚';
    autoFrame = true; lastFactionCount = -1;
  }
  function exitReplay() {
    if (!replay) return;
    replay = null;
    Arena.lore.setNow(null); Arena.art.setPhase(null);
    document.getElementById('replay').classList.remove('open');
    document.getElementById('btn-history').classList.remove('on');
    const r2 = new Arena.Replay(sim); r2.reset();
    loadState().then(() => connect());
    autoFrame = true; lastFactionCount = -1;
  }
  function setReplayMultUI(m) { document.querySelectorAll('#rp-speeds button').forEach((b) => b.classList.toggle('on', b.dataset.mult === m)); }
  function updateReplayUI() {
    if (!replay) return;
    const from = replay.viewFrom != null ? replay.viewFrom : replay.from;
    const span = replay.to - from || 1;
    document.getElementById('rp-when').textContent = fmtWhen(replay.clock);
    document.getElementById('rp-speedlbl').textContent = (replay.mult || 1) + '×';
    document.getElementById('rp-scrub').value = Math.round(((replay.clock - from) / span) * 1000);
    document.getElementById('rp-play').textContent = replay.playing ? '❚❚' : '▶';
  }
  document.getElementById('btn-history').onclick = () => { replay ? exitReplay() : enterReplay(); };
  document.getElementById('rp-live').onclick = exitReplay;
  document.getElementById('rp-play').onclick = () => { if (replay) { if (replay.clock >= replay.to) replay.seek(replay.viewFrom != null ? replay.viewFrom : replay.from); replay.playing = !replay.playing; } };
  document.getElementById('rp-scrub').addEventListener('input', (e) => { if (!replay) return; const from = replay.viewFrom != null ? replay.viewFrom : replay.from; const span = replay.to - from; replay.playing = false; replay.seek(from + (e.target.value / 1000) * span); });
  document.querySelectorAll('#rp-speeds button').forEach((b) => b.onclick = () => { if (!replay) return; replay.mult = +b.dataset.mult; replay.speed = replay.baseSpeed * replay.mult; if (replay.clock >= replay.to) { replay.seek(replay.viewFrom != null ? replay.viewFrom : replay.from); replay.playing = true; } setReplayMultUI(b.dataset.mult); });

  // ---- shared effects draw (world space) -----------------------------------
  function drawEffects() {
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    for (const p of sim.particles) {
      const a = 1 - p.life / p.max;
      const hue = p.kind === 'error' ? 0 : p.hue;
      U.glow(ctx, p.x, p.y, p.size * 3, U.hsl(hue, 90, 60, a * 0.7));
    }
    ctx.restore();
    for (const fl of sim.floaters) {
      const a = 1 - fl.life / fl.max;
      ctx.fillStyle = U.hsl(fl.hue, 90, 70, a);
      ctx.font = 'bold 14px ui-sans-serif,system-ui,sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(fl.text, fl.x, fl.y);
      ctx.textAlign = 'left';
    }
  }

  // ---- minimap (screen space) ----------------------------------------------
  function drawMinimap() {
    const mw = 168, mh = 110, pad = 14;
    const x0 = W - mw - pad, y0 = H - mh - pad;
    ctx.save();
    ctx.fillStyle = 'rgba(10,14,20,0.7)'; U.roundRect(ctx, x0, y0, mw, mh, 8); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.lineWidth = 1; ctx.stroke();
    const b = sim.bounds();
    const sx = (mw - 16) / (b.maxx - b.minx || 1), sy = (mh - 16) / (b.maxy - b.miny || 1);
    const s = Math.min(sx, sy);
    const toMx = (wx) => x0 + 8 + (wx - b.minx) * s;
    const toMy = (wy) => y0 + 8 + (wy - b.miny) * s;
    for (const f of sim.factions.values()) {
      ctx.fillStyle = U.hsl(f.hue, 70, 60);
      ctx.beginPath(); ctx.arc(toMx(f.x), toMy(f.y), 3 + f.level * 0.3, 0, TAU); ctx.fill();
    }
    for (const u of sim.units.values()) { ctx.fillStyle = U.hsl(sim.factions.get(u.factionKey)?.hue || 200, 80, 70, 0.8); ctx.fillRect(toMx(u.x), toMy(u.y), 1.5, 1.5); }
    // viewport rect
    const tl = screenToWorld(0, 0), br = screenToWorld(W, H);
    ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.lineWidth = 1;
    ctx.strokeRect(toMx(tl.x), toMy(tl.y), (br.x - tl.x) * s, (br.y - tl.y) * s);
    ctx.restore();
  }

  // ---- HUD -----------------------------------------------------------------
  const elFactions = document.getElementById('hud-factions');
  const elUnits = document.getElementById('hud-units');
  const elDrones = document.getElementById('hud-drones');
  const elTicker = document.getElementById('ticker');
  const elLive = document.getElementById('live-dot');
  let liveT = 0;
  function flashLive() { liveT = 1; }

  let stateLoaded = false;
  const welcomeEl = document.getElementById('welcome');
  document.getElementById('wc-demo').onclick = () => { fetch('/api/demo', { method: 'POST' }).catch(() => {}); welcomeEl.classList.remove('show'); };
  function updateHud() {
    let units = 0, drones = 0;
    for (const u of sim.units.values()) { if (u.dead) continue; if (u.kind === 'drone') drones++; else units++; }
    elFactions.textContent = sim.factions.size;
    elUnits.textContent = units;
    elDrones.textContent = drones;
    // first-run welcome only once we know the world is genuinely empty
    welcomeEl.classList.toggle('show', stateLoaded && sim.factions.size === 0 && !replay);
  }

  let tickerLast = '';
  function updateTicker() {
    const items = sim.ticker.slice(-7).reverse();
    const html = items.map((t) => `<span style="color:${U.hsl(t.hue, 70, 70)}">${escapeHtml(t.text)}</span>`).join('');
    if (html !== tickerLast) { elTicker.innerHTML = html; tickerLast = html; }
  }
  function escapeHtml(s) { return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

  // ---- faction / town panel ------------------------------------------------
  const panel = document.getElementById('curate');
  let curated = null;
  function ago(ms) {
    if (!ms) return 'just now';
    const s = (Date.now() - ms) / 1000;
    if (s < 90) return 'moments ago';
    if (s < 5400) return Math.round(s / 60) + ' min ago';
    if (s < 129600) return Math.round(s / 3600) + ' hr ago';
    return Math.round(s / 86400) + ' days ago';
  }
  function chip(label, val) { return `<div class="chip"><b>${val}</b><span>${label}</span></div>`; }
  function openCurate(f) {
    curated = f;
    panel.classList.add('open');
    panel.querySelector('#c-name').value = f.name;
    panel.querySelector('#c-motto').value = f.motto || '';
    panel.querySelector('#c-hue').value = f.hue;
    panel.querySelector('#c-crest').value = f.crest;
    panel.querySelector('#c-swatch').style.background = U.hsl(f.hue, 70, 50);
    markHue(f.hue); markCrest(f.crest);
    refreshPanel();
  }
  function fmtDate(ms) { if (!ms) return '—'; const d = new Date(ms); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function refreshPanel() {
    const f = curated; if (!f) return;
    const lore = Arena.lore;
    const ageDays = f.firstSeen ? Math.max(0, Math.floor((Date.now() - f.firstSeen) / 86400000)) : 0;
    panel.querySelector('#f-name-disp').textContent = f.name;
    panel.querySelector('#f-sub').innerHTML =
      `<b style="color:${U.hsl(f.hue, 62, 72)}">${f.eraName || 'Outpost'}</b> · est. ${fmtDate(f.firstSeen)} · ${ageDays}d old · ${lore.idleLabel(f)}`;
    // motto + deterministic "character" line from the tool-mix
    const motto = panel.querySelector('#f-motto');
    motto.innerHTML = (f.motto ? `“${esc(f.motto)}”<br>` : '') + `<span class="char">${esc(lore.character(f))}</span>`;
    motto.style.display = 'block';
    // era progress bar
    const prog = lore.eraProgress(f), next = lore.nextEra(f);
    const eraBar = `<div class="erabar"><div class="erabar-fill" style="width:${Math.round(prog * 100)}%;background:${U.hsl(f.hue, 58, 56)}"></div></div>` +
      `<div class="erabar-lbl">${next ? Math.round(prog * 100) + '% to ' + next : 'Capital — fully grown'}</div>`;
    const houses = f.town ? f.town.houses.length : 0;
    panel.querySelector('#f-stats').innerHTML = eraBar +
      chip('houses', '⌂ ' + houses) + chip('harvested', '⚒ ' + (f.resources || 0)) +
      chip('tools run', (f.totalTools || 0)) + chip('sessions', (f.totalSessions || 0)) +
      chip('subagents', (f.totalSubagents || 0)) + chip('live now', (f.liveSessions || 0));
    panel.querySelector('#f-work').innerHTML = workBar(f);   // how it's built
    drawSpark(f);                                            // 21-day activity pulse
    // heroes (click to follow)
    const heroes = [];
    for (const u of sim.units.values()) if (u.factionKey === f.key && u.kind === 'worker' && !u.dead) heroes.push(u);
    heroes.sort((a, b) => (b.actions - a.actions) || (a.born - b.born));
    panel.querySelector('#f-herocount').textContent = heroes.length ? `(${heroes.length})` : '';
    const heroHtml = heroes.length ? heroes.slice(0, 8).map((u) => {
      const id = u.identity || { name: 'Worker', title: '' };
      const star = u.veteran ? `<span class="vet" title="veteran">★</span>` : '';
      const act = u.state === 'gathering' ? 'harvesting' : u.state === 'toResource' ? 'en route' : u.state === 'returning' ? 'hauling' : u.state === 'rest' ? 'resting' : 'roaming';
      const sub = u.sub ? ` <span class="dim">· ${esc((u.sub.split('/').pop()) || '')}</span>` : '';
      return `<div class="hero click" data-uid="${u.id}"><span class="hdot" style="background:${U.hsl(f.hue, 60, 55)}"></span>` +
        `<span class="hn">${star}${esc(id.title)} ${esc(id.name)}${sub}</span><span class="ha">${act} · ${u.actions}⚒</span></div>`;
    }).join('') : `<div class="dim" style="font-size:12px">No active sessions. Open Claude Code in this project to summon workers.</div>`;
    // districts: subfolder satellites (click to fly there)
    const mem = f.members || [];
    const memHtml = mem.length ? `<div class="f-h" style="margin-top:13px">⌂ Districts <span class="dim">(${mem.length})</span></div>` +
      `<div class="f-heroes">` + mem.slice(0, 12).map((m) => `<div class="hero click" data-sub="${esc(m.sub)}"><span class="hdot" style="background:${U.hsl(f.hue, 42, 50)}"></span>` +
        `<span class="hn">${esc(m.name)}</span><span class="ha">${m.tools}⚒ · ${Arena.lore.idleLabel({ lastSeen: m.lastSeen })}</span></div>`).join('') + `</div>` : '';
    // chronicle: milestones reached
    const ms = f.milestones || [];
    const msHtml = ms.length ? `<div class="f-h" style="margin-top:13px">▦ Chronicle <span class="dim">(${ms.length})</span></div>` +
      `<div class="chron">` + ms.slice(-8).reverse().map((m) => `<span class="band">${esc(m)}</span>`).join('') + `</div>` : '';
    panel.querySelector('#f-heroes').innerHTML = heroHtml + memHtml + msHtml;
  }

  // ---- drill-down: work signature, activity pulse, follow a unit -----------
  const CAT_RGB = { forge: [255, 150, 70], workshop: [110, 180, 255], tower: [255, 214, 110], wargate: [185, 150, 255], barracks: [255, 110, 150] };
  const CAT_TIP = { forge: 'Bash', workshop: 'Edit', tower: 'Read', wargate: 'Web', barracks: 'Task' };
  function workBar(f) {
    const w = (f.fingerprint && f.fingerprint.weights) || {};
    const order = ['forge', 'workshop', 'tower', 'wargate', 'barracks'].filter((k) => (w[k] || 0) > 0.005);
    if (!order.length) return '';
    const seg = order.map((k) => `<span style="width:${(w[k] * 100).toFixed(2)}%;background:rgb(${CAT_RGB[k].join(',')})"></span>`).join('');
    const leg = order.map((k) => `<span class="wl"><i style="background:rgb(${CAT_RGB[k].join(',')})"></i>${CAT_TIP[k]} ${Math.round(w[k] * 100)}%</span>`).join('');
    return `<div class="f-h" style="margin-top:13px">⚒ Work signature</div><div class="workbar">${seg}</div><div class="worklegend">${leg}</div>`;
  }
  let _hist = null;
  async function ensureHistory() { if (_hist) return _hist; try { const r = await fetch('/api/history'); _hist = await r.json(); } catch (_) { _hist = { events: [] }; } return _hist; }
  async function drawSpark(f) {
    const wrap = document.getElementById('f-spark-wrap'), cv = document.getElementById('f-spark');
    const key = f.key, h = await ensureHistory();
    if (curated !== f) return;
    const DAYS = 21, dayMs = 86400000, now = Date.now(), buckets = new Array(DAYS).fill(0);
    for (const e of h.events) { if (e[2] !== key || e[1] !== 'PreToolUse') continue; const di = Math.floor((now - e[0]) / dayMs); if (di >= 0 && di < DAYS) buckets[DAYS - 1 - di]++; }
    const total = buckets.reduce((a, b) => a + b, 0);
    if (!total) { wrap.style.display = 'none'; return; }
    const max = Math.max(1, ...buckets), x = cv.getContext('2d'), W = cv.width, H = cv.height; x.clearRect(0, 0, W, H);
    const bw = W / DAYS;
    for (let i = 0; i < DAYS; i++) { const bh = (buckets[i] / max) * (H - 5); x.fillStyle = buckets[i] ? U.hsl(f.hue, 58, 58) : 'rgba(255,255,255,0.05)'; x.fillRect(i * bw + 1, H - Math.max(2, bh) - 1, bw - 2, Math.max(2, bh)); }
    document.getElementById('f-spark-sub').textContent = `${total} tools · last 21 days`;
    wrap.style.display = 'block';
  }
  function focusSatellite(f, sub) { if (!f.town || !f.town.satellites) return; const s = f.town.satellites.find((x) => x.sub === sub); if (!s) return; followUnitId = null; autoFrame = false; cam.tx = f.x + s.x; cam.ty = f.y + s.y; cam.tzoom = Math.max(cam.zoom, 1.7); }
  document.getElementById('f-heroes').addEventListener('click', (e) => {
    const row = e.target.closest('.hero.click'); if (!row) return;
    if (row.dataset.uid) { followUnitId = +row.dataset.uid; autoFrame = false; }
    else if (row.dataset.sub != null && curated) focusSatellite(curated, row.dataset.sub);
  });

  function closeCurate() { panel.classList.remove('open'); curated = null; followUnitId = null; }
  function applyCurate(save) {
    if (!curated) return;
    const name = panel.querySelector('#c-name').value.trim() || curated.name;
    const motto = panel.querySelector('#c-motto').value.trim();
    const hue = +panel.querySelector('#c-hue').value;
    const crest = +panel.querySelector('#c-crest').value;
    curated.name = name; curated.motto = motto; curated.hue = hue; curated.crest = crest;
    panel.querySelector('#c-swatch').style.background = U.hsl(hue, 70, 50);
    if (save) {
      fetch('/api/curate', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: curated.key, name, motto, hue, crest }) }).catch(() => {});
      closeCurate();
    }
  }
  panel.querySelector('#c-save').onclick = () => applyCurate(true);
  panel.querySelector('#c-close').onclick = closeCurate;

  // visual customizer: a banner-colour palette + a clickable crest grid
  const CUST_HUES = [0, 28, 45, 80, 135, 168, 200, 222, 255, 288, 318, 344];
  function buildCustomizer() {
    const hueHost = document.getElementById('c-hues');
    CUST_HUES.forEach((h) => { const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'swatch-btn'; btn.style.background = U.hsl(h, 62, 52); btn.dataset.h = h; btn.onclick = () => { panel.querySelector('#c-hue').value = h; markHue(h); applyCurate(false); }; hueHost.appendChild(btn); });
    const crestHost = document.getElementById('c-crests');
    for (let i = 0; i < 12; i++) { const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'crest-btn'; btn.dataset.c = i; const cv = document.createElement('canvas'); cv.width = cv.height = 30; btn.appendChild(cv); btn.onclick = () => { panel.querySelector('#c-crest').value = i; markCrest(i); applyCurate(false); }; crestHost.appendChild(btn); }
  }
  function markHue(h) { document.querySelectorAll('#c-hues .swatch-btn').forEach((b) => b.classList.toggle('on', +b.dataset.h === +h)); redrawCrests(); }
  function markCrest(i) { document.querySelectorAll('#c-crests .crest-btn').forEach((b) => b.classList.toggle('on', +b.dataset.c === +i)); }
  function redrawCrests() {
    const hue = +panel.querySelector('#c-hue').value || 200;
    document.querySelectorAll('#c-crests .crest-btn canvas').forEach((cv, i) => { const x = cv.getContext('2d'); x.clearRect(0, 0, 30, 30); U.crest(x, i, 15, 15, 9, U.hsl(hue, 72, 72)); });
  }

  // ---- player agency: Folk-Drops (plant things that grow from real work) ----
  let dropMode = false;
  let dropStore = {};
  try { dropStore = JSON.parse(localStorage.getItem('arena.drops')) || {}; } catch (_) { dropStore = {}; }
  function saveDrops() { try { localStorage.setItem('arena.drops', JSON.stringify(dropStore)); } catch (_) {} }
  function syncDrops() { for (const f of sim.factions.values()) f.drops = dropStore[f.key] || (dropStore[f.key] = []); }
  function placeDrop(wx, wy) {
    let best = null, bd = 1e9;
    for (const f of sim.factions.values()) { const d = Math.hypot(f.x - wx, f.y - wy); const r = f.town ? f.town.territory : 90; if (d < r && d < bd) { bd = d; best = f; } }
    if (!best) { sim.log('Plant inside a town\'s land.', 200); return; }
    if (!dropStore[best.key]) dropStore[best.key] = [];
    dropStore[best.key].push({ x: wx - best.x, y: wy - best.y, kind: 'sapling', growth: 0 });
    best.drops = dropStore[best.key]; saveDrops();
    sim.burst(wx, wy, 120, 8, 'deposit'); sim.floater(wx, wy - 10, '🌱', 120);
    sim.log(`🌱 You plant a sapling in ${best.name} — it grows as the project works`, best.hue);
    dropMode = false; document.getElementById('btn-plant').classList.remove('on'); canvas.style.cursor = '';
  }
  // a Stop-Beat feeds growth to that town's drops
  function growDropsOnStop(key) {
    const arr = dropStore[key]; if (!arr || !arr.length) return;
    for (const d of arr) d.growth = Math.min(1, (d.growth || 0) + 0.06);
    saveDrops();
  }
  setInterval(syncDrops, 1500);
  document.getElementById('btn-plant').onclick = () => {
    dropMode = !dropMode;
    document.getElementById('btn-plant').classList.toggle('on', dropMode);
    canvas.style.cursor = dropMode ? 'crosshair' : '';
    if (dropMode) sim.log('Plant mode — click inside a town to plant a sapling', 200);
  };

  // ---- toolbar actions -----------------------------------------------------
  document.getElementById('btn-frame').onclick = () => { autoFrame = true; lastFactionCount = -1; };
  document.getElementById('btn-help').onclick = () => document.getElementById('legend').classList.toggle('open');
  document.getElementById('lg-close').onclick = () => document.getElementById('legend').classList.remove('open');
  document.getElementById('btn-shot').onclick = () => {
    const oc = document.createElement('canvas'); oc.width = canvas.width; oc.height = canvas.height;
    const o = oc.getContext('2d'); o.drawImage(canvas, 0, 0);
    const W2 = canvas.width, H2 = canvas.height, d = DPR, barH = 64 * d;
    o.fillStyle = 'rgba(8,11,16,0.82)'; o.fillRect(0, H2 - barH, W2, barH);
    const f = curated;
    o.fillStyle = U.hsl(f ? f.hue : 205, 70, 55); o.fillRect(0, H2 - barH, 5 * d, barH);
    o.textBaseline = 'middle'; o.textAlign = 'left';
    let title, sub;
    if (f) { const age = f.firstSeen ? Math.floor((Date.now() - f.firstSeen) / 86400000) : 0; title = f.name; sub = `Day ${age} · ${f.eraName || 'Outpost'} · ${(f.totalTools || 0).toLocaleString()} tools forged · ${f.totalSessions || 0} sessions`; }
    else { let tools = 0, sess = 0; for (const x of sim.factions.values()) { tools += x.totalTools || 0; sess += x.totalSessions || 0; } title = 'Claude Arena'; sub = `${sim.factions.size} tribes · ${tools.toLocaleString()} tools forged · ${sess} sessions`; }
    o.fillStyle = '#e9eff6'; o.font = `800 ${21 * d}px ui-sans-serif,system-ui,sans-serif`;
    o.fillText('⚔ ' + title, 18 * d, H2 - barH + 23 * d);
    o.fillStyle = '#93a4b8'; o.font = `600 ${12.5 * d}px ui-monospace,monospace`;
    o.fillText(sub, 18 * d, H2 - barH + 45 * d);
    o.fillStyle = '#6cc6ff'; o.font = `700 ${12.5 * d}px ui-sans-serif,system-ui`; o.textAlign = 'right';
    o.fillText('claudearena.remotebb.com', W2 - 16 * d, H2 - barH / 2); o.textAlign = 'left';
    oc.toBlob((blob) => { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'claude-arena-postcard.png'; a.click(); });
  };

  // ---- main loop -----------------------------------------------------------
  let hoverId = null;
  let followUnitId = null;
  let lastFactionCount = -1;
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    if (replay) { replay.step(dt); updateReplayUI(); }
    sim.update(dt);

    // camera: only RE-frame when the set of tribes changes (a new town appears)
    // or on explicit request — never every frame, so it stays rock-steady.
    if (autoFrame && sim.factions.size !== lastFactionCount) { lastFactionCount = sim.factions.size; fitView(false); }
    // follow a selected worker around the world (drill-down)
    if (followUnitId != null) { const fu = sim.units.get(followUnitId); if (fu && !fu.dead) { cam.tx = fu.x; cam.ty = fu.y - 8; if (cam.tzoom < 1.5) cam.tzoom = 1.8; } else followUnitId = null; }
    // smooth easing toward the (stable) target
    const ease = Math.min(1, dt * 3.2);
    cam.x += (cam.tx - cam.x) * ease;
    cam.y += (cam.ty - cam.y) * ease;
    cam.zoom += (cam.tzoom - cam.zoom) * ease;
    // snap when essentially arrived so it never micro-drifts forever
    if (Math.abs(cam.tx - cam.x) < 0.4) cam.x = cam.tx;
    if (Math.abs(cam.ty - cam.y) < 0.4) cam.y = cam.ty;
    if (Math.abs(cam.tzoom - cam.zoom) < 0.0005) cam.zoom = cam.tzoom;
    liveT = Math.max(0, liveT - dt * 1.5);
    elLive.style.opacity = 0.4 + liveT * 0.6;

    const r = Arena.renderers[current];
    const env = { w: W, h: H, cam, time: sim.time, _s2w: screenToWorld, hoverId: hoverId || followUnitId, DPR: DPR };

    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    r.background(ctx, env);

    ctx.save();
    ctx.translate(W / 2, H / 2); ctx.scale(cam.zoom, cam.zoom); ctx.translate(-cam.x, -cam.y);
    r.drawWorld(ctx, sim, env);
    drawEffects();
    ctx.restore();

    drawMinimap();
    updateTicker();
    requestAnimationFrame(frame);
  }

  // periodic HUD refresh
  setInterval(updateHud, 500);

  // ---- go ------------------------------------------------------------------
  buildCustomizer();
  loadState().then(() => connect());
  requestAnimationFrame(frame);
})();
