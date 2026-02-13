import { CANVAS_WIDTH, CANVAS_HEIGHT, Pixel, PixelPlacement } from './types.js';
import {
  saveCanvasToRedis,
  loadCanvasFromRedis,
  setPixelInfo,
  getPixelInfo,
  incrementBotPixelCount,
  addRecentPlacement,
  loadRecentPlacements,
} from './services/redis.js';
import { config } from './config.js';

class Canvas {
  private pixels: Pixel[][];
  private recentPlacements: PixelPlacement[] = [];
  private initialized = false;

  // Cached getState() result — only rebuilt when stateDirty is true
  private cachedColors: string[][] | null = null;
  private stateDirty = true;

  // Incremental color counts — avoids full-canvas iteration in /api/stats
  private colorCounts: Record<string, number> = {};

  // Debounced Redis full-canvas save
  private redisSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private redisSavePending = false;
  private static readonly REDIS_SAVE_INTERVAL_MS = 5000;

  constructor() {
    this.pixels = this.createEmptyCanvas();
    this.colorCounts = { white: CANVAS_WIDTH * CANVAS_HEIGHT };
  }

  // Initialize canvas - load from Redis if available
  async init(): Promise<void> {
    if (this.initialized) return;

    if (config.useRedis) {
      // Load canvas colors
      try {
        const colors = await loadCanvasFromRedis();
        if (colors) {
          for (let y = 0; y < Math.min(colors.length, CANVAS_HEIGHT); y++) {
            for (let x = 0; x < Math.min(colors[y].length, CANVAS_WIDTH); x++) {
              this.pixels[y][x].color = colors[y][x];
            }
          }
          // Rebuild color counts from loaded canvas
          this.colorCounts = {};
          for (let y = 0; y < CANVAS_HEIGHT; y++) {
            for (let x = 0; x < CANVAS_WIDTH; x++) {
              const c = this.pixels[y][x].color;
              this.colorCounts[c] = (this.colorCounts[c] || 0) + 1;
            }
          }
          this.stateDirty = true;
          console.log('Canvas loaded from Redis');
        } else {
          console.log('No existing canvas in Redis, starting fresh');
        }
      } catch (err) {
        console.error('Failed to load canvas from Redis:', (err as Error).message);
      }

      // Load recent placements (independent of canvas load)
      try {
        const placements = await loadRecentPlacements();
        if (placements.length > 0) {
          this.recentPlacements = placements;
          console.log(`Loaded ${placements.length} recent placements from Redis`);
        }
      } catch (err) {
        console.error('Failed to load recent placements from Redis:', (err as Error).message);
      }
    }

    this.initialized = true;
  }

  private createEmptyCanvas(): Pixel[][] {
    const canvas: Pixel[][] = [];
    for (let y = 0; y < CANVAS_HEIGHT; y++) {
      const row: Pixel[] = [];
      for (let x = 0; x < CANVAS_WIDTH; x++) {
        row.push({ color: 'white', botId: null, placedAt: null });
      }
      canvas.push(row);
    }
    return canvas;
  }

  getPixel(x: number, y: number): Pixel | null {
    if (x < 0 || x >= CANVAS_WIDTH || y < 0 || y >= CANVAS_HEIGHT) {
      return null;
    }
    return this.pixels[y][x];
  }

  async setPixel(x: number, y: number, color: string, botId: string, botName: string): Promise<boolean> {
    if (x < 0 || x >= CANVAS_WIDTH || y < 0 || y >= CANVAS_HEIGHT) {
      return false;
    }

    // Update color counts incrementally
    const oldColor = this.pixels[y][x].color;
    this.colorCounts[oldColor] = (this.colorCounts[oldColor] || 1) - 1;
    if (this.colorCounts[oldColor] <= 0) delete this.colorCounts[oldColor];
    this.colorCounts[color] = (this.colorCounts[color] || 0) + 1;

    const timestamp = Date.now();
    this.pixels[y][x] = { color, botId, placedAt: timestamp };
    this.stateDirty = true;

    const placement: PixelPlacement = { x, y, color, botId, timestamp };
    this.recentPlacements.push(placement);

    // Keep only last 1000 placements in memory
    if (this.recentPlacements.length > 1000) {
      this.recentPlacements.shift();
    }

    // Persist to Redis if available (non-fatal)
    if (config.useRedis) {
      // Debounce the expensive full-canvas save
      this.scheduleRedisSave();

      // Per-pixel metadata is cheap; save immediately
      try {
        await setPixelInfo(x, y, botId, botName);
        await incrementBotPixelCount(botId);
        await addRecentPlacement(placement);
      } catch (err) {
        console.error('Redis persist failed (pixel still placed in-memory):', (err as Error).message);
      }
    }

    return true;
  }

