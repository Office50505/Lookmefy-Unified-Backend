import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeAvatarCropInput,
  phoneEmail,
  profileMediaFileForKind,
  signAuthActionToken,
  verifyAuthActionToken
} from '../server/routes/auth.js';

test('mobile compatibility derives deterministic phone email addresses', () => {
  assert.equal(phoneEmail('+91 98765 43210'), 'phone-919876543210@phone.lookmefy.local');
  assert.equal(phoneEmail('9876543210'), 'phone-9876543210@phone.lookmefy.local');
});

test('mobile action tokens preserve phone, purpose, and otp session', () => {
  process.env.JWT_SECRET = 'mobile-auth-compat-secret';
  const token = signAuthActionToken({
    phone: '+919876543210',
    purpose: 'signup',
    otpSession: 'otp-session-1'
  });

  assert.deepEqual(verifyAuthActionToken(token, 'signup'), {
    phone: '+919876543210',
    otpSession: 'otp-session-1'
  });
  assert.equal(verifyAuthActionToken(token, 'password-reset'), null);
  assert.equal(verifyAuthActionToken('not-a-token', 'signup'), null);
});

test('avatar crop input is normalized and clamped for mobile clients', () => {
  const crop = normalizeAvatarCropInput({
    avatarCrop: {
      scale: 8,
      x: -300,
      y: 24
    }
  });

  assert.equal(crop.scale, 5);
  assert.equal(crop.translateX, -160);
  assert.equal(crop.translateY, 24);
  assert.ok(crop.updatedAt instanceof Date);
});

test('profile media helper maps mobile media kinds to stored fields', () => {
  const user = {
    avatarPhoto: { path: 'uploads/profile/avatar/avatar.jpg' },
    bodyPhoto: {
      path: 'uploads/profile/body.jpg',
      original: { path: 'uploads/profile/original.jpg' }
    }
  };

  assert.equal(profileMediaFileForKind(user, 'avatar').path, 'uploads/profile/avatar/avatar.jpg');
  assert.equal(profileMediaFileForKind(user, 'body').path, 'uploads/profile/body.jpg');
  assert.equal(profileMediaFileForKind(user, 'body-original').path, 'uploads/profile/original.jpg');
  assert.equal(profileMediaFileForKind(user, 'missing'), null);
});
