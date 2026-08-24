import fs from 'fs/promises';
import path from 'node:path';
import { env } from '../config/env.js';
import { getPublicApiBaseUrl as getApiBaseUrl } from '../utils/publicApiUrl.js';

const ALLOWED_IMAGE_EXTENSIONS = new Set(['jpeg', 'jpg', 'png', 'gif', 'svg', 'webp']);
const ALLOWED_VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'mov']);
const MAX_BYTES = 10 * 1024 * 1024;

export { getApiBaseUrl };

function promotionsDir() {
  return path.resolve(env.projectRoot, '../ITrustLD_Existing/storage/app/promotions');
}

export function resolvePromotionalMediaPath(filename) {
  const safeName = path.basename(String(filename || ''));
  if (!safeName || safeName !== filename) {
    const error = new Error('Invalid media filename.');
    error.status = 400;
    throw error;
  }
  return path.join(promotionsDir(), safeName);
}

export async function promotionalMediaExists(filename) {
  if (!filename) return false;
  const safeName = path.basename(String(filename));
  const candidates = [
    resolvePromotionalMediaPath(safeName),
    path.resolve(env.projectRoot, '../ITrustLD_Existing/public/uploads/promotions', safeName),
  ];
  for (const filePath of candidates) {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      // try next
    }
  }
  return false;
}

export function guessPromotionalMediaMimeType(filename) {
  const ext = path.extname(filename).slice(1).toLowerCase();
  switch (ext) {
    case 'png':
      return 'image/png';
    case 'gif':
      return 'image/gif';
    case 'svg':
      return 'image/svg+xml';
    case 'webp':
      return 'image/webp';
    case 'mp4':
      return 'video/mp4';
    case 'webm':
      return 'video/webm';
    case 'mov':
      return 'video/quicktime';
    default:
      return 'image/jpeg';
  }
}

export function validatePromotionalMediaUpload(file) {
  if (!file) return null;

  const ext = path.extname(file.originalname || '').slice(1).toLowerCase();
  const mime = (file.mimetype || '').toLowerCase();
  const isImage =
    ALLOWED_IMAGE_EXTENSIONS.has(ext) || mime.startsWith('image/');
  const isVideo =
    ALLOWED_VIDEO_EXTENSIONS.has(ext) || mime.startsWith('video/');

  if (!isImage && !isVideo) {
    return 'Please upload a valid image or video file.';
  }

  if (file.size > MAX_BYTES) {
    return 'Media file must not exceed 10MB.';
  }

  return null;
}

export async function storePromotionalMedia(file) {
  const ext = path.extname(file.originalname || '').slice(1).toLowerCase();
  const allowed = new Set([...ALLOWED_IMAGE_EXTENSIONS, ...ALLOWED_VIDEO_EXTENSIONS]);
  const safeExt = allowed.has(ext) ? ext : 'jpg';
  const filename = `promo_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.${safeExt}`;
  const dir = promotionsDir();
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, filename), file.buffer);

  const publicDir = path.resolve(env.projectRoot, '../ITrustLD_Existing/public/uploads/promotions');
  try {
    await fs.mkdir(publicDir, { recursive: true });
    await fs.writeFile(path.join(publicDir, filename), file.buffer);
  } catch {
    // ignore
  }

  return filename;
}

export async function resolvePromotionalMediaPublicUrl(filename, updatedAt = null) {
  if (!filename) return null;

  const safeName = path.basename(String(filename));
  const version = updatedAt ? `?v=${new Date(updatedAt).getTime()}` : '';

  return `${getApiBaseUrl()}/public/promotional-banners/media/${encodeURIComponent(safeName)}${version}`;
}

export async function deletePromotionalMediaFile(filename) {
  if (!filename) return;
  const safeName = path.basename(String(filename));
  const paths = [
    resolvePromotionalMediaPath(safeName),
    path.resolve(env.projectRoot, '../ITrustLD_Existing/public/uploads/promotions', safeName),
  ];
  for (const filePath of paths) {
    try {
      await fs.unlink(filePath);
    } catch {
      // ignore
    }
  }
}
