import jwt from 'jsonwebtoken';
import AdminUser from '../models/AdminUser.js';
import { adminHasPermission, adminHasSection } from './adminPermissions.js';

async function signAdminSession(admin) {
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is missing on the server');
  const adminId = admin?._id?.toString?.() || String(admin?.id || '');
  if (!adminId) throw new Error('Admin identity is required');
  return jwt.sign(
    { scope: 'admin', sub: adminId, ver: Number(admin.credentialVersion || 1) },
    process.env.JWT_SECRET,
    { expiresIn: '12h' }
  );
}

async function verifyAdminSession(token) {
  if (!token || !process.env.JWT_SECRET) return null;
  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return null;
  }
  if (decoded?.scope !== 'admin' || !decoded.sub) return null;
  const admin = await AdminUser.findById(decoded.sub);
  if (!admin || admin.status !== 'active') return null;
  if (Number(decoded.ver || 0) !== Number(admin.credentialVersion || 1)) return null;
  return admin;
}

async function requireAdmin(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    const session = await verifyAdminSession(token);
    if (!session) return res.status(401).json({ message: 'Invalid admin session' });
    req.admin = session;
    return next();
  } catch (error) {
    return next(error);
  }
}

function requireAdminSection(section) {
  return function checkAdminSection(req, res, next) {
    if (!req.admin) return res.status(401).json({ message: 'Admin authentication required' });
    if (!adminHasSection(req.admin, section)) {
      return res.status(403).json({ message: 'You do not have access to this admin section' });
    }
    return next();
  };
}

function requireAdminPermission(permission) {
  return function checkAdminPermission(req, res, next) {
    if (!req.admin) return res.status(401).json({ message: 'Admin authentication required' });
    if (!adminHasPermission(req.admin, permission)) {
      return res.status(403).json({ message: 'You do not have permission to perform this action' });
    }
    return next();
  };
}

export {
  requireAdmin,
  requireAdminPermission,
  requireAdminSection,
  signAdminSession,
  verifyAdminSession
};
