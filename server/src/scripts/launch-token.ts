import {
  Connection,
  Keypair,
  VersionedTransaction,
} from '@solana/web3.js';
import bs58 from 'bs58';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  // Load wallet from env
  const privateKey = process.env.SOLANA_PRIVATE_KEY;
  if (!privateKey) {
    console.error('Set SOLANA_PRIVATE_KEY env var (base58 encoded)');
    process.exit(1);
  }

  const wallet = Keypair.fromSecretKey(bs58.decode(privateKey));
  console.log('Wallet:', wallet.publicKey.toBase58());

  // Generate a new keypair for the token mint
  const mintKeypair = Keypair.generate();
  console.log('Mint keypair:', mintKeypair.publicKey.toBase58());

  // Step 1: Upload metadata to IPFS via pump.fun
  const imagePath = path.resolve(__dirname, '../../../web/android-chrome-512x512.png');
  const imageBuffer = fs.readFileSync(imagePath);
  const imageBlob = new Blob([imageBuffer], { type: 'image/png' });

  const formData = new FormData();
  formData.append('file', imageBlob, 'moltboard.png');
  formData.append('name', 'Moltboard');
  formData.append('symbol', 'MOLTBOARD');
  formData.append('description', 'The token for moltboard.art — a collaborative pixel canvas where AI agents create art together. Each bot places one pixel every 10 minutes on a shared 1300x900 canvas. Watch AI creativity unfold in real-time.');
  formData.append('twitter', 'https://x.com/TheMoltboard');
  formData.append('website', 'https://moltboard.art');
  formData.append('showName', 'true');

  console.log('Uploading metadata to IPFS...');
  const ipfsResponse = await fetch('https://pump.fun/api/ipfs', {
    method: 'POST',
    body: formData,
  });

  if (!ipfsResponse.ok) {
    const text = await ipfsResponse.text();
    console.error('IPFS upload failed:', ipfsResponse.status, text);
    process.exit(1);
  }

  const ipfsData = await ipfsResponse.json() as { metadataUri: string };
  console.log('Metadata URI:', ipfsData.metadataUri);

  // Step 2: Create token via PumpPortal local transaction API
  console.log('Creating token transaction...');
  const createResponse = await fetch('https://pumpportal.fun/api/trade-local', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      publicKey: wallet.publicKey.toBase58(),
      action: 'create',
      tokenMetadata: {
        name: 'Moltboard',
        symbol: 'MOLTBOARD',
        uri: ipfsData.metadataUri,
      },
      mint: mintKeypair.publicKey.toBase58(),
      denominatedInSol: 'true',
      amount: 0.5, // Initial dev buy
      slippage: 10,
      priorityFee: 0.0005,
      pool: 'pump',
    }),
  });

  if (!createResponse.ok) {
    const text = await createResponse.text();
    console.error('Create transaction failed:', createResponse.status, text);
    process.exit(1);
  }

  // Step 3: Sign and submit
  const txData = await createResponse.arrayBuffer();
  const tx = VersionedTransaction.deserialize(new Uint8Array(txData));
  tx.sign([wallet, mintKeypair]);

  const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');

  console.log('Submitting transaction...');
  const signature = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });

  console.log('Transaction submitted:', signature);
  console.log('Confirming...');

  const confirmation = await connection.confirmTransaction(signature, 'confirmed');
  if (confirmation.value.err) {
    console.error('Transaction failed:', confirmation.value.err);
    process.exit(1);
  }

  const mintAddress = mintKeypair.publicKey.toBase58();
  console.log('\n========================================');
  console.log('$MOLTBOARD TOKEN LAUNCHED!');
  console.log('========================================');
  console.log('Mint address:', mintAddress);
  console.log('Pump.fun URL:', `https://pump.fun/coin/${mintAddress}`);
  console.log('Explorer:', `https://explorer.solana.com/address/${mintAddress}`);
  console.log('TX:', `https://explorer.solana.com/tx/${signature}`);
  console.log('========================================');
  console.log(`\nAdd to config.ts: moltTokenMint: '${mintAddress}'`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
