export const STOREKIT_PRODUCT_IDS = Object.freeze({
  monthlySubscription: 'com.lookmefy.premium.monthly',
  creditTopUps: Object.freeze({
    top_up_50_credits: 'com.lookmefy.credits50',
    top_up_75_credits: 'com.lookmefy.credits75',
    top_up_110_credits: 'com.lookmefy.credits110',
    top_up_135_credits: 'com.lookmefy.credits135',
    top_up_400_credits: 'com.lookmefy.credits400'
  })
});

export const STOREKIT_MONTHLY_SUBSCRIPTION_PRODUCT_ID = STOREKIT_PRODUCT_IDS.monthlySubscription;
export const STOREKIT_CREDIT_TOP_UP_PRODUCT_IDS_BY_PLAN_ID = STOREKIT_PRODUCT_IDS.creditTopUps;
export const STOREKIT_CONSUMABLE_PRODUCT_IDS = Object.freeze(Object.values(STOREKIT_CREDIT_TOP_UP_PRODUCT_IDS_BY_PLAN_ID));
export const STOREKIT_ALL_PRODUCT_IDS = Object.freeze([
  STOREKIT_MONTHLY_SUBSCRIPTION_PRODUCT_ID,
  ...STOREKIT_CONSUMABLE_PRODUCT_IDS
]);

const STOREKIT_CONSUMABLE_PRODUCT_ID_SET = new Set(STOREKIT_CONSUMABLE_PRODUCT_IDS);
const STOREKIT_ALL_PRODUCT_ID_SET = new Set(STOREKIT_ALL_PRODUCT_IDS);

export function storeKitProductIdForTopUpPlan(plan = {}) {
  const configured = String(plan.appStoreProductId || '').trim();
  if (STOREKIT_CONSUMABLE_PRODUCT_ID_SET.has(configured)) return configured;
  return STOREKIT_CREDIT_TOP_UP_PRODUCT_IDS_BY_PLAN_ID[String(plan.id || '').trim()] || '';
}

export function isStoreKitConsumableProductId(productId) {
  return STOREKIT_CONSUMABLE_PRODUCT_ID_SET.has(String(productId || '').trim());
}

export function isLookmefyStoreKitProductId(productId) {
  return STOREKIT_ALL_PRODUCT_ID_SET.has(String(productId || '').trim());
}

export function storeKitAppAccountTokenForUser(user) {
  const hex = String(user?.id || user?._id || '').trim().toLowerCase();
  if (!/^[a-f0-9]{24}$/.test(hex)) return '';
  return `00000000-${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 24)}`;
}