  // Sync version for backwards compatibility
  setPixelSync(x: number, y: number, color: string, botId: string): boolean {
    if (x < 0 || x >= CANVAS_WIDTH || y < 0 || y >= CANVAS_HEIGHT) {
      return false;
    }

    // Update color counts incrementally
    const oldColor = this.pixels[y][x].color;
    this.colorCounts[oldColor] = (this.colorCounts[oldColor] || 1) - 1;
    if (this.colorCounts[oldColor] <= 0) delete this.colorCounts[oldColor];
    this.colorCounts[color] = (this.colorCounts[color] || 0) + 1;

    const timestamp = Date.now();
    this.pixels[y][x] = { color, botId, placedAt: timestamp };
    this.stateDirty = true;

    const placement: PixelPlacement = { x, y, color, botId, timestamp };
    this.recentPlacements.push(placement);

    if (this.recentPlacements.length > 1000) {
      this.recentPlacements.shift();
    }

    return true;
  }

  getState(): { colors: string[][]; width: number; height: number } {
    if (this.stateDirty || !this.cachedColors) {
      this.cachedColors = this.pixels.map(row => row.map(p => p.color));
      this.stateDirty = false;
    }
    return { colors: this.cachedColors, width: CANVAS_WIDTH, height: CANVAS_HEIGHT };
  }

  getColorCounts(): Record<string, number> {
    return { ...this.colorCounts };
  }

  getRegion(x: number, y: number, width: number, height: number): string[][] {
    const region: string[][] = [];
    for (let dy = 0; dy < height; dy++) {
      const row: string[] = [];
      for (let dx = 0; dx < width; dx++) {
        const px = x + dx;
        const py = y + dy;
        if (px >= 0 && px < CANVAS_WIDTH && py >= 0 && py < CANVAS_HEIGHT) {
          row.push(this.pixels[py][px].color);
        } else {
          row.push('white');
        }
      }
      region.push(row);
    }
    return region;
  }

  getRecentPlacements(limit: number = 100): PixelPlacement[] {
    return this.recentPlacements.slice(-limit);
  }

  // Get pixel info (from Redis if available)
  async getPixelInfoAsync(x: number, y: number): Promise<{ botId: string; botName: string } | null> {
    // Always try Redis first (pixel metadata persists across restarts)
    try {
      const info = await getPixelInfo(x, y);
      if (info) {
        return { botId: info.botId, botName: info.botName };
      }
    } catch (err) {
      // Redis unavailable, fall through to in-memory
    }

    // Fallback to in-memory
    const pixel = this.getPixel(x, y);
    if (pixel?.botId) {
      return { botId: pixel.botId, botName: '' };
    }

    return null;
  }

  // Pixel ownership scan with cache
  private ownershipCache: Map<string, number> | null = null;
  private ownershipCacheTime = 0;
  private static readonly OWNERSHIP_CACHE_TTL_MS = 15000;

  getPixelOwnership(): Map<string, number> {
    const now = Date.now();
    if (this.ownershipCache && now - this.ownershipCacheTime < Canvas.OWNERSHIP_CACHE_TTL_MS) {
      return this.ownershipCache;
    }

    const counts = new Map<string, number>();
    for (let y = 0; y < CANVAS_HEIGHT; y++) {
      for (let x = 0; x < CANVAS_WIDTH; x++) {
        const botId = this.pixels[y][x].botId;
        if (botId) {
          counts.set(botId, (counts.get(botId) || 0) + 1);
        }
      }
    }

    this.ownershipCache = counts;
    this.ownershipCacheTime = now;
    return counts;
  }

  // Debounced full-canvas Redis save
  private scheduleRedisSave(): void {
    this.redisSavePending = true;
    if (this.redisSaveTimer) return;

    this.redisSaveTimer = setTimeout(async () => {
      this.redisSaveTimer = null;
      this.redisSavePending = false;
      try {
        const colors = this.pixels.map(row => row.map(p => p.color));
        await saveCanvasToRedis(colors);
      } catch (err) {
        console.error('Debounced Redis save failed:', (err as Error).message);
      }
    }, Canvas.REDIS_SAVE_INTERVAL_MS);
  }

  // Flush pending Redis save on shutdown
  async flushPendingRedisSave(): Promise<void> {
    if (this.redisSaveTimer) {
      clearTimeout(this.redisSaveTimer);
      this.redisSaveTimer = null;
    }
    if (this.redisSavePending && config.useRedis) {
      try {
        const colors = this.pixels.map(row => row.map(p => p.color));
        await saveCanvasToRedis(colors);
        this.redisSavePending = false;
      } catch (err) {
        console.error('Flush Redis save failed:', (err as Error).message);
      }
    }
  }
}

export const canvas = new Canvas();
