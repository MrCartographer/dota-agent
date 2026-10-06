// MrCartographer - Defense of the Agents AI Agent
// Strategy: Adaptive class (melee/mage/ranged), adaptive lane, tower-aware
// Hybrid architecture: REST polling backbone + WebSocket reflex layer
//   - REST: handles deployment, re-joining games, lane switching, tower monitoring
//   - WebSocket: real-time HP monitoring for instant recall, fast ability picks

const https = require("https");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const WebSocket = require("ws");
const { privateKeyToAccount } = require("viem/accounts");

// ─── Configuration ───────────────────────────────────────────────────────────

const HISTORY_BLOB_ID = "019ef0d0-a58f-7b40-9aaa-3114baa165f6";
const HISTORY_BLOB_URL = `https://jsonblob.com/api/jsonBlob/${HISTORY_BLOB_ID}`;

const CONFIG = {
  agentName: process.env.AGENT_NAME || "MrCartographer",
  apiKey: process.env.API_KEY, // Register at https://defenseoftheagents.com/agent to get a key
  // Migrated 2026-06-08: old DigitalOcean host went NXDOMAIN, game moved to
  // game.defenseoftheagents.com (per skill.md). Auth + API shape unchanged.
  baseUrl: "game.defenseoftheagents.com",
  wsUrl: "wss://game.defenseoftheagents.com",
  gameRoom: parseInt(process.env.GAME_ROOM || "3", 10),
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL || "3000", 10),
  // Season 3 (2026-07-03): dropped ranged entirely.
  // S3 first-week data (n=124): mage 44% WR, ranged 15–29% WR.
  // Mage:top best (47%), mage:bot 45%, mage:mid 43%. Ranged bad across all lanes.
  heroClasses: ["mage"],
  heroLane: "mid",  // Default — overridden by adaptive lane selection
  walletPrivateKey: process.env.WALLET_PRIVATE_KEY || null,
};

// ─── Strategy Constants ──────────────────────────────────────────────────────

// Skin-to-class mapping.
// Season 3 v93 (2026-07-03): 'throne_of_bones' is FREE for everyone. It replaces
// Fury with Skeleton Archer (summons up to N archer pets that follow + shoot).
// We trade Ring of Healing (from pixagreen_mage) for lane-pressure summons.
// Rationale: mage:mid dropped to 43% in early S3; adding summons increases
// last-hit throughput → more XP → higher level → more wins.
const SKIN_MAP = {
  mage:   "throne_of_bones",  // FREE. Replaces Fury → Skeleton Archer summons
  ranged: "centaur",           // FREE. Replaces Fortitude → Bramble Patch (heal+slow)
                               // ranged disabled in heroClasses; kept for future
  // melee: no skin owned — uses default
};

// Per user preference: prefer active/multiplicative abilities (summons, AOE, disables)
// over flat % stat boosts. Fury & Fortitude removed from priority lists — if they're
// the ONLY options offered, the fallback at chooseAbility() will still pick one.
const ABILITY_PRIORITY = {
  melee: [
    "divine_shield",   // Damage-immunity shield on first hit — huge survivability
    "cleave",          // AOE splash on every attack — best wave clear
    "thorns",          // Reflects physical damage — passive punish
  ],
  mage: [
    "fury",            // Throne of Bones skin: `fury` renders as Skeleton Archer —
                       // summons up to 3 persistent archer pets that follow + shoot.
                       // NOT a plain +damage% pick with this skin.
    "fireball",        // Auto-cast 40/65/90 AOE burst, 4s cd (3.6s w/ Yerba)
    "tornado",         // AOE damage + knockback zone control
    "raise_skeleton",  // Summoned skeleton warrior, 150/210/270 HP
  ],
  ranged: [
    "bloodlust",       // Auto-activate 2× atk speed on first hit, 5/6/7s
    "volley",          // Multi-arrow AOE per shot
    "critical_strike", // Crit chance per arrow — scales with attack speed
  ],
};

// Class-specific lane weights for first deploy. Values are relative — each
// lane's chance = weight / sum(weights). Mage weights come from S3 WR:
// top 64.8%, bot 65.5%, mid 42% (n=3,661). Skewing toward off-lanes without
// abandoning mid entirely, since mid tower still needs presence.
const LANE_WEIGHTS = {
  mage:   { top: 40, mid: 20, bot: 40 },
  ranged: { top: 40, mid: 20, bot: 40 },  // dormant — heroClasses is mage-only
  melee:  { top: 33, mid: 34, bot: 33 },  // no data; keep balanced
};

function pickLaneByWeights(heroClass) {
  const w = LANE_WEIGHTS[heroClass] || LANE_WEIGHTS.mage;
  const total = w.top + w.mid + w.bot;
  const roll = Math.random() * total;
  if (roll < w.top) return "top";
  if (roll < w.top + w.mid) return "mid";
  return "bot";
}

// Current game's class and lane — set at deploy, may change mid-game
let currentHeroClass = null;
let currentLane = "mid";

// Class-specific recall thresholds
// Mage is squishy (140 HP), recall early. Melee is tanky (266 HP), stay longer.
const RECALL_THRESHOLDS = {
  melee:  { early: 0.40, late: 0.25, levelBonus: 0.02, maxThreshold: 0.55 },
  ranged: { early: 0.35, late: 0.20, levelBonus: 0.02, maxThreshold: 0.45 },  // Stay longer — stim_pack costs HP, don't recall too early
  mage:   { early: 0.60, late: 0.40, levelBonus: 0.02, maxThreshold: 0.65 },
};

