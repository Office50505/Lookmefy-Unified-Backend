import CreditEvent from '../models/CreditEvent.js';
import User from '../models/User.js';

function creditLedgerError(message, statusCode, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function normalizeDirection(value, tokens) {
  const direction = String(value || '').trim().toLowerCase();
  if (direction === 'credit' || direction === 'debit') return direction;
  return Number(tokens) < 0 ? 'debit' : 'credit';
}

function normalizeTokenAmount(value) {
  const tokens = Number(value);
  if (!Number.isSafeInteger(tokens)) {
    throw creditLedgerError('Credit amount must be a whole number.', 400, 'invalid_credit_amount');
  }
  return Math.abs(tokens);
}

function applySession(query, session) {
  if (session && query && typeof query.session === 'function') return query.session(session);
  return query;
}

async function createCreditEvent(model, doc, session) {
  if (session) {
    const [event] = await model.create([doc], { session });
    return event;
  }
  return model.create(doc);
}

async function findCreditEvent(model, filter, session) {
  return applySession(model.findOne(filter), session);
}

async function findUserById(model, userId, session) {
  return applySession(model.findById(userId), session);
}

function userActiveFilter(userId) {
  return {
    _id: userId,
    $or: [{ accountStatus: 'active' }, { accountStatus: { $exists: false } }]
  };
}

function eventPayload({
  userId,
  action,
  product,
  productTitle,
  productImageUrl,
  tokens,
  balanceAfter,
  direction,
  source,
  sourceId,
  fulfillmentKey,
  metadata
}) {
  const payload = {
    user: userId,
    action,
    product,
    productTitle,
    productImageUrl,
    tokens,
    balanceAfter,
    direction,
    source,
    metadata
  };
  if (sourceId) payload.sourceId = sourceId;
  if (fulfillmentKey) payload.fulfillmentKey = fulfillmentKey;
  return payload;
}

async function applyCreditLedgerEntry({
  userId,
  action,
  tokens,
  direction,
  source = 'system',
  sourceId = '',
  fulfillmentKey = '',
  product,
  productTitle = '',
  productImageUrl = '',
  metadata = {},
  userSet = {},
  session,
  models = {}
}) {
  if (!userId) throw creditLedgerError('User id is required for credit ledger updates.', 400, 'missing_user_id');
  if (!String(action || '').trim()) throw creditLedgerError('Credit action is required.', 400, 'missing_credit_action');

  const UserModel = models.User || User;
  const CreditEventModel = models.CreditEvent || CreditEvent;
  const normalizedDirection = normalizeDirection(direction, tokens);
  const normalizedTokens = normalizeTokenAmount(tokens);
  const delta = normalizedDirection === 'debit' ? -normalizedTokens : normalizedTokens;

  if (fulfillmentKey) {
    const existingEvent = await findCreditEvent(CreditEventModel, { fulfillmentKey }, session);
    if (existingEvent) {
      return {
        user: await findUserById(UserModel, userId, session),
        event: existingEvent,
        alreadyRecorded: true
      };
    }
  }

  let user;
  if (normalizedTokens === 0) {
    user = await findUserById(UserModel, userId, session);
    if (!user) throw creditLedgerError('User not found.', 404, 'user_not_found');
  } else {
    const filter = userActiveFilter(userId);
    if (normalizedDirection === 'debit') filter.tokens = { $gte: normalizedTokens };
    const update = { $inc: { tokens: delta } };
    if (userSet && Object.keys(userSet).length) update.$set = userSet;

    user = await UserModel.findOneAndUpdate(
      filter,
      update,
      { new: true, session }
    );
    if (!user) {
      throw creditLedgerError(
        normalizedDirection === 'debit' ? 'Not enough credits.' : 'User not found.',
        normalizedDirection === 'debit' ? 402 : 404,
        normalizedDirection === 'debit' ? 'insufficient_credits' : 'user_not_found'
      );
    }
  }

  const event = await createCreditEvent(CreditEventModel, eventPayload({
    userId,
    action: String(action).trim(),
    product,
    productTitle,
    productImageUrl,
    tokens: normalizedTokens,
    balanceAfter: Number(user.tokens || 0),
    direction: normalizedDirection,
    source: String(source || 'system').trim().toLowerCase(),
    sourceId: String(sourceId || '').trim(),
    fulfillmentKey: String(fulfillmentKey || '').trim(),
    metadata
  }), session);

  return { user, event, alreadyRecorded: false };
}

function creditUser(options) {
  return applyCreditLedgerEntry({ ...options, direction: 'credit' });
}

function debitUser(options) {
  return applyCreditLedgerEntry({ ...options, direction: 'debit' });
}

export {
  applyCreditLedgerEntry,
  creditUser,
  debitUser,
  normalizeDirection,
  normalizeTokenAmount
};
