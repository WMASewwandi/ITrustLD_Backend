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

function blogsDir() {
  return path.resolve(env.projectRoot, '../ITrustLD_Existing/storage/app/blogs');
}

export function getBlogsDirectory() {
  return blogsDir();
}

export function resolveBlogBannerPath(filename) {
  const safeName = path.basename(String(filename || ''));
  if (!safeName || safeName !== filename) {
    const error = new Error('Invalid banner filename.');
    error.status = 400;
    throw error;
  }
  return path.join(blogsDir(), safeName);
}

export async function blogBannerExists(filename) {
  if (!filename) return false;
  const safeName = path.basename(String(filename));
  const candidates = [
    resolveBlogBannerPath(safeName),
    path.resolve(env.projectRoot, '../ITrustLD_Existing/public/uploads/blogs', safeName),
  ];
  for (const filePath of candidates) {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      // try next location
    }
  }
  return false;
}

export async function resolveBlogBannerPublicUrl(banner, updatedAt = null) {
  if (!banner) return null;

  const version = updatedAt ? `?v=${new Date(updatedAt).getTime()}` : '';

  if (await blogBannerExists(banner)) {
    return `${getApiBaseUrl()}/public/blog-banners/${encodeURIComponent(banner)}${version}`;
  }

  const bucket = process.env.AWS_BUCKET;
  if (bucket) {
    const region = process.env.AWS_DEFAULT_REGION || 'us-east-1';
    const base = process.env.AWS_URL || `https://${bucket}.s3.${region}.amazonaws.com`;
    return `${String(base).replace(/\/$/, '')}/blogs/${banner}${version}`;
  }

  const appUrl = (process.env.APP_URL || env.userAppUrl).replace(/\/$/, '');
  return `${appUrl}/uploads/blogs/${banner}${version}`;
}

export function guessBlogBannerMimeType(filename) {
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
    default:
      return 'image/jpeg';
  }
}

export function validateBlogBannerUpload(file) {
  if (!file) return 'Banner image is required.';

  const ext = path.extname(file.originalname || '').slice(1).toLowerCase();
  const mime = (file.mimetype || '').toLowerCase();

  if (!ALLOWED_EXTENSIONS.has(ext) && !mime.startsWith('image/')) {
    return 'Please upload a valid image (JPEG, PNG, JPG, GIF, SVG).';
  }

  if (file.size > MAX_BYTES) {
    return 'Banner image must not exceed 2MB.';
  }

  return null;
}

export async function storeBlogBanner(file) {
  const ext = path.extname(file.originalname || '').slice(1).toLowerCase();
  const safeExt = ALLOWED_EXTENSIONS.has(ext) ? ext : 'jpg';
  const filename = `blog_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.${safeExt}`;
  const dir = blogsDir();
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, filename), file.buffer);

  // Mirror to Laravel public path when storage:link symlink is missing (common on Windows).
  const publicDir = path.resolve(env.projectRoot, '../ITrustLD_Existing/public/uploads/blogs');
  try {
    await fs.mkdir(publicDir, { recursive: true });
    await fs.writeFile(path.join(publicDir, filename), file.buffer);
  } catch {
    // Ignore if public uploads path cannot be written.
  }

  return filename;
}