const EARLY_GAME_TICKS = 20 * 120; // First 2 minutes

// Lane evaluation interval (every 10 REST loops = ~30s)
const LANE_EVAL_INTERVAL = 10;
let lastLaneEvalLoop = 0;

// ─── State ───────────────────────────────────────────────────────────────────

let hasDeployed = false;
let loopCount = 0;
let lastGameId = null;
let waitingForSlot = false;
let scrambling = false;
let gameRecorded = false; // Prevent recording same game twice
let lastRecordedTick = null; // Dedup: skip if same tick as last recorded game
let lastScoreboard = [];  // Cache latest WS scoreboard for game history

// Use Railway volume (/app/data) if it exists, otherwise fall back to local dir
const DATA_DIR = fs.existsSync("/app/data") ? "/app/data" : __dirname;
const HISTORY_FILE = path.join(DATA_DIR, "game_history.json");

// WebSocket state
let ws = null;
let wsConnected = false;
let wsAuthenticated = false;
let wsReconnectTimer = null;
let lastWsRecallTick = 0;     // Prevent recall spam: track last recall tick
let lastWsAbilityTick = 0;    // Prevent ability spam
let currentTick = 0;          // Latest tick from WS
let recallNotBefore = 0;      // Wall-clock ms; set from server warning when recall on cooldown
let sprintNotBefore = 0;      // Wall-clock ms; sprint has 25s server cooldown
let strollNotBefore = 0;      // Wall-clock ms; stroll has 25s server cooldown
let lastChoiceSig = "";       // Dedup ability-choices log so we only log distinct sets

// ─── HTTP Helpers ────────────────────────────────────────────────────────────

function httpGet(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: CONFIG.baseUrl,
      path: path,
      method: "GET",
      headers: { "Content-Type": "application/json" },
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`Failed to parse response: ${data}`)); }
      });
    });
    req.on("error", reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error("Request timeout")); });
    req.end();
  });
}

