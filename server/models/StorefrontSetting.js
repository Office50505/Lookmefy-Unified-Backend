import mongoose from 'mongoose';

const STOREFRONT_SETTING_KEY = 'global';

const storefrontSettingSchema = new mongoose.Schema(
  {
    key: { type: String, default: STOREFRONT_SETTING_KEY, unique: true, index: true },
    demoEcommerceMode: { type: Boolean, default: false },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'AdminUser' }
  },
  { timestamps: true }
);

storefrontSettingSchema.methods.toClient = function toClient() {
  return {
    demoEcommerceMode: Boolean(this.demoEcommerceMode),
    updatedAt: this.updatedAt || null
  };
};

async function getStorefrontSetting() {
  return StorefrontSetting.findOneAndUpdate(
    { key: STOREFRONT_SETTING_KEY },
    { $setOnInsert: { key: STOREFRONT_SETTING_KEY, demoEcommerceMode: false } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}

const StorefrontSetting = mongoose.model('StorefrontSetting', storefrontSettingSchema);

export default StorefrontSetting;
export { STOREFRONT_SETTING_KEY, getStorefrontSetting };
