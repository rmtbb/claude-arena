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
      // Loose grid + deterministic per-town jitter so settlements feel scattered
      // across a land, not lined up in a row.
      const i = this.slot++;
      const cols = 4;
      const cell = 680;
      const col = i % cols;
      const row = Math.floor(i / cols);
      const h = window.Arena.art.hash(key);
      const jx = ((h & 0xff) / 255 - 0.5) * cell * 0.62;
      const jy = (((h >> 8) & 0xff) / 255 - 0.5) * cell * 0.62;
      const x = 520 + col * cell + (row % 2) * cell * 0.5 + jx;
      const y = 460 + row * cell + jy;
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
          resources: 0, totalTools: 0, totalSessions: 0,
          spawnFlash: 1, town: null, _townSig: '',
        };
        this.factions.set(n.projectKey, f);
        this.buildTown(f);
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
      f.totalSessions = meta.totalSessions || 0;
      f.totalSubagents = meta.totalSubagents || 0;
      f.totalEvents = meta.totalEvents || 0;
      f.liveSessions = meta.liveSessions || 0;
      f.firstSeen = meta.firstSeen || f.firstSeen || null;
      f.lastSeen = meta.lastSeen || f.lastSeen || null;
      f.toolCounts = meta.toolCounts || f.toolCounts || {};
      f.preCompacts = meta.preCompacts || 0;
      f.motto = meta.motto || null;
      // lore derived from real data
      const lore = window.Arena.lore;
      f.era = lore.eraIndex(f);
      f.eraName = lore.eraName(f);
      f.patina = lore.patina(f);
      f.gilded = lore.gilded(f);
      f.fingerprint = lore.fingerprint(f);
      f.milestones = lore.milestones(f);
      this.buildTown(f); // rebuild only if the town signature changed (cheap, see below)
    }

    // ---- town layout: a persistent settlement derived from lifetime history --
    // Stable + append-only: building/house positions are a pure function of the
    // faction seed + index, so growth adds structures without shuffling old ones.
    buildTown(f) {
      const A = window.Arena.art;
      const era = f.era || 0;                          // 0 Outpost .. 4 Capital
      const fp = (f.fingerprint && f.fingerprint.weights) || {};
      const tools = f.totalTools || 0;
      const wf = (k) => 0.78 + (fp[k] || 0) * 1.3;     // skyline emphasis from tool-mix
      // scale + density from real lifetime work (log so a giant never blows up)
      const houseCount = Math.min(52, 2 + era * 5 + Math.floor((f.totalSessions || 0) * 0.55) + Math.floor((fp.workshop || 0) * 10));
      const wallR = 58 + era * 15 + Math.min(46, Math.log10(1 + tools) * 9);
      const hasWall = era >= 2;                         // Outpost/Hamlet are open
      const stone = era >= 3;                           // palisade -> stone
      f.droneCap = Math.round(7 + (fp.barracks || 0) * 18);
      const sig = `${era}|${(f.fingerprint || {}).dominant}|${houseCount}|${Math.round(wallR)}|${f.gilded ? 1 : 0}`;
      if (f._townSig === sig && f.town) return;
      f._townSig = sig;

      const seed = A.hash(f.key);
      const ringR = wallR * 0.52;
      // distinct footprints, each biased by how this project is actually worked
      const defs = [
        { type: 'forge', station: 'gas', ang: -1.1, w: 28 * wf('forge'), d: 22, h: 12 + 7 * (fp.forge || 0), emph: fp.forge || 0 },
        { type: 'workshop', station: 'mineral', ang: 0.55, w: 28 * wf('workshop'), d: 26, h: 16, emph: fp.workshop || 0 },
        { type: 'tower', station: 'scout', ang: -2.3, w: 13, d: 13, h: 40 + 44 * (fp.tower || 0), emph: fp.tower || 0 },
        { type: 'wargate', station: 'expedition', ang: Math.PI / 2, w: 30, d: 14, h: 24, onWall: true, emph: fp.wargate || 0 },
        { type: 'barracks', station: 'spawn', ang: 2.9, w: 34 * wf('barracks'), d: 18, h: 15, emph: fp.barracks || 0 },
      ];
      const buildings = defs.map((b) => {
        const rad = (b.onWall && hasWall) ? wallR : ringR;
        const x = Math.cos(b.ang) * rad, y = Math.sin(b.ang) * rad * 0.8;
        return { ...b, x, y };
      });
      f.stations = {};
      for (const b of buildings) f.stations[b.station] = { x: f.x + b.x, y: f.y + b.y, type: b.station, pulse: 0 };

      // houses: append-only deterministic packing, avoiding keep + buildings
      const houses = [];
      let i = 0, guard = 0;
      while (houses.length < houseCount && guard < houseCount * 12) {
        guard++;
        const hr = A.mulberry(seed ^ (0x9e37 * (i + 1)));
        const ang = hr() * A.TAU, dist = 30 + hr() * (wallR - 36);
        const x = Math.cos(ang) * dist, y = Math.sin(ang) * dist * 0.8;
        i++;
        if (Math.hypot(x, y) < 26) continue;
        if (buildings.some((b) => Math.hypot(b.x - x, b.y - y) < 24)) continue;
        if (houses.some((h) => Math.hypot(h.x - x, h.y - y) < 14)) continue;
        houses.push({ x, y, w: 11 + (hr() * 5 | 0), h: 8 + (hr() * 6 | 0), roofHue: (hr() * 40 - 20), seed: hr() * 1000 });
      }
      const gates = [Math.PI / 2, -2.3, 0.5].map((a) => ({ x: Math.cos(a) * wallR, y: Math.sin(a) * wallR * 0.8, ang: a }));
      const props = [];
      const territory = wallR + 70;
      for (let p = 0; p < 26; p++) {
        const pr = A.mulberry(seed ^ (0x51ed * (p + 7)));
        const ang = pr() * A.TAU, dist = wallR + 18 + pr() * 60;
        props.push({ x: Math.cos(ang) * dist, y: Math.sin(ang) * dist * 0.8, kind: pr() < 0.65 ? 'tree' : 'rock', s: 6 + pr() * 6, seed: pr() });
      }
      // one Chronicle Stone near the keep; its height grows with milestone count
      const chronicle = { x: 34, y: -6, bands: (f.milestones || []).length };
      f.town = { era, wallR, ringR, territory, buildings, houses, gates, props, hasWall, stone, gilded: !!f.gilded, chronicle };
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
        hue: f.hue, carry: null, parent: null, tool: null, facing: 1,
        born: this.time, lastActive: this.time, alert: 0, scale: 0.1,
        actions: 0, veteran: false,
        identity: window.Arena.art.nameFor(String(sessionId)),
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
      if (count > (f.droneCap || 14)) return null;
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
          u.tool = n.tool; u.actions++;
          if (u.actions >= 12 && !u.veteran) u.veteran = true;
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
        if (Math.abs(u.vx) > 6) u.facing = u.vx >= 0 ? 1 : -1;
        if (u.kind === 'worker' && !u.veteran && (this.time - u.born) > 100) u.veteran = true;

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
