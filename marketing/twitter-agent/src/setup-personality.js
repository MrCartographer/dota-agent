import { createInterface } from 'readline';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { PERSONALITY_PATH, STORYLINE_PATH } from './files.js';
import { dirname } from 'path';

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((resolve) => rl.question(q + '\n> ', resolve));

async function main() {
  console.log('\n=== Defense of the Agents — Twitter Personality Builder ===\n');
  console.log('Answer these questions to define your agent\'s voice.\n');

  const elevator = await ask('1. What\'s the account about? Give me the elevator pitch.');
  const vibe = await ask('2. Describe the vibe (sharp, witty, degen, serious, chaotic, chill, academic, edgy, wholesome, provocative, technical, meme-heavy — pick a few):');
  const topics = await ask('3. What topics do you want to tweet about? What\'s strictly off-limits?');
  const length = await ask('4. Short punchy tweets or longer form? Threads?');
  const style = await ask('5. Emojis? Hashtags? Lowercase or proper grammar?');
  const phrases = await ask('6. Any signature phrases or words you always use?');
  const examples = await ask('7. Give 2-3 example tweets that sound like you — or accounts you want to sound like:');
  const persona = await ask('8. Is there a character or persona the account should tweet as? Or is it just you?');

  const personality = `# Twitter Personality

## Elevator Pitch
${elevator}

## Vibe
${vibe}

## Topics & Boundaries
${topics}

## Tweet Style
- Length preference: ${length}
- Formatting: ${style}
- Signature phrases: ${phrases}

## Voice Examples
${examples}

## Persona
${persona}

## Hard Rules
- Always stay in character
- Never break the fourth wall about being automated
- Never cold-reply to accounts that haven't tagged us
- Never mention @bankrbot or post anything that looks like an onchain transaction
- Cross-reference the storyline before every draft to avoid repetition
`;

  const dataDir = dirname(PERSONALITY_PATH);
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

  writeFileSync(PERSONALITY_PATH, personality, 'utf-8');
  console.log(`\nPersonality saved to: ${PERSONALITY_PATH}`);

  if (!existsSync(STORYLINE_PATH)) {
    const initialStoryline = JSON.stringify({
      currentState: {
        mood: 'fresh start',
        objective: 'spread the word about Defense of the Agents',
        context: 'new account, building audience',
      },
      entries: [],
      repliedToIds: [],
      usedPhrases: [],
      approvalGatedAccounts: ['bankrbot'],
      approvalGatedMilestones: [],
      pendingApproval: [],
    }, null, 2);
    writeFileSync(STORYLINE_PATH, initialStoryline, 'utf-8');
    console.log(`Storyline initialized at: ${STORYLINE_PATH}`);
  }

  console.log('\nDone! You can now run: npm run post\n');
  rl.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
