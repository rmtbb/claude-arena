/* Claude Arena — shared drawing helpers used by all renderers. */
(function () {
  'use strict';
  const TAU = Math.PI * 2;

  function hsl(h, s, l, a) { return `hsla(${h},${s}%,${l}%,${a == null ? 1 : a})`; }

  // 12 procedural faction crests (simple, readable sigils drawn at unit radius r).
  function crest(ctx, idx, x, y, r, color) {
    ctx.save();
    ctx.translate(x, y);
    ctx.strokeStyle = color; ctx.fillStyle = color;
    ctx.lineWidth = Math.max(1.2, r * 0.16);
    ctx.lineJoin = 'round';
    const k = ((idx % 12) + 12) % 12;
    ctx.beginPath();
    switch (k) {
      case 0: for (let i = 0; i < 3; i++) { const a = i / 3 * TAU - Math.PI / 2; ctx[i ? 'lineTo' : 'moveTo'](Math.cos(a) * r, Math.sin(a) * r); } ctx.closePath(); ctx.stroke(); break; // triangle
      case 1: ctx.arc(0, 0, r * 0.85, 0, TAU); ctx.moveTo(-r * 0.5, 0); ctx.lineTo(r * 0.5, 0); ctx.stroke(); break; // eye
      case 2: for (let i = 0; i < 4; i++) { const a = i / 4 * TAU; ctx[i ? 'lineTo' : 'moveTo'](Math.cos(a) * r, Math.sin(a) * r); } ctx.closePath(); ctx.stroke(); break; // diamond
      case 3: for (let i = 0; i < 10; i++) { const a = i / 10 * TAU - Math.PI / 2; const rr = i % 2 ? r * 0.45 : r; ctx[i ? 'lineTo' : 'moveTo'](Math.cos(a) * rr, Math.sin(a) * rr); } ctx.closePath(); ctx.stroke(); break; // star
      case 4: ctx.moveTo(0, -r); ctx.lineTo(0, r); ctx.moveTo(-r * 0.7, -r * 0.3); ctx.lineTo(0, -r); ctx.lineTo(r * 0.7, -r * 0.3); ctx.stroke(); break; // arrow up
      case 5: ctx.arc(0, 0, r, 0.2, TAU - 0.2); ctx.stroke(); break; // crescent ring
      case 6: ctx.rect(-r * 0.7, -r * 0.7, r * 1.4, r * 1.4); ctx.moveTo(-r * 0.7, 0); ctx.lineTo(r * 0.7, 0); ctx.stroke(); break;
      case 7: for (let i = 0; i < 6; i++) { const a = i / 6 * TAU; ctx[i ? 'lineTo' : 'moveTo'](Math.cos(a) * r, Math.sin(a) * r); } ctx.closePath(); ctx.stroke(); break; // hex
      case 8: ctx.moveTo(-r, -r); ctx.lineTo(r, r); ctx.moveTo(r, -r); ctx.lineTo(-r, r); ctx.stroke(); break; // X
      case 9: ctx.arc(0, 0, r * 0.5, 0, TAU); ctx.moveTo(r * 0.5, 0); ctx.arc(0, 0, r, -0.6, 0.6); ctx.stroke(); break;
      case 10: ctx.moveTo(-r, 0); ctx.lineTo(0, -r); ctx.lineTo(r, 0); ctx.lineTo(0, r); ctx.closePath(); ctx.moveTo(0, -r); ctx.lineTo(0, r); ctx.stroke(); break;
      default: ctx.arc(0, 0, r, 0, TAU); ctx.fill(); break; // dot
    }
    ctx.restore();
  }

  // Soft radial glow blob (additive look via lighter composite handled by caller).
  function glow(ctx, x, y, r, color, inner) {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, inner || color);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // Tiny deterministic value-noise for terrain texture.
  function vnoise(x, y) {
    const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
    return s - Math.floor(s);
  }

  window.Arena = window.Arena || {};
  window.Arena.util = { hsl, crest, glow, roundRect, vnoise, TAU };
})();
