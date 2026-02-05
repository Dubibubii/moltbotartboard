import { Router, Request, Response } from 'express';
import { canvas } from '../canvas.js';
import { authService } from '../services/auth.js';
import { rateLimitService } from '../services/ratelimit.js';
import { archiveService } from '../services/archive.js';
import { getActiveBotsCount } from '../services/redis.js';
import { COLOR_NAMES, CANVAS_WIDTH, CANVAS_HEIGHT } from '../types.js';

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
  const leaderboard = await authService.getLeaderboard(20);
  const recentPlacements = canvas.getRecentPlacements(50);
  const state = canvas.getState();
  const totalBots = await authService.getTotalBots();

  // Count colors
  const colorCounts: Record<string, number> = {};
  for (const row of state.colors) {
    for (const color of row) {
      colorCounts[color] = (colorCounts[color] || 0) + 1;
    }
  }

  res.json({
    leaderboard,
    recentPlacements: recentPlacements.length,
    colorDistribution: colorCounts,
    totalBots,
  });
});

// Get available colors
apiRouter.get('/colors', (_req: Request, res: Response) => {
  res.json({ colors: COLOR_NAMES });
});

// Get reset time
apiRouter.get('/reset-time', (_req: Request, res: Response) => {
  res.json({ resetTime: archiveService.getResetTime() });
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
