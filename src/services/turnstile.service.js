import { env } from '../config/env.js';

function getTurnstileSecret() {
  return process.env.TURNSTILE_SECRET_KEY || process.env.TURNSTILE_SECRET || '';
}

export async function verifyTurnstileToken(token, remoteIp = null) {
  const secret = getTurnstileSecret();
  if (!secret) {
    return env.nodeEnv !== 'production';
  }

  const responseToken = String(token || '').trim();
  if (!responseToken) {
    return false;
  }

  const body = new URLSearchParams({
    secret,
    response: responseToken,
  });
  if (remoteIp) {
    body.set('remoteip', remoteIp);
  }

  const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  const data = await response.json();
  return Boolean(data?.success);
}

export function isTurnstileRequired() {
  return Boolean(getTurnstileSecret()) && env.nodeEnv === 'production';
}
