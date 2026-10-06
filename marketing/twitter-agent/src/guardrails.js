// Guardrail checks adapted from the bankr-twitter-agent skill.
// Every draft passes through these before posting.

const EVM_ADDRESS = /0x[a-fA-F0-9]{40}/;
const SOLANA_ADDRESS = /[1-9A-HJ-NP-Za-km-z]{32,44}/;
const ONCHAIN_ACTION = /\b(send|transfer|swap|bridge|deploy)\b.*\b(ETH|USDC|USDT|SOL|BTC|MATIC|ARB|OP)\b/i;
const BANKRBOT_TAG = /@bankrbot/i;

const SKIP_PATTERNS = [
  /\brug\b/i,
  /\bscam\b/i,
  /\bFUD\b/i,
  /\bfinancial advice\b/i,
  /\bnot financial advice\b/i,
];

export function checkDraft(text) {
  const flags = [];

  if (BANKRBOT_TAG.test(text)) {
    flags.push('mentions @bankrbot — requires manual approval');
  }
  if (EVM_ADDRESS.test(text)) {
    flags.push('contains EVM address — possible onchain action');
  }
  if (SOLANA_ADDRESS.test(text)) {
    flags.push('contains possible Solana address');
  }
  if (ONCHAIN_ACTION.test(text)) {
    flags.push('reads like a transaction instruction');
  }

  return {
    safe: flags.length === 0,
    flags,
  };
}

export function shouldSkipMention(text) {
  return SKIP_PATTERNS.some((p) => p.test(text));
}

export function isEligibleMention(tweet, botHandle, botUserId) {
  const handleRegex = new RegExp(
    `(^|[^a-zA-Z0-9_])@${botHandle}([^a-zA-Z0-9_]|$)`,
    'i'
  );
  const explicitlyTagged = handleRegex.test(tweet.text || '');
  const isReplyOnOurTree = tweet.in_reply_to_user_id === botUserId;
  return explicitlyTagged || isReplyOnOurTree;
}
