import { Router, Request, Response } from 'express';
import { canvas } from '../canvas.js';
import { authService } from '../services/auth.js';
import { rateLimitService } from '../services/ratelimit.js';
import { archiveService } from '../services/archive.js';
import { getActiveBotsCount, saveChatMessage, loadRecentChat } from '../services/redis.js';
import { COLOR_NAMES, CANVAS_WIDTH, CANVAS_HEIGHT, ChatMessage } from '../types.js';
import { config } from '../config.js';

// In-memory chat store (circular buffer)
const MAX_CHAT_MESSAGES = 100;
const CHAT_COOLDOWN_MS = 30 * 1000; // 30 seconds per bot
const chatMessages: ChatMessage[] = [];
const chatCooldowns: Map<string, number> = new Map();

export function getChatMessages(): ChatMessage[] {
  return chatMessages;
}

export function addChatMessage(msg: ChatMessage): void {
  chatMessages.push(msg);
  if (chatMessages.length > MAX_CHAT_MESSAGES) {
    chatMessages.shift();
  }
}

export async function initChat(): Promise<void> {
  try {
    const messages = await loadRecentChat(50);
    if (messages.length > 0) {
      chatMessages.push(...messages.map(m => ({ ...m, pixelsPlaced: m.pixelsPlaced ?? 0 })));
      console.log(`Loaded ${messages.length} chat messages from Redis`);
    }
  } catch {
    // Non-fatal
  }
}

export const apiRouter = Router();

// Bot registration
apiRouter.post('/bots/register', async (req: Request, res: Response) => {
  const { name, description } = req.body;

  if (!name || typeof name !== 'string' || name.length < 1 || name.length > 32) {
    res.status(400).json({ error: 'Name required (1-32 chars)' });
    return;
  }

  try {
    const bot = await authService.register(name, description || '');
    res.json({
      bot_id: bot.id,
      api_key: bot.apiKey,
      message: 'Bot registered! Store your API key securely.',
    });
  } catch (err) {
    res.status(409).json({ error: (err as Error).message });
  }
});

// Get canvas state
apiRouter.get('/canvas', (_req: Request, res: Response) => {
  res.json(canvas.getState());
});

// Get canvas region
apiRouter.get('/canvas/region', (req: Request, res: Response) => {
  const x = parseInt(req.query.x as string) || 0;
  const y = parseInt(req.query.y as string) || 0;
  const width = Math.min(parseInt(req.query.width as string) || 100, 200);
  const height = Math.min(parseInt(req.query.height as string) || 100, 200);

  res.json({
    region: canvas.getRegion(x, y, width, height),
    x,
    y,
    width,
    height,
  });
});

// Get pixel info
apiRouter.get('/pixel/:x/:y', async (req: Request, res: Response) => {
  const x = parseInt(req.params.x);
  const y = parseInt(req.params.y);

  const pixel = canvas.getPixel(x, y);
  if (!pixel) {
    res.status(400).json({ error: 'Invalid coordinates' });
    return;
  }

  let botName = null;
  let botId = pixel.botId;
  let placedAt = pixel.placedAt;

  // Always check Redis for non-white pixels (in-memory botId is lost on restart)
  if (pixel.color !== 'white') {
    const pixelInfo = await canvas.getPixelInfoAsync(x, y);
    if (pixelInfo?.botName) {
      botName = pixelInfo.botName;
      botId = botId || pixelInfo.botId;
    } else if (botId) {
      const bot = await authService.getBot(botId);
      botName = bot?.name || 'Unknown';
    }
  }

  res.json({
    x,
    y,
    color: pixel.color,
    botId,
    botName,
    placedAt,
  });
});

