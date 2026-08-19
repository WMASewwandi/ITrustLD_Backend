/** Granular admin loyalty permissions (mirrored in ITrustLD_Admin/lib/loyalty-permissions.js). */

export const LOYALTY_ORDERS_READ = 'read_loyalty_orders_data';
export const LOYALTY_ORDERS_UPDATE = 'status_update_loyalty_orders_data';

export const LOYALTY_BONUS_READ = 'read_loyalty_bonus_claims_data';
export const LOYALTY_BONUS_UPDATE = 'status_update_loyalty_bonus_claims_data';

export const LOYALTY_VOUCHER_READ = 'read_loyalty_voucher_claims_data';
export const LOYALTY_VOUCHER_UPDATE = 'status_update_loyalty_voucher_claims_data';

export const LOYALTY_MANAGEMENT_READ = 'read_loyalty_management_data';
export const LOYALTY_MANAGEMENT_UPDATE = 'change_loyalty_management_data';

export const LOYALTY_GIFTS_READ = 'read_loyalty_gifts_data';
export const LOYALTY_GIFTS_CLAIMS_UPDATE = 'status_update_loyalty_gifts_data';
export const LOYALTY_GIFTS_CATALOG_UPDATE = 'change_loyalty_gifts_data';

/** Legacy broad permissions — still honored via aliases for existing roles. */
export const LEGACY_LOYALTY_READ = 'read_customer_loyalty_data';
export const LEGACY_LOYALTY_UPDATE = 'change_customer_loyalty_status';

const READ_ALIASES = {
  [LOYALTY_ORDERS_READ]: [LEGACY_LOYALTY_READ],
  [LOYALTY_BONUS_READ]: [LEGACY_LOYALTY_READ],
  [LOYALTY_VOUCHER_READ]: [LEGACY_LOYALTY_READ],
  [LOYALTY_MANAGEMENT_READ]: [LEGACY_LOYALTY_READ, 'view_account_configs'],
  [LOYALTY_GIFTS_READ]: [LEGACY_LOYALTY_READ],
};

const UPDATE_ALIASES = {
  [LOYALTY_ORDERS_UPDATE]: [LEGACY_LOYALTY_UPDATE],
  [LOYALTY_BONUS_UPDATE]: [LEGACY_LOYALTY_UPDATE],
  [LOYALTY_VOUCHER_UPDATE]: [LEGACY_LOYALTY_UPDATE],
  [LOYALTY_MANAGEMENT_UPDATE]: ['change_account_configs'],
  [LOYALTY_GIFTS_CLAIMS_UPDATE]: [LEGACY_LOYALTY_UPDATE],
  [LOYALTY_GIFTS_CATALOG_UPDATE]: ['change_account_configs'],
};

export const ALL_LOYALTY_READ_PERMISSIONS = [
  LOYALTY_ORDERS_READ,
  LOYALTY_BONUS_READ,
  LOYALTY_VOUCHER_READ,
  LOYALTY_MANAGEMENT_READ,
  LOYALTY_GIFTS_READ,
];

export const ALL_LOYALTY_UPDATE_PERMISSIONS = [
  LOYALTY_ORDERS_UPDATE,
  LOYALTY_BONUS_UPDATE,
  LOYALTY_VOUCHER_UPDATE,
  LOYALTY_MANAGEMENT_UPDATE,
  LOYALTY_GIFTS_CLAIMS_UPDATE,
  LOYALTY_GIFTS_CATALOG_UPDATE,
];

/** Queue tabs: orders, bonus, vouchers, management, gifts */
export const LOYALTY_TAB_READ = {
  orders: LOYALTY_ORDERS_READ,
  bonus: LOYALTY_BONUS_READ,
  vouchers: LOYALTY_VOUCHER_READ,
  management: LOYALTY_MANAGEMENT_READ,
  gifts: LOYALTY_GIFTS_READ,
};

export const LOYALTY_TAB_UPDATE = {
  orders: LOYALTY_ORDERS_UPDATE,
  bonus: LOYALTY_BONUS_UPDATE,
  vouchers: LOYALTY_VOUCHER_UPDATE,
  management: LOYALTY_MANAGEMENT_UPDATE,
  gifts: LOYALTY_GIFTS_CLAIMS_UPDATE,
};

export function userHasPermission(userPermissions = [], required) {
  if (!required) return true;
  const list = Array.isArray(userPermissions) ? userPermissions : [];
  if (list.includes(required)) return true;

  const readAliases = READ_ALIASES[required] || [];
  if (readAliases.some((alias) => list.includes(alias))) return true;

  const updateAliases = UPDATE_ALIASES[required] || [];
  return updateAliases.some((alias) => list.includes(alias));
}

export function userHasAnyPermission(userPermissions = [], requiredList = []) {
  return requiredList.some((permission) => userHasPermission(userPermissions, permission));
}

export const LOYALTY_LANDING_ROUTES = [
  { permission: LOYALTY_ORDERS_READ, href: '/loyalty?tab=orders&status=Pending' },
  { permission: LOYALTY_BONUS_READ, href: '/loyalty?tab=bonus&status=Pending' },
  { permission: LOYALTY_VOUCHER_READ, href: '/loyalty?tab=vouchers&status=Pending' },
  { permission: LOYALTY_MANAGEMENT_READ, href: '/loyalty?tab=management&audience=normal' },
  { permission: LOYALTY_GIFTS_READ, href: '/loyalty?tab=gifts&section=catalog' },
];

export function resolveFirstLoyaltyHref(userPermissions = []) {
  for (const route of LOYALTY_LANDING_ROUTES) {
    if (userHasPermission(userPermissions, route.permission)) {
      return route.href;
    }
  }
  return null;
}
