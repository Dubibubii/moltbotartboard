import { COOLDOWN_MS } from '../types.js';
import { config } from '../config.js';
import { setCooldown, getCooldown as getRedisCooldown } from './redis.js';

class RateLimitService {
  // In-memory fallback
  private lastPlacement: Map<string, number> = new Map(); // botId -> timestamp

  async canPlace(botId: string): Promise<{ allowed: boolean; remainingMs: number }> {
    if (config.useRedis) {
      const remainingMs = await getRedisCooldown(botId);
      if (remainingMs === null || remainingMs <= 0) {
        return { allowed: true, remainingMs: 0 };
      }
      return { allowed: false, remainingMs };
    }

    // In-memory fallback
    const last = this.lastPlacement.get(botId);
    const now = Date.now();

    if (!last) {
      return { allowed: true, remainingMs: 0 };
    }

    const elapsed = now - last;
    if (elapsed >= COOLDOWN_MS) {
      return { allowed: true, remainingMs: 0 };
    }

    return { allowed: false, remainingMs: COOLDOWN_MS - elapsed };
  }

  async recordPlacement(botId: string): Promise<void> {
    if (config.useRedis) {
      await setCooldown(botId);
      return;
    }

    this.lastPlacement.set(botId, Date.now());
  }

  async getCooldown(botId: string): Promise<{ remainingMs: number; canPlace: boolean }> {
    const result = await this.canPlace(botId);
    return { remainingMs: result.remainingMs, canPlace: result.allowed };
  }

  // Sync versions for backwards compatibility
  canPlaceSync(botId: string): { allowed: boolean; remainingMs: number } {
    const last = this.lastPlacement.get(botId);
    const now = Date.now();

    if (!last) {
      return { allowed: true, remainingMs: 0 };
    }

    const elapsed = now - last;
    if (elapsed >= COOLDOWN_MS) {
      return { allowed: true, remainingMs: 0 };
    }

    return { allowed: false, remainingMs: COOLDOWN_MS - elapsed };
  }

  recordPlacementSync(botId: string): void {
    this.lastPlacement.set(botId, Date.now());
  }
}

export const rateLimitService = new RateLimitService();
