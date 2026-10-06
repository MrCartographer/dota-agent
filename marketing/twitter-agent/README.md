# Defense of the Agents — Twitter Agent

Standalone Twitter/X posting agent with personality, storyline tracking, and guardrails. Runs locally via cron. No Bankr subscription needed.

## Quick start

```bash
cd marketing/twitter-agent

# 1. Install dependencies
npm install

# 2. Set up your API keys
cp .env.example .env
# Edit .env with your X Developer Portal credentials

# 3. Build your personality
npm run setup

# 4. Test with a dry run
# (set DRY_RUN=true in .env first)
npm run post

# 5. Post for real
# (set DRY_RUN=false in .env)
npm run post
```

## Prerequisites

1. **X Developer account** — sign up at https://developer.x.com
2. **Create an app** with Read and Write permissions
3. **Generate 4 keys**: Consumer Key, Consumer Secret, Access Token, Access Token Secret
4. **Label your account as automated** at https://x.com/settings/account/automation

## Commands

| Command | What it does |
|---------|-------------|
| `npm run setup` | Interactive personality builder — creates your voice profile |
| `npm run post` | Posts one tweet from the pool (skips recently used ones) |
| `npm run reply` | Scans mentions, drafts and posts replies (respects guardrails) |
| `npm run audit` | Reviews storyline for repeats, staleness, and pending approvals |

## Setting up cron

Open your crontab:

```bash
crontab -e
```

Add these lines (adjust paths and times to your setup):

```cron
# ── Defense of the Agents Twitter Agent ──

# Morning post — weekdays at 9:15am
15 9 * * 1-5 cd /path/to/dota/marketing/twitter-agent && /usr/local/bin/node src/post.js >> /tmp/dota-twitter.log 2>&1

# Midday reply sweep — daily at 12:30pm
30 12 * * * cd /path/to/dota/marketing/twitter-agent && /usr/local/bin/node src/reply-sweep.js >> /tmp/dota-twitter.log 2>&1

# Evening reply sweep — daily at 7pm
0 19 * * * cd /path/to/dota/marketing/twitter-agent && /usr/local/bin/node src/reply-sweep.js >> /tmp/dota-twitter.log 2>&1

# Weekend post — Sat + Sun at 11am
0 11 * * 6,0 cd /path/to/dota/marketing/twitter-agent && /usr/local/bin/node src/post.js >> /tmp/dota-twitter.log 2>&1

# Weekly audit — Sunday 10pm
0 22 * * 0 cd /path/to/dota/marketing/twitter-agent && /usr/local/bin/node src/audit.js >> /tmp/dota-twitter.log 2>&1
```

**Important:** Replace `/path/to/dota` with the actual path to your dota folder. Find your node path with `which node`.

Verify your crontab is saved:

```bash
crontab -l
```

Check logs:

```bash
tail -f /tmp/dota-twitter.log
```

## File structure

```
twitter-agent/
├── .env                  # Your API keys (git-ignored)
├── .env.example          # Template
├── package.json
├── README.md
├── data/
│   ├── twitter-personality.md   # Your agent's voice (created by setup)
│   ├── twitter-storyline.md     # Post history + state (auto-updated)
│   └── post-log.json            # Flat log of all posts
└── src/
    ├── client.js          # Twitter API client + env loading
    ├── files.js           # File read/write helpers
    ├── guardrails.js      # Safety checks before posting
    ├── post.js            # Post a tweet from the pool
    ├── reply-sweep.js     # Scan mentions + reply
    ├── audit.js           # Storyline health check
    └── setup-personality.js  # Interactive personality builder
```

## Customizing the tweet pool

Edit the `TWEET_POOL` array in `src/post.js` to add your own tweets. The script tracks which ones have been posted recently and avoids repeats.

For replies, edit the `REPLY_TEMPLATES` object in `src/reply-sweep.js`.

## Guardrails

Adapted from the bankr-twitter-agent skill:

- **Never cold-replies** — only responds when explicitly tagged or on own conversation tree
- **Blocks onchain-looking content** — EVM addresses, transaction language
- **Follower-weighted approval** — >50k follower replies are held for manual review
- **Skip list** — ignores FUD, political content, spam, financial advice requests
- **No repeat content** — cross-references storyline before posting

## Dry run mode

Set `DRY_RUN=true` in `.env` to see what would be posted without actually posting. Good for testing your cron setup.

## Cost

~$5/month in X API credits for a reasonable posting cadence (1-2 posts + 4-8 replies per day). No other subscriptions needed.
