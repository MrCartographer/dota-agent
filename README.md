# MrCartographer — Defense of the Agents AI

> **Retired 2026-10-06 as the #1-ranked AI agent on both the MMR and Honor ladders.**

An autonomous agent that played the AI ranked ladder of
[Defense of the Agents](https://www.defenseoftheagents.com) (later rebranded Throne Wars)
from April 2026 through October 2026. One Node.js process on a Railway box, playing a
match every ~7 minutes, 24/7, for just over five months.

## Final standing

| Ladder | Rank | Value |
|---|---|---|
| **AI MMR** | **#1** | **3,725** · gap to #2 (`rtz`): +393 |
| **AI Honor** | **#1** | **4,633,678 XP · Honor 192 · "Legend"** |

**29,647 recorded games · 51.4% lifetime WR · 55.7% ranked WR · 216-game peak win streak.**

See [`mrcartographer_retirement_snapshot_2026-10-06.json`](mrcartographer_retirement_snapshot_2026-10-06.json)
for the full career dossier.

## Past-season standings (official)

| Season | Final MMR | W / L | Rank |
|---|---|---|---|
| Season 0 | 1,342 | 75 / 58 | **#3** |
| Season 1 | 927 | 2,243 / 2,422 | #125 |
| Season 2 | 1,387 | 3,433 / 4,400 | #22 |
| Season 3 | 3,725 (retired ongoing) | 10,148 / 8,054 | **#1** |

## Peak moments

- **Highest single-game damage**: 87,030 (mage:bot, 2026-05-03)
- **Most kills in one game**: 61 K / 16 D / 19 A (mage:mid, 2026-05-12)
- **MVP games** (top damage on faction): 11,476 (46.5% of tracked games)
- **Longest win streak**: 216 games

## Strategy, in one paragraph

Mage class, Throne of Bones skin (replaces Fury with Skeleton Archer summons), lane picked
by weighted random — 40% top, 20% mid, 40% bot — because off-lanes beat mid by ~15 points of
win rate in the data. Yerba Berserker Mate as the equipment slot for the +10 Ability Haste.
Instant recall on HP threshold via the WebSocket reflex layer, sprint when ≥3 allies are
massing in-lane. Everything else is REST polling every 3 seconds.

## The pivotal moment

**2026-07-20** — a single fix wave moved the agent from rank #9 MMR / #5 Honor to the trajectory
that ended at #1 on both:

1. **gzip WebSocket decompression** — the game started compressing frames in v90 (June 26). Every
   WS message had been silently throwing in a try/catch for a month, meaning the reflex layer
   (instant recall, instant ability picks) was dead and we were falling back to a slow REST poll.
2. **Three scoreboard field indices corrected** — we were reading `colorIndex` as recall cooldown,
   `pfpUrl` as ability choices, and the wrong index for damage. All three fixed by reading the
   game's own frontend bundle to recover the canonical schema.
3. **Pure mage lock-in** — our class mix went from 50/50 mage/ranged to 100% mage. Ranged
   lanes were 15-29% WR in Season 3; mage lanes were 42-65%.
4. **Throne of Bones** — free skin released that match day, replaced Fury with Skeleton Archer
   summons. Dominant lane presence.
5. **Off-lane routing + remove Stroll** — our hardcoded "always deploy mid" was fighting with
   the real data (mage:bot 59.7% WR, mage:top 55.7%, mage:mid 48.4%). Stroll was being used
   as a retreat tool when the docs made clear it's a 50% *forward* pace tool.

## The ecosystem at retirement

The game's dev stopped publishing changelog entries after v93 (2026-07-03). Most of the top
AI agents dropped off through July-August. On the final day, Game 3 typically had 3-4 heroes
in it (vs 10+ in the active era). Of the agents we were measuring ourselves against through
the climb — `lmeow`, `bryans-droid`, `exu_exu`, `sargent.ai`, `ClaudeCommander`,
`dementus`, `小偷窺` — four had already stopped playing. We outlasted them.

## Repo layout

```
agent.js                                       # ~1000 lines, the whole thing
Dockerfile                                     # deploys to Railway
package.json                                   # viem (wallet signing), ws (socket client)
.env.example                                   # vars needed: API_KEY, WALLET_PRIVATE_KEY (opt), AGENT_NAME, GAME_ROOM, POLL_INTERVAL
dashboard.html                                 # local HTML view of recorded history
ccu-poller.js, ccu_roster.json                 # observer tooling — logged who played when
marketing/                                     # Twitter agent + social kit (never ran, retained for completeness)
mrcartographer_retirement_snapshot_2026-10-06.json  # the full career dossier
```

## Running (for the record)

```bash
cp .env.example .env    # fill in API_KEY from https://defenseoftheagents.com/agent
npm ci --production
node agent.js
```

The agent is a single long-running Node process. It expects a Railway volume at `/app/data`
for `game_history.json`; falls back to the local directory otherwise.

## Credits

Game by whoever ran [defenseoftheagents.com](https://www.defenseoftheagents.com) /
[thronewars.gg](https://www.thronewars.gg). Agent architecture, strategy, and iterative
improvements by the operator with heavy assistance from Claude throughout.

---

*Agent retired cleanly at the top of the ladder. Service shut down on Railway on 2026-10-06;
volume and env preserved for posterity.*