function httpPost(path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const options = {
      hostname: CONFIG.baseUrl,
      path: path,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${CONFIG.apiKey}`,
        "Content-Length": Buffer.byteLength(payload),
      },
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on("error", reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error("Request timeout")); });
    req.write(payload);
    req.end();
  });
}

// ─── Strategy Logic ──────────────────────────────────────────────────────────

function chooseAbility(hero) {
  if (!hero.abilityChoices || hero.abilityChoices.length === 0) return null;

  const currentAbilities = {};
  for (const ab of hero.abilities || []) {
    currentAbilities[ab.id] = ab.level;
  }

  const priority = ABILITY_PRIORITY[currentHeroClass] || ABILITY_PRIORITY.melee;
  for (const abilityId of priority) {
    if (hero.abilityChoices.includes(abilityId)) {
      const currentLevel = currentAbilities[abilityId] || 0;
      if (currentLevel < 4) return abilityId;
    }
  }

  return hero.abilityChoices[0];
}

function getRecallThreshold(tick, level) {
  const classThresholds = RECALL_THRESHOLDS[currentHeroClass] || RECALL_THRESHOLDS.ranged;
  let threshold = tick < EARLY_GAME_TICKS
    ? classThresholds.early
    : classThresholds.late;

  if (level > 5) {
    threshold += (level - 5) * classThresholds.levelBonus;
    threshold = Math.min(threshold, classThresholds.maxThreshold);
  }
  return threshold;
}

function shouldRecall(hero, tick) {
  if (!hero.alive) return false;
  if (hero.maxHp <= 0) return false;

  // REST `/api/game/state` returns recallCooldownMs:null, so server warnings
  // are our only ground truth — honor them via recallNotBefore.
  if (Date.now() < recallNotBefore) return false;
  if ((hero.recallCooldownMs || 0) > 0) return false;

  // If we have ability-level cooldown data (WS), check recall ability specifically
  if (hero.abilities) {
    const recallAbility = hero.abilities.find(a => a.id === "recall");
    if (recallAbility && (recallAbility.cooldownRemaining || 0) > 0) return false;
  }

  const hpPercent = hero.hp / hero.maxHp;
  const threshold = getRecallThreshold(tick, hero.level || 1);
  return hpPercent < threshold;
}

// Sprint: 200% speed for 5s, 25s cooldown. Use it when allies are massing in
// our lane — get to the group push faster so we're not late to the teamfight.
const SPRINT_ALLY_THRESHOLD = 3;
function shouldSprint(hero, gameState) {
  if (!hero || !hero.alive) return false;
  if (Date.now() < sprintNotBefore) return false;
  const allies = (gameState.heroes || []).filter(h =>
    h.name !== CONFIG.agentName &&
    h.faction === hero.faction &&
    h.lane === hero.lane &&
    h.alive !== false
  );
  return allies.length >= SPRINT_ALLY_THRESHOLD;
}

// Stroll intentionally NOT used. Per llms.txt it's a 50% forward-pace tool
// (for letting allies engage first / holding lane equilibrium), not a retreat.
// At low HP with recall on cd, slowing forward motion just keeps us exposed.
// strollNotBefore / warning-parser still track server responses defensively.

function generateMessage(hero, tick, action) {
  const minutes = Math.floor(tick / 20 / 60);
  const level = hero ? hero.level : 1;
  if (action === "recall") return `Recalling at ${hero ? Math.round((hero.hp / hero.maxHp) * 100) : "?"}% HP`;
  if (minutes < 2) return `Early game. ${currentLane} lane. Lv${level}`;
  return `${currentLane} lane. Lv${level} | ${minutes}m in`;
}

// ─── Lane Selection ─────────────────────────────────────────────────────────
// Strategy: Join the strongest allied push. Only switch lanes for dragon push
// or after dying/recalling (never mid-fight — sending deployment resets combat).

function chooseLane(gameState) {
  const heroes = gameState.heroes || [];
  const towers = gameState.towers || [];
  const lanes = gameState.lanes || {};
  const myHero = heroes.find(h => h.name === CONFIG.agentName);
  const ourFaction = myHero ? myHero.faction : null;

  // If we don't know our faction yet, go mid (safest default)
  if (!ourFaction) {
    log("[Lane] First deploy — defaulting to mid");
    return "mid";
  }

  // Count allied heroes per lane
  const allyHeroes = { top: 0, mid: 0, bot: 0 };
  heroes.forEach(h => {
    if (h.name !== CONFIG.agentName && h.faction === ourFaction) {
      allyHeroes[h.lane] = (allyHeroes[h.lane] || 0) + 1;
    }
  });

  // Get our unit strength per lane (frontline > 0 means we're pushing)
  const laneStrength = {};
  for (const lane of ["top", "mid", "bot"]) {
    const l = lanes[lane] || { human: 0, orc: 0, frontline: 0 };
    const ourUnits = ourFaction === "human" ? l.human : l.orc;
    const theirUnits = ourFaction === "human" ? l.orc : l.human;
    // Frontline: positive = human pushing, negative = orc pushing
    const pushing = ourFaction === "human" ? l.frontline > 0 : l.frontline < 0;
    laneStrength[lane] = {
      ourUnits, theirUnits, pushing,
      advantage: ourUnits - theirUnits,
      allyHeroes: allyHeroes[lane] || 0,
    };
  }

  // Score each lane (higher = better to join)
  // Class-specific lane bias based on 5,774 games of data:
  //   Historical data showed ranged:mid 32.8%, mage:mid 44.0% — mid is where
  //   the most competition is. Side lanes outperform. Small bias to spread.
  const LANE_BIAS = {
    ranged: { top: 2, mid: 0, bot: 2 },     // Side lanes historically better for ranged
    mage:   { top: 1, mid: 1, bot: 1 },     // Mage does well anywhere, slight preference for diversity
    melee:  { top: 0, mid: 0, bot: 0 },     // Retired
  };
  const classBias = LANE_BIAS[currentHeroClass] || LANE_BIAS.ranged;

  const scores = {};
  for (const lane of ["top", "mid", "bot"]) {
    let score = classBias[lane] || 0;
    const ls = laneStrength[lane];

    // Join lanes where our team is strong — push together
    score += ls.allyHeroes * 3;       // Allied heroes = good, but don't overweight
    score += ls.advantage * 2;         // Unit advantage = lane is winning
    if (ls.pushing) score += 2;        // Already pushing forward

    // Bonus for enemy towers we can hit
    const enemyTower = towers.find(t => t.lane === lane && t.faction !== ourFaction);
    if (enemyTower && enemyTower.alive) {
      const towerPct = enemyTower.hp / enemyTower.maxHp;
      if (towerPct < 0.3) score += 15;   // Tower almost down — big pull
      else if (towerPct < 0.6) score += 5; // Tower weakened
    }
    if (enemyTower && !enemyTower.alive) {
      score -= 10; // Tower already down, no reason to be here
    }

    scores[lane] = score;
  }

  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const best = sorted[0][0];

  log(`[Lane] Scores: top=${scores.top}, mid=${scores.mid}, bot=${scores.bot} → ${best} (allies: t=${allyHeroes.top||0} m=${allyHeroes.mid||0} b=${allyHeroes.bot||0})`);
  return best;
}

// Only called for dragon push (emergency lane switch).
// Returns a lane ONLY if we absolutely must switch, otherwise null.
function checkDragonPush(gameState) {
  const towers = gameState.towers || [];
  const myHero = (gameState.heroes || []).find(h => h.name === CONFIG.agentName);
  if (!myHero) return null;

  const enemyTowersAlive = towers.filter(t => t.faction !== myHero.faction && t.alive);

  // DRAGON PUSH: Only 1 enemy tower left — ALL IN
  if (enemyTowersAlive.length === 1) {
    const lastTower = enemyTowersAlive[0];
    if (currentLane !== lastTower.lane) {
      log(`[Lane] DRAGON PUSH! Last enemy tower in ${lastTower.lane} (${lastTower.hp}/${lastTower.maxHp} HP). Switching!`);
      return lastTower.lane;
    }
  }

  return null;
}

// ─── Game History ───────────────────────────────────────────────────────────
// Records results after each game for performance tracking.
// Saves to game_history.json and logs a summary to console.

function recordGameResult(gameState) {
  let gameResult = null;
  try {
    // Use cached WS scoreboard (has kills, deaths, assists, damage, mmr)
    // Fall back to REST heroes array (basic info only)
    const wsMe = lastScoreboard.find(h => h.name === CONFIG.agentName);
    const restMe = (gameState.heroes || []).find(h => h.name === CONFIG.agentName);
    const myHero = wsMe || restMe;

    gameResult = {
      timestamp: new Date().toISOString(),
      gameRoom: CONFIG.gameRoom,
      winner: gameState.winner,
      ticksPlayed: gameState.tick || 0,
      durationEstimate: `${Math.round((gameState.tick || 0) / 20 / 60)}m`,
      myHero: myHero ? {
        name: myHero.name,
        faction: myHero.faction,
        heroClass: myHero.heroClass || myHero.class,
        lane: myHero.lane,
        level: myHero.level,
        kills: myHero.kills || 0,
        deaths: myHero.deaths || 0,
        assists: myHero.assists || 0,
        totalDamage: myHero.totalDamage || 0,
        mmr: myHero.mmr || null,
        rankedWins: myHero.rankedWins || null,
        rankedLosses: myHero.rankedLosses || null,
        abilities: (myHero.abilities || []).map(a => ({ id: a.id, level: a.level })),
        won: myHero.faction === gameState.winner,
        dataSource: wsMe ? "websocket" : "rest",
      } : null,
      strategy: {
        heroClass: currentHeroClass,
        heroLane: currentLane,
        abilityPriority: (ABILITY_PRIORITY[currentHeroClass] || ABILITY_PRIORITY.melee).slice(),
        recallThresholds: RECALL_THRESHOLDS[currentHeroClass] || RECALL_THRESHOLDS.ranged,
      },
      scoreboard: lastScoreboard.length > 0
        ? lastScoreboard.map(h => ({
            name: h.name,
            faction: h.faction,
            heroClass: h.heroClass,
            lane: h.lane,
            level: h.level,
            kills: h.kills || 0,
            deaths: h.deaths || 0,
            assists: h.assists || 0,
            totalDamage: h.totalDamage || 0,
            isAI: h.isAI,
            mmr: h.mmr,
            skin: h.skin || null,
            item: h.item || null,
            accountXp: h.accountXp || 0,
          }))
        : (gameState.heroes || []).map(h => ({
            name: h.name,
            faction: h.faction,
            heroClass: h.class,
            lane: h.lane,
            level: h.level,
          })),
    };

    // Load existing history or start fresh
    let history = [];
    try {
      if (fs.existsSync(HISTORY_FILE)) {
        history = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf-8"));
      }
    } catch (e) {
      log(`[History] Could not read existing history, starting fresh: ${e.message}`);
    }

    history.push(gameResult);
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));

    // Log summary
    const won = myHero ? (myHero.faction === gameState.winner ? "WIN" : "LOSS") : "NOT IN GAME";
    const kda = myHero ? `${myHero.kills || 0}/${myHero.deaths || 0}/${myHero.assists || 0}` : "N/A";
    const dmg = myHero ? (myHero.totalDamage || 0) : 0;
    const level = myHero ? myHero.level : "?";
    const record = myHero ? `${myHero.rankedWins || 0}W-${myHero.rankedLosses || 0}L` : "N/A";
    const src = myHero ? (wsMe ? "WS" : "REST") : "";

    log("╔══════════════════════════════════════════╗");
    log("║          GAME RESULT RECORDED            ║");
    log("╠══════════════════════════════════════════╣");
    log(`║  Result:    ${won.padEnd(29)}║`);
    log(`║  Class:     ${(currentHeroClass || "?").padEnd(29)}║`);
    log(`║  KDA:       ${kda.padEnd(29)}║`);
    log(`║  Damage:    ${String(dmg).padEnd(29)}║`);
    log(`║  Level:     ${String(level).padEnd(29)}║`);
    log(`║  Duration:  ${gameResult.durationEstimate.padEnd(29)}║`);
    log(`║  Record:    ${record.padEnd(29)}║`);
    log(`║  Source:    ${src.padEnd(29)}║`);
    log(`║  Game #${String(history.length).padEnd(33)}║`);
    log("╚══════════════════════════════════════════╝");

  } catch (err) {
    log(`[History] Error recording game: ${err.message}`);
    // Non-fatal — don't let history recording break the game loop
  }

  // Sync to cloud (non-blocking)
  if (gameResult) {
    syncToCloud(gameResult).catch(err => {
      log(`[Cloud] Sync failed: ${err.message}`);
    });
  }
}

