import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireUser } from './auth.js';
import { isolateSubjectAsset } from '../utils/backgroundRemoval.js';
import { createRateLimiter, rateLimitKeys } from '../utils/rateLimit.js';

const router = express.Router();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../..');
const debugSubjectIsolation = ['1', 'true', 'yes', 'on'].includes(String(process.env.DEBUG_SUBJECT_ISOLATION || '').toLowerCase());
const subjectIsolationLimiter = createRateLimiter({
  name: 'images:subject-isolation',
  windowMs: 10 * 60 * 1000,
  max: 20,
  keyGenerator: rateLimitKeys.user,
  message: 'Image processing is temporarily limited. Please wait before processing more images.'
});

function logSubjectIsolation(step, meta = {}) {
  if (!debugSubjectIsolation) return;
  console.log(`[subject-isolation:route] ${step}`, meta);
}

function uploadPathname(imageUrl = '') {
  return String(imageUrl || '').trim().split('#')[0].split('?')[0];
}

function userScopedUploadUrl(user, imageUrl = '') {
  const value = String(imageUrl || '').trim();
  const pathname = uploadPathname(value);
  if (!pathname.startsWith('/uploads/')) {
    const error = new Error('Only saved Lookmefy upload images can be processed from this endpoint');
    error.status = 400;
    throw error;
  }
  const currentBodyPhotoUrl = user?.bodyPhoto?.path ? `/${String(user.bodyPhoto.path).replace(/^\/+/, '')}` : '';
  if (currentBodyPhotoUrl && pathname === currentBodyPhotoUrl) return pathname;
  if (/^\/uploads\/profile-fullbody-[^/]+\.(?:png|jpe?g|webp)$/i.test(pathname)) return pathname;
  const expectedPrefix = `/uploads/users/${user._id.toString()}/`;
  if (!pathname.startsWith(expectedPrefix)) {
    const error = new Error('This image does not belong to the current user');
    error.status = 403;
    throw error;
  }
  return pathname;
}

router.post('/subject-isolation', requireUser, subjectIsolationLimiter, async (req, res) => {
  try {
    const imageUrl = userScopedUploadUrl(req.user, req.body?.imageUrl);
    logSubjectIsolation('request received', {
      sourceImageUrl: imageUrl ? imageUrl.replace(/([?&][^=]+=)[^&]+/g, '$1…') : '',
      userId: req.user._id.toString()
    });
    const result = await isolateSubjectAsset({ rootDir, user: req.user, imageUrl });
    const status = result.metadata.processingStatus || 'failed';
    logSubjectIsolation('response prepared', {
      status,
      provider: result.metadata.processingProvider,
      cached: result.metadata.cached,
      outputUrlAvailable: Boolean(result.metadata.transparentImageUrl),
      outputWidth: result.metadata.transparentWidth,
      outputHeight: result.metadata.transparentHeight,
      error: result.metadata.processingError || ''
    });
    res.json({
      status,
      transparentImageUrl: result.metadata.transparentImageUrl,
      errorCode: status === 'failed' ? 'BACKGROUND_REMOVAL_FAILED' : '',
      message: result.metadata.processingError || '',
      processing: result.metadata
    });
  } catch (error) {
    logSubjectIsolation('request failed', { error: error?.message || 'Could not prepare transparent image' });
    res.status(error.status || 400).json({
      status: 'failed',
      transparentImageUrl: '',
      errorCode: 'BACKGROUND_REMOVAL_REQUEST_FAILED',
      message: error?.message || 'Could not prepare transparent image'
    });
  }
});

export default router;
