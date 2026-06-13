/*
 * Claude Arena — world simulation (renderer-agnostic).
 *
 * This holds the ENTIRE living world: factions (projects), units (sessions +
 * subagents), resource stations, particles. It ingests normalized events from
 * the server and advances a little steering/state-machine each frame.
 *
 * Renderers (rts / aquarium / cyber) only READ this state and draw it their own
 * way. Same data, three skins. Keep all gameplay/behavior here; keep all visuals
 * out of here.
 */
(function () {
  'use strict';

  const TAU = Math.PI * 2;
  const rnd = (a, b) => a + Math.random() * (b - a);

  // Tool → resource station type. Mirrors server RESOURCE_TOOLS but the sim is
  // self-sufficient if the server map changes.
  const TOOL_STATION = {
    Bash: 'gas', Read: 'scout', Grep: 'scout', Glob: 'scout',
    Edit: 'mineral', Write: 'mineral', NotebookEdit: 'mineral', MultiEdit: 'mineral',
    WebFetch: 'expedition', WebSearch: 'expedition',
    Task: 'spawn', Agent: 'spawn', Workflow: 'spawn',
  };
  const STATIONS = ['mineral', 'gas', 'scout', 'expedition', 'spawn'];
  const STATION_HUE = { mineral: 205, gas: 130, scout: 50, expedition: 285, spawn: 0 };

  let UID = 1;

  class Sim {
    constructor() {
      this.factions = new Map();
      this.units = new Map();          // id -> unit
      this.unitsBySession = new Map(); // sessionId -> unit id (the worker)
      this.particles = [];
      this.floaters = [];
      this.ticker = [];                // {text, hue, t}
      this.slot = 0;
      this.time = 0;
      this.alertHues = [];             // transient screen flashes
    }

    // ---- layout -----------------------------------------------------------
    placeFaction(key) {
      // Grid that grows outward; generous spacing so bases never overlap.
      const i = this.slot++;
      const cols = 4;
      const cell = 620;
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = 480 + col * cell + (row % 2) * cell * 0.5;
      const y = 420 + row * cell;
      return { x, y };
    }

    ensureFaction(n) {
      let f = this.factions.get(n.projectKey);
      if (!f) {
        const pos = this.placeFaction(n.projectKey);
        f = {
          key: n.projectKey,
          name: n.projectName || 'Unknown',
          hue: 200, crest: 0, level: 1,
          x: pos.x, y: pos.y,
          stations: {},
          beacon: 0, storm: 0, pop: 0,
          resources: 0, totalTools: 0,
          spawnFlash: 1,
        };
        // Stations arranged in a ring around the base.
        STATIONS.forEach((s, k) => {
          const a = (k / STATIONS.length) * TAU - Math.PI / 2;
          f.stations[s] = { x: f.x + Math.cos(a) * 150, y: f.y + Math.sin(a) * 150, type: s, pulse: 0 };
        });
        this.factions.set(n.projectKey, f);
      }
      if (n.projectName && n.projectName !== 'Unknown') f.name = n.projectName;
      return f;
    }

    // Apply server-provided faction metadata (hue/crest/level/stats/name overrides).
    applyFactionMeta(meta) {
      const f = this.factions.get(meta.key) || this.ensureFaction({ projectKey: meta.key, projectName: meta.name });
      f.name = meta.name;
      f.hue = meta.hue;
      f.crest = meta.crest;
      f.level = meta.level || 1;
      f.resources = meta.resources || 0;
      f.totalTools = meta.totalTools || 0;
      f.motto = meta.motto || null;
    }

    // ---- units ------------------------------------------------------------
    spawnWorker(f, sessionId) {
      // Hard cap workers per faction; recycle the stalest so we never runaway.
      let count = 0, oldest = null;
      for (const u of this.units.values()) {
        if (u.factionKey === f.key && u.kind === 'worker' && !u.dead) {
          count++;
          if (!oldest || u.lastActive < oldest.lastActive) oldest = u;
        }
      }
      if (count >= 24 && oldest) { oldest.state = 'leaving'; oldest.stateT = 0; }
      const id = UID++;
      const a = rnd(0, TAU);
      const u = {
        id, kind: 'worker', factionKey: f.key, sessionId,
        x: f.x + Math.cos(a) * 26, y: f.y + Math.sin(a) * 26,
        vx: 0, vy: 0, tx: f.x, ty: f.y,
        state: 'spawning', stateT: 0,
        hue: f.hue, carry: null, parent: null,
        born: this.time, lastActive: this.time, alert: 0, scale: 0.1,
        seed: Math.random() * 1000, wob: Math.random() * TAU, energy: 1, dead: false, deadT: 0,
      };
      this.units.set(id, u);
      this.unitsBySession.set(sessionId, id);
      this.burst(u.x, u.y, f.hue, 14, 'spawn');
      f.pop++;
      return u;
    }

    workerFor(f, sessionId) {
      if (!sessionId) {
        // fall back to any live worker of this faction
        for (const u of this.units.values()) if (u.factionKey === f.key && u.kind === 'worker' && !u.dead) return u;
        return this.spawnWorker(f, 'anon-' + UID);
      }
      const id = this.unitsBySession.get(sessionId);
      const u = id && this.units.get(id);
      if (u && !u.dead) return u;
      return this.spawnWorker(f, sessionId);
    }

    spawnDrone(f, parent, kind) {
      // Cap drones per faction so a big workflow doesn't overrun the screen.
      let count = 0;
      for (const u of this.units.values()) if (u.factionKey === f.key && u.kind === 'drone' && !u.dead) count++;
      if (count > 14) return null;
      const id = UID++;
      const a = rnd(0, TAU);
      const u = {
        id, kind: 'drone', factionKey: f.key, sessionId: null,
        x: parent.x, y: parent.y, vx: 0, vy: 0,
        tx: f.x + Math.cos(a) * rnd(170, 300), ty: f.y + Math.sin(a) * rnd(170, 300),
        state: 'patrol', stateT: 0, hue: f.hue, carry: null, parent: parent.id,
        born: this.time, lastActive: this.time, alert: 0, scale: 0.1,
        seed: Math.random() * 1000, wob: Math.random() * TAU, energy: 1,
        subType: kind || 'agent', dead: false, deadT: 0,
      };
      this.units.set(id, u);
      this.burst(parent.x, parent.y, f.hue, 8, 'spawn');
      return u;
    }

    // ---- effects ----------------------------------------------------------
    burst(x, y, hue, n, kind) {
      for (let i = 0; i < n; i++) {
        const a = rnd(0, TAU), sp = rnd(20, 120);
        this.particles.push({
          x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
          life: 0, max: rnd(0.4, 1.0), hue, size: rnd(1.5, 3.5), kind: kind || 'spark',
        });
      }
    }
    floater(x, y, text, hue) {
      this.floaters.push({ x, y, text, hue, life: 0, max: 1.4 });
    }
    log(text, hue) {
      this.ticker.push({ text, hue, t: this.time });
      if (this.ticker.length > 60) this.ticker.shift();
    }

    // ---- event ingestion --------------------------------------------------
    applyEvent(n) {
      if (!n || !n.projectKey) return;
      const f = this.ensureFaction(n);
      const short = f.name;

      switch (n.event) {
        case 'SessionStart': {
          const u = this.workerFor(f, n.sessionId);
          u.state = 'spawning'; u.stateT = 0;
          this.log(`▲ ${short} — a worker awakens`, f.hue);
          break;
        }
        case 'UserPromptSubmit': {
          const u = this.workerFor(f, n.sessionId);
          u.alert = 1; u.lastActive = this.time;
          this.floater(u.x, u.y - 18, '!', 45);
          break;
        }
        case 'PreToolUse': {
          const u = this.workerFor(f, n.sessionId);
          u.lastActive = this.time;
          const st = TOOL_STATION[n.tool] || 'mineral';
          if (st === 'spawn') {
            const d = this.spawnDrone(f, u, n.subagentType);
            f.stations.spawn.pulse = 1;
            if (d) this.log(`◇ ${short} deploys ${n.subagentType || 'a subagent'}`, f.hue);
          } else {
            const station = f.stations[st];
            u.tx = station.x + rnd(-12, 12); u.ty = station.y + rnd(-12, 12);
            u.state = 'toResource'; u.stateT = 0; u.targetStation = st;
            station.pulse = 1;
          }
          break;
        }
        case 'PostToolUse': {
          const u = this.workerFor(f, n.sessionId);
          u.lastActive = this.time;
          if (n.isError) {
            u.state = 'stumble'; u.stateT = 0;
            this.burst(u.x, u.y, 0, 12, 'error');
            this.floater(u.x, u.y - 16, '✕', 0);
          } else {
            const st = u.targetStation || 'mineral';
            u.carry = { type: st, hue: STATION_HUE[st] != null ? STATION_HUE[st] : f.hue };
            u.state = 'returning'; u.stateT = 0; u.tx = f.x; u.ty = f.y;
          }
          break;
        }
        case 'SubagentStop': {
          // recall the oldest active drone of this faction
          let best = null;
          for (const u of this.units.values())
            if (u.factionKey === f.key && u.kind === 'drone' && !u.dead && u.state !== 'recall')
              if (!best || u.born < best.born) best = u;
          if (best) { best.state = 'recall'; best.stateT = 0; }
          this.log(`◆ ${short} — subagent reports back`, f.hue);
          break;
        }
        case 'Stop': {
          const u = this.workerFor(f, n.sessionId);
          u.state = 'returning'; u.stateT = 0; u.tx = f.x; u.ty = f.y; u.rest = true;
          this.floater(f.x, f.y - 30, '✓', f.hue);
          break;
        }
        case 'SessionEnd': {
          const id = n.sessionId && this.unitsBySession.get(n.sessionId);
          const u = id && this.units.get(id);
          if (u) { u.state = 'leaving'; u.stateT = 0; u.tx = f.x; u.ty = f.y; }
          break;
        }
        case 'Notification': {
          f.beacon = 1.2;
          break;
        }
        case 'PreCompact': {
          f.storm = 1.5;
          this.log(`✺ ${short} — memory storm (compaction)`, f.hue);
          break;
        }
      }
    }

    // ---- per-frame update -------------------------------------------------
    update(dt) {
      this.time += dt;

      for (const f of this.factions.values()) {
        f.beacon = Math.max(0, f.beacon - dt);
        f.storm = Math.max(0, f.storm - dt * 0.6);
        f.spawnFlash = Math.max(0, f.spawnFlash - dt);
        for (const s of Object.values(f.stations)) s.pulse = Math.max(0, s.pulse - dt * 1.5);
      }

      for (const u of this.units.values()) {
        u.stateT += dt;
        u.wob += dt * (u.kind === 'drone' ? 9 : 5);
        u.alert = Math.max(0, u.alert - dt * 0.7);
        if (u.scale < 1) u.scale = Math.min(1, u.scale + dt * 2.5);

        const f = this.factions.get(u.factionKey);
        if (!f) continue;

        // Retire workers whose session has gone quiet — an avatar represents a
        // session, so when it stops emitting events for a while it wanders off.
        // This bounds population to roughly the set of active sessions.
        if (u.kind === 'worker' && !u.dead && u.state !== 'leaving' &&
            (this.time - u.lastActive) > 90 &&
            (u.state === 'idle' || u.state === 'rest')) {
          u.state = 'leaving'; u.stateT = 0;
        }

        // storm swirl perturbation
        if (f.storm > 0) {
          const a = Math.atan2(u.y - f.y, u.x - f.x) + dt * 3;
          const r = Math.hypot(u.x - f.x, u.y - f.y);
          u.x = f.x + Math.cos(a) * r; u.y = f.y + Math.sin(a) * r;
        }

        this.steer(u, dt, f);
      }

      // reap dead units
      for (const [id, u] of this.units) {
        if (u.dead) {
          u.deadT += dt;
          if (u.deadT > 0.6) {
            this.units.delete(id);
            if (u.sessionId && this.unitsBySession.get(u.sessionId) === id) this.unitsBySession.delete(u.sessionId);
          }
        }
      }

      // particles
      for (let i = this.particles.length - 1; i >= 0; i--) {
        const p = this.particles[i];
        p.life += dt;
        if (p.life >= p.max) { this.particles.splice(i, 1); continue; }
        p.x += p.vx * dt; p.y += p.vy * dt;
        p.vx *= 0.92; p.vy *= 0.92;
        if (p.kind !== 'error') p.vy -= 6 * dt;
      }
      // floaters
      for (let i = this.floaters.length - 1; i >= 0; i--) {
        const fl = this.floaters[i];
        fl.life += dt; fl.y -= 22 * dt;
        if (fl.life >= fl.max) this.floaters.splice(i, 1);
      }
    }

    steer(u, dt, f) {
      const dx = u.tx - u.x, dy = u.ty - u.y;
      const dist = Math.hypot(dx, dy) || 1;
      const baseSpeed = u.kind === 'drone' ? 150 : 95;
      let speed = baseSpeed;
      if (u.state === 'idle' || u.state === 'gathering' || u.state === 'rest') speed = 0;
      if (u.state === 'stumble') speed = 18;

      if (speed > 0 && dist > 3) {
        const ux = dx / dist, uy = dy / dist;
        u.vx += (ux * speed - u.vx) * Math.min(1, dt * 6);
        u.vy += (uy * speed - u.vy) * Math.min(1, dt * 6);
        u.x += u.vx * dt; u.y += u.vy * dt;
      } else {
        u.vx *= 0.8; u.vy *= 0.8;
      }

      const arrived = dist <= 6;

      switch (u.state) {
        case 'spawning':
          if (u.stateT > 0.5) { u.state = 'idle'; this.pickIdleTarget(u, f); }
          break;
        case 'idle':
          if (arrived && u.stateT > rnd(1, 2.5)) this.pickIdleTarget(u, f);
          break;
        case 'toResource':
          if (arrived) { u.state = 'gathering'; u.stateT = 0; if (f.stations[u.targetStation]) f.stations[u.targetStation].pulse = 1; }
          break;
        case 'gathering':
          // PostToolUse normally drives the exit; auto-finish if it never comes.
          if (u.stateT > 6) {
            u.carry = { type: u.targetStation || 'mineral', hue: STATION_HUE[u.targetStation] != null ? STATION_HUE[u.targetStation] : f.hue };
            u.state = 'returning'; u.stateT = 0; u.tx = f.x; u.ty = f.y;
          }
          break;
        case 'returning':
          if (arrived) {
            if (u.carry) {
              f.resources++;
              this.floater(f.x, f.y - 24, '+1', u.carry.hue);
              this.burst(f.x, f.y, u.carry.hue, 6, 'deposit');
              u.carry = null;
            }
            if (u.rest) { u.state = 'rest'; u.rest = false; this.floater(u.x, u.y - 16, 'z', f.hue); }
            else { u.state = 'idle'; this.pickIdleTarget(u, f); }
            u.stateT = 0;
          }
          break;
        case 'rest':
          if (u.stateT > rnd(2, 4)) { u.state = 'idle'; this.pickIdleTarget(u, f); }
          break;
        case 'stumble':
          if (u.stateT > 0.7) { u.state = 'idle'; this.pickIdleTarget(u, f); }
          break;
        case 'patrol':
          if (arrived && u.stateT > rnd(0.6, 1.6)) {
            const a = rnd(0, TAU);
            u.tx = f.x + Math.cos(a) * rnd(170, 320); u.ty = f.y + Math.sin(a) * rnd(170, 320); u.stateT = 0;
          }
          break;
        case 'recall':
          u.tx = f.x; u.ty = f.y;
          if (arrived) { this.burst(f.x, f.y, f.hue, 10, 'merge'); u.dead = true; }
          break;
        case 'leaving':
          u.tx = f.x; u.ty = f.y;
          if (arrived) { this.burst(f.x, f.y, f.hue, 12, 'depart'); u.dead = true; if (f.pop > 0) f.pop--; }
          break;
      }
    }

    pickIdleTarget(u, f) {
      const a = rnd(0, TAU), r = rnd(40, 110);
      u.tx = f.x + Math.cos(a) * r; u.ty = f.y + Math.sin(a) * r; u.stateT = 0;
    }

    // World bounds for camera framing.
    bounds() {
      let minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9;
      for (const f of this.factions.values()) {
        minx = Math.min(minx, f.x - 320); miny = Math.min(miny, f.y - 320);
        maxx = Math.max(maxx, f.x + 320); maxy = Math.max(maxy, f.y + 320);
      }
      if (minx > maxx) { minx = 0; miny = 0; maxx = 1280; maxy = 800; }
      return { minx, miny, maxx, maxy };
    }
  }

  window.Arena = window.Arena || {};
  window.Arena.Sim = Sim;
  window.Arena.STATIONS = STATIONS;
  window.Arena.STATION_HUE = STATION_HUE;
})();
