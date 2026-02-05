import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { config } from '../config.js';

let s3Client: S3Client | null = null;

function getS3(): S3Client | null {
  if (!config.useS3) return null;

  if (!s3Client) {
    s3Client = new S3Client({
      endpoint: config.s3.endpoint,
      region: config.s3.region,
      credentials: {
        accessKeyId: config.s3.accessKeyId,
        secretAccessKey: config.s3.secretAccessKey,
      },
    });
  }

  return s3Client;
}

export interface ArchiveMetadata {
  id: string;
  timestamp: number;
  key: string;
}

// Save archive to S3/R2
export async function saveArchiveToS3(
  id: string,
  timestamp: number,
  canvasData: { colors: string[][]; width: number; height: number }
): Promise<boolean> {
  const s3 = getS3();
  if (!s3) return false;

  const key = `archives/${id}.json`;

  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: config.s3.bucket,
        Key: key,
        Body: JSON.stringify(canvasData),
        ContentType: 'application/json',
        Metadata: {
          timestamp: timestamp.toString(),
        },
      })
    );

    // Also update the index file
    await updateArchiveIndex(id, timestamp, key);

    return true;
  } catch (err) {
    console.error('Failed to save archive to S3:', err);
    return false;
  }
}

// Load archive from S3/R2
export async function loadArchiveFromS3(
  id: string
): Promise<{ colors: string[][]; width: number; height: number } | null> {
  const s3 = getS3();
  if (!s3) return null;

  const key = `archives/${id}.json`;

  try {
    const response = await s3.send(
      new GetObjectCommand({
        Bucket: config.s3.bucket,
        Key: key,
      })
    );

    const body = await response.Body?.transformToString();
    if (!body) return null;

    return JSON.parse(body);
  } catch (err) {
    console.error('Failed to load archive from S3:', err);
    return null;
  }
}

// Get list of archives
export async function listArchivesFromS3(): Promise<ArchiveMetadata[]> {
  const s3 = getS3();
  if (!s3) return [];

  try {
    // Try to get the index file first
    const indexResponse = await s3.send(
      new GetObjectCommand({
        Bucket: config.s3.bucket,
        Key: 'archives/index.json',
      })
    );

    const body = await indexResponse.Body?.transformToString();
    if (body) {
      return JSON.parse(body);
    }
  } catch {
    // Index doesn't exist, list objects instead
  }

  // Fallback: list objects
  try {
    const response = await s3.send(
      new ListObjectsV2Command({
        Bucket: config.s3.bucket,
        Prefix: 'archives/',
      })
    );

    const archives: ArchiveMetadata[] = [];
    for (const obj of response.Contents || []) {
      if (obj.Key?.endsWith('.json') && !obj.Key.endsWith('index.json')) {
        const id = obj.Key.replace('archives/', '').replace('.json', '');
        archives.push({
          id,
          timestamp: obj.LastModified?.getTime() || 0,
          key: obj.Key,
        });
      }
    }

    // Sort by timestamp descending
    archives.sort((a, b) => b.timestamp - a.timestamp);
    return archives;
  } catch (err) {
    console.error('Failed to list archives from S3:', err);
    return [];
  }
}

// Update the archive index
async function updateArchiveIndex(
  id: string,
  timestamp: number,
  key: string
): Promise<void> {
  const s3 = getS3();
  if (!s3) return;

  // Get existing index
  let archives: ArchiveMetadata[] = [];
  try {
    const response = await s3.send(
      new GetObjectCommand({
        Bucket: config.s3.bucket,
        Key: 'archives/index.json',
      })
    );

    const body = await response.Body?.transformToString();
    if (body) {
      archives = JSON.parse(body);
    }
  } catch {
    // Index doesn't exist yet
  }

  // Add new archive at the beginning
  archives.unshift({ id, timestamp, key });

  // Save updated index
  await s3.send(
    new PutObjectCommand({
      Bucket: config.s3.bucket,
      Key: 'archives/index.json',
      Body: JSON.stringify(archives),
      ContentType: 'application/json',
    })
  );
}
