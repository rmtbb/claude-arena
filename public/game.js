/* Claude Arena — bootstrap: canvas, camera, input, live data, HUD, curation.
 * Renderer-agnostic: drives the shared Sim and hands it to the active skin. */
(function () {
  'use strict';
  const U = Arena.util, TAU = U.TAU;
  const sim = new Arena.Sim();

  // ---- renderer registry ---------------------------------------------------
  const ORDER = ['rts', 'aquarium', 'cyber'];
  let current = localStorage.getItem('arena.renderer') || 'rts';
  if (!Arena.renderers[current]) current = 'rts';

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
    cam.tx = cam.x; cam.ty = cam.y; autoFrame = false; lastX = e.clientX; lastY = e.clientY;
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
    if (e.key === 'r' || e.key === 'R') { autoFrame = true; fitView(false); }
    if (e.key === ' ') { autoFrame = !autoFrame; }
    const idx = ORDER.indexOf(current);
    if (e.key === 'Tab') { e.preventDefault(); setRenderer(ORDER[(idx + 1) % ORDER.length]); }
    if (e.key >= '1' && e.key <= '3') setRenderer(ORDER[+e.key - 1]);
  });

  function handleClick(sx, sy) {
    const w = screenToWorld(sx, sy);
    let best = null, bd = 1e9;
    for (const f of sim.factions.values()) {
      const d = Math.hypot(f.x - w.x, f.y - w.y);
      if (d < 60 && d < bd) { bd = d; best = f; }
    }
    if (best) openCurate(best);
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
      fitView(true);
      updateHud();
    } catch (e) { /* server may not be ready */ }
  }

  function connect() {
    const es = new EventSource('/api/stream');
    es.onmessage = (e) => {
      try { const n = JSON.parse(e.data); sim.applyEvent(n); flashLive(); } catch (_) {}
    };
    es.addEventListener('hello', () => {});
    es.onerror = () => { /* EventSource auto-reconnects */ };
  }

  // periodic resync of authoritative faction stats (level/resources/name)
  setInterval(async () => {
    try { const r = await fetch('/api/state'); const s = await r.json(); for (const m of s.factions) sim.applyFactionMeta(m); updateHud(); } catch (_) {}
  }, 8000);

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

  function updateHud() {
    let units = 0, drones = 0;
    for (const u of sim.units.values()) { if (u.dead) continue; if (u.kind === 'drone') drones++; else units++; }
    elFactions.textContent = sim.factions.size;
    elUnits.textContent = units;
    elDrones.textContent = drones;
  }

  let tickerLast = '';
  function updateTicker() {
    const items = sim.ticker.slice(-7).reverse();
    const html = items.map((t) => `<span style="color:${U.hsl(t.hue, 70, 70)}">${escapeHtml(t.text)}</span>`).join('');
    if (html !== tickerLast) { elTicker.innerHTML = html; tickerLast = html; }
  }
  function escapeHtml(s) { return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

  // ---- renderer switcher ---------------------------------------------------
  function setRenderer(id) {
    if (!Arena.renderers[id]) return;
    current = id; localStorage.setItem('arena.renderer', id);
    document.querySelectorAll('.skin-btn').forEach((b) => b.classList.toggle('active', b.dataset.id === id));
    document.body.dataset.skin = id;
  }
  function buildSwitcher() {
    const host = document.getElementById('skins');
    ORDER.forEach((id) => {
      const r = Arena.renderers[id];
      const b = document.createElement('button');
      b.className = 'skin-btn'; b.dataset.id = id;
      b.innerHTML = `<span class="emoji">${r.emoji}</span>${r.label}`;
      b.onclick = () => setRenderer(id);
      host.appendChild(b);
    });
    setRenderer(current);
  }

  // ---- curate panel --------------------------------------------------------
  const panel = document.getElementById('curate');
  let curated = null;
  function openCurate(f) {
    curated = f;
    panel.classList.add('open');
    panel.querySelector('#c-name').value = f.name;
    panel.querySelector('#c-motto').value = f.motto || '';
    panel.querySelector('#c-hue').value = f.hue;
    panel.querySelector('#c-crest').value = f.crest;
    panel.querySelector('#c-stats').innerHTML =
      `<b>LVL ${f.level}</b> · ⚒ ${f.resources} harvested · ${f.totalTools} tools`;
    panel.querySelector('#c-swatch').style.background = U.hsl(f.hue, 70, 50);
  }
  function closeCurate() { panel.classList.remove('open'); curated = null; }
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
  panel.querySelector('#c-hue').addEventListener('input', () => applyCurate(false));
  panel.querySelector('#c-crest').addEventListener('input', () => applyCurate(false));
  panel.querySelector('#c-save').onclick = () => applyCurate(true);
  panel.querySelector('#c-close').onclick = closeCurate;

  // ---- toolbar actions -----------------------------------------------------
  document.getElementById('btn-frame').onclick = () => { autoFrame = true; fitView(false); };
  document.getElementById('btn-demo').onclick = () => fetch('/api/demo', { method: 'POST' }).catch(() => {});
  document.getElementById('btn-shot').onclick = () => {
    canvas.toBlob((blob) => {
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
      a.download = 'claude-arena.png'; a.click();
    });
  };

  // ---- main loop -----------------------------------------------------------
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    sim.update(dt);

    // camera easing
    if (autoFrame) fitView(false);
    cam.x += (cam.tx - cam.x) * Math.min(1, dt * 4);
    cam.y += (cam.ty - cam.y) * Math.min(1, dt * 4);
    cam.zoom += (cam.tzoom - cam.zoom) * Math.min(1, dt * 4);
    liveT = Math.max(0, liveT - dt * 1.5);
    elLive.style.opacity = 0.4 + liveT * 0.6;

    const r = Arena.renderers[current];
    const env = { w: W, h: H, cam, time: sim.time };

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
  buildSwitcher();
  loadState().then(() => connect());
  requestAnimationFrame(frame);
})();
