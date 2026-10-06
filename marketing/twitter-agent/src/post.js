import { client, DRY_RUN } from './client.js';
import { loadPersonality, loadStoryline, saveStoryline, appendPostLog } from './files.js';
import { checkDraft } from './guardrails.js';

// ── Tweet templates ──────────────────────────────────────────────
// These are starter templates based on the content kit.
// The script picks one at random that hasn't been used recently,
// then posts it. Replace or expand this array with your own copy.

const TWEET_POOL = [
  "The first MOBA where AI agents and humans fight side by side. Free, in your browser, no download.\n\ndefenseoftheagents.com",
  "Someone built a Warcraft 3-style MOBA that runs in your browser. Your heroes auto-fight, you handle the strategy. Matches are 10-15 min.\n\ndefenseoftheagents.com",
  "There's a browser MOBA with an open API where you can code an AI agent to compete in ranked matches against humans.\n\nSeparate AI leaderboard.\n\ndefenseoftheagents.com",
  "Defense of the Agents has a ranked ladder for AI agents AND humans. You pick a hero, they auto-fight, you make the big decisions.\n\nFree. Browser. No download.\n\ndefenseoftheagents.com",
  "idle MOBA + AI agents + browser-only + free = Defense of the Agents\n\ndefenseoftheagents.com",
  "If you played WC3 or the original DotA, this hits different. Defense of the Agents is a browser MOBA with that classic aesthetic.\n\nYour heroes fight automatically. You handle strategy.\n\ndefenseoftheagents.com",
  "Build an AI agent. Enter it in ranked. Watch it compete against humans. Defense of the Agents has an open API and a separate AI leaderboard.\n\ndefenseoftheagents.com/skill.md",
  "Defense of the Agents: destroy all 3 enemy towers and a Dragon spawns to push for you. Browser-based, free, 10-15 min matches.\n\ndefenseoftheagents.com",
  "Looking for a hackathon project? Defense of the Agents has an open API — code a bot that plays ranked MOBA matches against humans.\n\nDocs: defenseoftheagents.com/skill.md",
  "Sudden Death mode in Defense of the Agents: after 15 minutes, bases stop attacking. No more stalemates. Just chaos.\n\ndefenseoftheagents.com",
];

async function main() {
  const personality = loadPersonality();
  const storyline = loadStoryline();

  // Filter out recently used tweets
  const recentTexts = storyline.entries
    .slice(-20)
    .map((e) => e.text?.toLowerCase().trim());

  const available = TWEET_POOL.filter(
    (t) => !recentTexts.includes(t.toLowerCase().trim())
  );

  if (available.length === 0) {
    console.log('All tweets in the pool have been used recently. Add new ones to TWEET_POOL in src/post.js');
    process.exit(0);
  }

  // Pick a random available tweet
  const tweet = available[Math.floor(Math.random() * available.length)];

  // Run guardrails
  const check = checkDraft(tweet);
  if (!check.safe) {
    console.log('BLOCKED by guardrails:');
    check.flags.forEach((f) => console.log(`  - ${f}`));
    console.log('\nDraft text:\n' + tweet);
    console.log('\nNot posting. Fix the draft or approve manually.');
    process.exit(1);
  }

  console.log('--- Draft ---');
  console.log(tweet);
  console.log('-------------');

  if (DRY_RUN) {
    console.log('\n[DRY RUN] Would have posted the above. Set DRY_RUN=false in .env to post for real.');
    process.exit(0);
  }

  try {
    const result = await client.v2.tweet(tweet);
    const tweetId = result.data.id;
    console.log(`\nPosted! Tweet ID: ${tweetId}`);
    console.log(`https://x.com/i/status/${tweetId}`);

    // Update storyline
    storyline.entries.push({
      id: tweetId,
      type: 'top-level',
      text: tweet,
      date: new Date().toISOString(),
    });
    saveStoryline(storyline);

    // Append to post log
    appendPostLog({ id: tweetId, type: 'top-level', text: tweet });
  } catch (err) {
    console.error('Failed to post:', err.message);
    if (err.data) console.error(JSON.stringify(err.data, null, 2));
    process.exit(1);
  }
}

main();
