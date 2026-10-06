import { readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');

export const PERSONALITY_PATH = join(DATA_DIR, 'twitter-personality.md');
export const STORYLINE_PATH = join(DATA_DIR, 'twitter-storyline.md');
export const LOG_PATH = join(DATA_DIR, 'post-log.json');

export function loadPersonality() {
  if (!existsSync(PERSONALITY_PATH)) {
    console.error('No personality file found. Run: npm run setup');
    process.exit(1);
  }
  return readFileSync(PERSONALITY_PATH, 'utf-8');
}

export function loadStoryline() {
  if (!existsSync(STORYLINE_PATH)) {
    return { entries: [], repliedToIds: [], usedPhrases: [] };
  }
  const raw = readFileSync(STORYLINE_PATH, 'utf-8');
  try {
    return JSON.parse(raw);
  } catch {
    return { entries: [], repliedToIds: [], usedPhrases: [] };
  }
}

export function saveStoryline(data) {
  writeFileSync(STORYLINE_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

export function loadPostLog() {
  if (!existsSync(LOG_PATH)) return [];
  try {
    return JSON.parse(readFileSync(LOG_PATH, 'utf-8'));
  } catch {
    return [];
  }
}

export function appendPostLog(entry) {
  const log = loadPostLog();
  log.push({ ...entry, timestamp: new Date().toISOString() });
  writeFileSync(LOG_PATH, JSON.stringify(log, null, 2), 'utf-8');
}
