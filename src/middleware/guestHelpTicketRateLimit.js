const WINDOW_MS = 10 * 60 * 1000;
const MAX_REQUESTS = 5;

const guestTicketBuckets = new Map();

function getBucketKey(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)[0];

  return forwarded || req.ip || 'unknown';
}

export function guestHelpTicketRateLimit(req, _res, next) {
  if (req.auth?.userId != null) {
    next();
    return;
  }

  const now = Date.now();
  const key = getBucketKey(req);
  const recent = (guestTicketBuckets.get(key) || []).filter((ts) => now - ts < WINDOW_MS);

  if (recent.length >= MAX_REQUESTS) {
    const error = new Error('Too many support requests from this network. Please wait a few minutes and try again.');
    error.status = 429;
    next(error);
    return;
  }

  recent.push(now);
  guestTicketBuckets.set(key, recent);
  next();
}
