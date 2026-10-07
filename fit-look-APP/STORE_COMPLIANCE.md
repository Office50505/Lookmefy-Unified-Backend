# Lookmefy Store Compliance Checklist

Last reviewed: 1 October 2026

This checklist records technical and store-console work needed before releasing Lookmefy. Store approval cannot be guaranteed because Apple and Google review the complete binary, backend behavior, metadata, declarations, regional programs, and reviewer access.

## Ready in the current project

- Public privacy policy: https://lookmefy.in/privacy
- Public terms: https://lookmefy.in/terms
- Public account deletion information is available from the Lookmefy website.
- Signed-in users can permanently delete their account from Profile.
- The backend deletion route removes the user, uploaded media, generated try-ons, wardrobe data, preferences, events, credit records, orders, and queued jobs from active systems.
- iOS digital subscriptions and credit purchases use StoreKit.
- iOS includes camera/photo purpose strings and a `PrivacyInfo.xcprivacy` required-reason manifest.
- Production API traffic is configured for HTTPS.
- Android photo uploads use the system picker. Broad photo/video storage permissions and the unused audio-recording permission are blocked in `mobile/app.json`.
- The mobile app uses Expo SDK 54 / React Native 0.81 and generates Android builds with `compileSdkVersion` and `targetSdkVersion` 36.
- AI previews are identified as estimates and not guarantees of real-world fit or appearance.

## Release blockers

### 1. Upgrade the Android target SDK — completed

The project has been upgraded from Expo SDK 53 to Expo SDK 54. Its generated React Native Android configuration uses Android 16 / API 36 for both the compile and target SDK.

Completed checks:

- Expo dependency validation passes.
- The Android production JavaScript bundle exports successfully.
- `targetSdkVersion` and `compileSdkVersion` resolve to 36.

Before each store release, complete the production-device regression tests in the Final release verification section and upload an Android App Bundle (`.aab`), not the internal APK profile.

### 2. Replace or formally enroll Android digital billing

The Android build currently excludes `expo-iap` and uses PhonePe for credits/subscriptions. Credits and subscriptions unlock digital app functionality, so a standard Play Store release must use Google Play Billing.

Choose one compliant route before release:

- Implement Google Play Billing for Android credit products and subscriptions, including secure server-side purchase verification, acknowledgement, restore/resync, cancellation management, and real-time developer notifications; or
- Enroll in an applicable Google Play alternative-billing program for every served region and implement all required disclosures, choice screens, transaction reporting, and fees.

Do not submit the current Android payment flow to the normal Play billing program unchanged.

### 3. Add an in-app AI-output reporting flow

Google Play requires generative-AI apps to let users report or flag offensive AI-generated content without leaving the app.

Required work:

- Add `Report AI output` beside every generated image, video, and stylist response.
- Submit the report inside the app to a persistent backend record.
- Include output ID, user ID, reason, optional note, timestamps, and moderation status.
- Create an operational review/removal process and use reports to improve safety filters.

### 4. Record explicit third-party AI consent

Before a personal photo is sent to a third-party AI provider, show a clear disclosure explaining what is sent, why it is sent, and who processes it. Require an affirmative action and store the consent version and timestamp. Provide a way to withdraw consent and delete associated data.

This must cover both new accounts and existing users who have not accepted the current disclosure.

### 5. Build iOS with the required toolchain

App Store Connect uploads must be built with Xcode 26 or newer and the iOS 26 SDK.

Required work:

- Produce and test an archive with the current required Xcode/iOS SDK.
- Validate the privacy manifest in the archived app.
- Run StoreKit sandbox tests for purchase, pending purchase, restore, renewal, cancellation, billing retry, refund, and revoked entitlement.

## Store-console declarations

These cannot be completed only in source code:

- Google Play Data safety form must match account data, phone/email, user photos, wardrobe media, generated content, purchase history, app activity, diagnostics/security logs, and every third-party SDK/provider.
- Add the public privacy-policy URL and web account-deletion URL in Play Console.
- Complete the Google Play AI-generated-content declarations and label any in-scope AI-generated store assets.
- Complete Google Play content rating, target audience, app access/reviewer credentials, ads declaration, and financial-features declarations where applicable.
- Complete App Store privacy nutrition labels, including data processed by third-party AI, storage, payment, OTP, analytics, and infrastructure providers.
- Add the privacy-policy URL in App Store Connect and complete the updated age-rating questions.
- Provide App Review with a working demo account or review instructions that do not depend on inaccessible OTP delivery.
- Configure all App Store and Play products, prices, subscription terms, support URLs, and cancellation instructions.
- If distributing in the EU, complete Apple DSA trader status and all applicable regional declarations.

## Final release verification

- Test production builds, not Expo Go.
- Verify all permission prompts are contextual and denied permissions have a usable fallback.
- Verify account deletion and media removal against the production backend and storage provider.
- Verify privacy/terms/deletion links are public without login.
- Verify generated-content safety filters and reporting from both platforms.
- Verify no development endpoints, exposed OTPs, test payment modes, debug menus, or placeholder content remain.
- Confirm screenshots, descriptions, pricing, AI claims, and product availability accurately match the submitted build.
