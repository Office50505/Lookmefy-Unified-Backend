const INDIA_STATES = [
  'Andaman and Nicobar Islands',
  'Andhra Pradesh',
  'Arunachal Pradesh',
  'Assam',
  'Bihar',
  'Chandigarh',
  'Chhattisgarh',
  'Dadra and Nagar Haveli and Daman and Diu',
  'Delhi',
  'Goa',
  'Gujarat',
  'Haryana',
  'Himachal Pradesh',
  'Jammu and Kashmir',
  'Jharkhand',
  'Karnataka',
  'Kerala',
  'Ladakh',
  'Lakshadweep',
  'Madhya Pradesh',
  'Maharashtra',
  'Manipur',
  'Meghalaya',
  'Mizoram',
  'Nagaland',
  'Odisha',
  'Puducherry',
  'Punjab',
  'Rajasthan',
  'Sikkim',
  'Tamil Nadu',
  'Telangana',
  'Tripura',
  'Uttar Pradesh',
  'Uttarakhand',
  'West Bengal'
];

const PINCODE_PREFIX_STATES = [
  [/^11/, 'Delhi'],
  [/^12|^13/, 'Haryana'],
  [/^14|^15/, 'Punjab'],
  [/^16/, 'Chandigarh'],
  [/^17/, 'Himachal Pradesh'],
  [/^18|^19/, 'Jammu and Kashmir'],
  [/^20|^21|^22|^23|^24|^25|^26|^27|^28/, 'Uttar Pradesh'],
  [/^30|^31|^32|^33|^34/, 'Rajasthan'],
  [/^36|^37|^38|^39/, 'Gujarat'],
  [/^40|^41|^42|^43|^44/, 'Maharashtra'],
  [/^45|^46|^47|^48/, 'Madhya Pradesh'],
  [/^49/, 'Chhattisgarh'],
  [/^50/, 'Telangana'],
  [/^51|^52|^53/, 'Andhra Pradesh'],
  [/^56|^57|^58|^59/, 'Karnataka'],
  [/^60|^61|^62|^63|^64/, 'Tamil Nadu'],
  [/^67|^68|^69/, 'Kerala'],
  [/^70|^71|^72|^73|^74/, 'West Bengal'],
  [/^75|^76|^77/, 'Odisha'],
  [/^78/, 'Assam'],
  [/^79/, 'Arunachal Pradesh'],
  [/^80|^81|^82|^83|^84|^85/, 'Bihar'],
  [/^82|^83|^84/, 'Jharkhand']
];

const KNOWN_PINCODES = new Map([
  ['110001', { city: 'New Delhi', district: 'New Delhi', state: 'Delhi' }],
  ['400001', { city: 'Mumbai', district: 'Mumbai', state: 'Maharashtra' }],
  ['560001', { city: 'Bengaluru', district: 'Bengaluru Urban', state: 'Karnataka' }],
  ['600001', { city: 'Chennai', district: 'Chennai', state: 'Tamil Nadu' }],
  ['700001', { city: 'Kolkata', district: 'Kolkata', state: 'West Bengal' }],
  ['500001', { city: 'Hyderabad', district: 'Hyderabad', state: 'Telangana' }],
  ['411001', { city: 'Pune', district: 'Pune', state: 'Maharashtra' }],
  ['452001', { city: 'Indore', district: 'Indore', state: 'Madhya Pradesh' }]
]);

function normalizePincode(value = '') {
  const pincode = String(value || '').replace(/\D/g, '').slice(0, 6);
  return /^\d{6}$/.test(pincode) ? pincode : '';
}

function normalizeIndiaState(value = '') {
  const requested = String(value || '').trim().replace(/\s+/g, ' ');
  return INDIA_STATES.find((state) => state.toLowerCase() === requested.toLowerCase()) || '';
}

function inferStateFromPincode(pincode) {
  const normalized = normalizePincode(pincode);
  if (!normalized) return '';
  return PINCODE_PREFIX_STATES.find(([pattern]) => pattern.test(normalized))?.[1] || '';
}

function lookupPincode(value = '') {
  const pincode = normalizePincode(value);
  if (!pincode) return null;
  const exact = KNOWN_PINCODES.get(pincode);
  const state = exact?.state || inferStateFromPincode(pincode);
  return {
    pincode,
    serviceable: Boolean(state),
    city: exact?.city || '',
    district: exact?.district || '',
    state,
    country: 'India'
  };
}

export { INDIA_STATES, lookupPincode, normalizeIndiaState, normalizePincode };