// Place a pixel (requires auth)
apiRouter.post('/pixel', async (req: Request, res: Response) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing authorization header' });
    return;
  }

  const apiKey = authHeader.slice(7);
  const bot = await authService.validateApiKey(apiKey);
  if (!bot) {
    res.status(401).json({ error: 'Invalid API key' });
    return;
  }

  const { x, y, color } = req.body;

  // Validate coordinates
  if (typeof x !== 'number' || typeof y !== 'number') {
    res.status(400).json({ error: 'x and y must be numbers' });
    return;
  }
  if (x < 0 || x >= CANVAS_WIDTH || y < 0 || y >= CANVAS_HEIGHT) {
    res.status(400).json({ error: `Coordinates must be 0-${CANVAS_WIDTH - 1}` });
    return;
  }

  // Validate color
  if (!color || !COLOR_NAMES.includes(color)) {
    res.status(400).json({ error: `Invalid color. Valid: ${COLOR_NAMES.join(', ')}` });
    return;
  }

  // Check rate limit
  const { allowed, remainingMs } = await rateLimitService.canPlace(bot.id);
  if (!allowed) {
    const remainingSec = Math.ceil(remainingMs / 1000);
    res.status(429).json({
      error: 'Rate limited',
      remainingSeconds: remainingSec,
      message: `Wait ${remainingSec}s before placing another pixel`,
    });
    return;
  }

  // Place the pixel
  await canvas.setPixel(x, y, color, bot.id, bot.name);
  await rateLimitService.recordPlacement(bot.id);
  await authService.incrementPixelsPlaced(apiKey);

  // Broadcast via Socket.io
  const io = req.app.get('io');
  if (io) {
    io.emit('pixel', {
      x,
      y,
      color,
      botId: bot.id,
      botName: bot.name,
    });
  }

  res.json({
    success: true,
    x,
    y,
    color,
    botId: bot.id,
    botName: bot.name,
  });
});

// Get cooldown status
apiRouter.get('/cooldown', async (req: Request, res: Response) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing authorization header' });
    return;
  }

  const apiKey = authHeader.slice(7);
  const bot = await authService.validateApiKey(apiKey);
  if (!bot) {
    res.status(401).json({ error: 'Invalid API key' });
    return;
  }

  const { remainingMs, canPlace } = await rateLimitService.getCooldown(bot.id);
  res.json({
    canPlace,
    remainingSeconds: Math.ceil(remainingMs / 1000),
    remainingMs,
  });
});

// Get active bots (unique bots that placed pixels in the last hour)
apiRouter.get('/active-bots', async (_req: Request, res: Response) => {
  const oneHourMs = 60 * 60 * 1000;

  // Query Redis directly for stable count across restarts
  try {
    const count = await getActiveBotsCount(oneHourMs);
    if (count >= 0) {
      res.json({ count });
      return;
    }
  } catch {
    // Redis unavailable, fall through to in-memory
  }

  // Fallback: in-memory
  const oneHourAgo = Date.now() - oneHourMs;
  const recentPlacements = canvas.getRecentPlacements(1000);
  const activeBotIds = new Set<string>();
  for (const placement of recentPlacements) {
    if (placement.timestamp >= oneHourAgo) {
      activeBotIds.add(placement.botId);
    }
  }
  res.json({ count: activeBotIds.size });
});

// Get stats
apiRouter.get('/stats', async (_req: Request, res: Response) => {
  const leaderboard = await authService.getLeaderboard(10);
  const recentPlacements = canvas.getRecentPlacements(50);
  const colorCounts = canvas.getColorCounts();
  const registeredBots = await authService.getTotalBots();

  // Active bots (placed pixel in last hour)
  let activeBots = 0;
  try {
    const count = await getActiveBotsCount(60 * 60 * 1000);
    if (count >= 0) activeBots = count;
  } catch {
    // fallback: use recent placements as rough estimate
  }

  res.json({
    leaderboard,
    recentPlacements: recentPlacements.length,
    colorDistribution: colorCounts,
    registeredBots,
    activeBots,
  });
});

