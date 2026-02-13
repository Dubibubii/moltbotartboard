import express from 'express';
import compression from 'compression';
import cors from 'cors';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import path from 'path';
import { fileURLToPath } from 'url';
import { config, isProduction } from './config.js';
import { apiRouter, getChatMessages, initChat } from './routes/api.js';
import { canvas } from './canvas.js';
import { archiveService } from './services/archive.js';
import { getRedis } from './services/redis.js';
import { initDatabase } from './services/database.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const server = createServer(app);
const MAX_CONNECTIONS = 200;

const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 1e6,
  connectTimeout: 10000,
  pingTimeout: 20000,
  pingInterval: 25000,
});

// Setup Redis adapter for Socket.io (enables horizontal scaling)
async function setupSocketAdapter() {
  const redis = getRedis();
  if (redis) {
    try {
      const subClient = redis.duplicate();
      subClient.on('error', (err: Error) => {
        console.error('Redis sub client error:', err.message);
      });
      io.adapter(createAdapter(redis, subClient));
      console.log('Socket.io using Redis adapter');
    } catch (err) {
      console.error('Redis adapter setup failed, using in-memory adapter:', (err as Error).message);
    }
  }
}

// Initialize services
async function init() {
  // Initialize database (non-fatal if it fails)
  if (config.usePostgres) {
    try {
      await initDatabase();
    } catch (err) {
      console.error('Database init failed (will retry on requests):', (err as Error).message);
    }
  }

  // Initialize canvas (load from Redis if available)
  try {
    await canvas.init();
  } catch (err) {
    console.error('Canvas init from Redis failed:', (err as Error).message);
  }

  // Load archives from persistent storage (after DB is ready)
  try {
    await archiveService.init();
  } catch (err) {
    console.error('Archive init failed:', (err as Error).message);
  }

  // Load chat history from Redis
  try {
    await initChat();
  } catch (err) {
    console.error('Chat init failed:', (err as Error).message);
  }

  // Setup Socket.io Redis adapter
  try {
    await setupSocketAdapter();
  } catch (err) {
    console.error('Socket.io Redis adapter failed:', (err as Error).message);
  }
}

// Trust first proxy hop (Railway reverse proxy)
app.set('trust proxy', 1);

// Middleware
app.use(compression());
app.use(cors());
app.use(express.json({ limit: '10kb' }));

// Serve static files from web folder
app.use(express.static(path.join(__dirname, '../../web')));

// Store io instance on app for use in routes
app.set('io', io);

// Healthcheck (no external dependencies)
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// API routes
app.use('/api', apiRouter);

// WebSocket connections
io.on('connection', (socket) => {
  // Limit max concurrent connections
  if (io.engine.clientsCount > MAX_CONNECTIONS) {
    console.warn(`Max connections (${MAX_CONNECTIONS}) reached, rejecting ${socket.id}`);
    socket.disconnect(true);
    return;
  }

  console.log(`Client connected: ${socket.id} (total: ${io.engine.clientsCount})`);

  // Send current canvas state on connect
  socket.emit('canvas', canvas.getState());

  // Send recent chat messages on connect
  const recentChat = getChatMessages();
  if (recentChat.length > 0) {
    socket.emit('chatHistory', recentChat.slice(-50));
  }

  // Handle request for fresh canvas (after navigation)
  socket.on('requestCanvas', () => {
    socket.emit('canvas', canvas.getState());
  });

  socket.on('disconnect', () => {
    console.log(`Client disconnected: ${socket.id}`);
  });
});

// Broadcast pixel updates (called from API route)
export function broadcastPixel(data: {
  x: number;
  y: number;
  color: string;
  botId: string;
  botName: string;
}) {
  io.emit('pixel', data);
}

// Start server
init().then(() => {
  server.listen(config.port, () => {
    const snapshotTime = new Date(archiveService.getSnapshotTime());
    console.log(`
╔══════════════════════════════════════════╗
║       MOLTBOT ARTBOARD SERVER            ║
╠══════════════════════════════════════════╣
║  Mode: ${isProduction ? 'PRODUCTION' : 'DEVELOPMENT'}                        ║
║  Canvas: ${config.canvas.width}x${config.canvas.height} pixels                 ║
║  Cooldown: 10 minutes per bot            ║
║  Redis: ${config.useRedis ? 'YES' : 'NO'}                              ║
║  Postgres: ${config.usePostgres ? 'YES' : 'NO'}                           ║
║  S3: ${config.useS3 ? 'YES' : 'NO'}                                 ║
║  Next snapshot: ${snapshotTime.toISOString().slice(0, 16)}      ║
║                                          ║
║  API: http://localhost:${config.port}/api         ║
║  Web: http://localhost:${config.port}             ║
╚══════════════════════════════════════════╝
    `);
  });
}).catch((err) => {
  console.error('Failed to initialize:', err);
  process.exit(1);
});

// Graceful shutdown — flush pending Redis canvas save
async function gracefulShutdown() {
  console.log('Shutting down, flushing pending saves...');
  await canvas.flushPendingRedisSave();
  process.exit(0);
}

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

// Prevent crashes from unhandled Redis/connection errors
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception (server continuing):', err.message);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection (server continuing):', reason);
});
