import dotenv from 'dotenv';
import mongoose from 'mongoose';
import AdminUser from '../server/models/AdminUser.js';
import AdminAuditLog from '../server/models/AdminAuditLog.js';
import { adminPasswordError, normalizeAdminName } from '../server/utils/adminCredentials.js';
import { ADMIN_ROLES, ALL_ADMIN_SECTIONS, normalizeAdminEmail } from '../server/utils/adminPermissions.js';
import { hashPassword } from '../server/utils/passwordHashing.js';

dotenv.config({ path: process.env.ENV_FILE || '.env' });

async function main() {
  const email = normalizeAdminEmail(process.env.MASTER_ADMIN_EMAIL);
  const password = String(process.env.MASTER_ADMIN_PASSWORD || '');
  const resetExisting = process.argv.includes('--reset-existing');
  if (!email || !/^\S+@\S+\.\S+$/.test(email)) throw new Error('Set MASTER_ADMIN_EMAIL to a valid email for this one-time command');
  const passwordError = adminPasswordError(password);
  if (passwordError) throw new Error(`MASTER_ADMIN_PASSWORD: ${passwordError}`);
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is missing');

  await mongoose.connect(process.env.MONGODB_URI, {
    dbName: process.env.MONGODB_DB || 'fitlook',
    serverSelectionTimeoutMS: 10000
  });

  const [activeMasterCount, existingTarget] = await Promise.all([
    AdminUser.countDocuments({ role: ADMIN_ROLES.MASTER, status: 'active' }),
    AdminUser.findOne({ email }).select('+credentialHash')
  ]);
  if (activeMasterCount > 0 && !resetExisting) {
    throw new Error('An active Master already exists; use --reset-existing only when intentionally replacing that Master account password');
  }
  if (activeMasterCount > 0 && (existingTarget?.role !== ADMIN_ROLES.MASTER || existingTarget?.status !== 'active')) {
    throw new Error('MASTER_ADMIN_EMAIL must identify an active Master when using --reset-existing');
  }

  let admin = existingTarget;
  if (!admin) {
    admin = new AdminUser({
      name: normalizeAdminName(process.env.MASTER_ADMIN_NAME, email),
      email,
      credentialHash: await hashPassword(password)
    });
  } else {
    admin.credentialHash = await hashPassword(password);
    admin.credentialVersion = Number(admin.credentialVersion || 1) + 1;
  }
  admin.role = ADMIN_ROLES.MASTER;
  admin.status = 'active';
  admin.sectionAccess = [...ALL_ADMIN_SECTIONS];
  await admin.save();

  await AdminAuditLog.create({
    actorAdmin: admin._id,
    actorEmail: admin.email,
    actorRole: admin.role,
    action: activeMasterCount > 0 ? 'admin_master_password_reset' : 'admin_master_bootstrapped',
    entityType: 'admin_user',
    entityId: String(admin._id),
    label: admin.email,
    detail: { source: 'bootstrap-script', sessionsRevoked: Boolean(existingTarget) }
  });
  console.log(`[admin-bootstrap] Master account ready for ${admin.email}${existingTarget ? '; previous sessions are revoked' : ''}`);
}

main()
  .catch((error) => {
    console.error(`[admin-bootstrap] failed: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect().catch(() => {}));
