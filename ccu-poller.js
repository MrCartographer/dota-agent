// Defense of the Agents — CCU / Operator Presence Poller
// ─────────────────────────────────────────────────────────────────────────────
// Polls the PUBLIC, unauthenticated game-state API across all live rooms and
// records a time series of concurrency + a per-operator presence log. This is
// the diligence artifact no other DOTA holder has: it turns "the ecosystem feels
// small" into a measurable CCU curve, filled-lobby rate, and — via stable hero
// names — an empirical split of persistent agents vs. transient (human / MMR-farm)
// operators, plus new-entrant rate week over week (the S-curve slope).
//
// Endpoint (no auth): GET https://game.defenseoftheagents.com/api/game/state?game={n}
//   top-level: { tick, agents:{human:[names],orc:[names]}, lanes, towers, bases, heroes, winner }
//   Rooms 1..5 are live; 6+ return 404. Lobby cap = 20.
//
// Usage:
//   node ccu-poller.js            # run forever, poll every POLL_INTERVAL ms (default 60s)
//   node ccu-poller.js --once     # single poll cycle then exit (for cron / launchd / CI)
//   node ccu-poller.js --report   # analyze ccu_log.jsonl and print stats
//
// Outputs (append-only, durable):
//   ccu_log.jsonl     — one JSON line per poll cycle (the raw time series)
//   ccu_roster.json   — rolling registry: every name ever seen + first/last/count/rooms
//
// Deps: Node built-ins only (https, fs, path). No npm install needed.

const https = require("https");
const fs = require("fs");
const path = require("path");

// ─── Config ──────────────────────────────────────────────────────────────────

const CONFIG = {
  host: "game.defenseoftheagents.com",
  rooms: (process.env.ROOMS || "1,2,3,4,5").split(",").map(s => parseInt(s.trim(), 10)),
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL || "60000", 10),
  lobbyCap: parseInt(process.env.LOBBY_CAP || "20", 10),
  filledThreshold: parseFloat(process.env.FILLED_THRESHOLD || "0.6"), // >=60% = "filled"
  reqTimeoutMs: 10000,
};

// Railway volume if present, else local dir — matches agent.js persistence pattern.
const DATA_DIR = fs.existsSync("/app/data") ? "/app/data" : __dirname;
const LOG_FILE = path.join(DATA_DIR, "ccu_log.jsonl");
const ROSTER_FILE = path.join(DATA_DIR, "ccu_roster.json");

// ─── HTTP ────────────────────────────────────────────────────────────────────

function getRoom(room) {
  return new Promise((resolve) => {
    const req = https.request(
      { hostname: CONFIG.host, path: `/api/game/state?game=${room}`, method: "GET" },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          if (res.statusCode !== 200) return resolve({ room, ok: false, status: res.statusCode });
          try { resolve({ room, ok: true, state: JSON.parse(data) }); }
          catch (e) { resolve({ room, ok: false, status: res.statusCode, err: "parse" }); }
        });
      }
    );
    req.on("error", (e) => resolve({ room, ok: false, err: e.message }));
    req.setTimeout(CONFIG.reqTimeoutMs, () => { req.destroy(); resolve({ room, ok: false, err: "timeout" }); });
    req.end();
  });
}

// ─── Per-room snapshot → compact record ──────────────────────────────────────

function summarizeRoom(res) {
  if (!res.ok) return { room: res.room, ok: false, reason: res.status || res.err };
  const s = res.state;
  const heroes = s.heroes || [];
  const roster = s.agents || { human: [], orc: [] };
  const names = [
    ...(roster.human || []).map(n => ({ n, f: "human" })),
    ...(roster.orc || []).map(n => ({ n, f: "orc" })),
  ];
  const count = names.length || heroes.length;
  // Match progress proxy: lowest base HP% across factions (lower = later game).
  const bases = s.bases || {};
  const baseHps = Object.values(bases)
    .filter(b => b && b.maxHp > 0)
    .map(b => b.hp / b.maxHp);
  const minBasePct = baseHps.length ? Math.min(...baseHps) : null;
  const towers = s.towers || [];
  return {
    room: res.room,
    ok: true,
    tick: s.tick ?? null,
    winner: s.winner ?? null,
    count,
    fill: +(count / CONFIG.lobbyCap).toFixed(3),
    factions: { human: (roster.human || []).length, orc: (roster.orc || []).length },
    names, // [{n,f}] — feeds the operator presence log
    minBasePct: minBasePct != null ? +minBasePct.toFixed(3) : null,
    towersAlive: towers.filter(t => t.alive).length,
    towersTotal: towers.length,
  };
}

