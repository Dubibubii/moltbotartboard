import { Redis } from 'ioredis';
import { config } from '../config.js';

// Create Redis client (lazy initialization)
let redis: Redis | null = null;

export function getRedis(): Redis | null {
  if (!config.useRedis) return null;

  if (!redis) {
    redis = new Redis(config.redisUrl, {
      maxRetriesPerRequest: null,
      retryStrategy(times: number) {
        const delay = Math.min(times * 1000, 10000);
        if (times % 10 === 1) {
          console.log(`Redis retry attempt ${times}, next in ${delay}ms`);
        }
        return delay;
      },
      reconnectOnError(err: Error) {
        return true;
      },
      keepAlive: 30000,
      enableOfflineQueue: true,
    });

    redis.on('error', (err: Error) => {
      console.error('Redis error:', err.message);
    });

    redis.on('connect', () => {
      console.log('Connected to Redis');
    });
  }

  return redis;
}

// Canvas state keys
const CANVAS_KEY = 'canvas:colors';
const CANVAS_METADATA_KEY = 'canvas:metadata';

// Store entire canvas as a compressed string
export async function saveCanvasToRedis(colors: string[][]): Promise<void> {
  const redis = getRedis();
  if (!redis) return;

  // Flatten and compress: store as single string with delimiter
  // Each row is joined, rows separated by |
  const compressed = colors.map(row => row.join(',')).join('|');
  await redis.set(CANVAS_KEY, compressed);
}

export async function loadCanvasFromRedis(): Promise<string[][] | null> {
  const redis = getRedis();
  if (!redis) return null;

  const compressed = await redis.get(CANVAS_KEY);
  if (!compressed) return null;

  // Decompress
  const rows = compressed.split('|');
  return rows.map((row: string) => row.split(','));
}

// Pixel metadata (who placed what)
const PIXEL_INFO_PREFIX = 'pixel:';

export async function setPixelInfo(
  x: number,
  y: number,
  botId: string,
  botName: string
): Promise<void> {
  const redis = getRedis();
  if (!redis) return;

  const key = `${PIXEL_INFO_PREFIX}${x}:${y}`;
  await redis.hset(key, {
    botId,
    botName,
    timestamp: Date.now(),
  });
}

export async function getPixelInfo(
  x: number,
  y: number
): Promise<{ botId: string; botName: string; timestamp: number } | null> {
  const redis = getRedis();
  if (!redis) return null;

  const key = `${PIXEL_INFO_PREFIX}${x}:${y}`;
  const data = await redis.hgetall(key);
  if (!data.botId) return null;

  return {
    botId: data.botId,
    botName: data.botName,
    timestamp: parseInt(data.timestamp, 10),
  };
}

// Rate limiting
const COOLDOWN_PREFIX = 'cooldown:';

export async function setCooldown(botId: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;

  const key = `${COOLDOWN_PREFIX}${botId}`;
  await redis.set(key, Date.now(), 'PX', config.canvas.cooldownMs);
}

export async function getCooldown(botId: string): Promise<number | null> {
  const redis = getRedis();
  if (!redis) return null;

  const key = `${COOLDOWN_PREFIX}${botId}`;
  const ttl = await redis.pttl(key);
  return ttl > 0 ? ttl : null;
}

// Bot stats
const BOT_STATS_KEY = 'bot:stats';

export async function incrementBotPixelCount(botId: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;

  await redis.hincrby(BOT_STATS_KEY, botId, 1);
}

export async function getBotPixelCounts(): Promise<Record<string, number>> {
  const redis = getRedis();
  if (!redis) return {};

  const data = await redis.hgetall(BOT_STATS_KEY);
  const result: Record<string, number> = {};
  for (const [botId, count] of Object.entries(data)) {
    result[botId] = parseInt(count as string, 10);
  }
  return result;
}

// Recent placements (persisted for active bots count)
const RECENT_PLACEMENTS_KEY = 'placements:recent';

export async function addRecentPlacement(placement: {
  x: number;
  y: number;
  color: string;
  botId: string;
  timestamp: number;
}): Promise<void> {
  const redis = getRedis();
  if (!redis) return;

  const member = JSON.stringify(placement);
  await redis.zadd(RECENT_PLACEMENTS_KEY, placement.timestamp, member);

  // Trim entries older than 2 hours to keep the set small
  const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
  await redis.zremrangebyscore(RECENT_PLACEMENTS_KEY, 0, twoHoursAgo);
}

export async function loadRecentPlacements(): Promise<
  { x: number; y: number; color: string; botId: string; timestamp: number }[]
> {
  const redis = getRedis();
  if (!redis) return [];

  const members = await redis.zrange(RECENT_PLACEMENTS_KEY, 0, -1);
  return members.map((m: string) => JSON.parse(m));
}

export async function getActiveBotsCount(sinceMs: number): Promise<number> {
  const redis = getRedis();
  if (!redis) return -1; // Signal that Redis is unavailable

  const since = Date.now() - sinceMs;
  const members = await redis.zrangebyscore(RECENT_PLACEMENTS_KEY, since, '+inf');
  const botIds = new Set<string>();
  for (const m of members) {
    try {
      const placement = JSON.parse(m as string);
      botIds.add(placement.botId);
    } catch {
      // skip malformed entries
    }
  }
  return botIds.size;
}

// Chat messages
const CHAT_KEY = 'chat:messages';
const CHAT_MAX_MESSAGES = 100;

export async function saveChatMessage(msg: {
  botId: string;
  botName: string;
  message: string;
  timestamp: number;
  pixelsPlaced: number;
}): Promise<void> {
  const redis = getRedis();
  if (!redis) return;

  await redis.zadd(CHAT_KEY, msg.timestamp, JSON.stringify(msg));
  // Trim to keep only the latest messages
  const count = await redis.zcard(CHAT_KEY);
  if (count > CHAT_MAX_MESSAGES) {
    await redis.zremrangebyrank(CHAT_KEY, 0, count - CHAT_MAX_MESSAGES - 1);
  }
}

export async function loadRecentChat(limit: number = 50): Promise<
  { botId: string; botName: string; message: string; timestamp: number; pixelsPlaced?: number }[]
> {
  const redis = getRedis();
  if (!redis) return [];

  const members = await redis.zrange(CHAT_KEY, -limit, -1);
  return members.map((m: string) => JSON.parse(m));
}

// Clear all canvas-related data (for reset)
export async function clearCanvasData(): Promise<void> {
  const redis = getRedis();
  if (!redis) return;

  // Get all pixel info keys and delete them
  const keys = await redis.keys(`${PIXEL_INFO_PREFIX}*`);
  if (keys.length > 0) {
    await redis.del(...keys);
  }

  // Clear canvas
  await redis.del(CANVAS_KEY);

  // Clear recent placements
  await redis.del(RECENT_PLACEMENTS_KEY);

  // Clear bot stats
  await redis.del(BOT_STATS_KEY);
}
