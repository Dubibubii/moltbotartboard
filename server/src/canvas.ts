import { CANVAS_WIDTH, CANVAS_HEIGHT, Pixel, PixelPlacement } from './types.js';
import {
  saveCanvasToRedis,
  loadCanvasFromRedis,
  setPixelInfo,
  getPixelInfo,
  incrementBotPixelCount,
  clearCanvasData,
  addRecentPlacement,
  loadRecentPlacements,
} from './services/redis.js';
import { config } from './config.js';

class Canvas {
  private pixels: Pixel[][];
  private recentPlacements: PixelPlacement[] = [];
  private initialized = false;

  constructor() {
    this.pixels = this.createEmptyCanvas();
  }

  // Initialize canvas - load from Redis if available
  async init(): Promise<void> {
    if (this.initialized) return;

    if (config.useRedis) {
      const colors = await loadCanvasFromRedis();
      if (colors) {
        // Restore canvas from Redis
        for (let y = 0; y < Math.min(colors.length, CANVAS_HEIGHT); y++) {
          for (let x = 0; x < Math.min(colors[y].length, CANVAS_WIDTH); x++) {
            this.pixels[y][x].color = colors[y][x];
          }
        }
        console.log('Canvas loaded from Redis');
      } else {
        console.log('No existing canvas in Redis, starting fresh');
      }

      // Restore recent placements from Redis
      const placements = await loadRecentPlacements();
      if (placements.length > 0) {
        this.recentPlacements = placements;
        console.log(`Loaded ${placements.length} recent placements from Redis`);
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

    const timestamp = Date.now();
    this.pixels[y][x] = { color, botId, placedAt: timestamp };

    const placement: PixelPlacement = { x, y, color, botId, timestamp };
    this.recentPlacements.push(placement);

    // Keep only last 1000 placements in memory
    if (this.recentPlacements.length > 1000) {
      this.recentPlacements.shift();
    }

    // Persist to Redis if available (non-fatal)
    if (config.useRedis) {
      try {
        const colors = this.pixels.map(row => row.map(p => p.color));
        await saveCanvasToRedis(colors);
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

    const timestamp = Date.now();
    this.pixels[y][x] = { color, botId, placedAt: timestamp };

    const placement: PixelPlacement = { x, y, color, botId, timestamp };
    this.recentPlacements.push(placement);

    if (this.recentPlacements.length > 1000) {
      this.recentPlacements.shift();
    }

    return true;
  }

  getState(): { colors: string[][]; width: number; height: number } {
    const colors = this.pixels.map(row => row.map(p => p.color));
    return { colors, width: CANVAS_WIDTH, height: CANVAS_HEIGHT };
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

  async reset(): Promise<void> {
    this.pixels = this.createEmptyCanvas();
    this.recentPlacements = [];

    // Clear Redis data if available
    if (config.useRedis) {
      await clearCanvasData();
    }
  }

  getFullState(): Pixel[][] {
    return this.pixels;
  }

  // Get pixel info (from Redis if available)
  async getPixelInfoAsync(x: number, y: number): Promise<{ botId: string; botName: string } | null> {
    if (config.useRedis) {
      const info = await getPixelInfo(x, y);
      if (info) {
        return { botId: info.botId, botName: info.botName };
      }
    }

    // Fallback to in-memory
    const pixel = this.getPixel(x, y);
    if (pixel?.botId) {
      return { botId: pixel.botId, botName: '' };
    }

    return null;
  }
}

export const canvas = new Canvas();
