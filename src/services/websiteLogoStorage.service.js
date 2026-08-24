import fs from 'fs/promises';
import path from 'node:path';
import { env } from '../config/env.js';
import { getPublicApiBaseUrl as getApiBaseUrl } from '../utils/publicApiUrl.js';

const ALLOWED_EXTENSIONS = new Set(['jpeg', 'jpg', 'png', 'svg']);
const MAX_BYTES = 2 * 1024 * 1024;

export const DEFAULT_WIDE_LOGO_URL = '/assets/img/logos/logo-itrustld-wide.png';
export const DEFAULT_ICON_LOGO_URL = '/assets/img/logos/logo-itrustld.svg';

export { getApiBaseUrl };

function logosDir() {
  return path.resolve(env.projectRoot, '../ITrustLD_Existing/storage/app/website-logos');
}

export function resolveWebsiteLogoPath(filename) {
  const safeName = path.basename(String(filename || ''));
  if (!safeName || safeName !== filename) {
    const error = new Error('Invalid logo filename.');
    error.status = 400;
    throw error;
  }
  return path.join(logosDir(), safeName);
}

export function guessWebsiteLogoMimeType(filename) {
  const ext = path.extname(filename).slice(1).toLowerCase();
  switch (ext) {
    case 'png':
      return 'image/png';
    case 'svg':
      return 'image/svg+xml';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    default:
      return 'application/octet-stream';
  }
}

export function validateWebsiteLogoUpload(file) {
  if (!file) {
    return 'Logo image is required.';
  }

  const ext = path.extname(file.originalname || '').slice(1).toLowerCase();
  const mime = (file.mimetype || '').toLowerCase();
  const allowedMime =
    mime === 'image/jpeg' ||
    mime === 'image/png' ||
    mime === 'image/svg+xml' ||
    mime === 'image/jpg';

  if (!ALLOWED_EXTENSIONS.has(ext) && !allowedMime) {
    return 'Logo must be a JPG, PNG, or SVG image.';
  }

  if (!file.buffer?.length) {
    return 'Logo file is empty.';
  }

  if (file.size > MAX_BYTES) {
    return 'Logo file must not exceed 2MB.';
  }

  return null;
}

export async function storeWebsiteLogo(file) {
  const ext = path.extname(file.originalname || '').slice(1).toLowerCase();
  const safeExt = ALLOWED_EXTENSIONS.has(ext) ? ext : 'png';
  const filename = `logo_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.${safeExt}`;
  const dir = logosDir();
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, filename), file.buffer);

  const publicDir = path.resolve(env.projectRoot, '../ITrustLD_Existing/public/uploads/website-logos');
  try {
    await fs.mkdir(publicDir, { recursive: true });
    await fs.writeFile(path.join(publicDir, filename), file.buffer);
  } catch {
    // ignore mirror failures
  }

  return filename;
}

export async function deleteWebsiteLogoFile(filename) {
  if (!filename) return;
  const safeName = path.basename(String(filename));
  const paths = [
    resolveWebsiteLogoPath(safeName),
    path.resolve(env.projectRoot, '../ITrustLD_Existing/public/uploads/website-logos', safeName),
  ];
  for (const filePath of paths) {
    try {
      await fs.unlink(filePath);
    } catch {
      // ignore
    }
  }
}

export function resolveWebsiteLogoPublicUrl(filename, updatedAt = null) {
  if (!filename) return null;
  const safeName = path.basename(String(filename));
  const version = updatedAt ? `?v=${new Date(updatedAt).getTime()}` : '';
  return `${getApiBaseUrl()}/public/website-logos/media/${encodeURIComponent(safeName)}${version}`;
}
