import bcrypt from 'bcryptjs';

/**
 * Verify a password against a Laravel bcrypt hash ($2y$ / $2a$ / $2b$).
 */
export async function verifyLaravelPassword(plain, hash) {
  if (!plain || !hash) {
    return false;
  }
  const normalized = hash.startsWith('$2y$') ? `$2a$${hash.slice(4)}` : hash;
  return bcrypt.compare(plain, normalized);
}

export async function hashLaravelPassword(plain) {
  const hash = await bcrypt.hash(plain, 10);
  return hash.replace('$2a$', '$2y$');
}
