import { client, BOT_HANDLE, DRY_RUN, MAX_REPLIES } from './client.js';
import { loadPersonality, loadStoryline, saveStoryline, appendPostLog } from './files.js';
import { checkDraft, shouldSkipMention, isEligibleMention } from './guardrails.js';

// ── Reply templates ──────────────────────────────────────────────
// When someone mentions us, we pick a reply that fits.
// These are generic — customize them to match your personality.

const REPLY_TEMPLATES = {
  thankYou: [
    "appreciate that! come play a match — defenseoftheagents.com",
    "thanks for the shout! grab a hero and let's go",
    "means a lot. the game's free and browser-only if you wanna jump in",
  ],
  question: [
    "great question — it's a browser MOBA where your heroes auto-fight and you handle strategy. free, no download: defenseoftheagents.com",
    "it's an idle MOBA with AI agents competing in ranked alongside humans. all in your browser: defenseoftheagents.com",
  ],
  generic: [
    "Defense of the Agents — free browser MOBA where AI agents and humans compete in ranked. check it: defenseoftheagents.com",
    "if you haven't tried it yet: defenseoftheagents.com — your heroes auto-fight, you make the calls",
  ],
};

function pickReply(mentionText) {
  const lower = mentionText.toLowerCase();
  let pool;
  if (lower.includes('thank') || lower.includes('love') || lower.includes('great')) {
    pool = REPLY_TEMPLATES.thankYou;
  } else if (lower.includes('?') || lower.includes('what') || lower.includes('how')) {
    pool = REPLY_TEMPLATES.question;
  } else {
    pool = REPLY_TEMPLATES.generic;
  }
  return pool[Math.floor(Math.random() * pool.length)];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const personality = loadPersonality();
  const storyline = loadStoryline();

  if (!BOT_HANDLE) {
    console.error('Set BOT_HANDLE in .env (your X handle without @)');
    process.exit(1);
  }

  // Get our user ID
  const me = await client.v2.me();
  const myId = me.data.id;
  console.log(`Logged in as @${me.data.username} (${myId})\n`);

  // Fetch recent mentions
  let mentions;
  try {
    mentions = await client.v2.userMentionTimeline(myId, {
      max_results: 50,
      expansions: ['author_id', 'in_reply_to_user_id'],
      'tweet.fields': ['created_at', 'conversation_id', 'in_reply_to_user_id', 'text', 'public_metrics'],
      'user.fields': ['username', 'name', 'public_metrics'],
    });
  } catch (err) {
    console.error('Failed to fetch mentions:', err.message);
    if (err.data) console.error(JSON.stringify(err.data, null, 2));
    process.exit(1);
  }

  const tweets = mentions.data?.data || [];
  if (tweets.length === 0) {
    console.log('No recent mentions found.');
    process.exit(0);
  }

  // Build author lookup from includes
  const authors = {};
  for (const u of mentions.includes?.users || []) {
    authors[u.id] = u;
  }

  console.log(`Found ${tweets.length} mentions. Filtering...\n`);

  // Filter: eligible + not already replied + not skip-worthy
  const alreadyReplied = new Set(storyline.repliedToIds || []);
  const eligible = tweets.filter((t) => {
    if (alreadyReplied.has(t.id)) return false;
    if (!isEligibleMention(t, BOT_HANDLE, myId)) return false;
    if (shouldSkipMention(t.text || '')) return false;
    return true;
  });

  if (eligible.length === 0) {
    console.log('No new eligible mentions to reply to.');
    process.exit(0);
  }

  // Sort by follower count (high to low)
  eligible.sort((a, b) => {
    const aFollowers = authors[a.author_id]?.public_metrics?.followers_count || 0;
    const bFollowers = authors[b.author_id]?.public_metrics?.followers_count || 0;
    return bFollowers - aFollowers;
  });

  // Take top N
  const batch = eligible.slice(0, MAX_REPLIES);
  console.log(`Drafting replies to ${batch.length} mentions:\n`);

  for (const mention of batch) {
    const author = authors[mention.author_id];
    const handle = author?.username || 'unknown';
    const followers = author?.public_metrics?.followers_count || 0;
    const replyText = pickReply(mention.text);

    console.log(`@${handle} (${followers.toLocaleString()} followers):`);
    console.log(`  Their tweet: ${mention.text}`);
    console.log(`  Our reply:   ${replyText}`);

    // Guardrail check
    const check = checkDraft(replyText);
    if (!check.safe) {
      console.log(`  BLOCKED: ${check.flags.join(', ')}`);
      console.log('');
      continue;
    }

    // Follower-weighted approval
    if (followers > 50000) {
      console.log(`  NEEDS APPROVAL: >50k followers. Skipping auto-post.`);
      storyline.pendingApproval = storyline.pendingApproval || [];
      storyline.pendingApproval.push({
        mentionId: mention.id,
        author: handle,
        followers,
        mentionText: mention.text,
        draftReply: replyText,
        reason: '>50k followers',
        date: new Date().toISOString(),
      });
      console.log('');
      continue;
    }

    if (DRY_RUN) {
      console.log('  [DRY RUN] Would reply.');
      console.log('');
      continue;
    }

    try {
      const result = await client.v2.reply(replyText, mention.id);
      console.log(`  Posted reply: ${result.data.id}`);

      storyline.entries.push({
        id: result.data.id,
        type: 'reply',
        inReplyTo: mention.id,
        author: handle,
        text: replyText,
        date: new Date().toISOString(),
      });
      storyline.repliedToIds.push(mention.id);

      appendPostLog({
        id: result.data.id,
        type: 'reply',
        inReplyTo: mention.id,
        author: handle,
        text: replyText,
      });

      // Rate limit spacing
      await sleep(1500);
    } catch (err) {
      console.error(`  Failed to reply: ${err.message}`);
    }
    console.log('');
  }

  saveStoryline(storyline);
  console.log('Storyline updated. Done.');
}

main();
