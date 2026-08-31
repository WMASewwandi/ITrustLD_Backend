export const REJECT_REASON_CATEGORIES = [
  { id: 'deposit', label: 'Deposits', description: 'Deposit rejects and proof status' },
  { id: 'withdrawal', label: 'Withdrawals', description: 'Withdrawal rejects and proof status' },
  { id: 'kyc_nic', label: 'KYC NIC', description: 'Identity document rejection' },
  { id: 'kyc_address', label: 'KYC Address', description: 'Address document rejection' },
  { id: 'loyalty_order', label: 'Loyalty Orders', description: 'Loyalty point redemption rejection' },
  { id: 'voucher_claim', label: 'Voucher Claims', description: 'Loyalty voucher claim rejection' },
  { id: 'gift_claim', label: 'Gift Claims', description: 'Loyalty gift claim rejection' },
];

export const REJECT_REASON_CATEGORY_IDS = REJECT_REASON_CATEGORIES.map((item) => item.id);

export function isRejectReasonCategory(value) {
  return REJECT_REASON_CATEGORY_IDS.includes(String(value || '').trim());
}