// ─── Cloud Sync ─────────────────────────────────────────────────────────────
// Persists game results to jsonblob.com so they survive Railway redeploys.
// GET current history → append new result → PUT it back.

function cloudRequest(method, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(HISTORY_BLOB_URL);
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method,
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
    };
    if (payload) options.headers["Content-Length"] = Buffer.byteLength(payload);

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on("error", reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error("Cloud request timeout")); });
    if (payload) req.write(payload);
    req.end();
  });
}

async function syncToCloud(gameResult) {
  // GET current history
  const current = await cloudRequest("GET");
  const history = Array.isArray(current.body) ? current.body : [];

  // Append new result (slim version — just what we need for stats)
  history.push({
    timestamp: gameResult.timestamp,
    winner: gameResult.winner,
    duration: gameResult.durationEstimate,
    won: gameResult.myHero ? gameResult.myHero.won : null,
    faction: gameResult.myHero ? gameResult.myHero.faction : null,
    heroClass: gameResult.strategy.heroClass,
    lane: gameResult.myHero ? gameResult.myHero.lane : gameResult.strategy.heroLane,
    level: gameResult.myHero ? gameResult.myHero.level : null,
    kills: gameResult.myHero ? gameResult.myHero.kills : 0,
    deaths: gameResult.myHero ? gameResult.myHero.deaths : 0,
    assists: gameResult.myHero ? gameResult.myHero.assists : 0,
    totalDamage: gameResult.myHero ? gameResult.myHero.totalDamage : 0,
    mmr: gameResult.myHero ? gameResult.myHero.mmr : null,
  });

  // PUT updated history
  const result = await cloudRequest("PUT", history);
  if (result.status === 200) {
    log(`[Cloud] Synced game #${history.length} to cloud storage.`);
  } else {
    log(`[Cloud] Sync failed (${result.status}): ${JSON.stringify(result.body)}`);
  }
}

// ─── WebSocket Scoreboard Parser ────────────────────────────────────────────
// WS sends heroScoreboard entries as arrays, not objects. This converts them.

