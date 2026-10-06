export const STOREKIT_PRODUCT_IDS = Object.freeze({
  monthlySubscription: 'com.lookmefy.premium.monthly',
  credits150: 'com.lookmefy.credits150'
});

export const STOREKIT_MONTHLY_SUBSCRIPTION_PRODUCT_ID = STOREKIT_PRODUCT_IDS.monthlySubscription;
export const STOREKIT_CREDITS_150_PRODUCT_ID = STOREKIT_PRODUCT_IDS.credits150;

export function storeKitAppAccountTokenForUser(user) {
  const hex = String(user?.id || user?._id || '').trim().toLowerCase();
  if (!/^[a-f0-9]{24}$/.test(hex)) return '';
  return `00000000-${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 24)}`;
}
