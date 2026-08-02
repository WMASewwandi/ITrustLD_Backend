export const IDENTITY_TYPE_TO_API = {
  "National Identity Card (Both sides)": 'NIC',
  "Driver's License": 'DL',
  Passport: 'PASSPORT',
};

export const ADDRESS_TYPE_TO_API = {
  'Electricity Bill': 'ELECTRICITY_BILL',
  'Water Bill': 'WATER_BILL',
  'Telephone Bill': 'TELEPHONE_BILL',
  'Utility Bill': 'UTILITY_BILL',
  Other: 'OTHER',
};

export const IDENTITY_TYPE_FROM_API = Object.fromEntries(
  Object.entries(IDENTITY_TYPE_TO_API).map(([label, value]) => [value, label]),
);

export const ADDRESS_TYPE_FROM_API = Object.fromEntries(
  Object.entries(ADDRESS_TYPE_TO_API).map(([label, value]) => [value, label]),
);
