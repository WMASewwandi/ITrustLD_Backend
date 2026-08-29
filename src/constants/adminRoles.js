/** Spatie roles allowed to use the admin portal (matches Laravel admin navigation). */
export const ADMIN_PORTAL_ROLES = [
  'super-admin',
  'sub-admin',
  'deposit-executive',
  'withdrawal-executive',
];

export const AUTHORIZE_WITHDRAWAL_PERMISSION = 'authorize_withdrawal_data';

/** Live vs local role name variants for withdrawal authorization. */
export const AUTHORIZER_ROLE_NAME_ALIASES = [
  'withdrawal-authorizer',
  'withdrawal-authorization',
  'Withdrawal Authorizer',
  'Withdrawal Authorization',
];

export const LARAVEL_USER_MODEL = 'App\\Models\\User';
