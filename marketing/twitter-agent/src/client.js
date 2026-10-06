import { TwitterApi } from 'twitter-api-v2';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', '.env') });

const required = ['X_API_KEY', 'X_API_KEY_SECRET', 'X_ACCESS_TOKEN', 'X_ACCESS_TOKEN_SECRET'];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`Missing env var: ${key}. Copy .env.example to .env and fill in your keys.`);
    process.exit(1);
  }
}

export const client = new TwitterApi({
  appKey: process.env.X_API_KEY,
  appSecret: process.env.X_API_KEY_SECRET,
  accessToken: process.env.X_ACCESS_TOKEN,
  accessSecret: process.env.X_ACCESS_TOKEN_SECRET,
});

export const BOT_HANDLE = (process.env.BOT_HANDLE || '').toLowerCase();
export const DRY_RUN = process.env.DRY_RUN === 'true';
export const MAX_REPLIES = parseInt(process.env.MAX_REPLIES_PER_SWEEP || '4', 10);
