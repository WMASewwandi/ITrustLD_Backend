import fs from 'fs/promises';
import path from 'node:path';
import { env } from '../config/env.js';

const ALLOWED_EXTENSIONS = new Set(['jpeg', 'jpg', 'png', 'gif', 'bmp', 'webp']);
const MAX_BYTES = 5 * 1024 * 1024;

function documentsDir() {
  return path.resolve(env.projectRoot, '../ITrustLD_Existing/storage/app/documents');
}

export function getDocumentsDirectory() {
  return documentsDir();
}

export function resolveDocumentPath(filename) {
  const safeName = path.basename(String(filename || ''));
  if (!safeName || safeName !== filename) {
    const error = new Error('Invalid document filename.');
    error.status = 400;
    throw error;
  }
  return path.join(documentsDir(), safeName);
}

export function deriveBackDocumentFilename(frontFilename) {
  const ext = path.extname(frontFilename);
  const base = frontFilename.slice(0, -ext.length);
  if (!base || base.endsWith('_back')) return null;
  return `${base}_back${ext}`;
}

export async function documentExists(filename) {
  try {
    await fs.access(resolveDocumentPath(filename));
    return true;
  } catch {
    return false;
  }
}

export async function getDocumentFileStats(filename) {
  const stats = await fs.stat(resolveDocumentPath(filename));
  return { size: stats.size, mtime: stats.mtime };
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

export async function storeVerificationDocument(file, prefix) {
  const ext = path.extname(file.originalname || '').slice(1).toLowerCase();
  const safeExt = ALLOWED_EXTENSIONS.has(ext) ? ext : 'jpg';
  const filename = `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.${safeExt}`;
  const dir = documentsDir();
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, filename), file.buffer);
  return filename;
}

export async function storePairedBackDocument(file, frontFilename) {
  const ext = path.extname(file.originalname || frontFilename).toLowerCase() || '.jpg';
  const safeExt = ext.replace('.', '');
  const normalizedExt = ALLOWED_EXTENSIONS.has(safeExt) ? safeExt : 'jpg';
  const baseName = frontFilename.replace(/\.[^.]+$/, '');
  const filename = `${baseName}_back.${normalizedExt}`;
  const dir = documentsDir();
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, filename), file.buffer);
  return filename;
}
