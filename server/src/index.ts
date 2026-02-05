import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import path from 'path';
import { fileURLToPath } from 'url';
import { config, isProduction } from './config.js';
import { apiRouter } from './routes/api.js';
import { canvas } from './canvas.js';
import { archiveService } from './services/archive.js';
import { getRedis } from './services/redis.js';
import { initDatabase } from './services/database.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
});

// Setup Redis adapter for Socket.io (enables horizontal scaling)
async function setupSocketAdapter() {
  const redis = getRedis();
  if (redis) {
    const subClient = redis.duplicate({ maxRetriesPerRequest: null });
    subClient.on('error', (err: Error) => {
      console.error('Redis sub client error:', err.message);
    });
    io.adapter(createAdapter(redis, subClient));
    console.log('Socket.io using Redis adapter');
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

  // Setup Socket.io Redis adapter
  try {
    await setupSocketAdapter();
  } catch (err) {
    console.error('Socket.io Redis adapter failed:', (err as Error).message);
  }
}

// Middleware
app.use(cors());
app.use(express.json());

// Serve static files from web folder
app.use(express.static(path.join(__dirname, '../../web')));

// Simple healthcheck that doesn't depend on Redis/Postgres
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// Store io instance on app for use in routes
app.set('io', io);

// API routes
app.use('/api', apiRouter);

// WebSocket connections
io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`);

  // Send current canvas state on connect
  socket.emit('canvas', canvas.getState());

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

// Handle canvas reset - broadcast new canvas to all clients
archiveService.setOnReset(() => {
  console.log('Broadcasting canvas reset to all clients');
  io.emit('reset');
  io.emit('canvas', canvas.getState());
});

// Start server immediately (so healthcheck passes), then init services in background
server.listen(config.port, () => {
  const resetTime = new Date(archiveService.getResetTime());
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
║  Next reset: ${resetTime.toISOString().slice(0, 16)}        ║
║                                          ║
║  API: http://localhost:${config.port}/api         ║
║  Web: http://localhost:${config.port}             ║
╚══════════════════════════════════════════╝
  `);

  // Initialize services after server is listening
  init().catch((err) => {
    console.error('Service initialization failed (server still running):', err);
  });
});

// Prevent crashes from unhandled Redis/connection errors
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception (server continuing):', err.message);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection (server continuing):', reason);
});
