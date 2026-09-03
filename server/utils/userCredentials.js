const USER_PASSWORD_MIN_LENGTH = 12;
const USER_PASSWORD_MAX_BYTES = 72;

function authenticationVersion(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function tokenAuthenticationVersionMatches(user, decoded) {
  const currentVersion = authenticationVersion(user?.authVersion);
  if (decoded?.ver === undefined || decoded?.ver === null) return currentVersion === 0;
  return Number.isSafeInteger(decoded.ver) && decoded.ver >= 0 && decoded.ver === currentVersion;
}

function userPasswordError(value) {
  const password = String(value || '');
  if (!password) return 'Password is required';
  if (password.length < USER_PASSWORD_MIN_LENGTH) {
    return `Password must be at least ${USER_PASSWORD_MIN_LENGTH} characters`;
  }
  if (Buffer.byteLength(password, 'utf8') > USER_PASSWORD_MAX_BYTES) {
    return `Password must be at most ${USER_PASSWORD_MAX_BYTES} bytes`;
  }
  return '';
}

export {
  authenticationVersion,
  tokenAuthenticationVersionMatches,
  USER_PASSWORD_MAX_BYTES,
  USER_PASSWORD_MIN_LENGTH,
  userPasswordError
};
