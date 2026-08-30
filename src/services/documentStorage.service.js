import fs from 'fs/promises';
import path from 'node:path';
import { env } from '../config/env.js';

const ALLOWED_EXTENSIONS = new Set(['jpeg', 'jpg', 'png', 'gif', 'bmp', 'webp']);
const MAX_BYTES = 5 * 1024 * 1024;

function documentsDir() {
  return path.resolve(env.projectRoot, '../ITrustLD_Existing/storage/app/documents');
}

function existingAppRoot() {
  return path.resolve(env.projectRoot, '../ITrustLD_Existing');
}

function localSearchRoots() {
  const root = existingAppRoot();
  return [
    documentsDir(),
    path.join(root, 'storage/app/documents'),
    path.join(root, 'storage/app/public/documents'),
    path.join(root, 'storage/app'),
    path.join(root, 'storage/app/public'),
    path.join(root, 'public'),
    path.join(root, 'public/documents'),
    path.join(root, 'public/uploads'),
    path.join(root, 'public/upload'),
  ];
}

function normalizedFilename(filename) {
  return String(filename || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+/, '');
}

function isPathInside(parent, child) {
  const resolvedParent = path.resolve(parent);
  const resolvedChild = path.resolve(child);
  return resolvedChild === resolvedParent || resolvedChild.startsWith(`${resolvedParent}${path.sep}`);
}

function candidateLocalPaths(filename) {
  const raw = normalizedFilename(filename);
  if (!raw) return [];
  const base = path.basename(raw);
  const paths = new Set();

  for (const root of localSearchRoots()) {
    paths.add(path.join(root, base));
    if (raw !== base) {
      const nested = path.resolve(root, raw);
      if (isPathInside(root, nested)) paths.add(nested);
    }
  }

  return [...paths];
}

function candidateS3Keys(filename) {
  const raw = normalizedFilename(filename);
  if (!raw) return [];
  const base = path.basename(raw);
  const keys = [`documents/${base}`, `upload/${base}`, `uploads/${base}`, raw, base];
  if (raw !== base && !raw.startsWith('documents/') && !raw.startsWith('upload')) {
    keys.push(`documents/${raw}`, `upload/${raw}`);
  }
  return [...new Set(keys.filter(Boolean))];
}

function shouldUseS3Storage() {
  const disk = String(process.env.FILESYSTEM_DISK || '').trim().toLowerCase();
  return disk === 's3' || Boolean(process.env.AWS_BUCKET);
}

function sanitizeFilename(filename) {
  const raw = normalizedFilename(filename);
  const safeName = path.basename(raw);
  if (!safeName) {
    const error = new Error('Invalid document filename.');
    error.status = 400;
    throw error;
  }
  return safeName;
}

function buildDocumentS3Key(filename) {
  return candidateS3Keys(filename)[0];
}

async function createS3Client() {
  const { S3Client } = await import('@aws-sdk/client-s3');
  return new S3Client({
    region: process.env.AWS_DEFAULT_REGION || process.env.AWS_REGION || 'ap-southeast-2',
    followRegionRedirects: true,
    credentials:
      process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
        ? {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
          }
        : undefined,
  });
}

async function headS3Document(filename) {
  const bucket = process.env.AWS_BUCKET;
  if (!bucket) return null;

  try {
    const { HeadObjectCommand } = await import('@aws-sdk/client-s3');
    const client = await createS3Client();
    for (const Key of candidateS3Keys(filename)) {
      try {
        const response = await client.send(
          new HeadObjectCommand({
            Bucket: bucket,
            Key,
          }),
        );
        return {
          size: response.ContentLength ?? 0,
          mtime: response.LastModified ?? new Date(),
        };
      } catch {
        // try next key
      }
    }
    return null;
  } catch {
    return null;
  }
}

async function readS3DocumentBuffer(filename) {
  const bucket = process.env.AWS_BUCKET;
  if (!bucket) return null;

  try {
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    const client = await createS3Client();
    for (const Key of candidateS3Keys(filename)) {
      try {
        const response = await client.send(
          new GetObjectCommand({
            Bucket: bucket,
            Key,
          }),
        );
        const bytes = await response.Body.transformToByteArray();
        return Buffer.from(bytes);
      } catch {
        // try next key
      }
    }
    return null;
  } catch {
    return null;
  }
}

