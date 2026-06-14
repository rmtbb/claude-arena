/* Claude Arena — standalone landing-page embed (RTS).
 * Runs the REAL engine (art + lore + sim + rts renderer) with a client-side
 * driver. Fictional tribes only, seeded across the full era range and a mix of
 * living/dormant so the page showcases growth, vitality, and the skyline
 * fingerprint — no real data, no server. */
(function () {
  'use strict';
  const A = Arena.art, lore = Arena.lore;
  const sim = new Arena.Sim();
  const now = Date.now();
  const DAY = 86400000;

  // tool-mix presets → "skyline fingerprint"
  function mix(dom) {
    const base = { Bash: 1, Edit: 1, Write: 1, Read: 1, Grep: 1, WebFetch: 1, Task: 1 };
    const heavy = { forge: 'Bash', workshop: 'Edit', tower: 'Read', barracks: 'Task' }[dom];
    if (heavy) base[heavy] = 9;
    return base;
  }
  function counts(total, dom) {
    const w = mix(dom), s = Object.values(w).reduce((a, b) => a + b, 0);
    const c = {}; for (const k in w) c[k] = Math.round(total * w[k] / s); return c;
  }

  // fictional tribes across eras; some live, some dormant (decayed)
  const TRIBES = [
    { key: '/t/null-pointers', name: 'Null Pointers', hue: 210, crest: 1, tools: 9200, sess: 140, sub: 80, ageD: 130, idleD: 0, dom: 'forge' },
    { key: '/t/the-refactory', name: 'The Refactory', hue: 150, crest: 7, tools: 2100, sess: 70, sub: 30, ageD: 64, idleD: 0, dom: 'workshop' },
    { key: '/t/async-armada', name: 'Async Armada', hue: 280, crest: 3, tools: 520, sess: 44, sub: 60, ageD: 22, idleD: 0, dom: 'barracks' },
    { key: '/t/heap-overlords', name: 'Heap Overlords', hue: 36, crest: 4, tools: 1300, sess: 38, sub: 12, ageD: 40, idleD: 0, dom: 'tower' },
    { key: '/t/segfault-syndicate', name: 'Segfault Syndicate', hue: 2, crest: 8, tools: 140, sess: 14, sub: 4, ageD: 11, idleD: 5, dom: 'tower' },
    { key: '/t/merge-conflict', name: 'Merge Conflict', hue: 322, crest: 10, tools: 430, sess: 26, sub: 8, ageD: 38, idleD: 3, dom: 'workshop' },
    { key: '/t/kernel-panic', name: 'Kernel Panic', hue: 95, crest: 5, tools: 36, sess: 6, sub: 0, ageD: 3, idleD: 0, dom: 'forge' },
  ];

  // a few tribes have subfolder "districts" — satellite extensions of the capital
  const SATS = {
    '/t/null-pointers': [{ sub: 'core', name: 'Core', tools: 1800 }, { sub: 'web', name: 'Web', tools: 700 }, { sub: 'docs', name: 'Docs', tools: 180 }, { sub: 'infra', name: 'Infra', tools: 60 }],
    '/t/the-refactory': [{ sub: 'engine', name: 'Engine', tools: 600 }, { sub: 'tests', name: 'Tests', tools: 120 }],
    '/t/heap-overlords': [{ sub: 'alloc', name: 'Allocator', tools: 300 }, { sub: 'gc', name: 'GC', tools: 80 }],
  };
  TRIBES.forEach((t) => {
    t.lastSeen = now - t.idleD * DAY - (t.idleD ? 0 : Math.random() * 1800000);
    const members = (SATS[t.key] || []).map((m) => ({ ...m, sessions: 1 + (m.tools / 200 | 0), firstSeen: now - t.ageD * DAY, lastSeen: t.lastSeen }));
    sim.applyFactionMeta({
      key: t.key, name: t.name, hue: t.hue, crest: t.crest,
      level: 1, resources: Math.round(t.tools * 0.6), totalTools: t.tools,
      totalSessions: t.sess, totalSubagents: t.sub, totalEvents: t.tools * 2,
      liveSessions: t.idleD ? 0 : 2, firstSeen: now - t.ageD * DAY, lastSeen: t.lastSeen,
      toolCounts: counts(t.tools, t.dom), preCompacts: Math.floor(t.tools / 800), members,
    });
  });

  // sessions only for LIVE tribes
  const sessions = {}; let SID = 1;
  const TOOLBYDOM = { forge: ['Bash', 'Bash', 'Read', 'Edit'], workshop: ['Edit', 'Write', 'Read', 'Bash'], tower: ['Read', 'Grep', 'Glob', 'Bash'], barracks: ['Task', 'Bash', 'Edit', 'Read'] };
  function ev(t, o) { o.projectKey = t.key; o.projectName = t.name; sim.applyEvent(o); const f = sim.factions.get(t.key); if (f) f.lastSeen = Date.now(); }
  TRIBES.filter((t) => !t.idleD).forEach((t) => {
    sessions[t.key] = [];
    const n = 1 + Math.floor(Math.random() * 2);
    for (let i = 0; i < n; i++) { const sid = 's' + SID++; sessions[t.key].push(sid); ev(t, { event: 'SessionStart', sessionId: sid, source: 'startup' }); }
  });

  function tick() {
    const live = TRIBES.filter((t) => !t.idleD);
    const t = live[Math.floor(Math.random() * live.length)];
    const arr = sessions[t.key]; if (!arr || !arr.length) return;
    if (Math.random() < 0.05 && arr.length < 4) { const sid = 's' + SID++; arr.push(sid); ev(t, { event: 'SessionStart', sessionId: sid }); return; }
    if (Math.random() < 0.04 && arr.length > 1) { ev(t, { event: 'SessionEnd', sessionId: arr.shift() }); return; }
    const sid = arr[Math.floor(Math.random() * arr.length)];
    if (Math.random() < 0.1) { ev(t, { event: 'UserPromptSubmit', sessionId: sid }); return; }
    const tool = (TOOLBYDOM[t.dom] || TOOLBYDOM.workshop)[Math.floor(Math.random() * 4)];
    ev(t, { event: 'PreToolUse', sessionId: sid, tool, subagentType: tool === 'Task' ? 'Explore' : null });
    setTimeout(() => {
      ev(t, { event: 'PostToolUse', sessionId: sid, tool, isError: Math.random() < 0.06 });
      if (tool === 'Task') setTimeout(() => ev(t, { event: 'SubagentStop', sessionId: sid, agentId: 'a' + SID++ }), 2400 + Math.random() * 3200);
      if (Math.random() < 0.16) ev(t, { event: 'Stop', sessionId: sid });
    }, 350 + Math.random() * 800);
  }
  setInterval(tick, 360);

  // ---- canvas / camera -----------------------------------------------------
  const canvas = document.getElementById('arena-stage');
  const ctx = canvas.getContext('2d');
  let W = 0, H = 0, DPR = 1;
  function resize() { const r = canvas.getBoundingClientRect(); DPR = Math.min(2, window.devicePixelRatio || 1); W = r.width; H = r.height; canvas.width = Math.max(1, W * DPR); canvas.height = Math.max(1, H * DPR); }
  window.addEventListener('resize', resize);
  const cam = { x: 0, y: 0, zoom: 0.55, tx: 0, ty: 0, tzoom: 0.55 };
  let autoFrame = true;
  function fitView(instant) {
    const b = sim.bounds(); const cx = (b.minx + b.maxx) / 2, cy = (b.miny + b.maxy) / 2;
    const z = Math.max(0.2, Math.min(0.9, Math.min(W / (b.maxx - b.minx + 260), H / (b.maxy - b.miny + 260))));
    cam.tx = cx; cam.ty = cy; cam.tzoom = z; if (instant) { cam.x = cx; cam.y = cy; cam.zoom = z; }
  }
  function s2w(sx, sy) { return { x: (sx - W / 2) / cam.zoom + cam.x, y: (sy - H / 2) / cam.zoom + cam.y }; }
  let drag = false, lx = 0, ly = 0;
  canvas.addEventListener('pointerdown', (e) => { drag = true; lx = e.clientX; ly = e.clientY; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener('pointerup', () => { drag = false; });
  canvas.addEventListener('pointermove', (e) => { if (!drag) return; cam.x -= (e.clientX - lx) / cam.zoom; cam.y -= (e.clientY - ly) / cam.zoom; cam.tx = cam.x; cam.ty = cam.y; autoFrame = false; lx = e.clientX; ly = e.clientY; });
  canvas.addEventListener('wheel', (e) => { e.preventDefault(); const r = canvas.getBoundingClientRect(); const before = s2w(e.clientX - r.left, e.clientY - r.top); cam.zoom = Math.max(0.18, Math.min(2.2, cam.zoom * Math.exp(-e.deltaY * 0.0015))); cam.tzoom = cam.zoom; const after = s2w(e.clientX - r.left, e.clientY - r.top); cam.x += before.x - after.x; cam.y += before.y - after.y; cam.tx = cam.x; cam.ty = cam.y; autoFrame = false; }, { passive: false });

  window.ArenaEmbed = { reframe: () => { autoFrame = true; fitView(false); }, focus: (i) => { const t = TRIBES[i]; const f = t && sim.factions.get(t.key); if (f) { autoFrame = false; cam.tx = f.x; cam.ty = f.y - 20; cam.tzoom = 1.5; } } };

  function drawEffects() {
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    for (const p of sim.particles) { const a = 1 - p.life / p.max; A.css && U(ctx, p, a); }
    ctx.restore();
    for (const fl of sim.floaters) { const a = 1 - fl.life / fl.max; ctx.fillStyle = `hsla(${fl.hue},90%,70%,${a})`; ctx.font = 'bold 14px ui-sans-serif,system-ui'; ctx.textAlign = 'center'; ctx.fillText(fl.text, fl.x, fl.y); ctx.textAlign = 'left'; }
  }
  function U(ctx, p, a) { const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.size * 3); const hue = p.kind === 'error' ? 0 : p.hue; g.addColorStop(0, `hsla(${hue},90%,60%,${a * 0.7})`); g.addColorStop(1, 'rgba(0,0,0,0)'); ctx.fillStyle = g; ctx.beginPath(); ctx.arc(p.x, p.y, p.size * 3, 0, Math.PI * 2); ctx.fill(); }

  const elU = document.getElementById('stat-units'), elT = document.getElementById('stat-tribes'), elD = document.getElementById('stat-drones');
  setInterval(() => { let u = 0, d = 0; for (const x of sim.units.values()) { if (x.dead) continue; if (x.kind === 'drone') d++; else u++; } if (elU) elU.textContent = u; if (elD) elD.textContent = d; if (elT) elT.textContent = sim.factions.size; }, 400);

  let last = performance.now();
  function frame(nw) {
    const dt = Math.min(0.05, (nw - last) / 1000); last = nw;
    sim.update(dt);
    if (autoFrame) fitView(false);
    cam.x += (cam.tx - cam.x) * Math.min(1, dt * 4); cam.y += (cam.ty - cam.y) * Math.min(1, dt * 4); cam.zoom += (cam.tzoom - cam.zoom) * Math.min(1, dt * 4);
    const r = Arena.renderers.rts; const env = { w: W, h: H, cam, time: sim.time, _s2w: s2w };
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    r.background(ctx, env);
    ctx.save(); ctx.translate(W / 2, H / 2); ctx.scale(cam.zoom, cam.zoom); ctx.translate(-cam.x, -cam.y);
    r.drawWorld(ctx, sim, env); drawEffects();
    ctx.restore();
    requestAnimationFrame(frame);
  }
  function boot() { resize(); fitView(true); requestAnimationFrame(frame); }
  if (document.readyState !== 'loading') boot(); else window.addEventListener('DOMContentLoaded', boot);
})();
