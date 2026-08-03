export const STRONG_PASSWORD_PATTERN = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[\W_]).{8,}$/;

export const STRONG_PASSWORD_MESSAGE =
  'Password must be at least 8 characters long and include an uppercase letter, a lowercase letter, a number, and a special character.';

export function isStrongPassword(password) {
  return STRONG_PASSWORD_PATTERN.test(String(password || ''));
}
