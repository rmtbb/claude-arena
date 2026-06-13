/* Claude Arena — RTS renderer. Top-down StarCraft-ish bases, harvesters, drones. */
(function () {
  'use strict';
  const U = Arena.util, TAU = U.TAU;

  const STATION_STYLE = {
    mineral: { hue: 205, label: '◆', name: 'crystals' },
    gas: { hue: 130, label: '⬢', name: 'geyser' },
    scout: { hue: 50, label: '▲', name: 'watchtower' },
    expedition: { hue: 285, label: '⌖', name: 'warp gate' },
    spawn: { hue: 350, label: '✶', name: 'hatchery' },
  };

  function background(ctx, env) {
    const { w, h, cam, time } = env;
    // dark tactical ground
    ctx.fillStyle = '#0c1014';
    ctx.fillRect(0, 0, w, h);
    // parallax terrain blotches
    ctx.save();
    const gz = 64 * cam.zoom;
    const ox = (-cam.x * cam.zoom) % gz, oy = (-cam.y * cam.zoom) % gz;
    ctx.strokeStyle = 'rgba(80,120,90,0.06)';
    ctx.lineWidth = 1;
    for (let x = ox; x < w; x += gz) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
    for (let y = oy; y < h; y += gz) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
    ctx.restore();
    // vignette
    const g = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.3, w / 2, h / 2, Math.max(w, h) * 0.75);
    g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,0.55)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  }

  function drawBase(ctx, f, env) {
    const t = env.time;
    const territory = 150 + f.level * 14;
    // territory glow
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    U.glow(ctx, f.x, f.y, territory, U.hsl(f.hue, 70, 30, 0.10));
    ctx.restore();
    // territory ring
    ctx.strokeStyle = U.hsl(f.hue, 60, 55, 0.25);
    ctx.lineWidth = 2; ctx.setLineDash([6, 10]);
    ctx.beginPath(); ctx.arc(f.x, f.y, territory, 0, TAU); ctx.stroke();
    ctx.setLineDash([]);

    // outlying buildings grow with level
    const rings = Math.min(10, f.level);
    for (let i = 0; i < rings; i++) {
      const a = i / rings * TAU + 0.4;
      const bx = f.x + Math.cos(a) * (territory * 0.62);
      const by = f.y + Math.sin(a) * (territory * 0.62);
      ctx.fillStyle = U.hsl(f.hue, 30, 22);
      ctx.strokeStyle = U.hsl(f.hue, 60, 45);
      ctx.lineWidth = 1.5;
      U.roundRect(ctx, bx - 9, by - 9, 18, 18, 3); ctx.fill(); ctx.stroke();
      ctx.fillStyle = U.hsl(f.hue, 70, 55, 0.9);
      ctx.fillRect(bx - 5, by - 5, 4, 4);
    }

    // resource stations
    for (const s of Object.values(f.stations)) {
      const st = STATION_STYLE[s.type];
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      U.glow(ctx, s.x, s.y, 26 + s.pulse * 18, U.hsl(st.hue, 80, 50, 0.18 + s.pulse * 0.3));
      ctx.restore();
      ctx.fillStyle = U.hsl(st.hue, 60, 45);
      ctx.strokeStyle = U.hsl(st.hue, 80, 70);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let i = 0; i < 6; i++) { const a = i / 6 * TAU; const r = 11; ctx[i ? 'lineTo' : 'moveTo'](s.x + Math.cos(a) * r, s.y + Math.sin(a) * r); }
      ctx.closePath(); ctx.fill(); ctx.stroke();
    }

    // command center
    const pulse = 1 + Math.sin(t * 2) * 0.02 + f.beacon * 0.1;
    ctx.save();
    ctx.translate(f.x, f.y); ctx.scale(pulse, pulse);
    // base plate
    ctx.fillStyle = U.hsl(f.hue, 25, 16);
    ctx.strokeStyle = U.hsl(f.hue, 65, 50);
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    for (let i = 0; i < 8; i++) { const a = i / 8 * TAU + Math.PI / 8; const r = 34; ctx[i ? 'lineTo' : 'moveTo'](Math.cos(a) * r, Math.sin(a) * r); }
    ctx.closePath(); ctx.fill(); ctx.stroke();
    // inner core
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    U.glow(ctx, 0, 0, 26, U.hsl(f.hue, 80, 55, 0.5 + f.beacon * 0.4));
    ctx.restore();
    ctx.fillStyle = U.hsl(f.hue, 40, 20);
    ctx.beginPath(); ctx.arc(0, 0, 19, 0, TAU); ctx.fill();
    U.crest(ctx, f.crest, 0, 0, 13, U.hsl(f.hue, 85, 72));
    ctx.restore();

    // beacon ping
    if (f.beacon > 0) {
      const pr = (1 - f.beacon / 1.2) * 70;
      ctx.strokeStyle = U.hsl(f.hue, 90, 65, f.beacon / 1.2);
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(f.x, f.y, 34 + pr, 0, TAU); ctx.stroke();
    }

    // banner
    label(ctx, f, env);
  }

  function label(ctx, f, env) {
    const y = f.y + 200 + f.level * 14 - 44;
    ctx.font = '700 15px ui-sans-serif,system-ui,sans-serif';
    const tw = ctx.measureText(f.name).width;
    ctx.fillStyle = 'rgba(8,12,16,0.7)';
    U.roundRect(ctx, f.x - tw / 2 - 12, y - 14, tw + 24, 24, 6); ctx.fill();
    ctx.fillStyle = U.hsl(f.hue, 70, 30, 1);
    ctx.fillRect(f.x - tw / 2 - 12, y - 14, 4, 24);
    ctx.fillStyle = U.hsl(f.hue, 80, 80);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(f.name, f.x, y - 1);
    ctx.font = '600 10px ui-monospace,monospace';
    ctx.fillStyle = U.hsl(f.hue, 40, 60, 0.8);
    ctx.fillText(`LVL ${f.level}  ·  ⚒ ${f.resources}`, f.x, y + 13);
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  }

  function drawUnit(ctx, u, f, env) {
    const r = (u.kind === 'drone' ? 5 : 7) * u.scale;
    const bob = Math.sin(u.wob) * (u.kind === 'drone' ? 2 : 1.2);
    const x = u.x, y = u.y + bob;
    const moving = Math.hypot(u.vx, u.vy) > 8;
    const ang = Math.atan2(u.vy, u.vx);

    // shadow
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath(); ctx.ellipse(u.x, u.y + r + 2, r * 0.9, r * 0.4, 0, 0, TAU); ctx.fill();

    // carry trail
    if (u.carry) {
      ctx.save(); ctx.globalCompositeOperation = 'lighter';
      U.glow(ctx, x, y - r - 3, 7, U.hsl(u.carry.hue, 90, 60, 0.7));
      ctx.restore();
    }

    ctx.save();
    ctx.translate(x, y); ctx.rotate(moving ? ang + Math.PI / 2 : 0);
    const light = u.state === 'stumble' ? 40 : 55;
    const sat = u.alert > 0.3 ? 95 : 70;
    if (u.kind === 'drone') {
      // diamond drone with thruster
      ctx.fillStyle = U.hsl(f.hue, sat, light);
      ctx.strokeStyle = U.hsl(f.hue, 80, 80); ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(0, -r); ctx.lineTo(r * 0.8, 0); ctx.lineTo(0, r); ctx.lineTo(-r * 0.8, 0); ctx.closePath();
      ctx.fill(); ctx.stroke();
      ctx.fillStyle = U.hsl(f.hue, 90, 85); ctx.fillRect(-1, -1.5, 2, 3);
    } else {
      // worker: rounded body + little legs
      ctx.fillStyle = u.state === 'stumble' ? U.hsl(0, 70, 45) : U.hsl(f.hue, sat, light);
      ctx.strokeStyle = U.hsl(f.hue, 80, 82); ctx.lineWidth = 1.4;
      U.roundRect(ctx, -r, -r, r * 2, r * 2, r * 0.6); ctx.fill(); ctx.stroke();
      // visor
      ctx.fillStyle = U.hsl(f.hue, 90, 88, 0.9);
      ctx.fillRect(-r * 0.5, -r * 0.6, r, r * 0.5);
      // legs
      const legp = Math.sin(u.wob) * r * 0.5;
      ctx.strokeStyle = U.hsl(f.hue, 60, 40); ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.moveTo(-r * 0.4, r); ctx.lineTo(-r * 0.4, r + 3 + legp); ctx.moveTo(r * 0.4, r); ctx.lineTo(r * 0.4, r + 3 - legp); ctx.stroke();
    }
    ctx.restore();

    if (u.state === 'rest') {
      ctx.fillStyle = U.hsl(f.hue, 60, 80, 0.8);
      ctx.font = '10px sans-serif';
      ctx.fillText('z', x + r, y - r - 2 + Math.sin(env.time * 3) * 2);
    }
    if (u.alert > 0.3) {
      ctx.fillStyle = U.hsl(48, 100, 60, u.alert);
      ctx.font = 'bold 13px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('!', x, y - r - 5); ctx.textAlign = 'left';
    }
  }

  function drawWorld(ctx, sim, env) {
    for (const f of sim.factions.values()) drawBase(ctx, f, env);
    // drones under workers for depth
    const arr = Array.from(sim.units.values()).sort((a, b) => a.y - b.y);
    for (const u of arr) {
      const f = sim.factions.get(u.factionKey); if (!f) continue;
      ctx.globalAlpha = u.dead ? Math.max(0, 1 - u.deadT / 0.6) : 1;
      drawUnit(ctx, u, f, env);
      ctx.globalAlpha = 1;
    }
  }

  Arena.renderers = Arena.renderers || {};
  Arena.renderers.rts = { id: 'rts', label: 'RTS', emoji: '⚔', background, drawWorld };
})();
