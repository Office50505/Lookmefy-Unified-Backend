import mongoose from 'mongoose';
import {
  ADMIN_ROLES,
  ALL_ADMIN_SECTIONS,
  normalizeAdminEmail,
  normalizeAdminSections
} from '../utils/adminPermissions.js';

const adminUserSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true, required: true },
    email: { type: String, trim: true, lowercase: true, unique: true, required: true, index: true },
    credentialHash: { type: String, required: true, select: false },
    credentialVersion: { type: Number, default: 1, min: 1 },
    role: {
      type: String,
      enum: Object.values(ADMIN_ROLES),
      default: ADMIN_ROLES.DEVELOPER,
      index: true
    },
    sectionAccess: {
      type: [{ type: String, enum: ALL_ADMIN_SECTIONS }],
      validate: {
        validator(value) {
          return this.status !== 'active'
            || this.role === ADMIN_ROLES.MASTER
            || normalizeAdminSections(value).length > 0;
        },
        message: 'An active developer must have access to at least one section'
      }
    },
    status: {
      type: String,
      enum: ['pending', 'active', 'disabled'],
      default: 'pending',
      index: true
    },
    lastLoginAt: Date,
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'AdminUser' },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'AdminUser' }
  },
  { timestamps: true }
);

adminUserSchema.pre('validate', function normalizeAdminUser() {
  this.email = normalizeAdminEmail(this.email);
  if (this.status === 'pending') {
    this.role = ADMIN_ROLES.DEVELOPER;
    this.sectionAccess = [];
    return;
  }
  this.sectionAccess = this.role === ADMIN_ROLES.MASTER
    ? [...ALL_ADMIN_SECTIONS]
    : normalizeAdminSections(this.sectionAccess);
});

adminUserSchema.index({ status: 1, role: 1, createdAt: -1 });

export default mongoose.model('AdminUser', adminUserSchema);
