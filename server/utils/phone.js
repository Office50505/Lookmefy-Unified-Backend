const INDIAN_MOBILE_PATTERN = /^[6-9]\d{9}$/;

function normalizeIndianMobile(value = '') {
  const raw = String(value || '').trim();
  if (!raw || /[a-z]/i.test(raw)) return '';
  const digits = raw.replace(/\D/g, '');
  let local = '';

  if (digits.length === 10) {
    local = digits;
  } else if (digits.length === 11 && digits.startsWith('0')) {
    local = digits.slice(1);
  } else if (digits.length === 12 && digits.startsWith('91')) {
    local = digits.slice(2);
  } else {
    return '';
  }

  return INDIAN_MOBILE_PATTERN.test(local) ? `+91${local}` : '';
}

function isValidIndianMobile(value = '') {
  return Boolean(normalizeIndianMobile(value));
}

export { isValidIndianMobile, normalizeIndianMobile };
