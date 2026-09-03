const ACCOUNT_STATUSES = ['active', 'banned', 'deleted'];

function accountStatusFor(user) {
  const status = String(user?.accountStatus || 'active').toLowerCase();
  return ACCOUNT_STATUSES.includes(status) ? status : 'active';
}

function accountAccessError(user) {
  const status = accountStatusFor(user);
  if (status === 'banned') {
    return { statusCode: 403, message: 'This account has been suspended. Contact support for help.' };
  }
  if (status === 'deleted') {
    return { statusCode: 401, message: 'This account is no longer available.' };
  }
  return null;
}

function tokenBalanceAfter({ current, mode, amount }) {
  if (amount === '' || amount === null || amount === undefined) {
    throw new Error('Token amount must be a non-negative whole number');
  }
  const parsedCurrent = Number(current);
  const parsedAmount = Number(amount);
  if (!['set', 'add'].includes(mode)) throw new Error('Token mode must be set or add');
  if (!Number.isSafeInteger(parsedAmount) || parsedAmount < 0) {
    throw new Error('Token amount must be a non-negative whole number');
  }
  if (!Number.isSafeInteger(parsedCurrent) || parsedCurrent < 0) {
    throw new Error('Current token balance is invalid');
  }
  const next = mode === 'add' ? parsedCurrent + parsedAmount : parsedAmount;
  if (!Number.isSafeInteger(next) || next < 0) throw new Error('Resulting token balance is invalid');
  return next;
}

function anonymizedIdentity(userId) {
  const id = String(userId || '').toLowerCase();
  if (!/^[a-f\d]{24}$/.test(id)) throw new Error('Invalid user id');
  return {
    name: 'Deleted user',
    email: `deleted+${id}@anonymous.lookmefy.invalid`,
    username: `deleted_${id}`
  };
}

export {
  ACCOUNT_STATUSES,
  accountAccessError,
  accountStatusFor,
  anonymizedIdentity,
  tokenBalanceAfter
};
