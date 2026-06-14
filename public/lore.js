/*
 * Claude Arena — lore: derives a town's "life" entirely from REAL data
 * (lifetime counters + first/last-seen timestamps + wall-clock). No faked
 * activity, no invented data. Pure functions, shared by sim / renderer / UI.
 *
 *   era      — structural growth tier (one-way, by lifetime work + age)
 *   vitality — reversible 0..1 liveness from time-since-last-event
 *   patina   — one-way 0..1 weathering from age + lifetime work
 *   fingerprint — which kind of town, from the tool-mix
 *   milestones  — durable achievements the counters already imply
 */
(function () {
  'use strict';
  const DAY = 86400000, HOUR = 3600000;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  // "now" override so time-lapse replay evaluates age/vitality/patina against
  // the REPLAY clock instead of the wall clock. null = live (real now).
  let nowOverride = null;
  function setNow(ms) { nowOverride = ms; }
  function now() { return nowOverride == null ? Date.now() : nowOverride; }

  // PreToolUse tool -> building category (mirrors the renderer mapping)
  const TOOL_CAT = {
    Bash: 'forge', Read: 'tower', Grep: 'tower', Glob: 'tower',
    Edit: 'workshop', Write: 'workshop', NotebookEdit: 'workshop', MultiEdit: 'workshop',
    WebFetch: 'wargate', WebSearch: 'wargate',
    Task: 'barracks', Agent: 'barracks', Workflow: 'barracks',
  };

  const ERAS = ['Outpost', 'Hamlet', 'Walled Town', 'Citadel', 'Capital'];
  const ERA_TOOLS = [0, 40, 220, 1100, 5500];      // lifetime-tool thresholds

  function eraIndex(f) {
    const tools = f.totalTools || 0;
    let e = 0;
    for (let i = 0; i < ERA_TOOLS.length; i++) if (tools >= ERA_TOOLS[i]) e = i;
    // a long-lived town never feels like a raw camp even if light-touch
    const ageDays = f.firstSeen ? (now() - f.firstSeen) / DAY : 0;
    if (ageDays > 14 && e < 1) e = 1;
    if (ageDays > 60 && e < 2) e = 2;
    return e;
  }
  function eraName(f) { return ERAS[eraIndex(f)]; }
  function eraProgress(f) {
    const e = eraIndex(f);
    if (e >= ERA_TOOLS.length - 1) return 1;
    const lo = ERA_TOOLS[e], hi = ERA_TOOLS[e + 1];
    return clamp(((f.totalTools || 0) - lo) / (hi - lo), 0, 1);
  }
  function nextEra(f) { const e = eraIndex(f); return e >= ERAS.length - 1 ? null : ERAS[e + 1]; }

  // reversible liveness: 1 if worked in the last ~2h, easing to a low floor over ~14 days idle
  function vitality(f) {
    if (!f.lastSeen) return 0.4;
    const h = (now() - f.lastSeen) / HOUR;
    if (h < 2) return 1;
    const span = 14 * 24;            // hours to reach the floor
    const t = clamp(Math.log10(1 + h / 2) / Math.log10(1 + span / 2), 0, 1);
    return clamp(1 - t * 0.9, 0.1, 1);
  }
  function idleLabel(f) {
    if (!f.lastSeen) return 'never';
    const m = (now() - f.lastSeen) / 60000;
    if (m < 3) return 'active now';
    if (m < 90) return Math.round(m) + ' min ago';
    if (m < 36 * 60) return Math.round(m / 60) + ' hr ago';
    return Math.round(m / (60 * 24)) + ' days ago';
  }

  // one-way weathering: grows with age and lifetime work, never resets
  function patina(f) {
    const tools = f.totalTools || 0;
    const ageDays = f.firstSeen ? (now() - f.firstSeen) / DAY : 0;
    const byTools = clamp(Math.log10(1 + tools) / Math.log10(1 + 50000), 0, 1);
    const byAge = clamp(ageDays / 120, 0, 1);
    return clamp(Math.max(byTools, byAge * 0.7), 0, 1);
  }
  function gilded(f) { return (f.totalTools || 0) >= 10000; }   // gilded keep roof tier

  function fingerprint(f) {
    const tc = f.toolCounts || {};
    const cat = { forge: 0, workshop: 0, tower: 0, wargate: 0, barracks: 0 };
    for (const k in tc) { const c = TOOL_CAT[k]; if (c) cat[c] += tc[k]; }
    const tot = Object.values(cat).reduce((a, b) => a + b, 0) || 1;
    const w = {}; let dom = 'workshop', dv = -1;
    for (const k in cat) { w[k] = cat[k] / tot; if (w[k] > dv) { dv = w[k]; dom = k; } }
    return { weights: w, dominant: dom, strength: dv };
  }
  function character(f) {
    const fp = fingerprint(f);
    if (fp.strength < 0.34) return 'A balanced settlement of many trades.';
    return {
      forge: 'A forge-town — all fire, iron, and running commands.',
      workshop: "A craftsfolk town of endless building and editing.",
      tower: 'A watchful town of scouts, readers, and scholars.',
      wargate: 'A frontier town forever sending expeditions afar.',
      barracks: 'A war-town that musters subagents by the score.',
    }[fp.dominant];
  }

  // durable milestones the counters imply (Chronicle Stone bands)
  function milestones(f) {
    const out = [];
    const t = f.totalTools || 0, s = f.totalSessions || 0, sub = f.totalSubagents || 0;
    [100, 1000, 10000, 50000].forEach((n) => { if (t >= n) out.push(n.toLocaleString() + ' tools forged'); });
    [10, 50, 100, 500].forEach((n) => { if (s >= n) out.push(n + ' sessions mustered'); });
    if (sub >= 1) out.push('first subagent deployed');
    if (sub >= 100) out.push('100 subagents deployed');
    if ((f.preCompacts || 0) >= 1) out.push('survived a memory storm');
    if ((f.preCompacts || 0) >= 10) out.push('weathered 10 memory storms');
    const ageDays = f.firstSeen ? (now() - f.firstSeen) / DAY : 0;
    [7, 30, 90, 365].forEach((n) => { if (ageDays >= n) out.push(n >= 365 ? 'one year old' : n + ' days old'); });
    return out;
  }

  window.Arena = window.Arena || {};
  window.Arena.lore = {
    setNow, now,
    ERAS, eraIndex, eraName, eraProgress, nextEra,
    vitality, idleLabel, patina, gilded, fingerprint, character, milestones,
  };
})();
