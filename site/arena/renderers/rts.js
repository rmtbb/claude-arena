/*
 * Claude Arena — RTS renderer (v2).
 *
 * A grounded, shaded, 2.5D settlement world. Each faction is a walled town built
 * from its real history; units are named colonists; lighting follows the local
 * clock. Everything shades through Arena.art so the look stays coherent.
 *
 * Draw order per frame:  sky → ground → (per town) territory/paths/walls →
 * depth-sorted structures+units → effects → atmosphere.
 */
(function () {
  'use strict';
  const A = Arena.art, U = Arena.util, TAU = A.TAU;
  // faction roofs are slate that LEANS toward the tribe hue — identity without garishness
  const facRoof = (hue) => A.mix(A.ROOFS.slate, A.hslArr(hue, 48, 48), 0.5);

  // structures RISE when first built — a satisfying spring-up over ~1.1s.
  const GROW = 1.1;
  function easeOutBack(t) { const c1 = 1.7, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); }
  function growF(born, env) { if (born == null) return 1; const age = env.time - born; if (age >= GROW || age < 0) return 1; return Math.max(0.04, easeOutBack(age / GROW)); }

  // frustum cull: is this town near enough the viewport to bother drawing?
  function onScreen(f, env) {
    const r = (f.town && f.town.radius ? f.town.radius : 320) + 50;
    const sx = (f.x - env.cam.x) * env.cam.zoom + env.w / 2;
    const sy = (f.y - env.cam.y) * env.cam.zoom + env.h / 2;
    const rr = r * env.cam.zoom;
    return sx > -rr && sx < env.w + rr && sy > -rr && sy < env.h + rr;
  }

  // ---- cached wild-ground tile --------------------------------------------
  let groundTile = null, groundPattern = null;
  function ensureGround(ctx) {
    if (groundTile) return;
    const s = 512;                                  // bigger tile = less obvious repeat
    groundTile = document.createElement('canvas'); groundTile.width = groundTile.height = s;
    const g = groundTile.getContext('2d');
    const lush = A.hslArr(108, 26, 31), dry = A.hslArr(74, 22, 33), dirt = A.hslArr(40, 24, 30);
    const img = g.createImageData(s, s), d = img.data;
    for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
      // large-scale biome blend (lush <-> dry) + fine grass mottle + occasional dirt
      const biome = A.fbm(x / 150, y / 150, 3);
      const fine = A.fbm(x / 30, y / 30, 4) - 0.5;
      const patch = A.fbm(x / 70 + 9, y / 70 + 4, 3);
      let c = A.mix(dry, lush, A.clamp(biome * 1.5 - 0.2, 0, 1));
      if (patch > 0.66) c = A.mix(c, dirt, (patch - 0.66) * 2.6);
      const k = fine * 24;
      const i = (y * s + x) * 4;
      d[i] = A.clamp(c[0] + k * 0.6, 0, 255); d[i + 1] = A.clamp(c[1] + k, 0, 255); d[i + 2] = A.clamp(c[2] + k * 0.5, 0, 255); d[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    for (let i = 0; i < 240; i++) { const x = Math.random() * s, y = Math.random() * s; g.fillStyle = A.css(A.shade(lush, Math.random() < 0.5 ? -0.3 : 0.25), 0.4); g.beginPath(); g.arc(x, y, 0.8 + Math.random() * 1.4, 0, TAU); g.fill(); }
    groundPattern = ctx.createPattern(groundTile, 'repeat');
  }

  // procedural wilderness: ponds, forests, outcrops — deterministic, culled,
  // and kept clear of towns. Makes the map feel like a place, not a felt mat.
  function drawTerrainFeatures(ctx, sim, env) {
    const L = env._L;
    const tl = env._s2w(0, 0), br = env._s2w(env.w, env.h);
    const cell = 420;
    const x0 = Math.floor(tl.x / cell) - 1, x1 = Math.ceil(br.x / cell) + 1;
    const y0 = Math.floor(tl.y / cell) - 1, y1 = Math.ceil(br.y / cell) + 1;
    if ((x1 - x0) * (y1 - y0) > 700) return;          // extreme zoom-out: features are sub-pixel anyway
    for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) {
      const r = A.mulberry(A.hash(cx + '_' + cy));
      const type = r();
      const px = cx * cell + r() * cell, py = cy * cell + r() * cell;
      let nearTown = false;
      for (const f of sim.factions.values()) { if (f.town && Math.hypot(f.x - px, f.y - py) < f.town.territory + 50) { nearTown = true; break; } }
      if (nearTown) continue;
      if (type < 0.1) {
        drawPond(ctx, px, py, 34 + r() * 54, L, env.time);
      } else if (type < 0.56) {
        const n = 6 + (r() * 8 | 0);
        const cluster = [];
        for (let k = 0; k < n; k++) { const a = r() * TAU, dd = r() * 46; cluster.push([px + Math.cos(a) * dd, py + Math.sin(a) * dd * 0.8, 6 + r() * 6]); }
        cluster.sort((p, q) => p[1] - q[1]);
        for (const c of cluster) A.tree(ctx, c[0], c[1], c[2], L, env.time);
      } else if (type < 0.64) {
        const n = 2 + (r() * 3 | 0); for (let k = 0; k < n; k++) { const a = r() * TAU, dd = r() * 22; A.rock(ctx, px + Math.cos(a) * dd, py + Math.sin(a) * dd, 5 + r() * 5, L); }
      }
    }
  }
  function drawPond(ctx, x, y, rad, L, time) {
    const a = Math.max(0.4, L.ambient);
    ctx.fillStyle = A.css(A.shade([60, 80, 70], -0.2)); ctx.beginPath(); ctx.ellipse(x, y, rad + 3, rad * 0.62 + 3, 0, 0, TAU); ctx.fill(); // muddy bank
    const g = ctx.createRadialGradient(x - rad * 0.3, y - rad * 0.2, rad * 0.1, x, y, rad);
    g.addColorStop(0, A.css(A.shade([70, 130, 165], 0.15 * a))); g.addColorStop(1, A.css(A.shade([40, 86, 120], 0)));
    ctx.fillStyle = g; ctx.beginPath(); ctx.ellipse(x, y, rad, rad * 0.62, 0, 0, TAU); ctx.fill();
    // glints
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 3; i++) { const gx = x + Math.sin(time * 0.6 + i * 2) * rad * 0.4, gy = y + (i - 1) * rad * 0.18; ctx.fillStyle = A.rgb(220, 240, 255, 0.12 * a); ctx.fillRect(gx - rad * 0.2, gy, rad * 0.4, 1.4); }
    ctx.restore();
  }

  // ---- background = sky tint ----------------------------------------------
  function background(ctx, env) {
    const L = A.lighting();
    env._L = L;
    const g = ctx.createLinearGradient(0, 0, 0, env.h);
    g.addColorStop(0, A.css(L.top)); g.addColorStop(1, A.css(L.hor));
    ctx.fillStyle = g; ctx.fillRect(0, 0, env.w, env.h);
    // night sky: stars + a moon that arcs with the clock
    const night = L.lampGlow;
    if (night > 0.05) {
      ctx.save();
      for (let i = 0; i < 90; i++) {
        const sx = (A.fbm(i * 1.7, 3.1, 2) * 1.3) % 1 * env.w;
        const sy = (A.fbm(i * 2.3, 7.7, 2)) * env.h * 0.62;
        const tw = 0.4 + 0.6 * Math.abs(Math.sin(env.time * 1.5 + i));
        ctx.fillStyle = A.rgb(220, 230, 250, night * 0.8 * tw * (0.4 + (i % 5) * 0.12));
        ctx.fillRect(sx, sy, 1.4, 1.4);
      }
      // moon: x by clock phase, gentle arc
      const ph = L.phase;
      const mx = env.w * (0.12 + ((ph + 0.5) % 1) * 0.76);
      const my = env.h * (0.30 - Math.sin(((ph + 0.5) % 1) * Math.PI) * 0.16);
      ctx.globalCompositeOperation = 'lighter';
      U.glow(ctx, mx, my, 46, A.rgb(210, 225, 255, night * 0.18));
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = A.rgb(235, 240, 252, night * 0.95);
      ctx.beginPath(); ctx.arc(mx, my, 13, 0, A.TAU); ctx.fill();
      ctx.fillStyle = A.css(L.top, night * 0.9);
      ctx.beginPath(); ctx.arc(mx + 5, my - 3, 12, 0, A.TAU); ctx.fill();   // crescent bite
      ctx.restore();
    }
  }

  // ---- ground plane (world space) -----------------------------------------
  function drawGround(ctx, env) {
    const L = env._L;
    ensureGround(ctx);
    // visible world rect
    const tl = env._s2w(0, 0), br = env._s2w(env.w, env.h);
    const x = tl.x, y = tl.y, w = br.x - tl.x, h = br.y - tl.y;
    ctx.fillStyle = groundPattern; ctx.fillRect(x, y, w, h);
    // ambient wash so ground matches time of day (cool + deep at night)
    ctx.save();
    ctx.fillStyle = A.css(A.mix([10, 13, 30], L.hor, A.clamp(L.ambient, 0, 1) * 0.55), (1 - L.ambient) * 0.82);
    ctx.fillRect(x, y, w, h);
    ctx.restore();
  }

  // ---- town pieces ---------------------------------------------------------
  function drawTerritory(ctx, f, env) {
    const L = env._L, t = f.town; if (!t) return;
    // cleared earth the town sits on
    const g = ctx.createRadialGradient(f.x, f.y, t.wallR * 0.3, f.x, f.y, t.territory);
    g.addColorStop(0, A.css(A.shade(A.hslArr(34, 26, 34), (L.ambient - 1) * 0.5)));
    g.addColorStop(0.7, A.css(A.shade(A.hslArr(40, 20, 30), (L.ambient - 1) * 0.5)));
    g.addColorStop(1, A.css(A.hslArr(95, 20, 30), 0));
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.ellipse(f.x, f.y, t.territory, t.territory * 0.82, 0, 0, TAU); ctx.fill();
    // worn paths keep→buildings & →gates
    ctx.strokeStyle = A.css(A.shade(A.hslArr(32, 24, 26), (L.ambient - 1) * 0.4)); ctx.lineCap = 'round';
    for (const b of t.buildings) { ctx.lineWidth = 7; ctx.beginPath(); ctx.moveTo(f.x, f.y); ctx.lineTo(f.x + b.x, f.y + b.y); ctx.stroke(); }
    for (const ga of t.gates) { ctx.lineWidth = 9; ctx.beginPath(); ctx.moveTo(f.x, f.y); ctx.lineTo(f.x + ga.x, f.y + ga.y); ctx.stroke(); }
  }

  function drawWall(ctx, f, env) {
    const L = env._L, t = f.town; if (!t) return;
    const rx = t.wallR, ry = t.wallR * 0.82;
    const stone = t.stone;
    const moss = f.patina || 0;                            // long-lived walls grow mossy
    const wallCol = A.mix(stone ? [122, 120, 130] : [124, 96, 62], [76, 96, 62], moss * 0.34);
    const wallH = stone ? 12 : 8, thick = stone ? 7 : 5;
    const gates = t.gates.map((g) => g.ang);
    const inGate = (mid) => gates.some((ga) => Math.abs(Math.atan2(Math.sin(mid - ga), Math.cos(mid - ga))) < 0.26);
    const seg = 0.09;
    // cast shadow
    ctx.strokeStyle = `rgba(8,10,16,${L.shadowA * 0.65})`; ctx.lineWidth = thick + 2; ctx.lineCap = 'butt';
    for (let a = 0; a < TAU; a += seg) { if (inGate(a + seg / 2)) continue; ctx.beginPath(); ctx.ellipse(f.x + L.shadowDir.x * 3, f.y + 3 + L.shadowDir.y * 2, rx, ry, 0, a, a + seg); ctx.stroke(); }
    // outer face (ground level, darker)
    ctx.strokeStyle = A.css(A.shade(wallCol, (L.ambient - 1) * 0.5 - 0.1)); ctx.lineWidth = thick + 1;
    for (let a = 0; a < TAU; a += seg) { if (inGate(a + seg / 2)) continue; ctx.beginPath(); ctx.ellipse(f.x, f.y, rx, ry, 0, a, a + seg); ctx.stroke(); }
    // lit wall top (lifted)
    ctx.strokeStyle = A.css(A.shade(wallCol, 0.16 * L.ambient)); ctx.lineWidth = thick;
    for (let a = 0; a < TAU; a += seg) { if (inGate(a + seg / 2)) continue; ctx.beginPath(); ctx.ellipse(f.x, f.y - wallH, rx, ry, 0, a, a + seg); ctx.stroke(); }
    // crenellations along the top
    ctx.fillStyle = A.css(A.shade(wallCol, 0.24 * L.ambient));
    for (let a = 0; a < TAU; a += 0.21) { if (inGate(a)) continue; const mx = f.x + Math.cos(a) * rx, my = f.y - wallH + Math.sin(a) * ry; ctx.fillRect(mx - 1.5, my - 3, 3, 3.5); }
    // interval towers (stone tier)
    if (stone) {
      for (let k = 0; k < 8; k++) { const a = k / 8 * TAU + 0.2; if (inGate(a)) continue; const tx = f.x + Math.cos(a) * rx, ty = f.y + Math.sin(a) * ry; const tp = A.cyl(ctx, tx, ty, 4.5, wallH + 7, wallCol, L, { cap: A.WALLS.darkstone }); A.cone(ctx, tx, tp[1], 5.5, 6, facRoof(f.hue), L); }
    }
  }

  const HOUSE_ROOFS = ['terracotta', 'thatch', 'slate', 'tile'];
  function drawHouse(ctx, f, h, env) {
    const L = env._L;
    const roof = A.ROOFS[HOUSE_ROOFS[(h.seed | 0) % HOUSE_ROOFS.length]];
    const wall = (h.seed & 1) ? A.WALLS.plaster : A.WALLS.timber;
    const g = growF(h.born, env);
    A.gableBox(ctx, f.x + h.x, f.y + h.y, h.w, h.w * 0.8, h.h * g, h.h * 0.7 * g, wall, roof, L, { windows: true });
  }

  function drawBuilding(ctx, f, b, env) {
    const L = env._L, x = f.x + b.x, y = f.y + b.y;
    const active = (f.stations[b.station] && f.stations[b.station].pulse > 0);
    b = Object.assign({}, b, { h: b.h * growF(b.born, env) });   // rise on construction
    switch (b.type) {
      case 'forge': {
        // industrial: dark stone, flat roof, glowing furnace; chimneys multiply
        // with how Bash-heavy this project is (skyline fingerprint).
        A.box(ctx, x, y, b.w, b.d, b.h, A.WALLS.darkstone, L, { roof: A.ROOFS.dark });
        const chimneys = 1 + Math.round((b.emph || 0) * 3);
        for (let ci = 0; ci < chimneys; ci++) {
          const cxo = (ci - (chimneys - 1) / 2) * 10;
          A.box(ctx, x + cxo, y - b.d * 0.18, 8, 8, b.h + 14 + (ci % 2) * 4, [66, 58, 56], L);
        }
        // furnace mouth on the south face — modest by day, glowing at night
        ctx.save(); ctx.globalCompositeOperation = 'lighter';
        const fl = 0.4 + (active ? 0.4 : 0) + Math.sin(env.time * 6) * 0.06;
        U.glow(ctx, x, y + b.d * 0.32, 10, A.rgb(255, 120, 30, (0.12 + (active ? 0.25 : 0)) * (0.45 + L.lampGlow)));
        ctx.restore();
        ctx.fillStyle = A.rgb(255, 150, 60, (0.4 + 0.4 * L.lampGlow) * fl);
        ctx.fillRect(x - 3.5, y + b.d * 0.32 - 4, 7, 4);
        break;
      }
      case 'workshop': {
        A.gableBox(ctx, x, y, b.w, b.d, b.h, b.h * 0.8, A.WALLS.timber, A.ROOFS.thatch, L, { windows: true });
        // log pile beside it
        for (let i = 0; i < 3; i++) { ctx.fillStyle = A.css(A.shade([120, 92, 60], -0.1 - i * 0.05)); const lx = x - b.w * 0.5 - 4, ly = y + b.d * 0.2 + i * 3; ctx.beginPath(); ctx.ellipse(lx, ly, 5, 2.4, 0, 0, TAU); ctx.fill(); }
        break;
      }
      case 'tower': {
        const top = A.cyl(ctx, x, y, b.w * 0.5, b.h, A.WALLS.stone, L, { cap: A.WALLS.darkstone });
        A.cone(ctx, x, top[1], b.w * 0.62, 16, facRoof(f.hue), L);
        if (active || L.lampGlow > 0) { ctx.save(); ctx.globalCompositeOperation = 'lighter'; U.glow(ctx, top[0], top[1], 9, A.rgb(255, 240, 190, 0.55 * (0.4 + L.lampGlow))); ctx.restore(); }
        break;
      }
      case 'wargate': {
        // gatehouse straddling the wall: central passage + two flanking towers
        A.box(ctx, x, y, b.w * 0.5, b.d, b.h * 0.72, A.WALLS.stone, L, { roof: A.WALLS.darkstone });
        const lt = A.cyl(ctx, x - b.w * 0.4, y, 5, b.h, A.WALLS.stone, L, { cap: A.WALLS.darkstone });
        const rt = A.cyl(ctx, x + b.w * 0.4, y, 5, b.h, A.WALLS.stone, L, { cap: A.WALLS.darkstone });
        A.cone(ctx, x - b.w * 0.4, lt[1], 6, 7, facRoof(f.hue), L);
        A.cone(ctx, x + b.w * 0.4, rt[1], 6, 7, facRoof(f.hue), L);
        // dark arch passage
        ctx.fillStyle = A.css([30, 28, 36]);
        ctx.beginPath(); ctx.ellipse(x, y - b.h * 0.18, b.w * 0.16, b.h * 0.34, 0, 0, TAU); ctx.fill();
        if (active) { ctx.save(); ctx.globalCompositeOperation = 'lighter'; U.glow(ctx, x, y - b.h * 0.18, 8, A.hslArr(f.hue, 65, 56), A.rgb(150, 180, 235, 0.35)); ctx.restore(); }
        A.banner(ctx, x - b.w * 0.4, lt[1] + 2, 7, f.hue, env.time, L, f._vit);
        break;
      }
      case 'barracks': {
        A.gableBox(ctx, x, y, b.w, b.d, b.h, b.h * 0.7, A.WALLS.stone, A.ROOFS.slate, L, { windows: true });
        A.banner(ctx, x, y - b.d * 0.45, 9, f.hue, env.time, L, f._vit);
        break;
      }
    }
  }

  function merlons(ctx, p0, p1, n, up, color) {
    ctx.fillStyle = color;
    for (let i = 0; i < n; i++) { const t = (i + 0.5) / n; const mx = A.lerp(p0[0], p1[0], t), my = A.lerp(p0[1], p1[1], t); ctx.fillRect(mx - 2, my - up, 4, up); }
  }
  function drawKeep(ctx, f, env) {
    const L = env._L, x = f.x, y = f.y;
    const vit = f._vit == null ? 1 : f._vit;
    const era = f.era || 0;
    const sizeBoost = 1 + Math.min(0.5, era * 0.1);
    const hw = 24 * sizeBoost, hd = 19 * sizeBoost, h = 24;
    // stone castle block
    A.box(ctx, x, y, hw * 2, hd * 2, h, A.WALLS.stone, L, { roof: A.WALLS.darkstone });
    // battlements along the visible (south + east) top edges
    const Dr = A.lift(x - hw, y + hd, h), Cr = A.lift(x + hw, y + hd, h), Br = A.lift(x + hw, y - hd, h);
    merlons(ctx, Dr, Cr, 5, 5, A.css(A.shade(A.WALLS.stone, 0.18 * L.ambient)));
    merlons(ctx, Cr, Br, 4, 5, A.css(A.shade(A.WALLS.stone, -0.06 * L.ambient)));
    // glowing gate / heart on the south face
    ctx.fillStyle = A.css([30, 28, 34]);
    ctx.fillRect(x - 5, y + hd - 9, 10, 9);
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    const pulse = 0.85 + Math.sin(env.time * 2) * 0.15;
    // the heart dims when the town goes quiet, warms back as it revives
    U.glow(ctx, x, y + hd - 4, 11 + f.beacon * 14, A.rgb(255, 196, 120, (0.1 + 0.4 * L.lampGlow + f.beacon * 0.3) * pulse * (0.28 + 0.72 * vit)));
    ctx.restore();
    // the coffer beside the gate brims as coins arrive, then settles
    if (f.coffer > 0.02) {
      const cofx = x + hw * 0.55, cofy = y + hd - 3;
      ctx.save(); ctx.globalCompositeOperation = 'lighter';
      U.glow(ctx, cofx, cofy, 5 + f.coffer * 7, A.rgb(255, 210, 120, Math.min(0.55, f.coffer * 0.5)));
      ctx.restore();
      ctx.fillStyle = A.css(A.hslArr(48, 80, 56));
      const n = Math.min(6, Math.ceil(f.coffer * 5));
      for (let i = 0; i < n; i++) { ctx.beginPath(); ctx.arc(cofx + (i % 3 - 1) * 2.4, cofy - Math.floor(i / 3) * 2, 1.5, 0, TAU); ctx.fill(); }
    }
    // central keep tower — gilded roof once lifetime tools cross the tier
    const ttop = A.cyl(ctx, x, y - hd * 0.2, 12 * sizeBoost, h + 26, A.WALLS.stone, L, { cap: A.WALLS.darkstone });
    const keepRoof = f.gilded ? A.mix([214, 176, 92], A.hslArr(f.hue, 50, 50), 0.22) : A.mix(facRoof(f.hue), A.hslArr(f.hue, 55, 48), 0.4);
    A.cone(ctx, x, ttop[1], 14 * sizeBoost, 18, keepRoof, L);
    A.banner(ctx, x + 9, ttop[1] + 3, 15, f.hue, env.time, L, vit);
    const ct = A.lift(x, y - hd * 0.2, h + 26);
    ctx.save(); ctx.translate(ct[0], ct[1] - 3); U.crest(ctx, f.crest, 0, 0, 6, A.css(A.hslArr(f.hue, 80, 82))); ctx.restore();
    // Capital era: corner turrets
    if (era >= 4) {
      for (const [cx, cy] of [[x - hw, y - hd], [x + hw, y - hd], [x - hw, y + hd]]) {
        const tt = A.cyl(ctx, cx, cy, 5, h + 8, A.WALLS.stone, L, {}); A.cone(ctx, cx, tt[1], 6, 8, facRoof(f.hue), L);
      }
    }
    if (f.beacon > 0) {
      const pr = (1 - f.beacon / 1.2) * 60;
      ctx.strokeStyle = A.css(A.hslArr(f.hue, 85, 65), f.beacon / 1.2); ctx.lineWidth = 2;
      ctx.beginPath(); ctx.ellipse(x, y, 30 + pr, (30 + pr) * 0.82, 0, 0, TAU); ctx.stroke();
    }
    // the Stop-Beat exhale: a warm tide of light blooms out from the keep heart
    if (f.exhaleT > 0) {
      const k = 1 - f.exhaleT / 2.6;                 // 0..1 over the beat
      const ex = f.exhale * (1 - k);                 // fades as it expands
      ctx.save(); ctx.globalCompositeOperation = 'lighter';
      U.glow(ctx, x, y, 26 + k * (70 + f.exhale * 90), A.rgb(255, 208, 138, 0.42 * ex));
      ctx.restore();
    }
  }

  function drawProp(ctx, f, p, env) {
    const L = env._L;
    if (p.kind === 'tree') A.tree(ctx, f.x + p.x, f.y + p.y, p.s, L, env.time);
    else A.rock(ctx, f.x + p.x, f.y + p.y, p.s, L);
  }

  // roads from the capital out to each subfolder satellite (drawn at ground level)
  function drawSatellitePaths(ctx, f, env) {
    const L = env._L, t = f.town; if (!t || !t.satellites || !t.satellites.length) return;
    ctx.lineCap = 'round';
    for (const sat of t.satellites) {
      ctx.strokeStyle = A.css(A.shade([116, 92, 60], (L.ambient - 1) * 0.4), 0.5);
      ctx.lineWidth = 5 + sat.tier * 1.5;
      ctx.beginPath(); ctx.moveTo(f.x, f.y); ctx.lineTo(f.x + sat.x, f.y + sat.y); ctx.stroke();
    }
  }

  // a satellite settlement: a subfolder rendered as a small hamlet extension of
  // the capital, joined by a road and flying the tribe's banner.
  const SAT_ROOFS = ['thatch', 'terracotta', 'tile'];
  function drawSatellite(ctx, f, sat, env) {
    const L = env._L, bx = f.x + sat.x, by = f.y + sat.y, pr = sat.tier * 8 + 24;
    ctx.fillStyle = A.css(A.shade(A.hslArr(36, 22, 32), (L.ambient - 1) * 0.5), 0.45);
    ctx.beginPath(); ctx.ellipse(bx, by, pr, pr * 0.68, 0, 0, TAU); ctx.fill();
    const huts = sat.huts.slice().sort((a, b) => a.y - b.y);
    for (const h of huts) { const roof = A.ROOFS[SAT_ROOFS[(h.seed | 0) % 3]]; const g = growF(h.born, env); A.gableBox(ctx, f.x + h.x, f.y + h.y, h.w, h.w * 0.8, h.h * g, h.h * 0.7 * g, (h.seed & 1) ? A.WALLS.plaster : A.WALLS.timber, roof, L, { windows: true }); }
    const mtop = A.cyl(ctx, bx, by - 4, 3, 13 + sat.tier * 4, A.WALLS.stone, L, {});
    A.banner(ctx, bx + 2, mtop[1] + 2, 8, f.hue, env.time + sat.ang, L, f._vit);
    if (env.cam.zoom > 0.95) {
      const nm = sat.name.length > 16 ? sat.name.slice(0, 15) + '…' : sat.name;
      ctx.font = '600 9px ui-sans-serif,system-ui'; const tw = ctx.measureText(nm).width;
      const ly = by + pr * 0.68 + 9;
      ctx.fillStyle = 'rgba(8,11,16,0.5)'; U.roundRect(ctx, bx - tw / 2 - 4, ly - 8, tw + 8, 12, 4); ctx.fill();
      ctx.fillStyle = A.css(A.hslArr(f.hue, 40, 74)); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(nm, bx, ly - 1); ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    }
  }

  // a player-planted Folk-Drop: a sapling that grows into a grove, fed by the
  // town's real Stop-Beats. A cultivated stake marks it as deliberately placed.
  function drawDrop(ctx, f, dp, env) {
    const L = env._L, x = f.x + dp.x, y = f.y + dp.y, g = dp.growth || 0;
    // faction stake/ribbon
    const top = A.lift(x - 5, y, 8);
    ctx.strokeStyle = A.css(A.shade([110, 92, 64], 0)); ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.moveTo(x - 5, y); ctx.lineTo(top[0], top[1]); ctx.stroke();
    ctx.fillStyle = A.css(A.hslArr(f.hue, 55, 52 * Math.max(0.6, L.ambient)));
    ctx.fillRect(top[0], top[1], 4, 3);
    // the growing tree (sprout -> grove)
    const s = 3 + g * 11;
    A.tree(ctx, x, y, s, L, env.time);
    if (g < 1 && (env.time % 2) < 0.06 + g) { ctx.save(); ctx.globalCompositeOperation = 'lighter'; U.glow(ctx, x, A.lift(x, y, s * 1.5)[1], 6, A.rgb(150, 255, 150, 0.18)); ctx.restore(); }
  }

  // ---- units ---------------------------------------------------------------
  // units keep a minimum on-screen size so they never vanish into the town
  function unitSize(base, env) { return Math.max(base, base * 1.5 / Math.max(0.55, env.cam.zoom)); }

  function drawWorker(ctx, u, f, env) {
    const L = env._L;
    const vet = u.veteran;
    const s = unitSize(vet ? 5.4 : 4.7, env) * u.scale;
    const walking = Math.hypot(u.vx, u.vy) > 8;
    const step = walking ? Math.sin(u.wob * 1.6) : 0;
    const bob = Math.abs(step) * 1.4;
    const x = u.x, y = u.y - bob;
    // grounded contact shadow (one global light azimuth)
    ctx.fillStyle = `rgba(6,8,12,${Math.min(0.55, L.shadowA + 0.12)})`;
    ctx.beginPath(); ctx.ellipse(u.x + L.shadowDir.x * 2, u.y + 1.5, s * 1.15, s * 0.45, 0, 0, TAU); ctx.fill();

    const aF = Math.max(0.5, L.ambient);
    const cloak = u.state === 'stumble' ? A.hslArr(0, 65, 46) : A.hslArr(f.hue, 55, 46 * aF);
    const cloakLit = A.shade(cloak, 0.18), cloakDark = A.shade(cloak, -0.3);
    const skin = A.shade([232, 205, 172], (aF - 1) * 0.5);
    // legs (little stepping marks)
    ctx.strokeStyle = A.css(cloakDark); ctx.lineWidth = Math.max(1.2, s * 0.32); ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x - s * 0.4, y + s * 0.7); ctx.lineTo(x - s * 0.4 + step * s * 0.5, y + s * 1.1);
    ctx.moveTo(x + s * 0.4, y + s * 0.7); ctx.lineTo(x + s * 0.4 - step * s * 0.5, y + s * 1.1); ctx.stroke();
    // body (cloak) with a lit/shadow split
    ctx.fillStyle = A.css(cloakDark); ctx.beginPath(); ctx.ellipse(x, y, s, s * 1.1, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = A.css(cloakLit); ctx.beginPath(); ctx.ellipse(x - s * 0.25, y - s * 0.15, s * 0.62, s * 0.85, 0, 0, TAU); ctx.fill();
    // head + faction cap
    ctx.fillStyle = A.css(skin); ctx.beginPath(); ctx.arc(x + u.facing * s * 0.18, y - s * 0.85, s * 0.52, 0, TAU); ctx.fill();
    ctx.fillStyle = A.css(A.hslArr(f.hue, 65, 52 * aF)); ctx.beginPath();
    ctx.arc(x + u.facing * s * 0.18, y - s * 1.05, s * 0.5, Math.PI, TAU); ctx.fill();
    // veteran: glow + plume
    if (vet) {
      ctx.save(); ctx.globalCompositeOperation = 'lighter';
      U.glow(ctx, x, y, s * 2.2, A.hslArr(f.hue, 80, 60), A.rgb(255, 232, 165, 0.16 * (0.5 + L.lampGlow)));
      ctx.restore();
      ctx.fillStyle = A.css(A.hslArr((f.hue + 45) % 360, 85, 66));
      ctx.beginPath(); ctx.moveTo(x, y - s * 1.4); ctx.lineTo(x - s * 0.4, y - s * 2.3); ctx.lineTo(x + s * 0.4, y - s * 2.1); ctx.closePath(); ctx.fill();
    }
    // carry / tool in hand
    if (u.carry) {
      ctx.save(); ctx.globalCompositeOperation = 'lighter';
      U.glow(ctx, x + u.facing * s, y - s * 0.2, 6, A.css(A.hslArr(Arena.STATION_HUE[u.carry.type] || 40, 85, 60), 0.85));
      ctx.restore();
      ctx.fillStyle = A.css(A.hslArr(Arena.STATION_HUE[u.carry.type] || 40, 70, 55));
      ctx.fillRect(x + u.facing * s * 0.8, y - s * 0.5, s * 0.9, s * 0.9);
    } else if (u.state === 'toResource' || u.state === 'gathering') {
      ctx.strokeStyle = A.css([110, 96, 80]); ctx.lineWidth = Math.max(1.2, s * 0.22);
      const sw = u.state === 'gathering' ? Math.sin(env.time * 9) * 0.5 : 0;
      ctx.beginPath(); ctx.moveTo(x + u.facing * s * 0.7, y - s * 0.1); ctx.lineTo(x + u.facing * (s * 1.9), y - s * (1.1 + sw)); ctx.stroke();
    }
    if (u.alert > 0.3) { ctx.fillStyle = A.css(A.hslArr(48, 100, 62), u.alert); ctx.font = `bold ${Math.round(s * 2.4)}px sans-serif`; ctx.textAlign = 'center'; ctx.fillText('!', x, y - s * 2.6); ctx.textAlign = 'left'; }
    if (u.state === 'rest') { ctx.fillStyle = A.css(A.hslArr(f.hue, 50, 82), 0.85); ctx.font = `${Math.round(s * 2)}px sans-serif`; ctx.fillText('z', x + s, y - s * 2 + Math.sin(env.time * 3) * 2); }
    // name tag: veterans always (when close-ish), or the hovered unit
    if ((vet && env.cam.zoom > 0.85) || env.hoverId === u.id) {
      const nm = (u.identity.title + ' ' + u.identity.name);
      ctx.font = '600 10px ui-sans-serif,system-ui'; const tw = ctx.measureText(nm).width;
      ctx.fillStyle = 'rgba(8,11,16,0.62)'; U.roundRect(ctx, x - tw / 2 - 4, y - s * 3.2 - 9, tw + 8, 13, 4); ctx.fill();
      ctx.fillStyle = A.rgb(235, 240, 248, 0.95); ctx.textAlign = 'center'; ctx.fillText(nm, x, y - s * 3.2); ctx.textAlign = 'left';
    }
  }

  function drawDrone(ctx, u, f, env) {
    const L = env._L;
    const s = unitSize(4, env) * u.scale;
    const alt = 12 + Math.sin(u.wob * 1.3) * 2;       // flight altitude
    const x = u.x, y = u.y - alt;
    // tether to parent worker (shows the subagent hierarchy)
    const p = u.parent && env._sim.units.get(u.parent);
    if (p && !p.dead) {
      ctx.strokeStyle = A.css(A.hslArr(f.hue, 60, 60), 0.22); ctx.lineWidth = 1;
      ctx.setLineDash([2, 3]); ctx.beginPath(); ctx.moveTo(p.x, p.y - 4); ctx.lineTo(x, y); ctx.stroke(); ctx.setLineDash([]);
    }
    // ground shadow offset by altitude → reads as flying
    ctx.fillStyle = `rgba(6,8,12,${L.shadowA * 0.6})`;
    ctx.beginPath(); ctx.ellipse(u.x + 2, u.y + 2, s * 0.9, s * 0.36, 0, 0, TAU); ctx.fill();
    // rotor blur
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = A.rgb(200, 225, 255, 0.12); ctx.beginPath(); ctx.ellipse(x, y - s * 0.4, s * 1.6, s * 0.5, 0, 0, TAU); ctx.fill();
    U.glow(ctx, x, y, s * 2.2, A.hslArr(f.hue, 80, 62), A.rgb(190, 225, 255, 0.5));
    ctx.restore();
    // body
    ctx.fillStyle = A.css(A.hslArr(f.hue, 58, 60 * Math.max(0.6, L.ambient)));
    ctx.beginPath(); ctx.moveTo(x, y - s); ctx.lineTo(x + s, y); ctx.lineTo(x, y + s); ctx.lineTo(x - s, y); ctx.closePath(); ctx.fill();
    ctx.fillStyle = A.css(A.hslArr(f.hue, 95, 86)); ctx.fillRect(x - s * 0.25, y - s * 0.25, s * 0.5, s * 0.5);
  }

  // Chronicle Stone: an obelisk near the keep that grows a band per milestone.
  function drawChronicle(ctx, f, env) {
    const L = env._L, c = f.town.chronicle; if (!c || !c.bands) return;
    const x = f.x + c.x, y = f.y + c.y;
    const bands = Math.min(12, c.bands);
    const h = 12 + bands * 3.5;
    A.box(ctx, x, y, 7, 6, h, A.WALLS.stone, L, { roof: A.WALLS.darkstone });
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < bands; i++) { const by = A.lift(x, y, 5 + i * 3); ctx.fillStyle = A.css(A.hslArr(f.hue, 70, 62), 0.55); ctx.fillRect(by[0] - 3, by[1], 6, 1.3); }
    const tp = A.lift(x, y, h); U.glow(ctx, tp[0], tp[1], 5, A.css(A.hslArr(f.hue, 80, 66), 0.5 * (f._vit || 1)));
    ctx.restore();
  }

  // dormant towns don't go muddy — they fall into a lovely teal-and-amber dusk
  // that deepens with idleness and lifts the instant vitality returns.
  function dormancyVeil(ctx, f) {
    const t = f.town, vit = f._vit; if (vit > 0.93) return;
    const d = 1 - vit;
    const R = (t.radius || t.territory);
    const g = ctx.createRadialGradient(f.x, f.y, R * 0.15, f.x, f.y, R);
    g.addColorStop(0, A.rgb(58, 78, 92, d * 0.30));          // cool teal core
    g.addColorStop(0.7, A.rgb(40, 54, 74, d * 0.40));        // deep dusk blue
    g.addColorStop(1, A.rgb(70, 52, 60, d * 0.30));          // faint amber edge
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.ellipse(f.x, f.y, R * 1.02, R * 0.86, 0, 0, TAU); ctx.fill();
    // a couple of lonely amber window-lights still burning
    if (d > 0.4) { ctx.save(); ctx.globalCompositeOperation = 'lighter'; U.glow(ctx, f.x + 6, f.y - 4, 10, A.rgb(255, 190, 110, d * 0.18)); ctx.restore(); }
  }

  // trade roads worn between towns that are active together
  function drawRoads(ctx, sim, env) {
    const L = env._L;
    for (const r of sim.roads.values()) {
      const a = sim.factions.get(r.a), b = sim.factions.get(r.b); if (!a || !b) continue;
      const mx = (a.x + b.x) / 2 + (b.y - a.y) * 0.06, my = (a.y + b.y) / 2 - (b.x - a.x) * 0.06;
      ctx.lineCap = 'round';
      ctx.strokeStyle = A.css(A.shade([116, 92, 60], (L.ambient - 1) * 0.4), 0.18 + r.wear * 0.5);
      ctx.lineWidth = 3 + r.wear * 7;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.quadraticCurveTo(mx, my, b.x, b.y); ctx.stroke();
      ctx.strokeStyle = A.css(A.shade([138, 112, 74], 0.1 * L.ambient), 0.2 + r.wear * 0.4);
      ctx.lineWidth = 1.5 + r.wear * 2.5;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.quadraticCurveTo(mx, my, b.x, b.y); ctx.stroke();
    }
  }

  // a little ox-cart envoy trundling along a road
  function drawEnvoys(ctx, sim, env) {
    const L = env._L;
    for (const e of sim.envoys) {
      const bob = Math.sin(e.wob) * 0.8, x = e.x, y = e.y + bob, f = e.facing;
      ctx.fillStyle = `rgba(6,8,12,${L.shadowA})`; ctx.beginPath(); ctx.ellipse(x + 1, e.y + 3, 9, 3, 0, 0, TAU); ctx.fill();
      ctx.save(); ctx.globalCompositeOperation = 'lighter'; U.glow(ctx, x - f * 8, y + 1, 5, A.rgb(185, 165, 135, 0.1)); ctx.restore();
      // ox
      ctx.fillStyle = A.css(A.shade([96, 84, 72], (L.ambient - 1) * 0.4)); ctx.beginPath(); ctx.ellipse(x + f * 9, y + 1, 4, 2.6, 0, 0, TAU); ctx.fill();
      // cart bed + wheels
      ctx.fillStyle = A.css(A.shade([108, 82, 52], (L.ambient - 1) * 0.4)); ctx.fillRect(x - 6, y - 3, 12, 5);
      ctx.fillStyle = '#241f1b'; ctx.beginPath(); ctx.arc(x - 4, y + 2, 2, 0, TAU); ctx.arc(x + 4, y + 2, 2, 0, TAU); ctx.fill();
      // faction canopy
      ctx.fillStyle = A.css(A.hslArr(e.hue, 46, 54 * Math.max(0.6, L.ambient)));
      ctx.beginPath(); ctx.moveTo(x - 6, y - 3); ctx.quadraticCurveTo(x, y - 11, x + 6, y - 3); ctx.closePath(); ctx.fill();
    }
  }

  // cross-project emissaries: scout (read), builder (edit), runner (bash)
  function drawEmissaries(ctx, sim, env) {
    for (const e of sim.emissaries) {
      const x = e.x, y = e.y + Math.sin(e.wob) * 1.4, fc = e.facing || 1;
      ctx.strokeStyle = A.css(A.hslArr(e.hue, 70, 60), 0.16); ctx.lineWidth = 1; ctx.setLineDash([3, 4]);
      ctx.beginPath(); ctx.moveTo(e.hx, e.hy); ctx.lineTo(x, y); ctx.stroke(); ctx.setLineDash([]);
      ctx.save(); ctx.globalCompositeOperation = 'lighter';
      U.glow(ctx, x, y, 9, A.hslArr(e.hue, 85, 62), A.rgb(255, 255, 255, 0.35));
      ctx.restore();
      ctx.fillStyle = A.css(A.hslArr(e.hue, 82, 72));
      if (e.cat === 'scout') { ctx.beginPath(); ctx.moveTo(x + fc * 5, y); ctx.lineTo(x - fc * 4, y - 3); ctx.lineTo(x - fc * 4, y + 3); ctx.closePath(); ctx.fill(); }
      else { ctx.beginPath(); ctx.moveTo(x, y - 4); ctx.lineTo(x + 4, y); ctx.lineTo(x, y + 4); ctx.lineTo(x - 4, y); ctx.closePath(); ctx.fill(); }
    }
  }

  // resource coins arcing into the coffer
  function drawCoins(ctx, sim) {
    for (const c of sim.coins) {
      ctx.save(); ctx.globalCompositeOperation = 'lighter';
      U.glow(ctx, c.x, c.y, 4, A.hslArr(c.hue, 90, 62), A.rgb(255, 240, 180, 0.45));
      ctx.restore();
      ctx.fillStyle = A.css(A.hslArr(c.hue, 85, 60)); ctx.beginPath(); ctx.ellipse(c.x, c.y, 2.2, 2.6, 0, 0, TAU); ctx.fill();
      ctx.fillStyle = A.rgb(255, 250, 220, 0.85); ctx.fillRect(c.x - 0.6, c.y - 1.5, 1.2, 1.4);
    }
  }

  // ---- main ----------------------------------------------------------------
  function drawWorld(ctx, sim, env) {
    const L = env._L || (env._L = A.lighting());
    env._sim = sim;
    drawGround(ctx, env);
    drawTerrainFeatures(ctx, sim, env);

    const all = Array.from(sim.factions.values()).sort((a, b) => a.y - b.y);
    // ONE rendering at every zoom — no LOD pop-in. We just cull what's off-screen
    // so the work stays bounded; everything visible is drawn the same way, scaled.
    const facs = all.filter((f) => onScreen(f, env));
    // group units by faction once (avoids scanning all units per town)
    const unitsByFac = new Map();
    for (const u of sim.units.values()) { if (u.dead) continue; let a = unitsByFac.get(u.factionKey); if (!a) { a = []; unitsByFac.set(u.factionKey, a); } a.push(u); }

    for (const f of all) { const target = Arena.lore.vitality(f); if (f._vit == null) f._vit = target; f._vit += (target - f._vit) * 0.05; }

    // pass 1: ground (roads, satellite roads, territory, walls)
    drawRoads(ctx, sim, env);
    for (const f of facs) drawTerritory(ctx, f, env);
    for (const f of facs) drawSatellitePaths(ctx, f, env);
    for (const f of facs) { if (f.town && f.town.hasWall) drawWall(ctx, f, env); }

    // pass 2: per town, depth-sort structures + units (full detail at all zooms)
    for (const f of facs) {
      const t = f.town; if (!t) continue;
      const draw = [];
      for (const p of t.props) draw.push({ y: f.y + p.y, fn: () => drawProp(ctx, f, p, env) });
      if (t.satellites) for (const sat of t.satellites) draw.push({ y: f.y + sat.y, fn: () => drawSatellite(ctx, f, sat, env) });
      if (f.drops) for (const dp of f.drops) draw.push({ y: f.y + dp.y, fn: () => drawDrop(ctx, f, dp, env) });
      for (const h of t.houses) draw.push({ y: f.y + h.y, fn: () => drawHouse(ctx, f, h, env) });
      for (const b of t.buildings) draw.push({ y: f.y + b.y, fn: () => drawBuilding(ctx, f, b, env) });
      draw.push({ y: f.y - 1, fn: () => drawKeep(ctx, f, env) });
      draw.push({ y: f.y + t.chronicle.y, fn: () => drawChronicle(ctx, f, env) });
      for (const u of (unitsByFac.get(f.key) || [])) {
        const yy = u.kind === 'drone' ? u.y - 10 : u.y;
        draw.push({ y: yy, fn: () => (u.kind === 'drone' ? drawDrone(ctx, u, f, env) : drawWorker(ctx, u, f, env)) });
      }
      draw.sort((a, b) => a.y - b.y);
      for (const d of draw) d.fn();
      dormancyVeil(ctx, f);
    }

    // dead units fade
    for (const u of sim.units.values()) {
      if (!u.dead) continue;
      ctx.globalAlpha = Math.max(0, 1 - u.deadT / 0.6);
      const f = sim.factions.get(u.factionKey); if (f) (u.kind === 'drone' ? drawDrone : drawWorker)(ctx, u, f, env);
      ctx.globalAlpha = 1;
    }

    // chimney/forge smoke — living towns always breathe a little; harvest billows
    ctx.save();
    for (const f of facs) {
      if (!f.town || (f._vit || 0) < 0.55) continue;
      const fb = f.town.buildings.find((b) => b.type === 'forge');
      const st = f.stations && f.stations.gas;
      if (!fb) continue;
      const active = st && st.pulse > 0.2;
      const puffs = active ? 4 : 2;
      const cx = f.x + fb.x + fb.w * 0.3, cy = f.y + fb.y - fb.d * 0.18;
      const top = A.lift(cx, cy, (fb.h * growF(fb.born, env)) + 16);
      for (let i = 0; i < puffs; i++) { const life = ((env.time * (active ? 0.5 : 0.32) + i * (1 / puffs)) % 1); A.smoke(ctx, top[0] + Math.sin(env.time * 0.8 + i * 2) * (3 + life * 5), top[1], life, L); }
    }
    ctx.restore();

    drawEnvoys(ctx, sim, env);
    drawEmissaries(ctx, sim, env);
    drawCoins(ctx, sim);

    // fireflies drift around LIVING towns at night — a quiet sign of life
    if (L.lampGlow > 0.2) {
      ctx.save(); ctx.globalCompositeOperation = 'lighter';
      for (const f of facs) {
        if (!f.town || (f._vit || 0) < 0.5) continue;
        const base = A.hash(f.key) % 100, R = f.town.wallR;
        for (let i = 0; i < 5; i++) {
          const sd = i * 1.7 + base;
          const fx = f.x + Math.sin(env.time * 0.7 + sd) * R * 0.85;
          const fy = f.y + Math.cos(env.time * 0.5 + sd * 1.3) * R * 0.6 - 5;
          const tw = 0.5 + 0.5 * Math.sin(env.time * 4 + sd * 3);
          ctx.fillStyle = A.rgb(205, 255, 150, 0.55 * tw * L.lampGlow * (f._vit || 1));
          ctx.beginPath(); ctx.arc(fx, fy, 1.5, 0, TAU); ctx.fill();
        }
      }
      ctx.restore();
    }

    // "grew while you were away" highlight pulse (set by the return beat)
    const nowMs = Date.now();
    for (const f of facs) {
      if (!f._grewAt) continue;
      const age = (nowMs - f._grewAt) / 1000; if (age > 20) continue;
      const t = f.town; if (!t) continue;
      const k = (env.time % 1.6) / 1.6;
      const rr = t.territory * (0.45 + k * 0.6);
      ctx.strokeStyle = A.rgb(255, 222, 140, (1 - k) * 0.55 * (1 - age / 20)); ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.ellipse(f.x, f.y, rr, rr * 0.8, 0, 0, TAU); ctx.stroke();
    }

    drawLabels(ctx, facs, env);
  }

  // labels drawn in SCREEN space → identical, readable size at every zoom level
  function drawLabels(ctx, facs, env) {
    const z = env.cam.zoom, DPR = env.DPR || 1;
    ctx.save(); ctx.setTransform(DPR, 0, 0, DPR, 0, 0); ctx.textBaseline = 'middle';
    for (const f of facs) {
      const t = f.town; if (!t) continue;
      const sx = (f.x - env.cam.x) * z + env.w / 2;
      const sy = (f.y - env.cam.y) * z + env.h / 2 + (t.territory * 0.82) * z + 13;
      ctx.font = '700 13px ui-sans-serif,system-ui,sans-serif';
      const tw = ctx.measureText(f.name).width;
      ctx.fillStyle = 'rgba(8,12,16,0.62)'; U.roundRect(ctx, sx - tw / 2 - 13, sy - 12, tw + 26, 30, 7); ctx.fill();
      ctx.fillStyle = A.css(stateColor(f)); ctx.beginPath(); ctx.arc(sx - tw / 2 - 6, sy - 3, 3, 0, TAU); ctx.fill();
      ctx.fillStyle = A.css(A.hslArr(f.hue, 58, 82)); ctx.textAlign = 'center';
      ctx.fillText(f.name, sx, sy - 3);
      ctx.font = '600 9px ui-monospace,monospace'; ctx.fillStyle = A.rgb(170, 186, 205, 0.85);
      ctx.fillText(`${f.eraName || 'Outpost'}  ·  ⌂ ${t.houses.length}  ·  ${Arena.lore.idleLabel(f)}`, sx, sy + 9);
    }
    ctx.textAlign = 'left'; ctx.restore();
  }
  function stateColor(f) {
    const v = f._vit == null ? Arena.lore.vitality(f) : f._vit;
    // warm green = worked recently, fading to cold grey-blue when long idle
    return A.mix([90, 110, 130], [110, 220, 130], v);
  }

  Arena.renderers = Arena.renderers || {};
  Arena.renderers.rts = { id: 'rts', label: 'RTS', emoji: '⚔', background, drawWorld };
})();
