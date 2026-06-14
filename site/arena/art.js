/*
 * Claude Arena — RTS art foundation.
 *
 * One shared module so the whole world stays visually coherent:
 *   - a fixed dimetric (2.5D) projection: ground point + height -> screen
 *   - one global light direction + a REAL-LOCAL-TIME day/night model
 *   - shaded, extruded primitives (boxes, cylinders) that cast shadows
 *   - value-noise terrain, props, smoke, and deterministic unit names
 *
 * Renderers call into this; they don't reinvent shading. Change the look here
 * and the entire RTS changes with it.
 */
(function () {
  'use strict';
  const TAU = Math.PI * 2;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;

  // --- color ----------------------------------------------------------------
  function rgb(r, g, b, a) { return `rgba(${r | 0},${g | 0},${b | 0},${a == null ? 1 : a})`; }
  function mix(c1, c2, t) { return [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)]; }
  function hslArr(h, s, l) {
    // hsl -> rgb array (0..255)
    h /= 360; s /= 100; l /= 100;
    const a = s * Math.min(l, 1 - l);
    const f = (n) => { const k = (n + h * 12) % 12; return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
    return [f(0) * 255, f(8) * 255, f(4) * 255];
  }
  function shade(c, amt) { // amt<0 darken, >0 lighten
    if (amt >= 0) return [lerp(c[0], 255, amt), lerp(c[1], 255, amt), lerp(c[2], 255, amt)];
    return [c[0] * (1 + amt), c[1] * (1 + amt), c[2] * (1 + amt)];
  }
  function css(c, a) { return rgb(c[0], c[1], c[2], a); }

  // --- deterministic hash / rng --------------------------------------------
  function hash(str) { let h = 2166136261 >>> 0; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h >>> 0; }
  function mulberry(seed) { let a = seed >>> 0; return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

  // --- value noise ----------------------------------------------------------
  function vn(x, y) { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s); }
  function noise2(x, y) {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const a = vn(xi, yi), b = vn(xi + 1, yi), c = vn(xi, yi + 1), d = vn(xi + 1, yi + 1);
    return lerp(lerp(a, b, u), lerp(c, d, u), v);
  }
  function fbm(x, y, oct) {
    let amp = 0.5, sum = 0, norm = 0;
    for (let i = 0; i < (oct || 4); i++) { sum += amp * noise2(x, y); norm += amp; x *= 2; y *= 2; amp *= 0.5; }
    return sum / norm;
  }

  // --- dimetric projection: height pushes up + slightly right ---------------
  const HX = 0.30, HY = 0.92;           // how a unit of height displaces on screen
  function lift(x, y, z) { return [x + z * HX, y - z * HY]; }

  // --- day / night (real local clock) --------------------------------------
  // phase 0..1 across 24h. Keyframes: 0=deep night, .25=dawn, .5=noon, .75=dusk
  const SKY = {            // [topRGB, horizonRGB, lightRGB, ambient(0..1), shadowAlpha]
    night:  [[14, 20, 38], [26, 30, 52], [120, 140, 200], 0.30, 0.28],
    dawn:   [[64, 70, 120], [210, 140, 120], [255, 200, 150], 0.62, 0.40],
    day:    [[120, 170, 220], [180, 205, 225], [255, 250, 235], 1.00, 0.34],
    dusk:   [[70, 60, 110], [230, 120, 90], [255, 170, 120], 0.66, 0.42],
  };
  let phaseOverride = null;
  function setPhase(p) { phaseOverride = p; }           // for screenshots/testing
  function clockPhase() {
    if (phaseOverride != null) return phaseOverride;
    const d = new Date();
    return (d.getHours() + d.getMinutes() / 60) / 24;
  }
  function lighting(t) {
    const p = (t == null ? clockPhase() : t);
    // segment between keyframes at 0,.25,.5,.75,1(=0)
    let a, b, f;
    if (p < 0.25) { a = SKY.night; b = SKY.dawn; f = p / 0.25; }
    else if (p < 0.5) { a = SKY.dawn; b = SKY.day; f = (p - 0.25) / 0.25; }
    else if (p < 0.75) { a = SKY.day; b = SKY.dusk; f = (p - 0.5) / 0.25; }
    else { a = SKY.dusk; b = SKY.night; f = (p - 0.75) / 0.25; }
    const top = mix(a[0], b[0], f), hor = mix(a[1], b[1], f), light = mix(a[2], b[2], f);
    const ambient = lerp(a[3], b[3], f), shadowA = lerp(a[4], b[4], f);
    const isNight = ambient < 0.5;
    // sun azimuth swings; longer shadows near dawn/dusk
    const sun = Math.sin(p * TAU - Math.PI / 2);          // -1 night .. 1 noon
    const lowSun = 1 - clamp((ambient - 0.3) / 0.7, 0, 1); // 0 noon .. 1 night
    const shadowLen = lerp(0.9, 2.3, lowSun);
    return {
      phase: p, top, hor, light, ambient, shadowA, isNight,
      shadowDir: { x: 0.55, y: 0.62 },                    // light from upper-left
      shadowLen,
      lampGlow: clamp((0.55 - ambient) / 0.35, 0, 1),     // window/lamp intensity at night
    };
  }

  // --- shadows --------------------------------------------------------------
  function groundShadow(ctx, x, y, w, d, h, L) {
    const sx = L.shadowDir.x * h * L.shadowLen, sy = L.shadowDir.y * h * L.shadowLen;
    // soft cast shadow
    ctx.fillStyle = `rgba(8,10,16,${L.shadowA})`;
    ctx.beginPath();
    ctx.ellipse(x + sx * 0.5, y + sy * 0.5 + d * 0.18, w * 0.62 + sx * 0.4, d * 0.42 + sy * 0.22, 0, 0, TAU);
    ctx.fill();
    // tight dark contact shadow so the structure feels planted
    ctx.fillStyle = `rgba(6,8,12,${Math.min(0.5, L.shadowA + 0.12)})`;
    ctx.beginPath(); ctx.ellipse(x, y + d * 0.18, w * 0.5, d * 0.3, 0, 0, TAU); ctx.fill();
  }

  // earthy, cohesive material palettes (faction color is applied as ACCENT only)
  const ROOFS = { terracotta: [150, 82, 56], slate: [96, 100, 116], thatch: [150, 126, 78], tile: [120, 74, 60], dark: [78, 70, 72] };
  const WALLS = { plaster: [192, 180, 160], timber: [126, 96, 64], stone: [132, 128, 134], darkstone: [96, 92, 98] };

  // extruded building with a PITCHED (gabled) roof. ridge runs along width (x).
  function gableBox(ctx, x, y, w, d, wallH, roofH, wallColor, roofColor, L, opts) {
    opts = opts || {};
    const hw = w / 2, hd = d / 2, amb = L.ambient;
    groundShadow(ctx, x, y, w, d, wallH + roofH, L);
    const lit = (c, k) => css(shade(c, k * amb));
    // ground + eave corners
    const C = [x + hw, y + hd], D = [x - hw, y + hd], B = [x + hw, y - hd], Aa = [x - hw, y - hd];
    const Cr = lift(C[0], C[1], wallH), Dr = lift(D[0], D[1], wallH), Br = lift(B[0], B[1], wallH), Ar = lift(Aa[0], Aa[1], wallH);
    // walls (south + east), like box
    ctx.fillStyle = lit(wallColor, -0.40);
    ctx.beginPath(); ctx.moveTo(D[0], D[1]); ctx.lineTo(C[0], C[1]); ctx.lineTo(Cr[0], Cr[1]); ctx.lineTo(Dr[0], Dr[1]); ctx.closePath(); ctx.fill();
    ctx.fillStyle = lit(wallColor, -0.20);
    ctx.beginPath(); ctx.moveTo(C[0], C[1]); ctx.lineTo(B[0], B[1]); ctx.lineTo(Br[0], Br[1]); ctx.lineTo(Cr[0], Cr[1]); ctx.closePath(); ctx.fill();
    // lit windows
    if (opts.windows && L.lampGlow > 0.02) {
      ctx.save(); ctx.globalCompositeOperation = 'lighter';
      const cols = Math.max(1, Math.floor(w / 8));
      for (let i = 0; i < cols; i++) {
        if ((hash('' + (x * 7 + y + i)) % 3) === 0) continue;
        const fx = D[0] + (C[0] - D[0]) * ((i + 0.5) / cols), fy = D[1] + (C[1] - D[1]) * ((i + 0.5) / cols);
        const wt = lift(fx, fy, wallH * 0.6);
        ctx.fillStyle = `rgba(255,205,120,${0.55 * L.lampGlow})`;
        ctx.fillRect(fx - 1.3, wt[1], 2.6, (fy - wt[1]) * 0.5);
      }
      ctx.restore();
    }
    // ridge endpoints
    const P1 = lift(x - hw, y, wallH + roofH), P2 = lift(x + hw, y, wallH + roofH);
    // north slope (back, catches sky light -> brightest)
    ctx.fillStyle = lit(roofColor, 0.20);
    ctx.beginPath(); ctx.moveTo(Ar[0], Ar[1]); ctx.lineTo(Br[0], Br[1]); ctx.lineTo(P2[0], P2[1]); ctx.lineTo(P1[0], P1[1]); ctx.closePath(); ctx.fill();
    // gable ends (west lit, east mid)
    ctx.fillStyle = lit(wallColor, -0.05);
    ctx.beginPath(); ctx.moveTo(Ar[0], Ar[1]); ctx.lineTo(Dr[0], Dr[1]); ctx.lineTo(P1[0], P1[1]); ctx.closePath(); ctx.fill();
    ctx.fillStyle = lit(wallColor, -0.30);
    ctx.beginPath(); ctx.moveTo(Br[0], Br[1]); ctx.lineTo(Cr[0], Cr[1]); ctx.lineTo(P2[0], P2[1]); ctx.closePath(); ctx.fill();
    // south slope (front -> mid), with a slight gradient + ridge line
    const g = ctx.createLinearGradient(P1[0], P1[1], Dr[0], Dr[1]);
    g.addColorStop(0, lit(roofColor, 0.02)); g.addColorStop(1, lit(roofColor, -0.16));
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.moveTo(P1[0], P1[1]); ctx.lineTo(P2[0], P2[1]); ctx.lineTo(Cr[0], Cr[1]); ctx.lineTo(Dr[0], Dr[1]); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = `rgba(0,0,0,.18)`; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(P1[0], P1[1]); ctx.lineTo(P2[0], P2[1]); ctx.stroke();
    return { ridge: [P1, P2], eaveS: [Dr, Cr] };
  }

  // --- extruded box building -----------------------------------------------
  // (x,y) footprint center on the ground. w(width) d(depth) h(height) in world units.
  function box(ctx, x, y, w, d, h, baseColor, L, opts) {
    opts = opts || {};
    const hw = w / 2, hd = d / 2;
    groundShadow(ctx, x, y, w, d, h, L);
    const A = [x - hw, y - hd], B = [x + hw, y - hd], C = [x + hw, y + hd], D = [x - hw, y + hd];
    const Ar = lift(A[0], A[1], h), Br = lift(B[0], B[1], h), Cr = lift(C[0], C[1], h), Dr = lift(D[0], D[1], h);
    const amb = L.ambient;
    const lit = (c, k) => css(shade(c, k * amb), 1);
    // south (front) wall — most shadowed
    ctx.fillStyle = lit(baseColor, -0.42);
    ctx.beginPath(); ctx.moveTo(D[0], D[1]); ctx.lineTo(C[0], C[1]); ctx.lineTo(Cr[0], Cr[1]); ctx.lineTo(Dr[0], Dr[1]); ctx.closePath(); ctx.fill();
    // east (right) wall — mid
    ctx.fillStyle = lit(baseColor, -0.22);
    ctx.beginPath(); ctx.moveTo(C[0], C[1]); ctx.lineTo(B[0], B[1]); ctx.lineTo(Br[0], Br[1]); ctx.lineTo(Cr[0], Cr[1]); ctx.closePath(); ctx.fill();
    // roof — lit, with a gentle gradient
    const roofCol = opts.roof ? opts.roof : shade(baseColor, 0.10);
    const g = ctx.createLinearGradient(Ar[0], Ar[1], Cr[0], Cr[1]);
    g.addColorStop(0, css(shade(roofCol, 0.18 * amb)));
    g.addColorStop(1, css(shade(roofCol, -0.06)));
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.moveTo(Ar[0], Ar[1]); ctx.lineTo(Br[0], Br[1]); ctx.lineTo(Cr[0], Cr[1]); ctx.lineTo(Dr[0], Dr[1]); ctx.closePath(); ctx.fill();
    // crisp roof edge
    ctx.strokeStyle = `rgba(0,0,0,${0.18})`; ctx.lineWidth = 1; ctx.stroke();
    // lit windows at night (front + east faces)
    if (opts.windows && L.lampGlow > 0.02) {
      ctx.save(); ctx.globalCompositeOperation = 'lighter';
      const wc = `rgba(255,210,130,${0.5 * L.lampGlow})`;
      const cols = Math.max(1, Math.floor(w / 9));
      for (let i = 0; i < cols; i++) {
        if ((hash('' + x + y + i) % 3) === 0) continue;
        const fx = D[0] + (C[0] - D[0]) * ((i + 0.5) / cols);
        const fy = D[1] + (C[1] - D[1]) * ((i + 0.5) / cols);
        const top = lift(fx, fy, h * 0.62);
        ctx.fillStyle = wc; ctx.fillRect(fx - 1.4, top[1], 2.8, (fy - top[1]) * 0.5);
      }
      ctx.restore();
    }
    return { roof: [Ar, Br, Cr, Dr] };
  }

  // --- cylinder / tower -----------------------------------------------------
  function cyl(ctx, x, y, r, h, baseColor, L, opts) {
    opts = opts || {};
    groundShadow(ctx, x, y, r * 2, r * 2, h, L);
    const amb = L.ambient;
    const top = lift(x, y, h);
    // barrel
    const bg = ctx.createLinearGradient(x - r, 0, x + r, 0);
    bg.addColorStop(0, css(shade(baseColor, 0.05 * amb)));
    bg.addColorStop(0.5, css(shade(baseColor, -0.18 * amb)));
    bg.addColorStop(1, css(shade(baseColor, -0.40 * amb)));
    ctx.fillStyle = bg;
    ctx.beginPath();
    ctx.moveTo(x - r, y); ctx.lineTo(top[0] - r, top[1]);
    ctx.lineTo(top[0] + r, top[1]); ctx.lineTo(x + r, y);
    ctx.ellipse(x, y, r, r * 0.42, 0, 0, Math.PI); ctx.closePath(); ctx.fill();
    // top cap
    const tc = opts.cap || shade(baseColor, 0.16);
    ctx.fillStyle = css(shade(tc, 0.12 * amb));
    ctx.beginPath(); ctx.ellipse(top[0], top[1], r, r * 0.42, 0, 0, TAU); ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,.2)'; ctx.lineWidth = 1; ctx.stroke();
    return top;
  }

  // --- conical roof (for towers) -------------------------------------------
  function cone(ctx, cx, cy, r, h, color, L) {
    const tip = lift(cx, cy, h);
    const amb = L.ambient;
    ctx.fillStyle = css(shade(color, -0.30 * amb));
    ctx.beginPath(); ctx.moveTo(cx - r, cy); ctx.lineTo(tip[0], tip[1]); ctx.lineTo(cx + r, cy);
    ctx.ellipse(cx, cy, r, r * 0.42, 0, 0, Math.PI); ctx.closePath(); ctx.fill();
    ctx.fillStyle = css(shade(color, 0.14 * amb));   // lit left face
    ctx.beginPath(); ctx.moveTo(cx - r, cy); ctx.lineTo(tip[0], tip[1]); ctx.lineTo(cx, cy + r * 0.42); ctx.closePath(); ctx.fill();
  }

  // --- a fluttering banner on a pole ---------------------------------------
  function banner(ctx, x, y, h, hue, time, L, vit) {
    if (vit == null) vit = 1;
    const top = lift(x, y, h);
    ctx.strokeStyle = css(shade([90, 80, 70], 0)); ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(top[0], top[1]); ctx.stroke();
    const flutter = Math.sin(time * 3 + x) * 2 * (0.25 + 0.75 * vit);   // limp when idle
    const droop = (1 - vit) * 5;                                        // flag hangs down
    const fc = hslArr(hue, clamp(20 + 50 * vit, 20, 70), 52 * Math.max(0.55, L.ambient));
    ctx.fillStyle = css(fc);
    ctx.beginPath();
    ctx.moveTo(top[0], top[1] + 1);
    ctx.quadraticCurveTo(top[0] + 7, top[1] + 3 + flutter + droop, top[0] + 13, top[1] + 2 + droop);
    ctx.lineTo(top[0] + 13, top[1] + 9 + droop); ctx.quadraticCurveTo(top[0] + 7, top[1] + 11 + flutter + droop, top[0], top[1] + 10);
    ctx.closePath(); ctx.fill();
  }

  // --- props ----------------------------------------------------------------
  function tree(ctx, x, y, s, L) {
    groundShadow(ctx, x, y, s * 1.2, s * 0.8, s * 1.6, L);
    const af = 0.42 + 0.58 * clamp(L.ambient, 0, 1);   // foliage dims at night
    ctx.fillStyle = css(shade([70, 55, 40], -0.1 - (1 - L.ambient) * 0.3));
    ctx.fillRect(x - s * 0.12, y - s * 0.2, s * 0.24, s * 0.7);
    const top = lift(x, y, s * 1.5);
    const g = ctx.createRadialGradient(top[0] - s * 0.3, top[1] - s * 0.3, s * 0.1, top[0], top[1], s * 1.1);
    g.addColorStop(0, css(shade(hslArr(110, 35, 38 * af), 0.14 * L.ambient)));
    g.addColorStop(1, css(shade(hslArr(120, 40, 24 * af), -0.05)));
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(top[0], top[1], s, 0, TAU); ctx.fill();
  }
  function rock(ctx, x, y, s, L) {
    groundShadow(ctx, x, y, s * 1.6, s, s * 0.7, L);
    ctx.fillStyle = css(shade([110, 110, 120], -0.15 * (1 - L.ambient)));
    ctx.beginPath(); ctx.moveTo(x - s, y); ctx.lineTo(x - s * 0.4, y - s * 0.7); ctx.lineTo(x + s * 0.5, y - s * 0.6); ctx.lineTo(x + s, y); ctx.closePath(); ctx.fill();
  }

  // --- smoke puff (drawn live) ---------------------------------------------
  function smoke(ctx, x, y, life, L) {
    const a = (1 - life) * 0.5 * (0.5 + L.ambient * 0.5);
    const r = 4 + life * 16;
    ctx.fillStyle = `rgba(${200 - life * 80},${200 - life * 80},${205 - life * 70},${a})`;
    ctx.beginPath(); ctx.arc(x, y - life * 26, r, 0, TAU); ctx.fill();
  }

  // --- deterministic names --------------------------------------------------
  const N1 = ['Al', 'Bex', 'Cor', 'Dax', 'El', 'Fen', 'Gar', 'Hex', 'Ix', 'Jor', 'Kael', 'Lyr', 'Mor', 'Nyx', 'Or', 'Pyx', 'Quill', 'Rax', 'Sol', 'Tyr', 'Vex', 'Wren', 'Xan', 'Yor', 'Zeph'];
  const N2 = ['ric', 'ix', 'or', 'an', 'eth', 'us', 'a', 'wyn', 'ar', 'is', 'on', 'ael', 'ux', 'im', ' os'];
  const TITLES = ['Scribe', 'Hauler', 'Tinker', 'Mason', 'Scout', 'Smith', 'Runner', 'Warden', 'Adept', 'Forager'];
  const VET_TITLES = ['the Tireless', 'the Veteran', 'Ironhand', 'the Steadfast', 'Longwatch', 'the Elder', 'Brightcore'];
  function nameFor(seedStr) {
    const r = mulberry(hash(seedStr));
    const base = N1[(r() * N1.length) | 0] + N2[(r() * N2.length) | 0];
    const title = TITLES[(r() * TITLES.length) | 0];
    return { name: base, title, vet: VET_TITLES[(r() * VET_TITLES.length) | 0] };
  }

  window.Arena = window.Arena || {};
  window.Arena.art = {
    TAU, clamp, lerp, mix, hslArr, shade, css, rgb, hash, mulberry, fbm, noise2,
    lift, HX, HY, lighting, setPhase, clockPhase,
    box, gableBox, cyl, cone, banner, tree, rock, smoke, groundShadow, nameFor,
    ROOFS, WALLS,
  };
})();
