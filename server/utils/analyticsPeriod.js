const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_ANALYTICS_DAYS = 180;

function startOfUtcDay(value) {
  const date = new Date(value);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function dateOnly(value, label) {
  const raw = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw new Error(`${label} must use YYYY-MM-DD`);
  const date = new Date(`${raw}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== raw) throw new Error(`${label} is invalid`);
  return date;
}

function analyticsPeriodFromQuery(query = {}, nowValue = new Date()) {
  const now = new Date(nowValue);
  const preset = String(query.range || '30').trim().toLowerCase();
  let from;
  let to;
  let range = preset;

  if (preset === 'custom') {
    from = dateOnly(query.from, 'From date');
    to = new Date(dateOnly(query.to, 'To date').getTime() + DAY_MS);
  } else {
    const days = Number(preset);
    if (![7, 30, 90].includes(days)) throw new Error('Analytics range must be 7, 30, 90, or custom');
    to = now;
    from = new Date(startOfUtcDay(now).getTime() - ((days - 1) * DAY_MS));
    range = String(days);
  }

  const durationMs = to.getTime() - from.getTime();
  const days = Math.ceil(durationMs / DAY_MS);
  if (durationMs <= 0) throw new Error('From date must be before or equal to the to date');
  if (days > MAX_ANALYTICS_DAYS) throw new Error(`Analytics ranges cannot exceed ${MAX_ANALYTICS_DAYS} days`);

  return {
    range,
    from,
    to,
    previousFrom: new Date(from.getTime() - durationMs),
    previousTo: from,
    days,
    label: range === 'custom' ? `${from.toISOString().slice(0, 10)} to ${new Date(to.getTime() - 1).toISOString().slice(0, 10)}` : `Last ${days} days`
  };
}

export { DAY_MS, MAX_ANALYTICS_DAYS, analyticsPeriodFromQuery };
