/**
 * Canonical system activity catalog — mirrors ITrustLD_Existing seeders plus new-app permissions.
 * `categoy_name` spelling matches legacy Laravel column.
 *
 * Category display order follows Laravel SystemActivitySeeder insert order (groupBy first-seen),
 * not numeric category id order (44 Dashboard appears before 40 User Management).
 */
export const SYSTEM_ACTIVITY_CATEGORIES = [
  { id: 1, category_identifier: 'deposit_activities', categoy_name: 'Deposit Activities', display_order: 1 },
  { id: 2, category_identifier: 'withdrawal_activities', categoy_name: 'Withdrawal Activities', display_order: 2 },
  { id: 3, category_identifier: 'profile_activities', categoy_name: 'Profile Activities', display_order: 3 },
  { id: 4, category_identifier: 'customer_accounts_activities', categoy_name: 'Customer Accounts Activities', display_order: 4 },
  { id: 5, category_identifier: 'loyalty_activities', categoy_name: 'Loyalty Activities', display_order: 5 },
  { id: 6, category_identifier: 'general_activities', categoy_name: 'General Activities', display_order: 6 },
  { id: 44, category_identifier: 'dashboard_activities', categoy_name: 'Dashboard Activities', display_order: 7 },
  { id: 40, category_identifier: 'user_manage_activities', categoy_name: 'User and Role Management', display_order: 8 },
  { id: 41, category_identifier: 'account_config_activities', categoy_name: 'Account Configurations', display_order: 9 },
  { id: 42, category_identifier: 'currency_config_activities', categoy_name: 'Currency Configurations', display_order: 10 },
  { id: 43, category_identifier: 'blog_post_activities', categoy_name: 'Blog Post Activities', display_order: 11 },
  { id: 45, category_identifier: 'performance_activities', categoy_name: 'Performance Activities', display_order: 12 },
];

export const SYSTEM_ACTIVITIES = [
  { activity_identifier: 'cusomer_deposit_activity', activity_name: 'Customer Deposit Activity', category_id: 1, sort_order: 1 },
  { activity_identifier: 'read_deposit_data', activity_name: 'Read Customer Deposit Information', category_id: 1, sort_order: 2 },
  { activity_identifier: 'status_update_deposit_data', activity_name: 'Status Update Customer Deposit Records', category_id: 1, sort_order: 3 },

  { activity_identifier: 'cusomer_withdrawal_activity', activity_name: 'Customer Withdrawal Activity', category_id: 2, sort_order: 1 },
  { activity_identifier: 'read_withdrawal_data', activity_name: 'Read Customer Withdrawal Information', category_id: 2, sort_order: 2 },
  { activity_identifier: 'status_update_withdrawal_data', activity_name: 'Status Update Customer Withdrawal Records', category_id: 2, sort_order: 3 },

  { activity_identifier: 'customer_profile_activity', activity_name: 'Customer Profile Activity', category_id: 3, sort_order: 1 },
  { activity_identifier: 'read_profile_data', activity_name: 'Read Customer Profile Data', category_id: 3, sort_order: 2 },
  { activity_identifier: 'change_profile_status', activity_name: 'Update Customer Profile Status', category_id: 3, sort_order: 3 },

  { activity_identifier: 'customer_accounts_activity', activity_name: 'Customer Account Activity', category_id: 4, sort_order: 1 },
  { activity_identifier: 'read_customer_accounts_data', activity_name: 'Read Customer Accounts Data', category_id: 4, sort_order: 2 },
  { activity_identifier: 'change_customer_account_status', activity_name: 'Update Customer Accounts Status', category_id: 4, sort_order: 3 },
  { activity_identifier: 'read_scammer_data', activity_name: 'Read Scammer Records', category_id: 4, sort_order: 4 },
  { activity_identifier: 'change_scammer_status', activity_name: 'Manage Scammer Records', category_id: 4, sort_order: 5 },

  { activity_identifier: 'customer_loyalty_activity', activity_name: 'Customer Loyalty Activity', category_id: 5, sort_order: 1 },
  { activity_identifier: 'read_customer_loyalty_data', activity_name: 'Read Customer Loyalty Requests', category_id: 5, sort_order: 2 },
  { activity_identifier: 'change_customer_loyalty_status', activity_name: 'Update Customer Loyalty  Request Status', category_id: 5, sort_order: 3 },

  { activity_identifier: 'customer_help_activity', activity_name: 'Customer Help Activity', category_id: 6, sort_order: 1 },
  { activity_identifier: 'read_help_requests', activity_name: 'Read Customer Help Request', category_id: 6, sort_order: 2 },
  { activity_identifier: 'change_help_requests_status', activity_name: 'Change Customer Help Status', category_id: 6, sort_order: 3 },
  { activity_identifier: 'comunicatte_to_customer', activity_name: 'SMS-Email Customer', category_id: 6, sort_order: 4 },
  { activity_identifier: 'manage_message_templates', activity_name: 'Manage SMS & Email Templates', category_id: 6, sort_order: 5 },
  { activity_identifier: 'manage_bulk_sms', activity_name: 'Manage Bulk SMS Queue', category_id: 6, sort_order: 6 },

  { activity_identifier: 'view_admin_dashboard', activity_name: 'View Admin Dashboard', category_id: 44, sort_order: 1 },

  { activity_identifier: 'customer_manage_activity', activity_name: 'Customer Manage Activity', category_id: 40, sort_order: 1 },
  { activity_identifier: 'system_user_manage_activity', activity_name: 'System User Manage Activity', category_id: 40, sort_order: 2 },
  { activity_identifier: 'role_manage_activity', activity_name: 'Role Manage Activity', category_id: 40, sort_order: 3 },
  { activity_identifier: 'view_shift_schedule', activity_name: 'View Shift Schedule', category_id: 40, sort_order: 4 },
  { activity_identifier: 'change_shift_schedule', activity_name: 'Update Shift Schedule', category_id: 40, sort_order: 5 },

  { activity_identifier: 'view_account_configs', activity_name: 'View Account Configurations', category_id: 41, sort_order: 1 },
  { activity_identifier: 'change_account_configs', activity_name: 'Update Account Configurations', category_id: 41, sort_order: 2 },

  { activity_identifier: 'view_currency_configs', activity_name: 'View Currency Configurations', category_id: 42, sort_order: 1 },
  { activity_identifier: 'change_currency_configs', activity_name: 'Update Currency Configurations', category_id: 42, sort_order: 2 },

  { activity_identifier: 'manage_blog_posts', activity_name: 'Manage Blog Posts', category_id: 43, sort_order: 1 },

  { activity_identifier: 'view_team_performance', activity_name: 'View Team Performance', category_id: 45, sort_order: 1 },
  { activity_identifier: 'view_my_performance', activity_name: 'View My Performance', category_id: 45, sort_order: 2 },
];