// ─── Roster registry (operator-level intelligence) ───────────────────────────

function loadRoster() {
  try { return fs.existsSync(ROSTER_FILE) ? JSON.parse(fs.readFileSync(ROSTER_FILE, "utf-8")) : {}; }
  catch { return {}; }
}

function updateRoster(roster, cycle) {
  roster.__meta = roster.__meta || { firstCycle: cycle.ts, cycles: 0 };
  roster.__meta.cycles++;
  roster.__meta.lastCycle = cycle.ts;
  for (const room of cycle.rooms) {
    if (!room.ok) continue;
    for (const { n, f } of room.names) {
      const e = roster[n] || {
        firstSeen: cycle.ts, lastSeen: cycle.ts, seen: 0,
        rooms: {}, factions: {},
      };
      e.lastSeen = cycle.ts;
      e.seen++;
      e.rooms[room.room] = (e.rooms[room.room] || 0) + 1;
      e.factions[f] = (e.factions[f] || 0) + 1;
      roster[n] = e;
    }
  }
  return roster;
}

// ─── One poll cycle ──────────────────────────────────────────────────────────

async function pollOnce() {
  const results = await Promise.all(CONFIG.rooms.map(getRoom));
  const rooms = results.map(summarizeRoom);
  const live = rooms.filter(r => r.ok);
  const totalCCU = live.reduce((a, r) => a + r.count, 0);
  const activeRooms = live.filter(r => r.count > 0).length;
  const filledLobbies = live.filter(r => r.fill >= CONFIG.filledThreshold).length;
  const cycle = {
    ts: new Date().toISOString(),
    totalCCU,
    roomsLive: live.length,
    activeRooms,
    filledLobbies,
    maxFill: live.length ? Math.max(...live.map(r => r.fill)) : 0,
    rooms,
  };

  // Append raw time series (durable, one line per cycle)
  fs.appendFileSync(LOG_FILE, JSON.stringify(cycle) + "\n");

  // Update operator registry
  const roster = updateRoster(loadRoster(), cycle);
  fs.writeFileSync(ROSTER_FILE, JSON.stringify(roster, null, 2));

  const roomStr = live.map(r => `r${r.room}:${r.count}`).join(" ");
  log(`CCU=${totalCCU} | active ${activeRooms}/${live.length} rooms | filled ${filledLobbies} | maxFill ${Math.round(cycle.maxFill * 100)}% | [${roomStr}]`);
  return cycle;
}

// ─── Report ──────────────────────────────────────────────────────────────────

function pct(arr, p) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}
function median(arr) { return pct(arr, 50); }

