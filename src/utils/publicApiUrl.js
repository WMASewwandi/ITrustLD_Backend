import { AsyncLocalStorage } from 'node:async_hooks';
import { env } from '../config/env.js';

const requestContext = new AsyncLocalStorage();

export function withRequestContext(req, _res, next) {
  requestContext.run({ req }, next);
}

function trimSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function withApiPrefix(base) {
  const trimmed = trimSlash(base);
  if (!trimmed) return trimmed;
  if (/\/api\/v\d+$/i.test(trimmed)) return trimmed;
  return `${trimmed}/api/v1`;
}

/**
 * Public API origin used in image URLs (wallet logos, banners, etc.).
 * Prefer API_PUBLIC_URL in production; otherwise use the incoming request host
 * so logos are not hardcoded to http://localhost:4000.
 */
export function getPublicApiBaseUrl() {
  const configured =
    process.env.API_PUBLIC_URL ||
    process.env.PUBLIC_API_URL ||
    process.env.NEXT_PUBLIC_API_URL;
  if (configured) {
    return withApiPrefix(configured);
  }

  const req = requestContext.getStore()?.req;
  if (req) {
    const forwardedHost = String(req.headers['x-forwarded-host'] || '')
      .split(',')[0]
      .trim();
    const host = forwardedHost || req.get?.('host') || req.headers.host;
    if (host) {
      const forwardedProto = String(req.headers['x-forwarded-proto'] || '')
        .split(',')[0]
        .trim();
      const proto = forwardedProto || req.protocol || 'http';
      return `${proto}://${host}/api/v1`;
    }
  }

  return `http://localhost:${env.port}/api/v1`;
}
