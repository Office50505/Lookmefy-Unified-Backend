function envFlag(value, fallback = false) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function isProductionRuntime() {
  return process.env.NODE_ENV === 'production';
}

function devModeBypassEnabled() {
  return !isProductionRuntime() && envFlag(process.env.ENABLE_DEV_MODE_BYPASS, false);
}

function signupDevModeDefault() {
  return devModeBypassEnabled() && envFlag(process.env.SIGNUP_DEV_MODE_DEFAULT, false);
}

function userDevModeControlsEnabled() {
  return devModeBypassEnabled() && envFlag(process.env.ALLOW_USER_DEV_MODE_TOGGLE, false);
}

function effectiveDevMode(user) {
  return devModeBypassEnabled() && Boolean(user?.devMode);
}

export {
  devModeBypassEnabled,
  effectiveDevMode,
  envFlag,
  isProductionRuntime,
  signupDevModeDefault,
  userDevModeControlsEnabled
};
