import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { canvas } from '../canvas.js';
import { config } from '../config.js';
import {
  saveArchiveToS3,
  loadArchiveFromS3,
  listArchivesFromS3,
  ArchiveMetadata,
} from './storage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARCHIVES_DIR = path.join(__dirname, '../../archives');
const CYCLE_MS = 24 * 60 * 60 * 1000; // 24 hours

interface Archive {
  id: string;
  timestamp: number;
  filename: string;
}

class ArchiveService {
  private archives: Archive[] = [];
  private nextResetTime: number;
  private onReset: (() => void) | null = null;

  constructor() {
    // Ensure archives directory exists (for local fallback)
    if (!fs.existsSync(ARCHIVES_DIR)) {
      fs.mkdirSync(ARCHIVES_DIR, { recursive: true });
    }

    // Load existing archives
    this.loadArchives();

    // Set next reset time to next midnight UTC
    const now = new Date();
    const nextMidnight = new Date(now);
    nextMidnight.setUTCHours(24, 0, 0, 0);
    this.nextResetTime = nextMidnight.getTime();

    // Start the reset timer
    this.scheduleReset();
  }

  private async loadArchives() {
    if (config.useS3) {
      try {
        const s3Archives = await listArchivesFromS3();
        this.archives = s3Archives.map(a => ({
          id: a.id,
          timestamp: a.timestamp,
          filename: a.key,
        }));
        console.log(`Loaded ${this.archives.length} archives from S3`);
        return;
      } catch (e) {
        console.error('Failed to load archives from S3:', e);
      }
    }

    // Local fallback
    try {
      const indexPath = path.join(ARCHIVES_DIR, 'index.json');
      if (fs.existsSync(indexPath)) {
        const data = fs.readFileSync(indexPath, 'utf-8');
        this.archives = JSON.parse(data);
      }
    } catch (e) {
      console.error('Failed to load archives index:', e);
      this.archives = [];
    }
  }

  private saveArchivesIndex() {
    if (config.useS3) return; // S3 manages its own index

    const indexPath = path.join(ARCHIVES_DIR, 'index.json');
    fs.writeFileSync(indexPath, JSON.stringify(this.archives, null, 2));
  }

  private scheduleReset() {
    const timeUntilReset = this.nextResetTime - Date.now();

    if (timeUntilReset <= 0) {
      this.performReset();
    } else {
      setTimeout(() => {
        this.performReset();
      }, timeUntilReset);
    }
  }

  private async performReset() {
    console.log('Performing canvas reset...');

    // Save current canvas
    await this.saveCanvas();

    // Reset canvas
    await canvas.reset();

    // Set next reset time
    this.nextResetTime = Date.now() + CYCLE_MS;

    // Notify listeners
    if (this.onReset) {
      this.onReset();
    }

    // Schedule next reset
    this.scheduleReset();

    console.log('Canvas reset complete. Next reset at:', new Date(this.nextResetTime).toISOString());
  }

  private async saveCanvas() {
    const timestamp = Date.now();
    const id = `archive_${timestamp}`;
    const state = canvas.getState();

    if (config.useS3) {
      const success = await saveArchiveToS3(id, timestamp, state);
      if (success) {
        this.archives.unshift({ id, timestamp, filename: `archives/${id}.json` });
        console.log('Saved archive to S3:', id);
        return;
      }
      console.error('Failed to save to S3, falling back to local');
    }

    // Local fallback
    const filename = `${id}.json`;
    const filepath = path.join(ARCHIVES_DIR, filename);
    fs.writeFileSync(filepath, JSON.stringify(state));

    const archive: Archive = { id, timestamp, filename };
    this.archives.unshift(archive);

    this.saveArchivesIndex();
    console.log('Saved archive locally:', id);
  }

  getResetTime(): number {
    return this.nextResetTime;
  }

  getArchives(): Archive[] {
    return this.archives;
  }

  async getArchive(id: string): Promise<{ colors: string[][]; width: number; height: number } | null> {
    if (config.useS3) {
      const data = await loadArchiveFromS3(id);
      if (data) return data;
    }

    // Local fallback
    const archive = this.archives.find(a => a.id === id);
    if (!archive) return null;

    const filepath = path.join(ARCHIVES_DIR, archive.filename);
    if (!fs.existsSync(filepath)) return null;

    try {
      const data = fs.readFileSync(filepath, 'utf-8');
      return JSON.parse(data);
    } catch (e) {
      console.error('Failed to load archive:', e);
      return null;
    }
  }

  setOnReset(callback: () => void) {
    this.onReset = callback;
  }
}

export const archiveService = new ArchiveService();
