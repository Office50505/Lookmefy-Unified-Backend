# FitLook Mobile App

This project now includes a React Native Expo client in `mobile/` that uses the existing Express/MongoDB API in `server/`.

## Setup

1. Copy `.env.example` to `.env` at the project root and fill in real values for `MONGODB_URI`, `JWT_SECRET`, and `FAL_KEY`.
2. Copy `mobile/.env.example` to `mobile/.env`.
3. Set the production API URL with HTTPS, for example `EXPO_PUBLIC_API_URL=https://api.lookmefy.in/api`.
4. For local development only, Android emulator can use `EXPO_PUBLIC_API_URL=http://10.0.2.2:5050/api`.
5. For local development only, iOS simulator can use `EXPO_PUBLIC_API_URL=http://localhost:5050/api`.

## Run

```sh
npm install
npm --prefix mobile install
npm run server
npm run mobile
```

## AI preflight

Before enabling or deploying AI features, run the masked backend checklist:

```sh
npm run server:ai-preflight
npm run server:ai-preflight:prod-env
```

After deploying the backend to AWS, check the live production API with the admin key:

```sh
curl -H "x-admin-key: <admin-key>" https://api.lookmefy.in/api/health/ai
```

The endpoint reports provider keys as `set` or `missing` only. It does not return secret values.

## iPhone

```sh
npm run mobile:ios
```

To generate or refresh the native iOS project, run:

```sh
npm run mobile:ios:prebuild
```

## TestFlight

Plan:

1. Confirm the Apple Developer account has an App Store Connect app record for bundle ID `com.kratikdhote.lookmefy`.
2. Build a production iOS `.ipa` with the EAS `production` profile.
3. Submit that build to App Store Connect/TestFlight.
4. Wait for Apple processing, then add internal testers in App Store Connect. Add external testers only when you are ready for Beta App Review.

One-time setup:

```sh
npm install --global eas-cli
cd mobile
eas login
eas credentials --platform ios
```

When `eas credentials --platform ios` asks about credentials, use the Apple Developer team that owns bundle ID `com.kratikdhote.lookmefy`. The native Xcode project currently uses Apple team ID `LJ48CVC23W`.

If the App Store Connect app record already exists, add its numeric Apple ID as `submit.production.ios.ascAppId` in `mobile/eas.json` to avoid interactive app selection during submit.

Build and submit to TestFlight in one step from the repo root:

```sh
npm run mobile:ios:testflight
```

Or build and submit separately:

```sh
npm run mobile:ios:build
npm run mobile:ios:submit
```

Versioning notes:

- Current app version is `1.0.1`.
- Local iOS build number is seeded at `16`.
- EAS production builds use remote `autoIncrement`, so each new TestFlight upload gets a unique build number.
- The previous iOS TestFlight line used version `1.0`, so new iOS uploads should stay at `1.0.1` or higher. Do not upload another `0.x` iOS build for this app.

Your remaining App Store Connect work:

1. Sign in to App Store Connect with the Apple Developer account.
2. Open or create the Lookmefy app record.
3. Confirm the bundle ID is exactly `com.kratikdhote.lookmefy`.
4. After the EAS upload finishes, open the TestFlight tab and wait for Apple build processing.
5. If Apple asks for export compliance, the app is configured with `ITSAppUsesNonExemptEncryption=false`.
6. Create an internal testing group, add your Apple ID email, and add the uploaded build to that group.
7. On the iPhone, install Apple's TestFlight app, accept the invite email/link, and install Lookmefy.
8. For external testers, add an external testing group and submit the build for Apple's Beta App Review before inviting them.

The mobile app includes the user-facing web features: signup/login with profile photo upload, product browsing and filtering, product details, token state, product try-ons, custom garment try-on, StyleBot Amazon search, and informational pages.
