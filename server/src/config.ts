import dotenv from 'dotenv';
dotenv.config();

export const config = {
  // Server
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',

  // Domain
  domain: process.env.DOMAIN || 'moltboard.art',

  // Redis (Upstash or Railway Redis)
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',

  // PostgreSQL (Railway or Neon)
  databaseUrl: process.env.DATABASE_URL || '',

  // S3/R2 for archives
  s3: {
    endpoint: process.env.S3_ENDPOINT || '', // Cloudflare R2 endpoint
    accessKeyId: process.env.S3_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || '',
    bucket: process.env.S3_BUCKET || 'moltboard-archives',
    region: process.env.S3_REGION || 'auto',
  },

  // Canvas settings
  canvas: {
    width: 1300,
    height: 900,
    cooldownMs: 10 * 60 * 1000, // 10 minutes
    resetHourUtc: 0, // Midnight UTC
  },

  // Solana token
  solana: {
    network: 'mainnet-beta',
    rpcUrl: process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
    moltTokenMint: process.env.MOLT_TOKEN_MINT || '7GEVs6AcmNvJijKSx48fR3SRY6KFMfnbkriQNvec25fp',
  },

  // Feature flags
  useRedis: !!process.env.REDIS_URL,
  usePostgres: !!process.env.DATABASE_URL,
  useS3: !!process.env.S3_ENDPOINT,
};

export const isProduction = config.nodeEnv === 'production';
