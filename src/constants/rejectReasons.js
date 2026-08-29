export const REJECT_REASON_CATEGORIES = [
  { id: 'deposit', label: 'Deposits', description: 'Deposit rejects and proof status' },
  { id: 'withdrawal', label: 'Withdrawals', description: 'Withdrawal rejects and proof status' },
  { id: 'kyc_nic', label: 'KYC NIC', description: 'Identity document rejection' },
  { id: 'kyc_address', label: 'KYC Address', description: 'Address document rejection' },
  { id: 'voucher_claim', label: 'Voucher Claims', description: 'Loyalty voucher claim rejection' },
  { id: 'gift_claim', label: 'Gift Claims', description: 'Loyalty gift claim rejection' },
];

export const REJECT_REASON_CATEGORY_IDS = REJECT_REASON_CATEGORIES.map((item) => item.id);

export function isRejectReasonCategory(value) {
  return REJECT_REASON_CATEGORY_IDS.includes(String(value || '').trim());
}

/** Original hardcoded lists — used by the existing-data seeder only. */
const TRANSACTION_REJECT_REASONS = [
  'Your slip is not clear',
  'The transaction date does not match',
  'Cash not received today',
  'Your order amount does not match',
  'Duplicate submission, your account is at risk',
  'Your slip details are incomplete',
  "Your slip's XM ID remark is missing",
  'Contact live chat for assistance',
  'Please write your XM ID clearly in the center of the slip',
  'Please Subscribe IB - 67104269',
  'Custom Message',
];

export const DEFAULT_REJECT_REASONS = {
  deposit: TRANSACTION_REJECT_REASONS,
  withdrawal: TRANSACTION_REJECT_REASONS,
  kyc_nic: [
    'Please upload both sides of the document',
    'Your image is not clear. Please upload clear image',
    'Your document does not include an address',
    'Your document does not include an NIC number',
    'Your document details do not match the registration record',
    'Custom Message',
  ],
  kyc_address: [
    'Your slip is not clear',
    'Invalid document',
    'Your image is not clear. Please upload clear image',
    'Your document does not include an address',
    'Your document details do not match the registration record',
    'Custom Message',
  ],
  voucher_claim: [
    'Invalid documentation',
    'Duplicate claim',
    'Suspicious activity',
    'Terms violation',
    'Account verification failed',
    'Other',
  ],
  gift_claim: [
    'Not eligible for this gift',
    'Duplicate claim',
    'Gift offer expired',
    'Invalid or missing details',
    'Suspicious activity',
    'Terms violation',
    'Custom',
  ],
};