async function statLocalDocument(filename) {
  for (const filePath of candidateLocalPaths(filename)) {
    try {
      const stats = await fs.stat(filePath);
      if (stats.isFile()) {
        return { size: stats.size, mtime: stats.mtime, filePath };
      }
    } catch {
      // try next location
    }
  }
  return null;
}

export function getDocumentsDirectory() {
  return documentsDir();
}

export function resolveDocumentPath(filename) {
  return path.join(documentsDir(), sanitizeFilename(filename));
}

export function deriveBackDocumentFilename(frontFilename) {
  const raw = normalizedFilename(frontFilename);
  const ext = path.extname(raw);
  const base = raw.slice(0, -ext.length);
  if (!base || base.endsWith('_back')) return null;
  return `${base}_back${ext}`;
}

export async function documentExists(filename) {
  if (!filename) return false;
  if (await headS3Document(filename)) return true;
  return Boolean(await statLocalDocument(filename));
}

export async function getDocumentFileStats(filename) {
  const s3Meta = await headS3Document(filename);
  if (s3Meta) return s3Meta;

  const local = await statLocalDocument(filename);
  if (local) return { size: local.size, mtime: local.mtime };

  return null;
}

export async function readDocumentBuffer(filename) {
  const s3Buffer = await readS3DocumentBuffer(filename);
  if (s3Buffer) return s3Buffer;

  const local = await statLocalDocument(filename);
  if (local) return fs.readFile(local.filePath);

  const notFound = new Error('Document file is not available on this server.');
  notFound.status = 404;
  throw notFound;
}

export function formatFileSize(bytes) {
  const size = Number(bytes) || 0;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function guessDocumentMimeType(filename) {
  const ext = path.extname(filename).slice(1).toLowerCase();
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

export function validateDocumentUpload(file) {
  if (!file) return null;

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
    return 'HEIC is not supported. Please upload JPG, PNG, GIF, BMP or WebP.';
  }

  if (ext === 'pdf' || mime === 'application/pdf' || name.endsWith('.pdf')) {
    return 'PDF is not supported. Please upload JPG, PNG, GIF, BMP or WebP image.';
  }

  if (!ALLOWED_EXTENSIONS.has(ext) && !mime.startsWith('image/')) {
    return 'Please upload only image files (JPG, PNG, GIF, BMP, WebP). PDF and HEIC are not supported.';
  }

  if (file.size > MAX_BYTES) {
    return 'File size must not exceed 5MB.';
  }

  return null;
}

async function writeLocalDocument(buffer, filename) {
  const dir = documentsDir();
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, filename), buffer);
}

async function uploadDocumentToS3(buffer, filename, contentType) {
  const bucket = process.env.AWS_BUCKET;
  if (!bucket) {
    const error = new Error('AWS bucket is not configured for KYC document upload.');
    error.status = 500;
    throw error;
  }

  const { PutObjectCommand } = await import('@aws-sdk/client-s3');
  const client = await createS3Client();
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: buildDocumentS3Key(filename),
      Body: buffer,
      ContentType: contentType,
    }),
  );
}

async function persistVerificationFile(buffer, filename, contentType) {
  await writeLocalDocument(buffer, filename);

  if (!shouldUseS3Storage()) {
    return filename;
  }

  try {
    await uploadDocumentToS3(buffer, filename, contentType);
  } catch (error) {
    console.error('[kyc:s3-upload]', filename, error.message);
  }

  return filename;
}

export async function storeVerificationDocument(file, prefix) {
  const ext = path.extname(file.originalname || '').slice(1).toLowerCase();
  const safeExt = ALLOWED_EXTENSIONS.has(ext) ? ext : 'jpg';
  const filename = `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.${safeExt}`;
  const contentType = guessDocumentMimeType(filename);
  await persistVerificationFile(file.buffer, filename, contentType);
  return filename;
}

export async function storePairedBackDocument(file, frontFilename) {
  const ext = path.extname(file.originalname || frontFilename).toLowerCase() || '.jpg';
  const safeExt = ext.replace('.', '');
  const normalizedExt = ALLOWED_EXTENSIONS.has(safeExt) ? safeExt : 'jpg';
  const baseName = frontFilename.replace(/\.[^.]+$/, '');
  const filename = `${baseName}_back.${normalizedExt}`;
  const contentType = guessDocumentMimeType(filename);
  await persistVerificationFile(file.buffer, filename, contentType);
  return filename;
}