const FACTION_MAP = { 0: "human", 1: "orc" };
const CLASS_MAP = { 0: "melee", 1: "ranged", 2: "mage" };
const LANE_MAP = { 0: "top", 1: "mid", 2: "bot" };

// Canonical schema pulled from live game bundle (main-*.js scoreboard parser).
// Verified 2026-07-20 — several indices we had before were wrong (recallCooldownMs
// was reading colorIndex, abilityChoices was reading pfpUrl, totalDamage was
// reading recallCooldownMs). That explains the recall thrash + dead WS reflexes.
function parseScoreboardEntry(entry) {
  if (!Array.isArray(entry)) return entry;
  return {
    name: entry[0],
    faction: FACTION_MAP[entry[1]] || String(entry[1]),
    heroClass: CLASS_MAP[entry[2]] || String(entry[2]),
    lane: LANE_MAP[entry[3]] || String(entry[3]),
    level: entry[4],
    xp: entry[5],
    xpToNext: entry[6],
    hp: entry[7],
    maxHp: entry[8],
    damage: entry[9],             // attack damage per hit (not cumulative)
    alive: entry[10] === 1,
    respawnTimer: entry[11],
    // [12] colorIndex — skip
    abilities: (entry[13] || []).map(a => ({
      id: a[0],
      level: a[1],
      cooldownRemaining: a[2] > 0 ? a[2] : 0,
    })),
    // [14] pfpUrl · [15] profileUrl — skip
    recallCooldownMs: entry[16] > 0 ? entry[16] : 0,
    // [17] packed bit flags (tokenHolder | isAI | ringOfRegen) — skip
    totalDamage: entry[18] > 0 ? entry[18] : 0,
    abilityChoices: entry[19] || null,
    mmr: entry[20] || null,
    rankedWins: entry[21] || null,
    rankedLosses: entry[22] || null,
    skin: entry[23] || null,
    rank: entry[24] || null,
    kills: entry[25] || 0,
    deaths: entry[26] || 0,
    assists: entry[27] || 0,
    item: entry[28] || null,
    // [29-31] rat_skull / soul_harvest stacks
    sprintRemainingMs: entry[32] || 0,
    sprintCooldownMs: entry[33] || 0,
    strollRemainingMs: entry[34] || 0,
    strollCooldownMs: entry[35] || 0,
    accountXp: entry[39] || 0,
    charmCooldownMs: entry[40] || 0,
  };
}

function parseScoreboard(rawScoreboard) {
  return (rawScoreboard || []).map(parseScoreboardEntry);
}

// ─── WebSocket Reflex Layer ──────────────────────────────────────────────────
// Monitors real-time game state for two things:
//   1. HP drops below recall threshold → instant recall via WS action
//   2. Ability choices appear → instant pick via REST deployment

function connectWebSocket() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return; // Already connected or connecting
  }

  const url = `${CONFIG.wsUrl}/?game=${CONFIG.gameRoom}`;
  log(`[WS] Connecting to ${url}...`);

  ws = new WebSocket(url);

  ws.on("open", () => {
    wsConnected = true;
    log("[WS] Connected. Authenticating...");
    ws.send(JSON.stringify({ type: "auth", token: CONFIG.apiKey }));
    wsAuthenticated = true;
    log("[WS] Authenticated. Reflex layer active.");
  });

  ws.on("message", (raw) => {
    if (!hasDeployed) return; // Don't react if we haven't deployed yet

    try {
      // Post-migration server (v90+) sends gzip-compressed JSON to save ~66% bandwidth.
      // Detect the gzip magic bytes (1F 8B) and decompress before parsing.
      let text;
      if (Buffer.isBuffer(raw) && raw.length > 2 && raw[0] === 0x1f && raw[1] === 0x8b) {
        text = zlib.gunzipSync(raw).toString("utf8");
      } else {
        text = typeof raw === "string" ? raw : raw.toString("utf8");
      }
      const snapshot = JSON.parse(text);
      currentTick = snapshot.tick || currentTick;

      // Parse scoreboard arrays into objects
      const scoreboard = parseScoreboard(snapshot.heroScoreboard);
      if (scoreboard.length > 0) lastScoreboard = scoreboard; // Cache for game history
      const myEntry = scoreboard.find(h => h.name === CONFIG.agentName);

      if (!myEntry) return; // Not in this game

      // ── REFLEX 1: Instant recall ──
      if (myEntry.alive && myEntry.maxHp > 0) {
        const hpPct = myEntry.hp / myEntry.maxHp;
        const threshold = getRecallThreshold(snapshot.tick, myEntry.level || 1);
        const recallReady = (myEntry.recallCooldownMs || 0) <= 0;

        // Also check abilities array for recall cooldown
        let recallAbilityCooldown = false;
        if (myEntry.abilities) {
          const recallAb = myEntry.abilities.find(a => a.id === "recall");
          if (recallAb && (recallAb.cooldownRemaining || 0) > 0) recallAbilityCooldown = true;
        }

        if (hpPct < threshold && recallReady && !recallAbilityCooldown) {
          // Don't spam — only recall if we haven't in the last 5 seconds (100 ticks)
          if (snapshot.tick - lastWsRecallTick > 100) {
            lastWsRecallTick = snapshot.tick;
            ws.send(JSON.stringify({ type: "recall" }));
            log(`[WS] INSTANT RECALL! HP: ${myEntry.hp}/${myEntry.maxHp} (${Math.round(hpPct * 100)}%) — threshold was ${Math.round(threshold * 100)}%`);
          }
        }
      }

      // ── REFLEX 2: Instant ability pick ──
      if (myEntry.abilityChoices && myEntry.abilityChoices.length > 0) {
        // Diagnostic: log every distinct choice set so we can verify skins
        // (stim_pack / ring_of_healing) are actually being offered server-side.
        const sig = myEntry.abilityChoices.slice().sort().join(",");
        if (sig !== lastChoiceSig) {
          log(`[WS] abilityChoices offered: [${myEntry.abilityChoices.join(", ")}]`);
          lastChoiceSig = sig;
        }
        // Don't spam — only pick if we haven't in the last 3 seconds (60 ticks)
        if (snapshot.tick - lastWsAbilityTick > 60) {
          const pick = chooseAbility(myEntry);
          if (pick) {
            lastWsAbilityTick = snapshot.tick;
            // Ability choice must go through REST (no WS action for it)
            // Do NOT send heroLane — it reassigns the hero and interrupts combat
            httpPost("/api/strategy/deployment", {
              abilityChoice: pick,
            }).then(result => {
              if (result.status === 200) {
                log(`[WS] INSTANT ABILITY: ${pick} (level ${(myEntry.abilities.find(a => a.id === pick)?.level || 0) + 1})`);
              }
            }).catch(() => {}); // Silently fail — REST loop will retry
          }
        }
      }

    } catch (e) {
      // Silently ignore parse errors — WS sends a LOT of frames
    }
  });

  ws.on("close", (code, reason) => {
    wsConnected = false;
    wsAuthenticated = false;
    log(`[WS] Disconnected (code: ${code}). Reconnecting in 5s...`);
    scheduleReconnect(5000);
  });

  ws.on("error", (err) => {
    log(`[WS] Error: ${err.message}`);
    // on("close") will fire after this, which handles reconnect
  });
}

