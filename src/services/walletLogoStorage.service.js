import fs from 'fs/promises';
import path from 'node:path';
import { env } from '../config/env.js';

const ALLOWED_EXTENSIONS = new Set(['jpeg', 'jpg', 'png', 'gif', 'svg', 'webp']);
const MAX_BYTES = 2 * 1024 * 1024;

export function getApiBaseUrl() {
  const configured =
    process.env.API_PUBLIC_URL ||
    process.env.PUBLIC_API_URL ||
    process.env.NEXT_PUBLIC_API_URL;
  if (configured) {
    return String(configured).replace(/\/$/, '');
  }
  return `http://localhost:${env.port}/api/v1`;
}

function logosDir() {
  return path.resolve(env.projectRoot, '../ITrustLD_Existing/storage/app/logos');
}

export function getLogosDirectory() {
  return logosDir();
}

export function resolveWalletLogoPath(filename) {
  const safeName = path.basename(String(filename || ''));
  if (!safeName || safeName !== filename) {
    const error = new Error('Invalid wallet logo filename.');
    error.status = 400;
    throw error;
  }
  return path.join(logosDir(), safeName);
}

export function guessWalletLogoMimeType(filename) {
  const ext = path.extname(String(filename || '')).slice(1).toLowerCase();
  if (ext === 'svg') return 'image/svg+xml';
  if (ext === 'png') return 'image/png';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'webp') return 'image/webp';
  return 'image/jpeg';
}

export function validateWalletLogoUpload(file) {
  if (!file) return null;
  if (!file.buffer?.length) return 'Logo file is required.';
  if (file.size > MAX_BYTES) return 'Logo image must not exceed 2MB.';
  const ext = path.extname(file.originalname || '').slice(1).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return 'Logo must be a JPEG, PNG, JPG, GIF, or SVG image.';
  }
  return null;
}

export async function storeWalletLogo(file) {
  const validationError = validateWalletLogoUpload(file);
  if (validationError) {
    const error = new Error(validationError);
    error.status = 422;
    throw error;
  }

  const ext = path.extname(file.originalname || '').slice(1).toLowerCase() || 'png';
  const fileName = `wallet_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const dir = logosDir();
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, fileName), file.buffer);
  return fileName;
}

export function resolveWalletLogoPublicUrl(filename) {
  if (!filename) return null;
  const safeName = path.basename(String(filename));
  if (!safeName) return null;
  return `${getApiBaseUrl()}/public/wallet-logos/${encodeURIComponent(safeName)}`;
}