/** Laravel RoleAndPermissionSeeder defaults + new portal permissions for super-admin. */
export const BUILTIN_ROLE_PERMISSIONS = {
  customer: [
    'cusomer_deposit_activity',
    'cusomer_withdrawal_activity',
    'customer_profile_activity',
    'customer_accounts_activity',
    'customer_loyalty_activity',
    'customer_help_activity',
  ],
  'sub-admin': [
    'view_admin_dashboard',
    'read_deposit_data',
    'status_update_deposit_data',
    'read_withdrawal_data',
    'status_update_withdrawal_data',
    'read_profile_data',
    'change_profile_status',
    'read_customer_accounts_data',
    'change_customer_account_status',
    'read_customer_loyalty_data',
    'change_customer_loyalty_status',
    'read_help_requests',
    'change_help_requests_status',
    'customer_manage_activity',
    'view_account_configs',
    'view_currency_configs',
    'comunicatte_to_customer',
    'read_scammer_data',
    'manage_message_templates',
    'manage_bulk_sms',
    'view_my_performance',
  ],
  'super-admin': [
    'view_admin_dashboard',
    'read_deposit_data',
    'status_update_deposit_data',
    'read_withdrawal_data',
    'status_update_withdrawal_data',
    'read_profile_data',
    'change_profile_status',
    'read_customer_accounts_data',
    'change_customer_account_status',
    'read_customer_loyalty_data',
    'change_customer_loyalty_status',
    'read_help_requests',
    'change_help_requests_status',
    'customer_manage_activity',
    'view_account_configs',
    'view_currency_configs',
    'system_user_manage_activity',
    'role_manage_activity',
    'view_shift_schedule',
    'change_shift_schedule',
    'change_account_configs',
    'change_currency_configs',
    'manage_blog_posts',
    'comunicatte_to_customer',
    'read_scammer_data',
    'change_scammer_status',
    'manage_message_templates',
    'manage_bulk_sms',
    'view_team_performance',
    'view_my_performance',
  ],
  'deposit-executive': [
    'view_admin_dashboard',
    'read_deposit_data',
    'status_update_deposit_data',
    'read_customer_loyalty_data',
    'change_customer_loyalty_status',
    'comunicatte_to_customer',
    'view_my_performance',
  ],
  'withdrawal-executive': [
    'view_admin_dashboard',
    'read_withdrawal_data',
    'status_update_withdrawal_data',
    'comunicatte_to_customer',
    'view_my_performance',
  ],
};

const categoryOrderMap = new Map(
  SYSTEM_ACTIVITY_CATEGORIES.map((category) => [category.id, category.display_order]),
);
const activityOrderMap = new Map(
  SYSTEM_ACTIVITIES.map((activity) => [activity.activity_identifier, activity.sort_order]),
);

export function sortCategoriesForDisplay(categories = []) {
  return [...categories].sort((a, b) => {
    const orderA = categoryOrderMap.get(a.id) ?? a.id;
    const orderB = categoryOrderMap.get(b.id) ?? b.id;
    return orderA - orderB;
  });
}

export function sortActivitiesForDisplay(activities = []) {
  return [...activities].sort((a, b) => {
    const orderA = activityOrderMap.get(a.identifier) ?? 999;
    const orderB = activityOrderMap.get(b.identifier) ?? 999;
    return orderA - orderB;
  });
}

export function buildGroupedActivitiesFromCatalog() {
  const categoriesById = new Map(SYSTEM_ACTIVITY_CATEGORIES.map((category) => [category.id, category]));
  const grouped = new Map();

  for (const activity of SYSTEM_ACTIVITIES) {
    if (!grouped.has(activity.category_id)) {
      const category = categoriesById.get(activity.category_id);
      if (!category) continue;
      grouped.set(activity.category_id, {
        id: category.id,
        identifier: category.category_identifier,
        name: category.categoy_name,
        activities: [],
      });
    }
    grouped.get(activity.category_id).activities.push({
      identifier: activity.activity_identifier,
      name: activity.activity_name,
    });
  }

  return sortCategoriesForDisplay([...grouped.values()]).map((category) => ({
    ...category,
    activities: sortActivitiesForDisplay(category.activities),
  }));
}
