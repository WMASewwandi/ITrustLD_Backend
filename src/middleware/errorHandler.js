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

  if (env.nodeEnv !== 'production' && err.stack) {
    payload.stack = err.stack;
  }

  res.status(status).json(payload);
}
