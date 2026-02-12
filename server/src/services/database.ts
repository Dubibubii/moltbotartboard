import pg from 'pg';
import { config } from '../config.js';

const { Pool } = pg;

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool | null {
  if (!config.usePostgres) return null;

  if (!pool) {
    pool = new Pool({
      connectionString: config.databaseUrl,
      ssl: config.nodeEnv === 'production' ? { rejectUnauthorized: false } : false,
      max: 10,
    });

    pool.on('error', (err) => {
      console.error('Database pool error:', err);
    });
  }

  return pool;
}

// Initialize database schema
export async function initDatabase(): Promise<void> {
  const pool = getPool();
  if (!pool) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS bots (
      id VARCHAR(32) PRIMARY KEY,
      api_key VARCHAR(64) UNIQUE NOT NULL,
      name VARCHAR(32) UNIQUE NOT NULL,
      description TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      pixels_placed INTEGER DEFAULT 0,
      last_placement TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_bots_api_key ON bots(api_key);
    CREATE INDEX IF NOT EXISTS idx_bots_name ON bots(name);

    CREATE TABLE IF NOT EXISTS archives (
      id VARCHAR(64) PRIMARY KEY,
      timestamp BIGINT NOT NULL,
      canvas_data JSONB NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_archives_timestamp ON archives(timestamp DESC);
  `);

  console.log('Database schema initialized');
}

// Bot operations
export interface Bot {
  id: string;
  apiKey: string;
  name: string;
  description: string | null;
  createdAt: Date;
  pixelsPlaced: number;
  lastPlacement: Date | null;
}

export async function createBot(
  id: string,
  apiKey: string,
  name: string,
  description?: string
): Promise<Bot | null> {
  const pool = getPool();
  if (!pool) return null;

  try {
    const result = await pool.query(
      `INSERT INTO bots (id, api_key, name, description)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [id, apiKey, name, description || null]
    );

    return rowToBot(result.rows[0]);
  } catch (err: any) {
    if (err.code === '23505') {
      // Unique constraint violation
      return null;
    }
    throw err;
  }
}

export async function getBotByApiKey(apiKey: string): Promise<Bot | null> {
  const pool = getPool();
  if (!pool) return null;

  const result = await pool.query(
    'SELECT * FROM bots WHERE api_key = $1',
    [apiKey]
  );

  return result.rows[0] ? rowToBot(result.rows[0]) : null;
}

export async function getBotById(id: string): Promise<Bot | null> {
  const pool = getPool();
  if (!pool) return null;

  const result = await pool.query(
    'SELECT * FROM bots WHERE id = $1',
    [id]
  );

  return result.rows[0] ? rowToBot(result.rows[0]) : null;
}

export async function getBotByName(name: string): Promise<Bot | null> {
  const pool = getPool();
  if (!pool) return null;

  const result = await pool.query(
    'SELECT * FROM bots WHERE name = $1',
    [name]
  );

  return result.rows[0] ? rowToBot(result.rows[0]) : null;
}

export async function incrementBotPixels(id: string): Promise<void> {
  const pool = getPool();
  if (!pool) return;

  await pool.query(
    `UPDATE bots
     SET pixels_placed = pixels_placed + 1, last_placement = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [id]
  );
}

export async function getLeaderboard(limit: number = 10): Promise<Array<{ name: string; pixelsPlaced: number }>> {
  const pool = getPool();
  if (!pool) return [];

  const result = await pool.query(
    `SELECT name, pixels_placed FROM bots
     WHERE pixels_placed > 0
     ORDER BY pixels_placed DESC
     LIMIT $1`,
    [limit]
  );

  return result.rows.map(row => ({
    name: row.name,
    pixelsPlaced: row.pixels_placed,
  }));
}

export async function getTotalBots(): Promise<number> {
  const pool = getPool();
  if (!pool) return 0;

  const result = await pool.query('SELECT COUNT(*) FROM bots');
  return parseInt(result.rows[0].count, 10);
}

// Archive operations
export interface ArchiveRow {
  id: string;
  timestamp: number;
}

export async function saveArchiveToDb(
  id: string,
  timestamp: number,
  canvasData: { colors: string[][]; width: number; height: number }
): Promise<boolean> {
  const pool = getPool();
  if (!pool) return false;

  try {
    await pool.query(
      `INSERT INTO archives (id, timestamp, canvas_data)
       VALUES ($1, $2, $3)
       ON CONFLICT (id) DO NOTHING`,
      [id, timestamp, JSON.stringify(canvasData)]
    );
    return true;
  } catch (err) {
    console.error('Failed to save archive to DB:', err);
    return false;
  }
}

export async function loadArchiveFromDb(
  id: string
): Promise<{ colors: string[][]; width: number; height: number } | null> {
  const pool = getPool();
  if (!pool) return null;

  try {
    const result = await pool.query(
      'SELECT canvas_data FROM archives WHERE id = $1',
      [id]
    );
    return result.rows[0]?.canvas_data || null;
  } catch (err) {
    console.error('Failed to load archive from DB:', err);
    return null;
  }
}

export async function listArchivesFromDb(): Promise<ArchiveRow[]> {
  const pool = getPool();
  if (!pool) return [];

  try {
    const result = await pool.query(
      'SELECT id, timestamp FROM archives ORDER BY timestamp DESC'
    );
    return result.rows.map(row => ({
      id: row.id,
      timestamp: parseInt(row.timestamp, 10),
    }));
  } catch (err) {
    console.error('Failed to list archives from DB:', err);
    return [];
  }
}

export async function clearAllArchives(): Promise<boolean> {
  const pool = getPool();
  if (!pool) return false;

  try {
    await pool.query('DELETE FROM archives');
    console.log('Cleared all archives from Postgres');
    return true;
  } catch (err) {
    console.error('Failed to clear archives from DB:', err);
    return false;
  }
}

function rowToBot(row: any): Bot {
  return {
    id: row.id,
    apiKey: row.api_key,
    name: row.name,
    description: row.description,
    createdAt: row.created_at,
    pixelsPlaced: row.pixels_placed,
    lastPlacement: row.last_placement,
  };
}
