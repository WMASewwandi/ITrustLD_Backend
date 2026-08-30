import fs from 'fs/promises';
import path from 'node:path';
import { env } from '../config/env.js';
import { getPublicApiBaseUrl as getApiBaseUrl } from '../utils/publicApiUrl.js';

const ALLOWED_EXTENSIONS = new Set(['jpeg', 'jpg', 'png', 'webp', 'gif']);
export const COUNTDOWN_BACKGROUND_MAX_BYTES = 8 * 1024 * 1024;

function backgroundsDir() {
  return path.resolve(env.projectRoot, '../ITrustLD_Existing/storage/app/launch-countdown');
}

export function resolveCountdownBackgroundPath(filename) {
  const safeName = path.basename(String(filename || ''));
  if (!safeName || safeName !== filename) {
    const error = new Error('Invalid background filename.');
    error.status = 400;
    throw error;
  }
  return path.join(backgroundsDir(), safeName);
}

export function guessCountdownBackgroundMimeType(filename) {
  const ext = path.extname(filename).slice(1).toLowerCase();
  switch (ext) {
    case 'png':
      return 'image/png';
    case 'webp':
      return 'image/webp';
    case 'gif':
      return 'image/gif';
    default:
      return 'image/jpeg';
  }
}

export function validateCountdownBackgroundUpload(file) {
  if (!file) return 'Background image is required.';

  const ext = path.extname(file.originalname || '').slice(1).toLowerCase();
  const mime = (file.mimetype || '').toLowerCase();
  const allowedMime =
    mime === 'image/jpeg' ||
    mime === 'image/jpg' ||
    mime === 'image/png' ||
    mime === 'image/webp' ||
    mime === 'image/gif';

  if (!ALLOWED_EXTENSIONS.has(ext) && !allowedMime) {
    return 'Background must be a JPG, PNG, WEBP, or GIF image.';
  }

  if (!file.buffer?.length) {
    return 'Background file is empty.';
  }

  if (file.size > COUNTDOWN_BACKGROUND_MAX_BYTES) {
    return 'Background image must not exceed 8MB.';
  }

  return null;
}

export async function storeCountdownBackground(file) {
  const ext = path.extname(file.originalname || '').slice(1).toLowerCase();
  const safeExt = ALLOWED_EXTENSIONS.has(ext) ? ext : 'jpg';
  const filename = `countdown_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.${safeExt}`;
  const dir = backgroundsDir();
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, filename), file.buffer);

  const publicDir = path.resolve(env.projectRoot, '../ITrustLD_Existing/public/uploads/launch-countdown');
  try {
    await fs.mkdir(publicDir, { recursive: true });
    await fs.writeFile(path.join(publicDir, filename), file.buffer);
  } catch {
    // ignore mirror failures
  }

  return filename;
}

export async function deleteCountdownBackgroundFile(filename) {
  if (!filename) return;
  const safeName = path.basename(String(filename));
  const paths = [
    resolveCountdownBackgroundPath(safeName),
    path.resolve(env.projectRoot, '../ITrustLD_Existing/public/uploads/launch-countdown', safeName),
  ];
  for (const filePath of paths) {
    try {
      await fs.unlink(filePath);
    } catch {
      // ignore
    }
  }
}

export function resolveCountdownBackgroundPublicUrl(filename, updatedAt = null) {
  if (!filename) return null;
  const safeName = path.basename(String(filename));
  const version = updatedAt ? `?v=${new Date(updatedAt).getTime()}` : '';
  return `${getApiBaseUrl()}/public/maintenance-mode/media/${encodeURIComponent(safeName)}${version}`;
}
