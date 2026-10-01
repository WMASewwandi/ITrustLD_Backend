const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const TYPE_PHRASE = {
  int: 'a numeric ID',
  email: 'a valid email address',
  mobile: 'a valid mobile number',
};

const TYPE_PLACEHOLDER = {
  int: 'numeric ID',
  email: 'email address',
  mobile: 'mobile number',
  text: 'account ID',
  vachar: 'account ID',
};

export function parsePlatformTypes(value) {
  if (Array.isArray(value)) {
    return [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))];
  }
  return [
    ...new Set(
      String(value || '')
        .split(/[,|]/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

export function platformTypesFromSource(source) {
  if (Array.isArray(source)) return parsePlatformTypes(source);
  if (source && typeof source === 'object') {
    if (Array.isArray(source.platformTypes) && source.platformTypes.length) {
      return parsePlatformTypes(source.platformTypes);
    }
    return parsePlatformTypes(source.platformType);
  }
  return parsePlatformTypes(source);
}

function canonicalType(type) {
  return String(type || '').trim().toLowerCase();
}

function matchesType(value, type) {
  if (type === 'int') return /^\d+$/.test(value);
  if (type === 'email') return EMAIL_PATTERN.test(value);
  if (type === 'mobile') return /^\+?\d{7,15}$/.test(value.replace(/[\s()-]/g, ''));
  if (type === 'text' || type === 'vachar') return value.length > 0;
  return false;
}

function joinPhrases(phrases) {
  if (phrases.length <= 1) return phrases[0] || '';
  if (phrases.length === 2) return `${phrases[0]} or ${phrases[1]}`;
  return `${phrases.slice(0, -1).join(', ')}, or ${phrases[phrases.length - 1]}`;
}

function restrictiveTypes(types) {
  return types
    .map(canonicalType)
    .filter((type) => TYPE_PHRASE[type]);
}

export function platformAccountFormatHint(source) {
  const types = platformTypesFromSource(source).map(canonicalType);
  if (!types.length || types.some((type) => type === 'text' || type === 'vachar')) {
    return 'Enter your platform account ID.';
  }
  const phrases = [...new Set(restrictiveTypes(types).map((type) => TYPE_PHRASE[type]))];
  if (!phrases.length) return 'Enter your platform account ID.';
  if (phrases.length === 1 && types.includes('email') && types.length === 1) {
    return 'Please enter a valid email address.';
  }
  return `Enter ${joinPhrases(phrases)}.`;
}

export function platformAccountPlaceholder(source) {
  const types = platformTypesFromSource(source).map(canonicalType);
  if (!types.length || types.some((type) => type === 'text' || type === 'vachar')) {
    return 'Your account ID';
  }
  const labels = [...new Set(types.map((type) => TYPE_PLACEHOLDER[type]).filter(Boolean))];
  if (labels.length === 1) {
    return `Your ${labels[0]}`;
  }
  return joinPhrases(labels.map((label) => label.charAt(0).toUpperCase() + label.slice(1)));
}

export function validatePlatformAccountId(accountId, source, requiredMessage = 'Account ID is required.') {
  const value = String(accountId || '').trim();
  if (!value) return requiredMessage;

  const types = platformTypesFromSource(source).map(canonicalType);
  if (!types.length || types.some((type) => type === 'text' || type === 'vachar')) return null;
  if (types.some((type) => matchesType(value, type))) return null;

  return platformAccountFormatHint(types);
}