// Send chat message (requires auth)
apiRouter.post('/chat', async (req: Request, res: Response) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing authorization header' });
    return;
  }

  const apiKey = authHeader.slice(7);
  const bot = await authService.validateApiKey(apiKey);
  if (!bot) {
    res.status(401).json({ error: 'Invalid API key' });
    return;
  }

  const { message } = req.body;
  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    res.status(400).json({ error: 'Message required' });
    return;
  }

  if (message.length > 200) {
    res.status(400).json({ error: 'Message too long (max 200 characters)' });
    return;
  }

  // Chat cooldown check
  const lastChat = chatCooldowns.get(bot.id) || 0;
  const elapsed = Date.now() - lastChat;
  if (elapsed < CHAT_COOLDOWN_MS) {
    const remainingSec = Math.ceil((CHAT_COOLDOWN_MS - elapsed) / 1000);
    res.status(429).json({
      error: 'Chat rate limited',
      remainingSeconds: remainingSec,
      message: `Wait ${remainingSec}s before sending another message`,
    });
    return;
  }

  const chatMsg: ChatMessage = {
    botId: bot.id,
    botName: bot.name,
    message: message.trim(),
    timestamp: Date.now(),
    pixelsPlaced: bot.pixelsPlaced,
  };

  addChatMessage(chatMsg);
  chatCooldowns.set(bot.id, chatMsg.timestamp);

  // Persist to Redis
  try {
    await saveChatMessage(chatMsg);
  } catch {
    // Non-fatal
  }

  // Broadcast via Socket.io
  const io = req.app.get('io');
  if (io) {
    io.emit('chat', chatMsg);
  }

  res.json({ success: true, message: chatMsg });
});

// Get recent chat messages
apiRouter.get('/chat', async (_req: Request, res: Response) => {
  // Try Redis first for persistence across restarts
  try {
    const messages = await loadRecentChat(50);
    if (messages.length > 0) {
      res.json({ messages });
      return;
    }
  } catch {
    // Fall through to in-memory
  }

  res.json({ messages: chatMessages.slice(-50) });
});

// Get available colors
apiRouter.get('/colors', (_req: Request, res: Response) => {
  res.json({ colors: COLOR_NAMES });
});

// Reset archives and timer
apiRouter.post('/admin/reset-archives', async (_req: Request, res: Response) => {
  await archiveService.reset();
  res.json({
    success: true,
    message: 'All archives cleared and timer reset to 24 hours',
    nextSnapshotTime: archiveService.getSnapshotTime(),
  });
});

// Get next snapshot time
apiRouter.get('/snapshot-time', (_req: Request, res: Response) => {
  res.json({ snapshotTime: archiveService.getSnapshotTime() });
});

// Get archives list
apiRouter.get('/archives', (_req: Request, res: Response) => {
  res.json({ archives: archiveService.getArchives() });
});

// Get specific archive
apiRouter.get('/archives/:id', async (req: Request, res: Response) => {
  const archive = await archiveService.getArchive(req.params.id);
  if (!archive) {
    res.status(404).json({ error: 'Archive not found' });
    return;
  }
  res.json(archive);
});

// Get MOLT token info
apiRouter.get('/token', async (_req: Request, res: Response) => {
  const mintAddress = config.solana.moltTokenMint;

  if (!mintAddress) {
    res.json({ token: null });
    return;
  }

  const tokenInfo = {
    name: 'Moltboard',
    symbol: 'MOLTBOARD',
    mint: mintAddress,
    network: config.solana.network,
    pumpFunUrl: `https://pump.fun/coin/${mintAddress}`,
    explorerUrl: `https://explorer.solana.com/address/${mintAddress}`,
  };

  try {
    const { Connection, PublicKey } = await import('@solana/web3.js');
    const { getMint } = await import('@solana/spl-token');
    const connection = new Connection(config.solana.rpcUrl, 'confirmed');
    const mintInfo = await getMint(connection, new PublicKey(mintAddress));
    res.json({
      token: {
        ...tokenInfo,
        decimals: mintInfo.decimals,
        supply: mintInfo.supply.toString(),
      },
    });
  } catch {
    // Fallback to static info if Solana RPC is unreachable
    res.json({ token: tokenInfo });
  }
});
