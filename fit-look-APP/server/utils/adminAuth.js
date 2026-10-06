import { timingSafeEqual } from 'node:crypto';

function safeEqual(a = '', b = '') {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

function requireAdmin(req, res, next) {
  const adminKey = String(process.env.ADMIN_KEY || '');
  if (!adminKey) return res.status(503).json({ message: 'Admin access is not configured' });
  if (!safeEqual(req.get('x-admin-key') || '', adminKey)) return res.status(401).json({ message: 'Invalid admin key' });
  next();
}

export { requireAdmin };
