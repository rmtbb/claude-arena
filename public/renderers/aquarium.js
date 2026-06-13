/* Claude Arena — Aquarium renderer. Cozy living tank; bases are reefs, units drift. */
(function () {
  'use strict';
  const U = Arena.util, TAU = U.TAU;

  function background(ctx, env) {
    const { w, h, time } = env;
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#06283d');
    g.addColorStop(0.5, '#0a3a54');
    g.addColorStop(1, '#04202f');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    // caustic light shafts
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 5; i++) {
      const x = ((i * 0.21 + time * 0.01) % 1.2 - 0.1) * w;
      const grad = ctx.createLinearGradient(x, 0, x + 80, h);
      grad.addColorStop(0, 'rgba(120,200,230,0.05)');
      grad.addColorStop(1, 'rgba(120,200,230,0)');
      ctx.fillStyle = grad;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x + 120, 0); ctx.lineTo(x + 60, h); ctx.lineTo(x - 60, h); ctx.closePath(); ctx.fill();
    }
    ctx.restore();
    // floating motes
    ctx.fillStyle = 'rgba(180,220,240,0.15)';
    for (let i = 0; i < 40; i++) {
      const x = (U.vnoise(i, 1) * w + time * 6 * (0.3 + U.vnoise(i, 9))) % w;
      const y = (U.vnoise(i, 2) * h - time * 4) % h;
      ctx.beginPath(); ctx.arc(x, (y + h) % h, 1 + U.vnoise(i, 3) * 1.5, 0, TAU); ctx.fill();
    }
  }

  function drawReef(ctx, f, env) {
    const t = env.time;
    const territory = 150 + f.level * 14;
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    U.glow(ctx, f.x, f.y, territory, U.hsl(f.hue, 80, 45, 0.10));
    ctx.restore();

    // sandy mound
    ctx.fillStyle = U.hsl(f.hue, 25, 22, 0.5);
    ctx.beginPath(); ctx.ellipse(f.x, f.y + 8, territory * 0.6, territory * 0.34, 0, 0, TAU); ctx.fill();

    // coral fronds (grow with level), swaying
    const fronds = Math.min(14, 4 + f.level);
    for (let i = 0; i < fronds; i++) {
      const a = i / fronds * TAU;
      const r = territory * 0.42 * (0.5 + U.vnoise(i + f.crest, 4) * 0.6);
      const bx = f.x + Math.cos(a) * r, by = f.y + Math.sin(a) * r + 6;
      const sway = Math.sin(t * 1.2 + i) * 6;
      ctx.strokeStyle = U.hsl((f.hue + i * 12) % 360, 65, 55, 0.8);
      ctx.lineWidth = 3; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(bx, by);
      ctx.quadraticCurveTo(bx + sway, by - 18, bx + sway * 1.6, by - 34 - (i % 3) * 6); ctx.stroke();
      ctx.fillStyle = U.hsl((f.hue + i * 12) % 360, 70, 65, 0.9);
      ctx.beginPath(); ctx.arc(bx + sway * 1.6, by - 34 - (i % 3) * 6, 3, 0, TAU); ctx.fill();
    }

    // anemone stations
    for (const s of Object.values(f.stations)) {
      ctx.save(); ctx.globalCompositeOperation = 'lighter';
      U.glow(ctx, s.x, s.y, 18 + s.pulse * 16, U.hsl(Arena.STATION_HUE[s.type], 80, 55, 0.18 + s.pulse * 0.3));
      ctx.restore();
      const tent = 8;
      ctx.strokeStyle = U.hsl(Arena.STATION_HUE[s.type], 70, 60, 0.8); ctx.lineWidth = 2; ctx.lineCap = 'round';
      for (let i = 0; i < tent; i++) {
        const a = i / tent * TAU; const sway = Math.sin(t * 2 + i + s.x) * 3;
        ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(s.x + Math.cos(a) * (9 + sway), s.y + Math.sin(a) * (9 + sway)); ctx.stroke();
      }
    }

    // central clam / heart
    const breathe = 1 + Math.sin(t * 1.5) * 0.04 + f.beacon * 0.12;
    ctx.save(); ctx.translate(f.x, f.y); ctx.scale(breathe, breathe);
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    U.glow(ctx, 0, 0, 28, U.hsl(f.hue, 85, 60, 0.45 + f.beacon * 0.4));
    ctx.restore();
    ctx.fillStyle = U.hsl(f.hue, 45, 30); ctx.strokeStyle = U.hsl(f.hue, 70, 65); ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.arc(0, 0, 20, 0, TAU); ctx.fill(); ctx.stroke();
    ctx.fillStyle = U.hsl(f.hue, 30, 18); ctx.beginPath(); ctx.arc(0, 0, 14, 0, TAU); ctx.fill();
    U.crest(ctx, f.crest, 0, 0, 11, U.hsl(f.hue, 85, 78));
    ctx.restore();

    label(ctx, f, env, territory);
  }

  function label(ctx, f, env, territory) {
    const y = f.y - territory * 0.34 - 28;
    ctx.font = '700 15px ui-sans-serif,system-ui,sans-serif';
    const tw = ctx.measureText(f.name).width;
    ctx.fillStyle = 'rgba(4,24,36,0.6)';
    U.roundRect(ctx, f.x - tw / 2 - 10, y - 13, tw + 20, 22, 11); ctx.fill();
    ctx.fillStyle = U.hsl(f.hue, 75, 80); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(f.name, f.x, y - 1);
    ctx.font = '600 10px ui-monospace,monospace';
    ctx.fillStyle = U.hsl(f.hue, 50, 65, 0.85);
    ctx.fillText(`depth ${f.level}  ·  ✦ ${f.resources}`, f.x, y + 13);
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  }

  function drawCreature(ctx, u, f, env) {
    const r = (u.kind === 'drone' ? 4.5 : 7) * u.scale;
    const swim = Math.sin(u.wob) * 3;
    const x = u.x, y = u.y + Math.sin(u.wob * 0.5) * 2;
    const ang = Math.atan2(u.vy, u.vx);
    const moving = Math.hypot(u.vx, u.vy) > 6;

    if (u.carry) { ctx.save(); ctx.globalCompositeOperation = 'lighter'; U.glow(ctx, x, y, 8, U.hsl(u.carry.hue, 90, 60, 0.6)); ctx.restore(); }

    ctx.save(); ctx.translate(x, y); ctx.rotate(moving ? ang : 0);
    const sat = u.alert > 0.3 ? 95 : 72;
    const light = u.state === 'stumble' ? 40 : 60;
    // body (fish-like ellipse)
    ctx.fillStyle = u.state === 'stumble' ? U.hsl(0, 70, 45) : U.hsl(f.hue, sat, light);
    ctx.beginPath(); ctx.ellipse(0, 0, r * 1.5, r, 0, 0, TAU); ctx.fill();
    // tail
    ctx.fillStyle = U.hsl(f.hue, sat, light - 8);
    ctx.beginPath(); ctx.moveTo(-r * 1.4, 0); ctx.lineTo(-r * 2.3, -r * 0.8 + swim); ctx.lineTo(-r * 2.3, r * 0.8 + swim); ctx.closePath(); ctx.fill();
    // dorsal fin for workers
    if (u.kind === 'worker') {
      ctx.beginPath(); ctx.moveTo(0, -r); ctx.lineTo(r * 0.6, -r * 1.8); ctx.lineTo(r * 0.8, -r * 0.6); ctx.closePath(); ctx.fill();
    }
    // eye
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(r * 0.8, -r * 0.2, r * 0.32, 0, TAU); ctx.fill();
    ctx.fillStyle = '#04202f'; ctx.beginPath(); ctx.arc(r * 0.9, -r * 0.2, r * 0.16, 0, TAU); ctx.fill();
    ctx.restore();

    if (u.alert > 0.3) { ctx.fillStyle = U.hsl(48, 100, 65, u.alert); ctx.font = 'bold 12px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('!', x, y - r - 6); ctx.textAlign = 'left'; }
    if (u.state === 'rest') { ctx.fillStyle = U.hsl(f.hue, 60, 85, 0.7); ctx.font = '10px sans-serif'; ctx.fillText('z', x + r, y - r - 2 + Math.sin(env.time * 3) * 2); }
  }

  function drawWorld(ctx, sim, env) {
    for (const f of sim.factions.values()) drawReef(ctx, f, env);
    const arr = Array.from(sim.units.values()).sort((a, b) => a.y - b.y);
    for (const u of arr) {
      const f = sim.factions.get(u.factionKey); if (!f) continue;
      ctx.globalAlpha = u.dead ? Math.max(0, 1 - u.deadT / 0.6) : 1;
      drawCreature(ctx, u, f, env);
      ctx.globalAlpha = 1;
    }
  }

  Arena.renderers = Arena.renderers || {};
  Arena.renderers.aquarium = { id: 'aquarium', label: 'Aquarium', emoji: '🐠', background, drawWorld };
})();
