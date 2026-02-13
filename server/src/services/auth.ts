import { v4 as uuidv4 } from 'uuid';
import { Bot } from '../types.js';
import { config } from '../config.js';
import {
  createBot as dbCreateBot,
  getBotByApiKey as dbGetBotByApiKey,
  getBotById as dbGetBotById,
  getBotByName as dbGetBotByName,
  incrementBotPixels as dbIncrementBotPixels,
  getLeaderboard as dbGetLeaderboard,
  getTotalBots as dbGetTotalBots,
  getAllBotsWithIp as dbGetAllBotsWithIp,
} from './database.js';

class AuthService {
  // In-memory storage (fallback when no database)
  private bots: Map<string, Bot> = new Map(); // apiKey -> Bot
  private botsByName: Map<string, Bot> = new Map(); // name -> Bot
  private botsById: Map<string, Bot> = new Map(); // id -> Bot

  async register(name: string, description: string, registrationIp?: string): Promise<Bot> {
    const id = `bot_${uuidv4().slice(0, 8)}`;
    const apiKey = `artboard_sk_${uuidv4().replace(/-/g, '')}`;

    if (config.usePostgres) {
      const dbBot = await dbCreateBot(id, apiKey, name, description, registrationIp);
      if (!dbBot) {
        throw new Error('Bot name already taken');
      }
      return {
        id: dbBot.id,
        name: dbBot.name,
        description: dbBot.description || '',
        apiKey: dbBot.apiKey,
        createdAt: dbBot.createdAt.getTime(),
        pixelsPlaced: dbBot.pixelsPlaced,
        registrationIp: dbBot.registrationIp || undefined,
      };
    }

    // In-memory fallback
    if (this.botsByName.has(name.toLowerCase())) {
      throw new Error('Bot name already taken');
    }

    const bot: Bot = {
      id,
      name,
      description,
      apiKey,
      createdAt: Date.now(),
      pixelsPlaced: 0,
      registrationIp,
    };

    this.bots.set(bot.apiKey, bot);
    this.botsByName.set(name.toLowerCase(), bot);
    this.botsById.set(bot.id, bot);

    return bot;
  }

  async validateApiKey(apiKey: string): Promise<Bot | null> {
    if (config.usePostgres) {
      const dbBot = await dbGetBotByApiKey(apiKey);
      if (!dbBot) return null;
      return {
        id: dbBot.id,
        name: dbBot.name,
        description: dbBot.description || '',
        apiKey: dbBot.apiKey,
        createdAt: dbBot.createdAt.getTime(),
        pixelsPlaced: dbBot.pixelsPlaced,
      };
    }

    return this.bots.get(apiKey) || null;
  }

  async getBot(botId: string): Promise<Bot | null> {
    if (config.usePostgres) {
      const dbBot = await dbGetBotById(botId);
      if (!dbBot) return null;
      return {
        id: dbBot.id,
        name: dbBot.name,
        description: dbBot.description || '',
        apiKey: dbBot.apiKey,
        createdAt: dbBot.createdAt.getTime(),
        pixelsPlaced: dbBot.pixelsPlaced,
      };
    }

    return this.botsById.get(botId) || null;
  }

  async getBotByName(name: string): Promise<Bot | null> {
    if (config.usePostgres) {
      const dbBot = await dbGetBotByName(name);
      if (!dbBot) return null;
      return {
        id: dbBot.id,
        name: dbBot.name,
        description: dbBot.description || '',
        apiKey: dbBot.apiKey,
        createdAt: dbBot.createdAt.getTime(),
        pixelsPlaced: dbBot.pixelsPlaced,
      };
    }

    return this.botsByName.get(name.toLowerCase()) || null;
  }

  async incrementPixelsPlaced(apiKey: string): Promise<void> {
    if (config.usePostgres) {
      const bot = await dbGetBotByApiKey(apiKey);
      if (bot) {
        await dbIncrementBotPixels(bot.id);
      }
      return;
    }

    const bot = this.bots.get(apiKey);
    if (bot) {
      bot.pixelsPlaced++;
    }
  }

  async getLeaderboard(limit: number = 10): Promise<{ name: string; pixelsPlaced: number }[]> {
    if (config.usePostgres) {
      return dbGetLeaderboard(limit);
    }

    return Array.from(this.bots.values())
      .sort((a, b) => b.pixelsPlaced - a.pixelsPlaced)
      .slice(0, limit)
      .map(b => ({ name: b.name, pixelsPlaced: b.pixelsPlaced }));
  }

  async getTotalBots(): Promise<number> {
    if (config.usePostgres) {
      return dbGetTotalBots();
    }

    return this.bots.size;
  }

  // Sync versions for backwards compatibility
  validateApiKeySync(apiKey: string): Bot | null {
    return this.bots.get(apiKey) || null;
  }

  getBotSync(botId: string): Bot | null {
    return this.botsById.get(botId) || null;
  }

  getAllBots(): Bot[] {
    return Array.from(this.bots.values());
  }

  async getBotIpMap(): Promise<Map<string, string | null>> {
    if (config.usePostgres) {
      try {
        const bots = await dbGetAllBotsWithIp();
        const map = new Map<string, string | null>();
        for (const bot of bots) {
          map.set(bot.id, bot.registrationIp);
        }
        return map;
      } catch {
        // Fall through to in-memory
      }
    }

    const map = new Map<string, string | null>();
    for (const bot of this.bots.values()) {
      map.set(bot.id, bot.registrationIp || null);
    }
    return map;
  }
}

export const authService = new AuthService();