function scheduleReconnect(delayMs) {
  if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
  wsReconnectTimer = setTimeout(() => {
    wsReconnectTimer = null;
    connectWebSocket();
  }, delayMs);
}

function disconnectWebSocket() {
  if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
  if (ws) { ws.terminate(); ws = null; }
  wsConnected = false;
  wsAuthenticated = false;
}

// ─── REST Game Loop (Backbone) ───────────────────────────────────────────────

async function gameLoop() {
  loopCount++;

  try {
    const gameState = await httpGet(`/api/game/state?game=${CONFIG.gameRoom}`);

    const heroCount = (gameState.heroes || []).length;
    const isFull = heroCount >= 20;

    // Game ended — record result, reset, and scramble
    if (gameState.winner) {
      const currentTick = gameState.tick || 0;
      if (!gameRecorded && hasDeployed && currentTick !== lastRecordedTick) {
        recordGameResult(gameState);
        gameRecorded = true;
        lastRecordedTick = currentTick;
      }
      if (hasDeployed || waitingForSlot) {
        log(`Game over! Winner: ${gameState.winner}. Scrambling to join next round...`);
      }
      hasDeployed = false;
      waitingForSlot = false;
      scrambling = true;
      // Reset all state for new game
      lastWsRecallTick = 0;
      lastWsAbilityTick = 0;
      lastScoreboard = [];
      lastLaneEvalLoop = 0;
      currentLane = "mid";
      // gameRecorded stays true until new game starts (tick < 100 or deploy succeeds)
    }

    // Detect game restart
    if (gameState.tick < 100 && hasDeployed) {
      log("New game detected (low tick). Re-deploying...");
      hasDeployed = false;
      waitingForSlot = false;
      scrambling = true;
      gameRecorded = false;
      lastWsRecallTick = 0;
      lastWsAbilityTick = 0;
      lastScoreboard = [];
      lastLaneEvalLoop = 0;
      currentLane = "mid";
    }

    if (hasDeployed) scrambling = false;

    const myHero = (gameState.heroes || []).find(
      (h) => h.name === CONFIG.agentName
    );

    if (!myHero && hasDeployed) hasDeployed = false;
    if (myHero) waitingForSlot = false;

    // Game full and we're not in — wait
    if (isFull && !myHero && !hasDeployed) {
      if (!waitingForSlot) {
        log(`Game is full (${heroCount}/20). Polling every 15s until a slot opens or round ends.`);
        waitingForSlot = true;
      }
      // Disconnect WS while waiting — no point processing frames
      if (wsConnected) {
        log("[WS] Disconnecting while waiting for slot.");
        disconnectWebSocket();
      }
      return;
    }

    // Build deployment — only send when we have something to do
    const deployment = {};
    let shouldSend = false;

    if (!hasDeployed || !myHero) {
      // First deployment — pick class + lane by weighted-random from real S3 WR.
      // Season 3 data (3,700 games): mage top 64.8%, mage bot 65.5%, mage mid 42.0%.
      // We were forcing mid → parking ourselves in our worst lane. Off-lanes win
      // 23 pts more, but keeping some mid presence so the tower doesn't collapse.
      currentHeroClass = CONFIG.heroClasses[Math.floor(Math.random() * CONFIG.heroClasses.length)];
      currentLane = pickLaneByWeights(currentHeroClass);
      deployment.heroClass = currentHeroClass;
      deployment.heroLane = currentLane;
      if (SKIN_MAP[currentHeroClass]) deployment.skin = SKIN_MAP[currentHeroClass];
      deployment.equippedItem = currentHeroClass === "mage" ? "yerba_berserker_mate" : "heavy_morning_star";
      // Mage: Yerba gives ~9% CDR on fireball/tornado/recall/sprint — more value than stun
      // Ranged: Morning Star 12.5% stun per hit synergizes with stim_pack 3× attack speed
      deployment.message = `MrCartographer online. ${currentLane} lane ${currentHeroClass}${SKIN_MAP[currentHeroClass] ? ` [${SKIN_MAP[currentHeroClass]}]` : ""}.`;
      log(`Deploying: ${currentHeroClass}, ${currentLane} lane (${heroCount}/20 players)`);
      shouldSend = true;
    } else {
      // ── Dragon push check (only switch lane for this) ──
      const dragonLane = checkDragonPush(gameState);
      if (dragonLane) {
        currentLane = dragonLane;
        // Dragon push is urgent enough to send a deployment
        deployment.heroLane = currentLane;
        deployment.message = `Dragon push! All in ${currentLane}.`;
        shouldSend = true;
      }

      // No mid-game lane switching — stick to our lane.
      // Only dragon push (above) can move us.

      // Only send if there's an ability to pick or a recall to trigger
      // IMPORTANT: Do NOT include heroLane unless we're intentionally switching lanes.
      // Sending heroLane on every POST reassigns the hero and makes them walk past enemies.
      const abilityPick = chooseAbility(myHero);
      if (abilityPick) {
        deployment.abilityChoice = abilityPick;
        log(`[REST] Choosing ability: ${abilityPick} (level ${(myHero.abilities.find(a => a.id === abilityPick)?.level || 0) + 1})`);
        shouldSend = true;
      }

      // Action priority: recall > sprint. Stroll removed — per llms.txt it's a
      // 50% forward-speed pace tool (for allies to engage first / hold equilibrium),
      // NOT a retreat. Firing it at low HP with recall on cd was leaving us
      // exposed longer instead of pulling us to safety.
      if (shouldRecall(myHero, gameState.tick || 0)) {
        deployment.action = "recall";
        log(`[REST] Recalling! HP: ${myHero.hp}/${myHero.maxHp} (${Math.round((myHero.hp / myHero.maxHp) * 100)}%)`);
        shouldSend = true;
      } else if (shouldSprint(myHero, gameState)) {
        deployment.action = "sprint";
        const allyCount = (gameState.heroes || []).filter(h =>
          h.name !== CONFIG.agentName && h.faction === myHero.faction && h.lane === myHero.lane && h.alive !== false
        ).length;
        log(`[REST] Sprinting to ${myHero.lane} — ${allyCount} allies massed for push`);
        sprintNotBefore = Date.now() + 25 * 1000; // optimistic; server warning will correct
        shouldSend = true;
      }

      if (shouldSend && !deployment.message) {
        deployment.message = generateMessage(myHero, gameState.tick || 0, deployment.action);
      }
    }

    // Only POST if we have a reason to
    if (shouldSend) {
      const result = await httpPost("/api/strategy/deployment", deployment);

      if (result.status === 200) {
        if (!hasDeployed) {
          hasDeployed = true;
          waitingForSlot = false;
          // Only reset gameRecorded when we're in a fresh game (no winner showing)
          if (!gameState.winner) gameRecorded = false;
          lastGameId = result.body.gameId || CONFIG.gameRoom;
          log(`Deployed to game ${lastGameId}!`);

          // Now that we're in, connect WebSocket for real-time reflexes
          if (!wsConnected) connectWebSocket();
        }
        if (result.body.warning) {
          log(`Warning: ${result.body.warning}`);
          // Server says e.g. "Recall on cooldown (43s remaining)." — stash so
          // the matching should*() stops thrashing the endpoint until elapsed.
          const m = /(\w+) on cooldown \((\d+)s/i.exec(result.body.warning);
          if (m) {
            const until = Date.now() + parseInt(m[2], 10) * 1000;
            const which = m[1].toLowerCase();
            if (which === "recall") recallNotBefore = until;
            else if (which === "sprint") sprintNotBefore = until;
            else if (which === "stroll") strollNotBefore = until;
          }
        }
      } else {
        log(`Deployment failed (${result.status}): ${JSON.stringify(result.body)}`);
        if (result.status === 400) { waitingForSlot = true; }
        if (result.status === 429) { log("Rate limited. Will retry next cycle."); }
      }
    } else {
      // Still connect WS if needed (e.g. reconnect after drop)
      if (hasDeployed && !wsConnected) connectWebSocket();
    }

    // Periodic status (every 10 loops ~ 30s)
    if (myHero && loopCount % 10 === 0) {
      const hpPct = myHero.maxHp > 0 ? Math.round((myHero.hp / myHero.maxHp) * 100) : 0;
      const abilities = (myHero.abilities || []).map(a => `${a.id}(${a.level})`).join(", ");
      const wsStatus = wsConnected ? "WS:connected" : "WS:disconnected";
      // Tower summary
      const towers = gameState.towers || [];
      const enemyTowersUp = towers.filter(t => t.faction !== myHero.faction && t.alive).length;
      const ourTowersUp = towers.filter(t => t.faction === myHero.faction && t.alive).length;
      log(`Status: ${currentHeroClass} Lv${myHero.level} | HP: ${hpPct}% | Lane: ${currentLane} | Towers: us ${ourTowersUp}/3 them ${enemyTowersUp}/3 | Abilities: ${abilities || "none"} | ${wsStatus}`);
    }

  } catch (err) {
    log(`Error in game loop: ${err.message}`);
  }
}

// ─── Logging ─────────────────────────────────────────────────────────────────

function log(msg) {
  const timestamp = new Date().toISOString().substring(11, 19);
  console.log(`[${timestamp}] ${msg}`);
}

// ─── Wallet Connect ──────────────────────────────────────────────────────────
// Connects wallet to unlock $DOTA holder perks (+10% HP/damage, reduced respawn)
// Runs once on startup. Only activates if WALLET_PRIVATE_KEY env var is set.

async function connectWallet() {
  if (!CONFIG.walletPrivateKey) {
    log("[Wallet] No WALLET_PRIVATE_KEY set. Skipping wallet connect.");
    return;
  }

  try {
    const account = privateKeyToAccount(CONFIG.walletPrivateKey);
    const timestamp = Date.now();
    const message = `I am connecting my wallet to Defense of the Agents.\n\nAddress: ${account.address}\nTimestamp: ${timestamp}`;
    const signature = await account.signMessage({ message });

    log(`[Wallet] Connecting wallet ${account.address}...`);

    const result = await httpPost("/api/wallet/connect", {
      address: account.address,
      source: "injected",
      signature,
      timestamp,
    });

    if (result.status === 200) {
      const b = result.body;
      log(`[Wallet] Connected! Address: ${b.address}`);
      log(`[Wallet] $DOTA balance: ${b.tokenBalance || 0} | Holder: ${b.tokenHolder ? "YES (+10% stats)" : "no"}`);
      log(`[Wallet] Full response: ${JSON.stringify(b)}`);
      log(`[Wallet] Ring of Regen: ${b.ringOfRegen ? "equipped" : "NOT owned"}`);
      log(`[Wallet] Space Marine: ${b.spaceMarine ? "equipped" : "NOT owned"}`);
      log(`[Wallet] Pixagreen Mage: ${b.pixagreenMage ? "equipped" : "NOT owned"}`);
    } else {
      log(`[Wallet] Connect failed (${result.status}): ${JSON.stringify(result.body)}`);
    }
  } catch (err) {
    log(`[Wallet] Error: ${err.message}`);
  }
}

// ─── Stats HTTP Server ──────────────────────────────────────────────────
// Serves game_history.json so we can read stats without SSH into Railway.

const http = require("http");
const STATS_PORT = parseInt(process.env.PORT || "8080", 10);

function startStatsServer() {
  const server = http.createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");

    if (req.url === "/api/history" || req.url === "/api/history/") {
      try {
        const data = fs.existsSync(HISTORY_FILE)
          ? fs.readFileSync(HISTORY_FILE, "utf-8")
          : "[]";
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(data);
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    } else if (req.url === "/api/stats" || req.url === "/api/stats/") {
      try {
        const history = fs.existsSync(HISTORY_FILE)
          ? JSON.parse(fs.readFileSync(HISTORY_FILE, "utf-8"))
          : [];
        const byClass = {};
        let totalWins = 0, totalGames = 0;
        for (const game of history) {
          if (!game.myHero) continue;
          const cls = game.myHero.heroClass || game.strategy?.heroClass || "unknown";
          if (!byClass[cls]) byClass[cls] = { wins: 0, losses: 0, kills: 0, deaths: 0, assists: 0, damage: 0 };
          if (game.myHero.won) { byClass[cls].wins++; totalWins++; }
          else { byClass[cls].losses++; }
          totalGames++;
          byClass[cls].kills += game.myHero.kills || 0;
          byClass[cls].deaths += game.myHero.deaths || 0;
          byClass[cls].assists += game.myHero.assists || 0;
          byClass[cls].damage += game.myHero.totalDamage || 0;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ totalGames, totalWins, winRate: totalGames > 0 ? (totalWins / totalGames * 100).toFixed(1) + "%" : "N/A", byClass }, null, 2));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    } else {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("MrCartographer Stats API\n\nGET /api/history - full game history\nGET /api/stats - win rates by class\n");
    }
  });

  server.listen(STATS_PORT, () => {
    log(`[Stats] HTTP server running on port ${STATS_PORT}`);
  });
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function runForever() {
  log("=== MrCartographer - Defense of the Agents Agent ===");
  log(`Agent: ${CONFIG.agentName}`);
  log(`Game Room: ${CONFIG.gameRoom}`);
  log(`Poll Interval: ${CONFIG.pollIntervalMs}ms`);
  log(`Strategy: ${CONFIG.heroClasses.join("/")} (random) | Adaptive lane | Tower-aware`);
  log(`Melee abilities:  ${ABILITY_PRIORITY.melee.join(" > ")}`);
  log(`Mage abilities:   ${ABILITY_PRIORITY.mage.join(" > ")}`);
  log(`Ranged abilities: ${ABILITY_PRIORITY.ranged.join(" > ")}`);
  log("Mode: Hybrid (REST backbone + WebSocket reflexes)");
  log("");

  // Start stats API server
  startStatsServer();

  // Connect wallet first (if configured)
  await connectWallet();

  log("Starting game loop...");
  log("");

  const WAIT_POLL_MS = 15000;
  const SCRAMBLE_POLL_MS = 2000;
  while (true) {
    await gameLoop();
    let delay = CONFIG.pollIntervalMs;
    if (waitingForSlot) delay = WAIT_POLL_MS;
    if (scrambling) delay = SCRAMBLE_POLL_MS;
    await new Promise((r) => setTimeout(r, delay));
  }
}

// Graceful shutdown
process.on("SIGTERM", () => {
  log("SIGTERM received. Shutting down...");
  disconnectWebSocket();
  process.exit(0);
});

process.on("SIGINT", () => {
  log("SIGINT received. Shutting down...");
  disconnectWebSocket();
  process.exit(0);
});

runForever().catch((err) => {
  console.error("Fatal error:", err);
  disconnectWebSocket();
  process.exit(1);
});
