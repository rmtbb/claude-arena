/*
 * Claude Arena — time-lapse replay.
 * Fetches the full timestamped history and re-grows the whole world at an
 * adjustable clock so you can scrub back days and watch progress fast or slow.
 * It rebuilds the same lifetime aggregates the server keeps, then feeds the sim
 * applyFactionMeta (town growth) + applyEvent (unit animation) as the replay
 * clock advances. lore + day/night are driven by the replay clock, not now.
 */
(function () {
  'use strict';
  const HOUR = 3600000;

  class Replay {
    constructor(sim) {
      this.sim = sim;
      this.events = [];
      this.idx = 0;
      this.clock = 0; this.from = 0; this.to = 0;
      this.speed = 6 * HOUR;          // sim-ms advanced per real second
      this.playing = false;
      this.agg = new Map();
      this.loaded = false;
    }
    async load() {
      const r = await fetch('/api/history'); const j = await r.json();
      this.events = j.events || []; this.from = j.from || 0; this.to = j.to || 0;
      this.loaded = true; return j;
    }
    reset() {
      const s = this.sim;
      s.factions.clear(); s.units.clear(); s.unitsBySession.clear();
      s.particles.length = 0; s.floaters.length = 0; s.envoys.length = 0; s.roads.clear();
      s.slot = 0; this.agg.clear(); this.idx = 0;
    }
    applyOne(ev, animate) {
      const A = window.Arena.art;
      const ts = ev[0], event = ev[1], key = ev[2], name = ev[3], tool = ev[4] || null, sid = ev[5] || null, isErr = ev[6], sub = ev[7] || null;
      let a = this.agg.get(key);
      if (!a) { a = { name, firstSeen: ts, lastSeen: ts, totalTools: 0, totalSessions: 0, sessions: new Set(), totalSubagents: 0, resources: 0, preCompacts: 0, totalEvents: 0, toolCounts: {} }; this.agg.set(key, a); }
      a.lastSeen = ts; a.totalEvents++; if (name) a.name = name;
      if (sid && !a.sessions.has(sid)) { a.sessions.add(sid); a.totalSessions++; }
      if (event === 'PreToolUse') { a.totalTools++; if (tool) a.toolCounts[tool] = (a.toolCounts[tool] || 0) + 1; if (tool === 'Task' || tool === 'Agent' || tool === 'Workflow') a.totalSubagents++; }
      if (event === 'PostToolUse' && !isErr) a.resources++;
      if (event === 'PreCompact') a.preCompacts++;
      const h = A.hash(key);
      this.sim.applyFactionMeta({ key, name: a.name, hue: h % 360, crest: h % 12, level: 1, resources: a.resources, totalTools: a.totalTools, totalSessions: a.totalSessions, totalSubagents: a.totalSubagents, totalEvents: a.totalEvents, liveSessions: 0, firstSeen: a.firstSeen, lastSeen: a.lastSeen, toolCounts: a.toolCounts, preCompacts: a.preCompacts });
      if (animate) this.sim.applyEvent({ event, projectKey: key, projectName: a.name, sessionId: sid, tool, isError: !!isErr, subagentType: sub });
    }
    // jump to a time: rebuild from start to target (fast, no unit animation)
    seek(targetTs) {
      this.reset();
      const evs = this.events;
      let i = 0;
      for (; i < evs.length; i++) { if (evs[i][0] > targetTs) break; this.applyOne(evs[i], false); }
      this.idx = i; this.clock = targetTs;
      this.syncClocks();
    }
    syncClocks() {
      window.Arena.lore.setNow(this.clock);
      const d = new Date(this.clock);
      window.Arena.art.setPhase((d.getHours() + d.getMinutes() / 60) / 24);
    }
    step(dtReal) {
      if (this.playing) {
        this.clock += dtReal * this.speed;
        if (this.clock >= this.to) { this.clock = this.to; this.playing = false; }
      }
      // animate unit-level life only at slower speeds; fast-forward just grows towns
      const animate = this.speed <= 6 * HOUR;
      const evs = this.events;
      let budget = 4000;              // cap events/frame so huge jumps stay responsive
      while (this.idx < evs.length && evs[this.idx][0] <= this.clock && budget-- > 0) { this.applyOne(evs[this.idx], animate); this.idx++; }
      this.syncClocks();
    }
  }

  window.Arena = window.Arena || {};
  window.Arena.Replay = Replay;
})();
