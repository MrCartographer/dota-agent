import { loadStoryline, saveStoryline } from './files.js';

function main() {
  const storyline = loadStoryline();
  const entries = storyline.entries || [];
  const now = new Date();

  console.log('\n=== Storyline Audit ===\n');
  console.log(`Total entries: ${entries.length}`);
  console.log(`Replied-to IDs tracked: ${(storyline.repliedToIds || []).length}`);
  console.log(`Pending approvals: ${(storyline.pendingApproval || []).length}\n`);

  // Check for repeated phrases
  const phrases = entries.map((e) => e.text?.toLowerCase().trim()).filter(Boolean);
  const phraseCounts = {};
  for (const p of phrases) {
    phraseCounts[p] = (phraseCounts[p] || 0) + 1;
  }
  const repeats = Object.entries(phraseCounts).filter(([, c]) => c > 1);
  if (repeats.length > 0) {
    console.log('REPEATED CONTENT:');
    for (const [text, count] of repeats) {
      console.log(`  [${count}x] ${text.slice(0, 80)}...`);
    }
    console.log('');
  } else {
    console.log('No repeated content found.\n');
  }

  // Check for stale content (nothing posted in 3+ days)
  const lastEntry = entries[entries.length - 1];
  if (lastEntry) {
    const lastDate = new Date(lastEntry.date);
    const daysSince = Math.floor((now - lastDate) / (1000 * 60 * 60 * 24));
    if (daysSince >= 3) {
      console.log(`WARNING: Last post was ${daysSince} days ago. Consider posting soon.\n`);
    } else {
      console.log(`Last post: ${daysSince} day(s) ago. Looking good.\n`);
    }
  }

  // Check tweet pool usage
  const last20 = entries.slice(-20).map((e) => e.text?.toLowerCase().trim());
  const uniqueLast20 = new Set(last20);
  console.log(`Unique tweets in last 20 entries: ${uniqueLast20.size}/20`);
  if (uniqueLast20.size < 15) {
    console.log('Consider adding more tweets to the TWEET_POOL in src/post.js.\n');
  }

  // Pending approvals
  if ((storyline.pendingApproval || []).length > 0) {
    console.log('\nPENDING APPROVALS:');
    for (const p of storyline.pendingApproval) {
      console.log(`  @${p.author} (${p.followers?.toLocaleString()} followers) — ${p.reason}`);
      console.log(`    Their tweet: ${p.mentionText?.slice(0, 80)}`);
      console.log(`    Draft reply: ${p.draftReply?.slice(0, 80)}`);
      console.log(`    Date: ${p.date}\n`);
    }
  }

  // Post type breakdown
  const topLevel = entries.filter((e) => e.type === 'top-level').length;
  const replies = entries.filter((e) => e.type === 'reply').length;
  console.log(`\nBreakdown: ${topLevel} top-level posts, ${replies} replies`);

  // Weekly stats
  const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);
  const thisWeek = entries.filter((e) => new Date(e.date) > weekAgo);
  console.log(`This week: ${thisWeek.length} total (${thisWeek.filter((e) => e.type === 'top-level').length} posts, ${thisWeek.filter((e) => e.type === 'reply').length} replies)`);

  console.log('\n=== Audit Complete ===\n');
}

main();
