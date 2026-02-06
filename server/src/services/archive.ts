import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { canvas } from '../canvas.js';
import { config } from '../config.js';
import {
  saveArchiveToS3,
  loadArchiveFromS3,
  listArchivesFromS3,
} from './storage.js';
import {
  saveArchiveToDb,
  loadArchiveFromDb,
  listArchivesFromDb,
} from './database.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARCHIVES_DIR = path.join(__dirname, '../../archives');
const CYCLE_MS = 24 * 60 * 60 * 1000; // 24 hours

interface Archive {
  id: string;
  timestamp: number;
}

class ArchiveService {
  private archives: Archive[] = [];
  private nextSnapshotTime: number;

  constructor() {
    // Ensure archives directory exists (for local dev fallback)
    if (!fs.existsSync(ARCHIVES_DIR)) {
      fs.mkdirSync(ARCHIVES_DIR, { recursive: true });
    }

    // Set next snapshot time to next midnight UTC
    const now = new Date();
    const nextMidnight = new Date(now);
    nextMidnight.setUTCHours(24, 0, 0, 0);
    this.nextSnapshotTime = nextMidnight.getTime();

    // Start the snapshot timer
    this.scheduleSnapshot();
  }

  // Must be called after database is initialized
  async init() {
    await this.loadArchives();
  }

  private async loadArchives() {
    // Try Postgres first (persistent across deploys)
    if (config.usePostgres) {
      try {
        const dbArchives = await listArchivesFromDb();
        if (dbArchives.length > 0) {
          this.archives = dbArchives;
          console.log(`Loaded ${this.archives.length} archives from Postgres`);
          return;
        }
      } catch (e) {
        console.error('Failed to load archives from Postgres:', e);
      }
    }

    // Try S3
    if (config.useS3) {
      try {
        const s3Archives = await listArchivesFromS3();
        this.archives = s3Archives.map(a => ({
          id: a.id,
          timestamp: a.timestamp,
        }));
        console.log(`Loaded ${this.archives.length} archives from S3`);
        return;
      } catch (e) {
        console.error('Failed to load archives from S3:', e);
      }
    }

    // Local fallback (dev only, lost on deploy)
    try {
      const indexPath = path.join(ARCHIVES_DIR, 'index.json');
      if (fs.existsSync(indexPath)) {
        const data = fs.readFileSync(indexPath, 'utf-8');
        this.archives = JSON.parse(data);
        console.log(`Loaded ${this.archives.length} archives from local filesystem`);
      }
    } catch (e) {
      console.error('Failed to load archives index:', e);
      this.archives = [];
    }
  }

  private scheduleSnapshot() {
    const timeUntilSnapshot = this.nextSnapshotTime - Date.now();

    if (timeUntilSnapshot <= 0) {
      this.performSnapshot();
    } else {
      setTimeout(() => {
        this.performSnapshot();
      }, timeUntilSnapshot);
    }
  }

  private async performSnapshot() {
    console.log('Taking canvas snapshot...');

    await this.saveCanvas();

    this.nextSnapshotTime = Date.now() + CYCLE_MS;
    this.scheduleSnapshot();

    console.log('Snapshot saved. Next snapshot at:', new Date(this.nextSnapshotTime).toISOString());
  }

  private async saveCanvas() {
    const timestamp = Date.now();
    const id = `archive_${timestamp}`;
    const state = canvas.getState();

    // Save to Postgres (primary persistent store)
    if (config.usePostgres) {
      const success = await saveArchiveToDb(id, timestamp, state);
      if (success) {
        this.archives.unshift({ id, timestamp });
        console.log('Saved archive to Postgres:', id);
        return;
      }
      console.error('Failed to save to Postgres');
    }

    // Save to S3 (secondary persistent store)
    if (config.useS3) {
      const success = await saveArchiveToS3(id, timestamp, state);
      if (success) {
        this.archives.unshift({ id, timestamp });
        console.log('Saved archive to S3:', id);
        return;
      }
      console.error('Failed to save to S3');
    }

    // Local fallback (dev only)
    const filename = `${id}.json`;
    const filepath = path.join(ARCHIVES_DIR, filename);
    fs.writeFileSync(filepath, JSON.stringify(state));

    this.archives.unshift({ id, timestamp });

    const indexPath = path.join(ARCHIVES_DIR, 'index.json');
    fs.writeFileSync(indexPath, JSON.stringify(this.archives, null, 2));
    console.log('Saved archive locally:', id);
  }

  getSnapshotTime(): number {
    return this.nextSnapshotTime;
  }

  getArchives(): Archive[] {
    return this.archives;
  }

  async getArchive(id: string): Promise<{ colors: string[][]; width: number; height: number } | null> {
    // Try Postgres first
    if (config.usePostgres) {
      try {
        const data = await loadArchiveFromDb(id);
        if (data) return data;
      } catch (e) {
        console.error('Failed to load archive from Postgres:', e);
      }
    }

    // Try S3
    if (config.useS3) {
      try {
        const data = await loadArchiveFromS3(id);
        if (data) return data;
      } catch (e) {
        console.error('Failed to load archive from S3:', e);
      }
    }

    // Local fallback
    const filepath = path.join(ARCHIVES_DIR, `${id}.json`);
    if (!fs.existsSync(filepath)) return null;

    try {
      const data = fs.readFileSync(filepath, 'utf-8');
      return JSON.parse(data);
    } catch (e) {
      console.error('Failed to load archive from local:', e);
      return null;
    }
  }
}

export const archiveService = new ArchiveService();
