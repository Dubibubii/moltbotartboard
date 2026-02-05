import { Redis } from 'ioredis';
import { config } from '../config.js';

// Create Redis client (lazy initialization)
let redis: Redis | null = null;

export function getRedis(): Redis | null {
  if (!config.useRedis) return null;

  if (!redis) {
    redis = new Redis(config.redisUrl, {
      maxRetriesPerRequest: 3,
      lazyConnect: true,
    });

    redis.on('error', (err: Error) => {
      console.error('Redis error:', err);
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

  // Clear bot stats
  await redis.del(BOT_STATS_KEY);
}
