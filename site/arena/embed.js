/* Claude Arena — standalone embed for the landing page.
 * Runs the REAL engine (sim.js + renderers) with a client-side synthetic event
 * driver. No server, no SSE, no real data — purely fictional tribes so the
 * public demo never shows anyone's actual projects. */
(function () {
  'use strict';
  const U = Arena.util, TAU = U.TAU;
  const sim = new Arena.Sim();

  // Clearly-fictional tribes. (Any resemblance to your 2am git history is coincidental.)
  const TRIBES = [
    { key: '/t/null-pointers', name: 'Null Pointers', hue: 210, crest: 1, level: 6 },
    { key: '/t/the-refactory', name: 'The Refactory', hue: 150, crest: 7, level: 5 },
    { key: '/t/async-armada', name: 'Async Armada', hue: 280, crest: 3, level: 7 },
    { key: '/t/segfault-syndicate', name: 'Segfault Syndicate', hue: 2, crest: 8, level: 4 },
    { key: '/t/heap-overlords', name: 'Heap Overlords', hue: 36, crest: 4, level: 5 },
    { key: '/t/merge-conflict', name: 'Merge Conflict', hue: 322, crest: 10, level: 3 },
  ];
  const TOOLS = ['Bash', 'Read', 'Edit', 'Write', 'Grep', 'Bash', 'Edit', 'Read', 'WebFetch', 'Task'];

  // Seed an established-looking world.
  TRIBES.forEach((t) => sim.applyFactionMeta({
    key: t.key, name: t.name, hue: t.hue, crest: t.crest, level: t.level,
    resources: 40 + t.level * 25, totalTools: t.level * 18,
  }));

  // Per-tribe live sessions. (Declare state + helpers BEFORE the init loop uses them.)
  const sessions = {}; // key -> [sid]
  let SID = 1;
  function ev(o) { sim.applyEvent(o); }
  function startSession(key) {
    const t = TRIBES.find((x) => x.key === key);
    const sid = 't' + (SID++);
    sessions[key].push(sid);
    ev({ event: 'SessionStart', projectKey: key, projectName: t.name, sessionId: sid, source: 'startup' });
    return sid;
  }
  function endSession(key) {
    const arr = sessions[key];
    if (arr.length <= 1) return;
    const sid = arr.shift();
    const t = TRIBES.find((x) => x.key === key);
    ev({ event: 'SessionEnd', projectKey: key, projectName: t.name, sessionId: sid });
  }

  TRIBES.forEach((t) => {
    sessions[t.key] = [];
    const n = 1 + Math.floor(Math.random() * 2);
    for (let i = 0; i < n; i++) startSession(t.key);
  });

  function tick() {
    const t = TRIBES[Math.floor(Math.random() * TRIBES.length)];
    const arr = sessions[t.key];
    // churn sessions occasionally so avatars are born and retire
    if (Math.random() < 0.06 && arr.length < 4) startSession(t.key);
    else if (Math.random() < 0.04) endSession(t.key);
    if (!arr.length) return;
    const sid = arr[Math.floor(Math.random() * arr.length)];
    const base = { projectKey: t.key, projectName: t.name, sessionId: sid };

    if (Math.random() < 0.12) { ev({ ...base, event: 'UserPromptSubmit' }); return; }
    if (Math.random() < 0.02) { ev({ ...base, event: 'Notification' }); return; }
    if (Math.random() < 0.012) { ev({ ...base, event: 'PreCompact' }); return; }

    const tool = TOOLS[Math.floor(Math.random() * TOOLS.length)];
    ev({ ...base, event: 'PreToolUse', tool, subagentType: tool === 'Task' ? pickSub() : null });
    const dt = 300 + Math.random() * 900;
    setTimeout(() => {
      const err = Math.random() < 0.07;
      ev({ ...base, event: 'PostToolUse', tool, isError: err });
      if (tool === 'Task') setTimeout(() => ev({ ...base, event: 'SubagentStop', agentId: 'a' + SID++ }), 2200 + Math.random() * 3500);
      if (Math.random() < 0.16) ev({ ...base, event: 'Stop' });
    }, dt);
  }
  function pickSub() { return ['Explore', 'Plan', 'general-purpose', 'code-reviewer'][Math.floor(Math.random() * 4)]; }

  setInterval(tick, 380);

  // ---- canvas / camera (trimmed from game.js) ------------------------------
  const canvas = document.getElementById('arena-stage');
  const ctx = canvas.getContext('2d');
  let W = 0, H = 0, DPR = 1;
  function resize() {
    const r = canvas.getBoundingClientRect();
    DPR = Math.min(2, window.devicePixelRatio || 1);
    W = r.width; H = r.height;
    canvas.width = Math.max(1, W * DPR); canvas.height = Math.max(1, H * DPR);
  }
  window.addEventListener('resize', resize);

  const cam = { x: 0, y: 0, zoom: 0.6, tx: 0, ty: 0, tzoom: 0.6 };
  let autoFrame = true;
  function fitView(instant) {
    const b = sim.bounds();
    const cx = (b.minx + b.maxx) / 2, cy = (b.miny + b.maxy) / 2;
    const z = Math.max(0.22, Math.min(0.95, Math.min(W / (b.maxx - b.minx + 260), H / (b.maxy - b.miny + 260))));
    cam.tx = cx; cam.ty = cy; cam.tzoom = z;
    if (instant) { cam.x = cx; cam.y = cy; cam.zoom = z; }
  }
  function s2w(sx, sy) { return { x: (sx - W / 2) / cam.zoom + cam.x, y: (sy - H / 2) / cam.zoom + cam.y }; }

  let drag = false, lx = 0, ly = 0;
  canvas.addEventListener('pointerdown', (e) => { drag = true; lx = e.clientX; ly = e.clientY; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener('pointerup', () => { drag = false; });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return; const dx = e.clientX - lx, dy = e.clientY - ly;
    cam.x -= dx / cam.zoom; cam.y -= dy / cam.zoom; cam.tx = cam.x; cam.ty = cam.y; autoFrame = false; lx = e.clientX; ly = e.clientY;
  });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    const before = s2w(e.clientX - r.left, e.clientY - r.top);
    cam.zoom = Math.max(0.2, Math.min(2.2, cam.zoom * Math.exp(-e.deltaY * 0.0015))); cam.tzoom = cam.zoom;
    const after = s2w(e.clientX - r.left, e.clientY - r.top);
    cam.x += before.x - after.x; cam.y += before.y - after.y; cam.tx = cam.x; cam.ty = cam.y; autoFrame = false;
  }, { passive: false });

  // ---- skin control --------------------------------------------------------
  let current = localStorage.getItem('arena.skin') || 'rts';
  if (!Arena.renderers[current]) current = 'rts';
  function setSkin(id) {
    if (!Arena.renderers[id]) return;
    current = id; localStorage.setItem('arena.skin', id);
    document.querySelectorAll('[data-skin]').forEach((b) => b.classList.toggle('on', b.dataset.skin === id));
  }
  window.ArenaEmbed = { setSkin, reframe: () => { autoFrame = true; fitView(false); } };

  // ---- effects -------------------------------------------------------------
  function drawEffects() {
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    for (const p of sim.particles) { const a = 1 - p.life / p.max; U.glow(ctx, p.x, p.y, p.size * 3, U.hsl(p.kind === 'error' ? 0 : p.hue, 90, 60, a * 0.7)); }
    ctx.restore();
    for (const fl of sim.floaters) { const a = 1 - fl.life / fl.max; ctx.fillStyle = U.hsl(fl.hue, 90, 70, a); ctx.font = 'bold 14px ui-sans-serif,system-ui,sans-serif'; ctx.textAlign = 'center'; ctx.fillText(fl.text, fl.x, fl.y); ctx.textAlign = 'left'; }
  }

  // live counters in the page (optional elements)
  const elU = document.getElementById('stat-units');
  const elT = document.getElementById('stat-tribes');
  const elD = document.getElementById('stat-drones');
  setInterval(() => {
    let u = 0, d = 0; for (const x of sim.units.values()) { if (x.dead) continue; if (x.kind === 'drone') d++; else u++; }
    if (elU) elU.textContent = u; if (elD) elD.textContent = d; if (elT) elT.textContent = sim.factions.size;
  }, 400);

  // ---- loop ----------------------------------------------------------------
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    sim.update(dt);
    if (autoFrame) fitView(false);
    cam.x += (cam.tx - cam.x) * Math.min(1, dt * 4);
    cam.y += (cam.ty - cam.y) * Math.min(1, dt * 4);
    cam.zoom += (cam.tzoom - cam.zoom) * Math.min(1, dt * 4);
    const r = Arena.renderers[current];
    const env = { w: W, h: H, cam, time: sim.time };
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    r.background(ctx, env);
    ctx.save();
    ctx.translate(W / 2, H / 2); ctx.scale(cam.zoom, cam.zoom); ctx.translate(-cam.x, -cam.y);
    r.drawWorld(ctx, sim, env);
    drawEffects();
    ctx.restore();
    requestAnimationFrame(frame);
  }

  function boot() {
    resize(); fitView(true); setSkin(current);
    document.querySelectorAll('[data-skin]').forEach((b) => b.addEventListener('click', () => setSkin(b.dataset.skin)));
    // settle the population a moment before first paint
    requestAnimationFrame(frame);
  }
  if (document.readyState === 'complete' || document.readyState === 'interactive') boot();
  else window.addEventListener('DOMContentLoaded', boot);
})();
