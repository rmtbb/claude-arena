/* Claude Arena — Cyber renderer. Dark grid, neon trails, glow-heavy. Screenshot bait. */
(function () {
  'use strict';
  const U = Arena.util, TAU = U.TAU;

  // persistent trails keyed by unit id
  const trails = new Map();

  function background(ctx, env) {
    const { w, h, cam } = env;
    ctx.fillStyle = '#04060a';
    ctx.fillRect(0, 0, w, h);
    const gz = 48 * cam.zoom;
    const ox = (-cam.x * cam.zoom) % gz, oy = (-cam.y * cam.zoom) % gz;
    ctx.strokeStyle = 'rgba(40,120,160,0.10)'; ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = ox; x < w; x += gz) { ctx.moveTo(x, 0); ctx.lineTo(x, h); }
    for (let y = oy; y < h; y += gz) { ctx.moveTo(0, y); ctx.lineTo(w, y); }
    ctx.stroke();
    // brighter major grid
    ctx.strokeStyle = 'rgba(60,180,220,0.06)'; ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let x = ox; x < w; x += gz * 4) { ctx.moveTo(x, 0); ctx.lineTo(x, h); }
    for (let y = oy; y < h; y += gz * 4) { ctx.moveTo(0, y); ctx.lineTo(w, y); }
    ctx.stroke();
  }

  function drawNode(ctx, f, env) {
    const t = env.time;
    const territory = 150 + f.level * 14;
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    U.glow(ctx, f.x, f.y, territory, U.hsl(f.hue, 100, 50, 0.08));

    // hex perimeter
    ctx.strokeStyle = U.hsl(f.hue, 100, 60, 0.4); ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i <= 6; i++) { const a = i / 6 * TAU + t * 0.1; const r = territory * 0.85; ctx[i ? 'lineTo' : 'moveTo'](f.x + Math.cos(a) * r, f.y + Math.sin(a) * r); }
    ctx.stroke();

    // links to stations (energy conduits)
    for (const s of Object.values(f.stations)) {
      const flow = (t * 2 + s.x) % 1;
      ctx.strokeStyle = U.hsl(Arena.STATION_HUE[s.type], 100, 60, 0.25 + s.pulse * 0.5);
      ctx.lineWidth = 1 + s.pulse * 2;
      ctx.beginPath(); ctx.moveTo(f.x, f.y); ctx.lineTo(s.x, s.y); ctx.stroke();
      // packet
      const px = f.x + (s.x - f.x) * flow, py = f.y + (s.y - f.y) * flow;
      U.glow(ctx, px, py, 4, U.hsl(Arena.STATION_HUE[s.type], 100, 70, 0.8));
      // station node
      U.glow(ctx, s.x, s.y, 10 + s.pulse * 14, U.hsl(Arena.STATION_HUE[s.type], 100, 60, 0.4 + s.pulse * 0.4));
      ctx.fillStyle = U.hsl(Arena.STATION_HUE[s.type], 100, 65);
      ctx.beginPath(); ctx.arc(s.x, s.y, 4, 0, TAU); ctx.fill();
    }
    ctx.restore();

    // core
    const pulse = 1 + Math.sin(t * 3) * 0.05 + f.beacon * 0.2;
    ctx.save(); ctx.translate(f.x, f.y); ctx.scale(pulse, pulse);
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    U.glow(ctx, 0, 0, 34, U.hsl(f.hue, 100, 55, 0.6 + f.beacon * 0.4));
    ctx.restore();
    ctx.strokeStyle = U.hsl(f.hue, 100, 70); ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < 6; i++) { const a = i / 6 * TAU - t * 0.4; const r = 22; ctx[i ? 'lineTo' : 'moveTo'](Math.cos(a) * r, Math.sin(a) * r); }
    ctx.closePath(); ctx.stroke();
    ctx.beginPath();
    for (let i = 0; i < 3; i++) { const a = i / 3 * TAU + t * 0.6; const r = 12; ctx[i ? 'lineTo' : 'moveTo'](Math.cos(a) * r, Math.sin(a) * r); }
    ctx.closePath(); ctx.stroke();
    U.crest(ctx, f.crest, 0, 0, 9, U.hsl(f.hue, 100, 80));
    ctx.restore();

    label(ctx, f, env, territory);
  }

  function label(ctx, f, env, territory) {
    const y = f.y - territory * 0.85 - 16;
    ctx.font = '700 13px ui-monospace,monospace';
    const name = f.name.toUpperCase();
    const tw = ctx.measureText(name).width;
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = U.hsl(f.hue, 100, 65, 0.95); ctx.textAlign = 'center';
    ctx.shadowColor = U.hsl(f.hue, 100, 60, 1); ctx.shadowBlur = 10;
    ctx.fillText(name, f.x, y);
    ctx.shadowBlur = 0;
    ctx.font = '600 9px ui-monospace,monospace';
    ctx.fillStyle = U.hsl(f.hue, 80, 60, 0.7);
    ctx.fillText(`v${f.level} ▚ ${f.resources} units`, f.x, y + 12);
    ctx.restore(); ctx.textAlign = 'left';
  }

  function drawAgent(ctx, u, f, env) {
    const r = (u.kind === 'drone' ? 4 : 6) * u.scale;
    const x = u.x, y = u.y;

    // trail
    let tr = trails.get(u.id); if (!tr) { tr = []; trails.set(u.id, tr); }
    tr.push([x, y]); if (tr.length > 14) tr.shift();
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    for (let i = 1; i < tr.length; i++) {
      ctx.strokeStyle = U.hsl(f.hue, 100, 60, (i / tr.length) * 0.5);
      ctx.lineWidth = (i / tr.length) * r;
      ctx.beginPath(); ctx.moveTo(tr[i - 1][0], tr[i - 1][1]); ctx.lineTo(tr[i][0], tr[i][1]); ctx.stroke();
    }
    const hue = u.state === 'stumble' ? 0 : f.hue;
    U.glow(ctx, x, y, r * 2.6, U.hsl(hue, 100, 60, u.alert > 0.3 ? 0.9 : 0.6));
    ctx.fillStyle = U.hsl(hue, 100, u.kind === 'drone' ? 70 : 78);
    if (u.kind === 'drone') {
      ctx.beginPath(); ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); ctx.closePath(); ctx.fill();
    } else {
      ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
      ctx.strokeStyle = U.hsl(hue, 100, 85, 0.9); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(x, y, r + 2, 0, TAU); ctx.stroke();
    }
    ctx.restore();

    if (u.alert > 0.3) { ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.fillStyle = U.hsl(48, 100, 70, u.alert); ctx.font = 'bold 12px monospace'; ctx.textAlign = 'center'; ctx.fillText('!', x, y - r - 6); ctx.restore(); ctx.textAlign = 'left'; }
  }

  function drawWorld(ctx, sim, env) {
    // prune trails of dead units occasionally
    if (trails.size > 400) trails.clear();
    for (const f of sim.factions.values()) drawNode(ctx, f, env);
    for (const u of sim.units.values()) {
      const f = sim.factions.get(u.factionKey); if (!f) continue;
      ctx.globalAlpha = u.dead ? Math.max(0, 1 - u.deadT / 0.6) : 1;
      drawAgent(ctx, u, f, env);
      ctx.globalAlpha = 1;
    }
  }

  Arena.renderers = Arena.renderers || {};
  Arena.renderers.cyber = { id: 'cyber', label: 'Cyber', emoji: '⚡', background, drawWorld };
})();