function report() {
  if (!fs.existsSync(LOG_FILE)) { console.log("No ccu_log.jsonl yet — run the poller first."); return; }
  const cycles = fs.readFileSync(LOG_FILE, "utf-8").trim().split("\n").filter(Boolean).map(JSON.parse);
  if (!cycles.length) { console.log("Log is empty."); return; }

  const ccu = cycles.map(c => c.totalCCU);
  const first = new Date(cycles[0].ts), last = new Date(cycles[cycles.length - 1].ts);
  const spanH = (last - first) / 3.6e6;

  console.log("═══ DOTA CCU / Operator Report ═══");
  console.log(`Cycles: ${cycles.length} | Span: ${spanH.toFixed(1)}h (${first.toISOString().slice(0,16)} → ${last.toISOString().slice(0,16)})`);
  console.log(`\nConcurrency (total CCU across rooms):`);
  console.log(`  min ${Math.min(...ccu)} | median ${median(ccu)} | p90 ${pct(ccu,90)} | max ${Math.max(...ccu)}`);

  // Filled-lobby rate (re-rate trigger: median filled-lobby rate > 0 & rising)
  const filledCycles = cycles.filter(c => c.filledLobbies > 0).length;
  const maxFills = cycles.map(c => c.maxFill);
  console.log(`\nLobby fill (cap ${CONFIG.lobbyCap}, "filled" = ${Math.round(CONFIG.filledThreshold*100)}%):`);
  console.log(`  median maxFill ${Math.round(median(maxFills)*100)}% | p90 ${Math.round(pct(maxFills,90)*100)}% | cycles w/ a filled lobby: ${filledCycles}/${cycles.length} (${(filledCycles/cycles.length*100).toFixed(1)}%)`);

  // Hourly CCU average — the trend line
  const byHour = {};
  for (const c of cycles) {
    const h = c.ts.slice(0, 13);
    (byHour[h] = byHour[h] || []).push(c.totalCCU);
  }
  const hours = Object.keys(byHour).sort();
  if (hours.length > 1) {
    console.log(`\nHourly avg CCU (last ${Math.min(12, hours.length)}h):`);
    for (const h of hours.slice(-12)) {
      const avg = byHour[h].reduce((a, b) => a + b, 0) / byHour[h].length;
      console.log(`  ${h}:00  ${"█".repeat(Math.round(avg))} ${avg.toFixed(1)}`);
    }
  }

  // Operator analysis from roster
  if (fs.existsSync(ROSTER_FILE)) {
    const roster = JSON.parse(fs.readFileSync(ROSTER_FILE, "utf-8"));
    const totalCycles = (roster.__meta && roster.__meta.cycles) || cycles.length;
    const ops = Object.entries(roster).filter(([k]) => k !== "__meta");
    const withRatio = ops.map(([name, e]) => {
      // presence ratio = seen / cycles elapsed since first appearance
      const firstIdx = cycles.findIndex(c => c.ts >= e.firstSeen);
      const window = Math.max(1, totalCycles - Math.max(0, firstIdx));
      return { name, seen: e.seen, ratio: e.seen / window, rooms: Object.keys(e.rooms).length, first: e.firstSeen, last: e.lastSeen };
    }).sort((a, b) => b.ratio - a.ratio);

    const persistent = withRatio.filter(o => o.ratio >= 0.7);   // ~always-on = agents
    const transient = withRatio.filter(o => o.ratio < 0.7);
    console.log(`\nOperators (unique names ever seen): ${ops.length}`);
    console.log(`  persistent (>=70% presence, ~always-on agents): ${persistent.length}`);
    console.log(`  transient  (<70%, human / MMR-farm / intermittent): ${transient.length}`);

    // New entrants: first seen in the most recent 24h vs prior
    const cutoff = new Date(last - 24 * 3.6e6).toISOString();
    const newOps = withRatio.filter(o => o.first >= cutoff);
    console.log(`  new operators in last 24h: ${newOps.length}${newOps.length ? " — " + newOps.map(o=>o.name).join(", ") : ""}`);

    console.log(`\nTop operators by presence ratio:`);
    for (const o of withRatio.slice(0, 15)) {
      console.log(`  ${(o.ratio*100).toFixed(0).padStart(3)}%  ${o.name.padEnd(20)} seen ${o.seen}x, ${o.rooms} room(s)`);
    }
    if (spanH < 2) console.log(`\n⚠ Span <2h — presence ratios and new-entrant counts need days of data to be meaningful.`);
  }
}

// ─── Utils / main ────────────────────────────────────────────────────────────

function log(msg) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

async function runForever() {
  log(`CCU poller starting — rooms [${CONFIG.rooms.join(",")}], every ${CONFIG.pollIntervalMs/1000}s → ${LOG_FILE}`);
  while (true) {
    try { await pollOnce(); } catch (e) { log(`poll error: ${e.message}`); }
    await new Promise(r => setTimeout(r, CONFIG.pollIntervalMs));
  }
}

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));

const arg = process.argv[2];
if (arg === "--report") report();
else if (arg === "--once") pollOnce().then(() => process.exit(0));
else runForever();
