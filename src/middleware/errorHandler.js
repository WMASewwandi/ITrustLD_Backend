import { env } from '../config/env.js';

export function notFoundHandler(_req, res) {
  res.status(404).json({
    message: 'Not found',
  });
}

export function errorHandler(err, _req, res, _next) {
  const status = err.status || err.statusCode || 500;
  const payload = {
    message: err.message || 'Internal server error',
  };

  if (err.code) {
    payload.code = err.code;
  }
  if (err.activeShift) {
    payload.active_shift = err.activeShift;
  }
  if (err.userShift) {
    payload.user_shift = err.userShift;
  }

  if (env.nodeEnv !== 'production' && err.stack) {
    payload.stack = err.stack;
  }

  res.status(status).json(payload);
}
