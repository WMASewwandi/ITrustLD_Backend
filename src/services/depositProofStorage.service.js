import fs from 'fs/promises';
import path from 'node:path';
import { env } from '../config/env.js';
import { getApiBaseUrl } from './blogStorage.service.js';

function depositsDir() {
  return path.resolve(env.projectRoot, '../ITrustLD_Existing/storage/app/deposits');
}

function publicDepositsDir() {
  return path.resolve(env.projectRoot, '../ITrustLD_Existing/public/deposits');
}

export function normalizeProofKey(proofKey) {
  const raw = String(proofKey || '')
    .trim()
    .replace(/^\/+/, '')
    .replace(/\\/g, '/');
  if (!raw || raw.includes('..')) {
    const error = new Error('Invalid proof path.');
    error.status = 400;
    throw error;
  }
  return raw;
}

function encodeProofPath(proofKey) {
  return proofKey
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function buildLaravelProofUrl(proofKey) {
  const appUrl = (process.env.APP_URL || 'http://localhost').replace(/\/$/, '');
  return `${appUrl}/deposits/${encodeProofPath(proofKey)}`;
}

function buildS3ProofUrl(proofKey) {
  const bucket = process.env.AWS_BUCKET;
  const configuredUrl = (process.env.AWS_URL || '').replace(/\/$/, '');
  const usesS3 =
    (process.env.FILESYSTEM_DISK || '').toLowerCase() === 's3' || Boolean(bucket);
  if (!usesS3) return null;

  const base =
    configuredUrl ||
    (bucket
      ? `https://${bucket}.s3.${process.env.AWS_DEFAULT_REGION || 'us-east-1'}.amazonaws.com`
      : null);
  if (!base) return null;
  return `${base}/deposits/${encodeProofPath(proofKey)}`;
}

export function buildDepositProofApiUrl(proofKey) {
  if (!proofKey) return null;
  if (/^https?:\/\//i.test(proofKey)) return proofKey;
  return `${getApiBaseUrl()}/admin/deposits/proof?path=${encodeURIComponent(normalizeProofKey(proofKey))}`;
}

export function guessDepositProofMimeType(proofKey) {
  const ext = path.extname(proofKey).slice(1).toLowerCase();
  switch (ext) {
    case 'png':
      return 'image/png';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    case 'bmp':
      return 'image/bmp';
    default:
      return 'image/jpeg';
  }
}

async function readLocalFile(filePath) {
  try {
    await fs.access(filePath);
    return fs.readFile(filePath);
  } catch {
    return null;
  }
}

async function fetchRemoteBuffer(url) {
  const response = await fetch(url);
  if (!response.ok) return null;
  return Buffer.from(await response.arrayBuffer());
}

export async function readDepositProofBuffer(proofKey) {
  const normalized = normalizeProofKey(proofKey);
  const localCandidates = [
    path.join(depositsDir(), normalized),
    path.join(publicDepositsDir(), normalized),
  ];

  for (const filePath of localCandidates) {
    const resolved = path.resolve(filePath);
    const allowedRoots = [path.resolve(depositsDir()), path.resolve(publicDepositsDir())];
    if (!allowedRoots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`))) {
      continue;
    }
    const buffer = await readLocalFile(resolved);
    if (buffer) return buffer;
  }

  const remoteCandidates = [buildLaravelProofUrl(normalized), buildS3ProofUrl(normalized)].filter(
    Boolean,
  );

  for (const url of remoteCandidates) {
    try {
      const buffer = await fetchRemoteBuffer(url);
      if (buffer) return buffer;
    } catch {
      // try next source
    }
  }

  const notFound = new Error('Deposit proof not found.');
  notFound.status = 404;
  throw notFound;
}

const PROOF_ALLOWED_EXTENSIONS = new Set(['jpeg', 'jpg', 'png', 'gif', 'bmp', 'webp']);
const PROOF_MAX_BYTES = 2 * 1024 * 1024;

export function validateDepositProofUpload(file) {
  if (!file) return 'Payment proof should be less than 2Mb. Kindly reupload.';

  const ext = path.extname(file.originalname || '').slice(1).toLowerCase();
  const mime = (file.mimetype || '').toLowerCase();
  const name = (file.originalname || '').toLowerCase();

  if (
    ext === 'heic' ||
    ext === 'heif' ||
    name.endsWith('.heic') ||
    name.endsWith('.heif') ||
    mime.includes('heic') ||
    mime.includes('heif')
  ) {
    return 'HEIC format is not supported. Please upload JPG, PNG, GIF, BMP or WebP image.';
  }

  if (ext === 'pdf' || mime === 'application/pdf' || name.endsWith('.pdf')) {
    return 'PDF is not supported. Please upload JPG, PNG, GIF, BMP or WebP image.';
  }

  if (!PROOF_ALLOWED_EXTENSIONS.has(ext) && !mime.startsWith('image/')) {
    return 'HEIC format is not supported. Please upload JPG, PNG, GIF, BMP or WebP image.';
  }

  if (file.size > PROOF_MAX_BYTES) {
    return 'Payment proof should be less than 2Mb. Kindly reupload.';
  }

  return null;
}

export async function storeDepositProof(file) {
  const validationError = validateDepositProofUpload(file);
  if (validationError) {
    const error = new Error(validationError);
    error.status = 422;
    throw error;
  }

  const ext = path.extname(file.originalname || '').slice(1).toLowerCase();
  const safeExt = PROOF_ALLOWED_EXTENSIONS.has(ext) ? ext : 'jpg';
  const filename = `deposit_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}.${safeExt}`;
  const contentType = guessDepositProofMimeType(filename);

  if (shouldUseS3Storage()) {
    await uploadDepositProofToS3(file.buffer, filename, contentType);
    return filename;
  }

  const dir = depositsDir();
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, filename), file.buffer);
  return filename;
}

function shouldUseS3Storage() {
  const disk = String(process.env.FILESYSTEM_DISK || '').trim().toLowerCase();
  return disk === 's3' || Boolean(process.env.AWS_BUCKET);
}

async function uploadDepositProofToS3(buffer, filename, contentType) {
  const bucket = process.env.AWS_BUCKET;
  if (!bucket) {
    const error = new Error('AWS bucket is not configured for deposit proof upload.');
    error.status = 500;
    throw error;
  }

  const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
  const client = new S3Client({
    region: process.env.AWS_DEFAULT_REGION || 'us-east-1',
    credentials:
      process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
        ? {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
          }
        : undefined,
  });

  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: `deposits/${filename}`,
      Body: buffer,
      ContentType: contentType,
    }),
  );
}
