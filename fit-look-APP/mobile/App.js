import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useFonts } from 'expo-font';
import * as ImagePicker from 'expo-image-picker';
import { StatusBar } from 'expo-status-bar';
import { useVideoPlayer, VideoView } from 'expo-video';
import { Component, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  BackHandler,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  StatusBar as NativeStatusBar,
  useWindowDimensions,
  View
} from 'react-native';
import { api, clearToken, filePart, formatMoney, getToken, imageUrl, saveToken } from './src/api';
import { categories, images, infoPages, policyPages } from './src/assets';
import { calculateCreditPercentage, normalizeProduct, normalizeProducts, resolveImageUrl } from './src/products';
import { STOREKIT_CREDITS_150_PRODUCT_ID, STOREKIT_MONTHLY_SUBSCRIPTION_PRODUCT_ID, storeKitAppAccountTokenForUser } from './src/storeKitProducts';

const logoSymbol = require('./assets/lookmefy-symbol.png');

const genders = ['men', 'women', 'unisex'];
const profileGenderOptions = [
  { value: 'female', label: 'Female', icon: 'female-outline' },
  { value: 'male', label: 'Male', icon: 'male-outline' },
  { value: 'other', label: 'Other', icon: 'person-outline' }
];
const sortOptions = [
  ['', 'Relevant'],
  ['newest', 'Newest'],
  ['price-asc', 'Price low'],
  ['price-desc', 'Price high']
];
const supportEmail = 'support@lookmefy.com';
const aiPreviewDisclaimer = 'Note: AI previews can make mistakes. Check fit, colour, and product details before buying.';
const appTopInset = Platform.OS === 'android' ? Math.max(76, NativeStatusBar.currentHeight || 0) : 0;
const bottomNavigationHeight = Platform.OS === 'ios' ? 86 : 78;
const screenBottomInset = 40;
const screenScrollProps = {
  showsVerticalScrollIndicator: false,
  keyboardShouldPersistTaps: 'handled',
  nestedScrollEnabled: true,
  scrollEventThrottle: 16,
  ...(Platform.OS === 'android'
    ? { overScrollMode: 'never' }
    : {
        alwaysBounceVertical: true,
        bounces: true,
        scrollIndicatorInsets: { bottom: screenBottomInset }
      })
};
const horizontalScrollProps = {
  horizontal: true,
  showsHorizontalScrollIndicator: false,
  keyboardShouldPersistTaps: 'handled',
  nestedScrollEnabled: true,
  directionalLockEnabled: true,
  scrollEventThrottle: 16
};
const homeCategorySnapInterval = 70;
const productImageAspectRatio = 0.8;
const avatarCropReferenceSize = 132;
const homeHeroSlideIntervalMs = 4000;
const homeHeroSlides = [
  { key: 'summer', title: 'SUMMER ESSENTIALS', cta: 'SHOP NOW', image: 'homeSliderAtelier', route: 'shop' },
  { key: 'natural-light', title: 'LIGHT LAYERING', cta: 'EXPLORE', image: 'homeSliderNaturalLight', route: 'shop' },
  { key: 'archway', title: 'NEW SEASON EDIT', cta: 'VIEW ALL', image: 'homeSliderArchway', route: 'shop' }
];
const fontAssets = {
  BodoniModa_400Regular: require('@expo-google-fonts/bodoni-moda/400Regular/BodoniModa_400Regular.ttf'),
  PlusJakartaSans_600SemiBold: require('@expo-google-fonts/plus-jakarta-sans/600SemiBold/PlusJakartaSans_600SemiBold.ttf'),
  PlusJakartaSans_700Bold: require('@expo-google-fonts/plus-jakarta-sans/700Bold/PlusJakartaSans_700Bold.ttf'),
  Manrope_400Regular: require('@expo-google-fonts/manrope/400Regular/Manrope_400Regular.ttf'),
  Manrope_500Medium: require('@expo-google-fonts/manrope/500Medium/Manrope_500Medium.ttf'),
  Manrope_600SemiBold: require('@expo-google-fonts/manrope/600SemiBold/Manrope_600SemiBold.ttf'),
  Manrope_700Bold: require('@expo-google-fonts/manrope/700Bold/Manrope_700Bold.ttf')
};
const fontFamilies = {
  logo: 'BodoniModa_400Regular',
  headingSemiBold: 'PlusJakartaSans_600SemiBold',
  headingBold: 'PlusJakartaSans_700Bold',
  bodyRegular: 'Manrope_400Regular',
  bodyMedium: 'Manrope_500Medium',
  bodySemiBold: 'Manrope_600SemiBold',
  bodyBold: 'Manrope_700Bold'
};

function openSupportEmail(subject = 'Lookmefy support request') {
  const mailUrl = `mailto:${supportEmail}?subject=${encodeURIComponent(subject)}`;
  Linking.openURL(mailUrl).catch(() => {
    Alert.alert('Email support', supportEmail);
  });
}
const typography = {
  display: { fontFamily: fontFamilies.headingBold, fontSize: 30, lineHeight: 38, fontWeight: '700', letterSpacing: 0 },
  h1: { fontFamily: fontFamilies.headingBold, fontSize: 28, lineHeight: 35, fontWeight: '700', letterSpacing: 0 },
  h2: { fontFamily: fontFamilies.headingSemiBold, fontSize: 24, lineHeight: 31, fontWeight: '600', letterSpacing: 0 },
  h3: { fontFamily: fontFamilies.headingSemiBold, fontSize: 20, lineHeight: 26, fontWeight: '600', letterSpacing: 0 },
  h4: { fontFamily: fontFamilies.headingSemiBold, fontSize: 18, lineHeight: 24, fontWeight: '600', letterSpacing: 0 },
  productTitle: { fontFamily: fontFamilies.bodyMedium, fontSize: 16, lineHeight: 22, fontWeight: '500', letterSpacing: 0 },
  body: { fontFamily: fontFamilies.bodyRegular, fontSize: 15, lineHeight: 22, fontWeight: '400', letterSpacing: 0 },
  smallBody: { fontFamily: fontFamilies.bodyRegular, fontSize: 14, lineHeight: 20, fontWeight: '400', letterSpacing: 0 },
  caption: { fontFamily: fontFamilies.bodyMedium, fontSize: 12, lineHeight: 16, fontWeight: '500', letterSpacing: 0 },
  button: { fontFamily: fontFamilies.bodySemiBold, fontSize: 16, lineHeight: 21, fontWeight: '600', letterSpacing: 0 },
  price: { fontFamily: fontFamilies.bodyBold, fontSize: 18, lineHeight: 24, fontWeight: '700', letterSpacing: 0 },
  label: { fontFamily: fontFamilies.bodySemiBold, fontSize: 12, lineHeight: 16, fontWeight: '600', letterSpacing: 0 },
  nav: { fontFamily: fontFamilies.bodySemiBold, fontSize: 11, lineHeight: 14, fontWeight: '600', letterSpacing: 0 }
};
const aiStudioStarterPrompts = [
  {
    title: 'Linen shirts',
    text: 'Easy smart-casual.',
    icon: 'shirt-outline',
    prompt: 'Find linen shirts under ₹1500.'
  },
  {
    title: 'Casual sneakers',
    text: 'Daily footwear picks.',
    icon: 'walk-outline',
    prompt: 'Show casual sneakers under ₹2000.'
  },
  {
    title: 'Office trousers',
    text: 'Polished work options.',
    icon: 'briefcase-outline',
    prompt: 'Find office trousers under ₹1200.'
  }
];
const recentSearchLimit = 5;
const recentSearchStoragePrefix = 'lookmefy_recent_searches';
const onboardingPendingStorageKey = 'lookmefy_onboarding_pending';
const onboardingSeenStoragePrefix = 'lookmefy_onboarding_seen';
const onboardingTourSteps = [
  {
    key: 'intro',
    eyebrow: 'WELCOME',
    title: "Let's take a quick tour",
    text: "It takes a few seconds to show where your profile, AI Studio, wardrobe, and shopping tools live.",
    icon: 'sparkles-outline',
    primary: 'Take a tour'
  },
  {
    key: 'shop',
    eyebrow: 'DISCOVER',
    title: 'Explore categories',
    text: 'Start with the category rail to jump into dresses, tops, shoes, eyewear, and live product cards.',
    icon: 'grid-outline',
    targetKey: 'home-catalog',
    route: { name: 'home' },
    placement: 'below',
    target: ({ width, height }) => ({
      x: 14,
      y: Math.min(height * 0.44, Platform.OS === 'android' ? appTopInset + 320 : 330),
      width: width - 28,
      height: 128
    })
  },
  {
    key: 'stylist',
    eyebrow: 'AI STUDIO',
    title: 'Ask for fashion',
    text: 'Tell Lookmefy the item, occasion, budget, colour, fabric, or vibe. AI Studio searches wearable fashion.',
    icon: 'sparkles-outline',
    targetKey: 'ai-studio-composer',
    route: { name: 'tryon' },
    placement: 'above',
    target: ({ width, height }) => ({
      x: 20,
      y: Math.max(340, height - bottomNavigationHeight - 92),
      width: width - 40,
      height: 62
    })
  },
  {
    key: 'wardrobe',
    eyebrow: 'WARDROBE',
    title: 'Add your clothes',
    text: 'Upload an item and Lookmefy can read its type, colour, fabric, pattern, and tags for review.',
    icon: 'shirt-outline',
    targetKey: 'wardrobe-upload',
    route: { name: 'closet', params: { view: 'add' } },
    placement: 'below',
    target: ({ width, height }) => ({
      x: 20,
      y: Math.min(292, Math.max(210, height * 0.24)),
      width: width - 40,
      height: Math.min(360, Math.max(230, height * 0.38))
    })
  },
  {
    key: 'profile',
    eyebrow: 'PROFILE',
    title: 'Keep your studio ready',
    text: 'Your profile holds orders, credits, try-on portraits, and account settings.',
    icon: 'person-outline',
    targetKey: 'profile-avatar',
    route: { name: 'profile' },
    primary: 'Finish',
    placement: 'below',
    target: ({ width }) => ({
      x: Math.max(18, width - 132),
      y: Platform.OS === 'android' ? appTopInset + 34 : 68,
      width: 108,
      height: 108
    })
  }
];
const validRoutes = new Set(['auth', 'home', 'shop', 'search', 'tryon', 'closet', 'custom', 'stylebot', 'tokens', 'profile', 'generation-history', 'product', 'wishlist', 'orders', 'signup', 'login', 'how', 'info']);

function normalizeRoute(name, params = {}) {
  const routeName = typeof name === 'string' && validRoutes.has(name) ? name : 'home';
  const routeParams = params && typeof params === 'object' && !Array.isArray(params) ? params : {};
  return { name: routeName, params: routeParams };
}

class ScreenErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidUpdate(previousProps) {
    if (previousProps.routeName !== this.props.routeName && this.state.error) {
      this.setState({ error: null });
    }
  }

  render() {
    if (this.state.error) {
      return (
        <ScrollView contentContainerStyle={styles.scrollContent} {...screenScrollProps}>
          <View style={styles.statusPanel}>
            <Text style={styles.statusTitle}>Screen could not open</Text>
            <Text style={styles.statusText}>{this.state.error?.message || 'Try another tab or reload the app.'}</Text>
            <AppButton label="Go Home" icon="home-outline" onPress={this.props.onHome} />
          </View>
        </ScrollView>
      );
    }
    return this.props.children;
  }
}

function titleCase(value = '') {
  return String(value)
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function normalizePhoneInput(value = '') {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length > 10 && digits.startsWith('91')) return digits.slice(-10);
  return digits.slice(0, 10);
}

function normalizeOtpInput(value = '') {
  return String(value || '').replace(/\D/g, '').slice(0, 8);
}

function passwordValidationMessage(value = '') {
  const password = String(value || '');
  if (password.length < 8) return 'Password must be at least 8 characters.';
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) return 'Use at least one letter and one number in your password.';
  return '';
}

function shopResultTitle(filters = {}, tryOnMode = false) {
  if (tryOnMode) return 'AI Try-On';
  if (filters.q) return filters.q;
  if (filters.category) return titleCase(filters.category);
  return 'All Products';
}

function friendlyFirstName(user) {
  const name = String(user?.name || '').split(' ')?.[0] || '';
  const suspicious = /^(?:red|blue|green|black|white|test|user|admin)$/i.test(name.trim());
  return name && !suspicious ? titleCase(name) : '';
}

function initialAiStudioMessages(user) {
  const firstName = friendlyFirstName(user);
  return [
    {
      id: `welcome-${user?.id || user?._id || user?.phone || 'guest'}`,
      role: 'assistant',
      text: `Hi${firstName ? ` ${firstName}` : ''}. Tell me what fashion item you want: shirts, dresses, pants, shoes, accessories, budget, colour, fabric, or vibe.`
    }
  ];
}

function recentSearchStorageKey(user) {
  const owner = user?.id || user?._id || user?.phone || user?.username || 'guest';
  return `${recentSearchStoragePrefix}:${owner}`;
}

function onboardingSeenStorageKey(user) {
  const owner = user?.id || user?._id || user?.phone || user?.username || 'guest';
  return `${onboardingSeenStoragePrefix}:${owner}`;
}

function isMissingRouteError(message = '') {
  return /\b404\b|not found|not available on the running backend/i.test(String(message || ''));
}

function tryOnProfileBlockMessage(user) {
  if (!user) return '';
  if (user.bodyPhotoStatus === 'generating') {
    return 'Your full-body try-on profile is being prepared. You can keep browsing and try again in a moment.';
  }
  if (user.bodyPhotoStatus === 'failed') {
    return 'Could not prepare your full-body try-on profile. Upload a clearer profile photo before trying on products.';
  }
  if (!user.bodyPhotoUrl) {
    return 'Upload a profile photo before generating AI try-ons.';
  }
  return '';
}

function aiFeatureErrorMessage(error, fallback = 'AI request could not be completed. Try again in a moment.') {
  const message = String(error?.message || '').trim();
  if (!message) return fallback;
  if (isMissingRouteError(message)) return 'This AI feature is not active on the running backend. Restart the backend with the latest code, then try again.';
  return message;
}

function userAvatarUrl(user) {
  const avatarUrl = user?.avatarPhotoUrl || '';
  const bodyUrl = user?.bodyPhotoUrl || '';
  if (user?.bodyPhotoSource === 'fal-full-body' && bodyUrl) return bodyUrl;
  return avatarUrl || bodyUrl || '';
}

function userAvatarResizeMode(user) {
  if (isGeneratedFullBodyAvatar(user)) return 'stretch';
  return 'cover';
}

function isGeneratedFullBodyAvatar(user) {
  return user?.bodyPhotoSource === 'fal-full-body' && Boolean(user?.bodyPhotoUrl);
}

function clampAvatarNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function defaultAvatarCrop(user) {
  return isGeneratedFullBodyAvatar(user)
    ? { scale: 2.35, translateX: 0, translateY: 0 }
    : { scale: 1.04, translateX: 0, translateY: 0 };
}

function avatarCropForUser(user, override) {
  const defaults = defaultAvatarCrop(user);
  const source = override || user?.avatarCrop || {};
  const minScale = isGeneratedFullBodyAvatar(user) ? 1.4 : 1;
  return {
    scale: clampAvatarNumber(source.scale, minScale, 5, defaults.scale),
    translateX: clampAvatarNumber(source.translateX ?? source.x, -160, 160, defaults.translateX),
    translateY: clampAvatarNumber(source.translateY ?? source.y, -160, 160, defaults.translateY)
  };
}

function avatarImageStyleForUser(user, size, override) {
  const crop = avatarCropForUser(user, override);
  const cropScale = Number.isFinite(Number(size)) && Number(size) > 0 ? Number(size) / avatarCropReferenceSize : 1;
  const translateX = crop.translateX * cropScale;
  const translateY = crop.translateY * cropScale;
  if (isGeneratedFullBodyAvatar(user)) {
    const width = size * crop.scale;
    const height = width * 1.5;
    const faceCenterY = height * 0.13;
    return {
      position: 'absolute',
      width,
      height,
      left: ((size - width) / 2) + translateX,
      top: (size / 2) - faceCenterY + translateY
    };
  }
  return {
    transform: [
      { scale: crop.scale },
      { translateX },
      { translateY }
    ]
  };
}

function avatarImageBaseStyleForUser(user) {
  return isGeneratedFullBodyAvatar(user) ? styles.avatarPositionedImage : null;
}

function userInitials(user) {
  const seed = String(user?.name || user?.username || user?.phone || 'L').trim();
  const words = seed.replace(/^\+?91/, '').split(/[\s_@.-]+/).filter(Boolean);
  const letters = words.length > 1
    ? `${words[0][0] || ''}${words[1][0] || ''}`
    : (words[0] || 'L').slice(0, 2);
  return letters.toUpperCase();
}

function productGenderForUser(user) {
  if (user?.genderPreference === 'male') return 'men';
  if (user?.genderPreference === 'female') return 'women';
  return '';
}

function defaultCategorySectionForUser(user) {
  if (user?.genderPreference === 'male') return 'men';
  if (user?.genderPreference === 'female') return 'western';
  return 'popular';
}

function normalizeRecentSearches(searches = [], limit = recentSearchLimit) {
  const seen = new Set();
  return searches
    .map((item) => String(item?.query || item || '').trim())
    .filter((item) => {
      const key = item.toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit);
}

async function loadStoredRecentSearches(key) {
  try {
    const raw = await AsyncStorage.getItem(key);
    return normalizeRecentSearches(JSON.parse(raw || '[]'));
  } catch {
    return [];
  }
}

async function saveStoredRecentSearches(key, searches) {
  try {
    await AsyncStorage.setItem(key, JSON.stringify(normalizeRecentSearches(searches)));
  } catch {
    // Search history is a convenience feature; failed local storage should not block search.
  }
}

function dateInputValue(value = new Date()) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
}

function productImageSource(product, tryOn) {
  const url = tryOn?.imageUrl ? tryOnImageUrl(tryOn) : resolveImageUrl(product?.imageUrl || product?.imageUrls?.[0]);
  return url ? { uri: url } : null;
}

function productImageResizeMode(tryOn) {
  return tryOn?.imageUrl ? 'contain' : 'cover';
}

function mediaUrlWithVersion(url, version) {
  const resolved = imageUrl(url);
  const signature = String(version || '').trim();
  if (!resolved || !signature || /[?&]_v=/.test(resolved)) return resolved;
  return `${resolved}${resolved.includes('?') ? '&' : '?'}_v=${encodeURIComponent(signature)}`;
}

function tryOnMediaVersion(tryOn, kind = 'image') {
  return [kind, tryOn?.updatedAt, tryOn?.videoGeneratedAt, tryOn?.createdAt, tryOn?.id]
    .filter(Boolean)
    .join(':');
}

function tryOnImageUrl(tryOn) {
  return mediaUrlWithVersion(tryOn?.imageUrl, tryOnMediaVersion(tryOn, 'image'));
}

function tryOnVideoUrl(tryOn) {
  return mediaUrlWithVersion(tryOn?.videoUrl, tryOnMediaVersion(tryOn, 'video'));
}

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function fetchProductTryOn(productId, { waitForImage = false } = {}) {
  if (!productId) return null;
  const attempts = waitForImage ? 4 : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const data = await api(`/tryons?productIds=${encodeURIComponent(productId)}`, { noCache: true });
    const latest = (data?.tryOns || []).find((item) => String(item.productId) === String(productId)) || null;
    if (!waitForImage || latest?.imageUrl || latest?.videoUrl || attempt === attempts - 1) return latest;
    await wait(1200);
  }
  return null;
}

function chatProductKey(product = {}) {
  return String(product?.id || product?.sourceUrl || product?.affiliateLink || product?.name || 'product');
}

function useTourTarget(targetKey, registerTourTarget, options = {}) {
  const { request, scrollRef, scrollOffset = 110 } = options || {};
  const ref = useRef(null);
  const measure = useCallback((delay = 40) => {
    if (!targetKey || !registerTourTarget || !ref.current?.measureInWindow) return;
    setTimeout(() => {
      ref.current?.measureInWindow?.((x, y, width, height) => {
        if (width > 0 && height > 0) registerTourTarget(targetKey, { x, y, width, height });
      });
    }, delay);
  }, [targetKey, registerTourTarget]);

  const focus = useCallback(() => {
    if (!targetKey) return;
    const node = ref.current;
    const scroller = scrollRef?.current;
    if (node?.measureLayout && scroller?.scrollTo) {
      try {
        node.measureLayout(
          scroller,
          (_x, y) => {
            scroller.scrollTo({ y: Math.max(0, y - scrollOffset), animated: true });
            measure(280);
          },
          () => measure(80)
        );
      } catch {
        measure(80);
      }
      return;
    }
    measure(120);
  }, [measure, scrollOffset, scrollRef, targetKey]);

  useEffect(() => {
    measure();
    const timer = setTimeout(measure, 360);
    return () => clearTimeout(timer);
  }, [measure]);

  useEffect(() => {
    if (!request?.targetKey || request.targetKey !== targetKey) return undefined;
    const timer = setTimeout(focus, 180);
    return () => clearTimeout(timer);
  }, [focus, request?.nonce, request?.targetKey, targetKey]);

  return { ref, onLayout: () => measure(40) };
}

function sourceSignature(source) {
  if (!source) return '';
  if (typeof source === 'number') return `asset:${source}`;
  if (Array.isArray(source)) return source.map(sourceSignature).join(',');
  return source.uri || JSON.stringify(source);
}

const ResilientImage = memo(function ResilientImage({ source, fallbackSource, style, imageStyle, imageBaseStyle, resizeMode = 'cover', alt, fallbackIcon = 'image-outline', fallbackText }) {
  const [sourceIndex, setSourceIndex] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const sources = useMemo(() => {
    const entries = [source, fallbackSource].filter(Boolean);
    const seen = new Set();
    return entries.filter((entry) => {
      const key = sourceSignature(entry);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [source, fallbackSource]);
  const signature = sources.map(sourceSignature).join('|');
  const activeSource = sources[sourceIndex];

  useEffect(() => {
    setSourceIndex(0);
    setLoaded(false);
    setFailed(false);
  }, [signature]);

  if (!activeSource || failed) {
    return (
      <View style={[style, styles.resilientImageFrame, styles.resilientImageFallback]} accessibilityLabel={alt || 'Image unavailable'}>
        <Ionicons name={fallbackIcon} size={22} color="#9b8f89" />
        {fallbackText ? <Text style={styles.resilientImageFallbackText}>{fallbackText}</Text> : null}
      </View>
    );
  }

  const hasFallbackLayer = fallbackSource && sourceSignature(fallbackSource) !== sourceSignature(activeSource);

  return (
    <View style={[style, styles.resilientImageFrame]}>
      {hasFallbackLayer ? <Image source={fallbackSource} style={[imageBaseStyle || styles.resilientImage, imageStyle]} resizeMode={resizeMode} /> : null}
      {!loaded && !hasFallbackLayer ? <View style={styles.resilientImageSkeleton} /> : null}
      <Image
        accessibilityLabel={alt}
        source={activeSource}
        style={[imageBaseStyle || styles.resilientImage, imageStyle]}
        resizeMode={resizeMode}
        fadeDuration={160}
        onLoad={() => setLoaded(true)}
        onError={() => {
          if (sourceIndex < sources.length - 1) {
            setLoaded(false);
            setSourceIndex((current) => current + 1);
          } else {
            setLoaded(true);
            setFailed(true);
          }
        }}
      />
    </View>
  );
});

const ProductImage = memo(function ProductImage({ product, tryOn, style, resizeMode, alt, fallbackIcon = 'image-outline' }) {
  const [imageIndex, setImageIndex] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const tryOnUrl = tryOnImageUrl(tryOn);
  const imageUrls = useMemo(() => (
    tryOnUrl ? [tryOnUrl] : (product?.imageUrls?.length ? product.imageUrls : [product?.imageUrl]).filter(Boolean)
  ), [tryOnUrl, product?.imageUrl, product?.imageUrls]);
  const imageSignature = imageUrls.join('|');
  const source = useMemo(() => (imageUrls[imageIndex] ? { uri: imageUrls[imageIndex] } : null), [imageUrls, imageIndex]);

  useEffect(() => {
    setImageIndex(0);
    setLoaded(false);
  }, [product?.id, tryOnUrl, imageSignature]);

  if (!source) {
    return (
      <View style={[style, styles.productImageFallback]} accessibilityLabel={alt || product?.title || product?.name || 'Product image unavailable'}>
        <Ionicons name={fallbackIcon} size={26} color="#9b8f89" />
        <Text style={styles.productImageFallbackText}>No image</Text>
      </View>
    );
  }

  return (
    <View style={[style, styles.productImageFrame]}>
      {!loaded ? <View style={styles.productImageSkeleton} /> : null}
      <Image
        accessibilityLabel={alt || product?.title || product?.name || 'Product image'}
        source={source}
        style={[StyleSheet.absoluteFillObject, styles.productImage]}
        resizeMode={resizeMode || productImageResizeMode(tryOn)}
        fadeDuration={160}
        onLoad={() => setLoaded(true)}
        onError={() => {
          if (imageIndex < imageUrls.length - 1) setImageIndex((current) => current + 1);
          else setLoaded(true);
        }}
      />
    </View>
  );
});

function productListPath(query, extras = {}) {
  const search = new URLSearchParams(query);
  Object.entries(extras).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') search.set(key, value);
  });
  const nextQuery = search.toString();
  return `/products${nextQuery ? `?${nextQuery}` : ''}`;
}

function uniqueProductsById(products = []) {
  const seen = new Set();
  return products.filter((product) => {
    if (!product?.id) return false;
    if (seen.has(product.id)) return false;
    seen.add(product.id);
    return true;
  });
}

function useProducts(params, token) {
  const enabled = params?.enabled !== false;
  const fetchAll = params?.all === true;
  const pageSize = useMemo(() => {
    const limit = Number(params?.limit);
    return Number.isFinite(limit) && limit > 0 ? Math.min(limit, 96) : 96;
  }, [params?.limit]);
  const query = useMemo(() => {
    const search = new URLSearchParams();
    Object.entries(params || {}).forEach(([key, value]) => {
      if (key === 'all' || key === 'enabled') return;
      if (value !== undefined && value !== null && value !== '') search.set(key, value);
    });
    return search.toString();
  }, [JSON.stringify(params || {})]);
  const [state, setState] = useState({
    products: [],
    total: 0,
    facets: { brands: [], categories: [], categoryCounts: [] },
    loading: true,
    error: ''
  });

  const load = useCallback(() => {
    let alive = true;
    if (!enabled) {
      setState({ products: [], total: 0, facets: { brands: [], categories: [], categoryCounts: [] }, loading: false, error: '' });
      return () => {
        alive = false;
      };
    }
    setState((current) => ({ ...current, loading: true, error: '' }));
    const loadProducts = async () => {
      if (!fetchAll) return api(productListPath(query));

      const firstPage = await api(productListPath(query, { limit: pageSize, skip: 0 }));
      const allProducts = [...(firstPage.products || [])];
      const total = Number(firstPage.total) || allProducts.length;
      let skip = allProducts.length;

      while (alive && skip < total) {
        const page = await api(productListPath(query, { limit: pageSize, skip }));
        const products = page.products || [];
        if (!products.length) break;
        allProducts.push(...products);
        skip += products.length;
      }

      return { ...firstPage, products: allProducts };
    };

    loadProducts()
      .then((data) => {
        if (!alive) return;
        const products = uniqueProductsById(normalizeProducts(data.products || []));
        setState({
          products,
          total: data.total || 0,
          facets: data.facets || { brands: [], categories: [], categoryCounts: [] },
          loading: false,
          error: ''
        });
      })
      .catch((error) => {
        if (!alive) return;
        setState({ products: [], total: 0, facets: { brands: [], categories: [], categoryCounts: [] }, loading: false, error: error.message });
      });
    return () => {
      alive = false;
    };
  }, [query, token, fetchAll, pageSize, enabled]);

  useEffect(load, [load]);
  return { ...state, reload: load };
}

function useApiState(path, token, enabled = true, emptyData = {}) {
  const [state, setState] = useState({ data: emptyData, loading: Boolean(enabled), error: '' });

  const load = useCallback(() => {
    if (!enabled || !path) {
      setState({ data: emptyData, loading: false, error: '' });
      return undefined;
    }
    let alive = true;
    setState((current) => ({ ...current, loading: true, error: '' }));
    api(path)
      .then((data) => {
        if (alive) setState({ data: data || emptyData, loading: false, error: '' });
      })
      .catch((error) => {
        if (alive) setState({ data: emptyData, loading: false, error: error.message });
      });
    return () => {
      alive = false;
    };
  }, [path, token, enabled]);

  useEffect(load, [load]);
  return { ...state, reload: load };
}

function useTryOns(user, products, token) {
  const productIds = useMemo(
    () => [...new Set((products || []).map((product) => product?.id).filter(Boolean))].slice(0, 96).join(','),
    [products]
  );
  const [tryOns, setTryOns] = useState({});

  useEffect(() => {
    if (!user || !productIds) {
      setTryOns({});
      return undefined;
    }
    let alive = true;
    api(`/tryons?productIds=${encodeURIComponent(productIds)}`)
      .then((data) => {
        if (!alive) return;
        const saved = Object.fromEntries((data.tryOns || []).map((tryOn) => [tryOn.productId, tryOn]));
        setTryOns(saved);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [user?.id, user?.bodyPhotoUrl, productIds, token]);

  return [tryOns, setTryOns];
}

function showMediaPermissionAlert(title, message, permission) {
  if (permission?.canAskAgain !== false) {
    Alert.alert(title, message);
    return;
  }

  Alert.alert(title, message, [
    { text: 'Not now', style: 'cancel' },
    {
      text: 'Open Settings',
      onPress: () => {
        Linking.openSettings().catch(() => {
          Alert.alert('Settings unavailable', 'Open Settings and enable access for Lookmefy.');
        });
      },
    },
  ]);
}

async function openExternalWebUrl(value) {
  try {
    const parsedUrl = new URL(String(value || '').trim());
    if (!['http:', 'https:'].includes(parsedUrl.protocol) || !parsedUrl.hostname) {
      throw new Error('Unsupported URL');
    }

    const url = parsedUrl.toString();
    if (!(await Linking.canOpenURL(url))) {
      throw new Error('URL cannot be opened');
    }

    await Linking.openURL(url);
    return true;
  } catch {
    Alert.alert('Link unavailable', 'This shopping link could not be opened.');
    return false;
  }
}

async function pickImage() {
  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) {
    showMediaPermissionAlert(
      'Photo access needed',
      'Allow photo access to upload images for Lookmefy try-ons.',
      permission,
    );
    return null;
  }
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ImagePicker.MediaTypeOptions.Images,
    quality: 0.9
  });
  if (result.canceled) return null;
  return result.assets?.[0] || null;
}

async function takePhoto() {
  const permission = await ImagePicker.requestCameraPermissionsAsync();
  if (!permission.granted) {
    showMediaPermissionAlert(
      'Camera access needed',
      'Allow camera access to take a Lookmefy profile photo.',
      permission,
    );
    return null;
  }
  const result = await ImagePicker.launchCameraAsync({
    mediaTypes: ImagePicker.MediaTypeOptions.Images,
    quality: 0.9
  });
  if (result.canceled) return null;
  return result.assets?.[0] || null;
}

function AppButton({ label, icon, variant = 'primary', disabled, onPress, style }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(disabled) }}
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.button,
        variant === 'secondary' && styles.secondaryButton,
        variant === 'ghost' && styles.ghostButton,
        pressed && !disabled && styles.buttonPressed,
        disabled && styles.disabledButton,
        style
      ]}
    >
      {icon ? <Ionicons name={icon} size={17} color={variant === 'primary' ? '#fff' : '#111827'} /> : null}
      <Text style={[styles.buttonText, variant !== 'primary' && styles.secondaryButtonText]}>{label}</Text>
    </Pressable>
  );
}

function BrandLogo({ compact = false, light = false, style, textStyle, symbolStyle, dividerStyle }) {
  return (
    <View style={[styles.brandLogo, compact && styles.brandLogoCompact, style]}>
      <Image
        source={logoSymbol}
        style={[
          styles.brandLogoSymbol,
          compact && styles.brandLogoSymbolCompact,
          light && styles.brandLogoSymbolLight,
          symbolStyle
        ]}
        resizeMode="contain"
      />
      <View style={[styles.brandLogoDivider, compact && styles.brandLogoDividerCompact, light && styles.brandLogoDividerLight, dividerStyle]} />
      <Text style={[styles.brandLogoText, compact && styles.brandLogoTextCompact, light && styles.brandLogoTextLight, textStyle]} numberOfLines={1}>
        Lookmefy
      </Text>
    </View>
  );
}

function Header({ user, canGoBack, onBack, onNavigate, onLogout }) {
  const avatarUri = userAvatarUrl(user);
  const avatarResizeMode = userAvatarResizeMode(user);
  const avatarImageStyle = avatarImageStyleForUser(user, 34);
  const avatarImageBaseStyle = avatarImageBaseStyleForUser(user);
  return (
    <View style={styles.header}>
      <View style={styles.headerLeft}>
        {canGoBack ? (
          <TouchableOpacity style={styles.iconButton} onPress={onBack}>
            <Ionicons name="chevron-back" size={22} color="#111827" />
          </TouchableOpacity>
        ) : null}
        <View>
          <Pressable onPress={() => onNavigate('home')}>
            <BrandLogo />
          </Pressable>
          <Text style={styles.headerSub}>{user ? `${user.tokens} tokens ready` : 'AI fitting room'}</Text>
          {user?.bodyPhotoStatus === 'generating' ? <Text style={styles.headerNotice}>Profile preparing</Text> : null}
        </View>
      </View>
      <View style={styles.headerActions}>
        {user ? (
          <TouchableOpacity style={styles.iconButton} onPress={() => onNavigate('profile')}>
            {avatarUri ? <ResilientImage source={{ uri: imageUrl(avatarUri) }} style={styles.headerAvatar} imageStyle={avatarImageStyle} imageBaseStyle={avatarImageBaseStyle} resizeMode={avatarResizeMode} fallbackIcon="person-outline" /> : <InitialsAvatar user={user} style={styles.headerAvatar} textStyle={styles.headerAvatarInitials} />}
          </TouchableOpacity>
        ) : null}
        <TouchableOpacity style={styles.iconButton} onPress={() => onNavigate('tokens')}>
          <Ionicons name="sparkles-outline" size={19} color="#111827" />
        </TouchableOpacity>
        {user ? (
          <TouchableOpacity style={styles.iconButton} onPress={onLogout}>
            <Ionicons name="log-out-outline" size={20} color="#111827" />
          </TouchableOpacity>
        ) : (
          <TouchableOpacity style={styles.iconButton} onPress={() => onNavigate('login')}>
            <Ionicons name="person-outline" size={20} color="#111827" />
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

function AppHeader({ onNavigate, title = 'Lookmefy', leftIcon = 'menu-outline', leftRoute = 'profile', rightIcon = 'receipt-outline', rightRoute = 'orders', user, showAvatar = false, hideLeft = true, brandAlign = 'left', compact = false, showWishlist = true, showSearch = true, registerTourTarget, tourTargetKeys = {} }) {
  const openLeft = () => leftRoute && onNavigate(leftRoute);
  const openRight = () => rightRoute && onNavigate(rightRoute);
  const showWishlistAction = showWishlist && !showAvatar;
  const showSearchAction = showSearch && !showAvatar;
  const showProfileAction = Boolean(user) && !showAvatar;
  const brandLeft = brandAlign === 'left';
  const searchTourTarget = useTourTarget(tourTargetKeys.search, registerTourTarget);
  const avatarTourTarget = useTourTarget(tourTargetKeys.avatar, registerTourTarget);
  const avatarUri = userAvatarUrl(user);
  const avatarResizeMode = userAvatarResizeMode(user);
  const avatarImageStyle = avatarImageStyleForUser(user, 32);
  const avatarImageBaseStyle = avatarImageBaseStyleForUser(user);
  return (
    <View style={[styles.appHeader, compact && styles.appHeaderCompact]}>
      {!brandLeft ? (
        <View style={[styles.appHeaderSide, styles.appHeaderLeftSide]}>
          {hideLeft ? null : (
            <TouchableOpacity accessibilityRole="button" accessibilityLabel="Open left action" style={styles.appHeaderAction} onPress={openLeft}>
              <Ionicons name={leftIcon} size={22} color="#171412" />
            </TouchableOpacity>
          )}
        </View>
      ) : null}
      <Pressable accessibilityRole="button" accessibilityLabel="Go to feed" onPress={() => onNavigate('home')} style={[styles.appHeaderBrandWrap, brandLeft && styles.appHeaderBrandWrapLeft]}>
        {title === 'Lookmefy' ? <BrandLogo compact={compact} /> : <Text style={styles.appHeaderBrand} numberOfLines={1}>{title}</Text>}
      </Pressable>
      <View style={[styles.appHeaderSide, styles.appHeaderRightSide]}>
        {showSearchAction ? (
          <TouchableOpacity ref={searchTourTarget.ref} onLayout={searchTourTarget.onLayout} accessibilityRole="button" accessibilityLabel="Search products" style={styles.appHeaderAction} onPress={() => onNavigate('search')}>
            <Ionicons name="search-outline" size={22} color="#171412" />
          </TouchableOpacity>
        ) : null}
        {showWishlistAction ? (
          <TouchableOpacity accessibilityRole="button" accessibilityLabel="Open wishlist" style={styles.appHeaderAction} onPress={() => onNavigate('wishlist')}>
            <Ionicons name="heart-outline" size={21} color="#171412" />
          </TouchableOpacity>
        ) : null}
        <TouchableOpacity ref={avatarTourTarget.ref} onLayout={avatarTourTarget.onLayout} accessibilityRole="button" accessibilityLabel={rightRoute === 'orders' ? 'Open orders' : 'Open bag'} style={styles.appHeaderAction} onPress={openRight}>
          {showAvatar ? (
            avatarUri ? <ResilientImage source={{ uri: imageUrl(avatarUri) }} style={styles.appHeaderAvatar} imageStyle={avatarImageStyle} imageBaseStyle={avatarImageBaseStyle} resizeMode={avatarResizeMode} fallbackIcon="person-outline" /> : <InitialsAvatar user={user} style={styles.appHeaderAvatar} textStyle={styles.appHeaderAvatarInitials} />
          ) : <Ionicons name={rightIcon} size={20} color="#171412" />}
        </TouchableOpacity>
        {showProfileAction ? (
          <TouchableOpacity accessibilityRole="button" accessibilityLabel="Open profile" style={styles.appHeaderAction} onPress={() => onNavigate('profile')}>
            {avatarUri ? <ResilientImage source={{ uri: imageUrl(avatarUri) }} style={styles.appHeaderAvatar} imageStyle={avatarImageStyle} imageBaseStyle={avatarImageBaseStyle} resizeMode={avatarResizeMode} fallbackIcon="person-outline" /> : <InitialsAvatar user={user} style={styles.appHeaderAvatar} textStyle={styles.appHeaderAvatarInitials} />}
          </TouchableOpacity>
        ) : null}
      </View>
    </View>
  );
}

function BottomNav({ route = { name: 'home' }, onNavigate = () => {} }) {
  const routeName = route?.name || 'home';
  const activeRoute = routeName === 'product' || routeName === 'wishlist' || routeName === 'search'
      ? 'shop'
      : routeName === 'stylebot'
        ? 'tryon'
        : routeName;
  const items = [
    ['home', 'home-outline', 'Home'],
    ['shop', 'grid-outline', 'Categories'],
    ['closet', 'shirt-outline', 'Wardrobe'],
    ['tryon', 'sparkles-outline', 'AI Studio'],
    ['custom', 'color-wand-outline', 'Custom']
  ];
  return (
    <View style={styles.bottomNav}>
      {items.map(([name, icon, label]) => {
        const active = activeRoute === name;
        return (
          <TouchableOpacity key={name} activeOpacity={0.82} accessibilityRole="tab" accessibilityState={{ selected: active }} style={styles.navItem} onPress={() => onNavigate(name)}>
            <View style={[styles.navIconWrap, active && styles.navIconWrapCenter]}>
              <Ionicons name={icon} size={active ? 20 : 21} color={active ? '#111111' : '#8d8682'} />
            </View>
            <Text style={[styles.navText, active && styles.navTextActive]}>{label}</Text>
            <View style={[styles.navActiveUnderline, active && styles.navActiveUnderlineVisible]} />
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

function Hero({ compact, onNavigate }) {
  return (
    <View style={[styles.hero, compact && styles.heroCompact]}>
      <Image source={images.hero} style={styles.heroImage} resizeMode="cover" />
      <View style={styles.heroOverlay} />
      <View style={styles.heroCopy}>
        <Text style={styles.kicker}>AI Try-On</Text>
        <Text style={styles.heroTitle}>See it on you, before you buy.</Text>
        <Text style={styles.heroText}>Upload once. Try thousands of outfits and shop from top brands.</Text>
        <AppButton label="Start Trying" icon="sparkles-outline" onPress={() => onNavigate('shop')} style={styles.heroButton} />
      </View>
    </View>
  );
}

function StatusPanel({ loading, error, empty, text }) {
  if (loading) {
    return (
      <View style={[styles.statusPanel, styles.loadingPanel]}>
        <View style={styles.skeletonIcon} />
        <View style={styles.skeletonLineWide} />
        <View style={styles.skeletonLine} />
        <Text style={styles.statusText}>{text || 'Loading...'}</Text>
      </View>
    );
  }
  if (error || empty) {
    return (
      <View style={styles.statusPanel}>
        <View style={[styles.statusIcon, error ? styles.statusIconError : styles.statusIconEmpty]}>
          <Ionicons name={error ? 'alert-circle-outline' : 'sparkles-outline'} size={22} color={error ? '#9b5658' : '#0f766e'} />
        </View>
        <Text style={styles.statusTitle}>{error ? 'Something needs attention' : 'No products yet'}</Text>
        <Text style={styles.statusText}>{error || text || 'Products will appear here as soon as the catalog is available.'}</Text>
      </View>
    );
  }
  return null;
}

function EmptyStateCard({ icon = 'sparkles-outline', title = 'Nothing here yet', text, actionLabel, actionIcon = 'arrow-forward', onAction, compact }) {
  return (
    <View style={[styles.emptyStateCard, compact && styles.emptyStateCardCompact]}>
      <View style={styles.emptyStateIcon}>
        <Ionicons name={icon} size={24} color="#9b5658" />
      </View>
      <Text style={styles.emptyStateTitle}>{title}</Text>
      {text ? <Text style={styles.emptyStateText}>{text}</Text> : null}
      {actionLabel && onAction ? (
        <TouchableOpacity style={styles.emptyStateButton} activeOpacity={0.86} onPress={onAction}>
          <Text style={styles.emptyStateButtonText}>{actionLabel}</Text>
          <Ionicons name={actionIcon} size={16} color="#ffffff" />
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

function InitialsAvatar({ user, style, textStyle }) {
  return (
    <View style={[styles.initialsAvatar, style]}>
      <Text style={[styles.initialsAvatarText, textStyle]}>{userInitials(user)}</Text>
    </View>
  );
}

function SkeletonBlock({ style }) {
  return <View style={[styles.skeletonBlock, style]} />;
}

function ProductCardSkeleton({ variant = 'grid' }) {
  const useHomeImageFrame = variant === 'homeFrame';
  return (
    <View style={[styles.productCard, styles.skeletonProductCard, useHomeImageFrame && styles.productCardHomeFrame, variant === 'carousel' && styles.productCardCarousel]}>
      <View style={[styles.productImageWrap, useHomeImageFrame && styles.homeProductImageWrap]}>
        <SkeletonBlock style={styles.skeletonFill} />
      </View>
      <View style={styles.productBody}>
        <SkeletonBlock style={styles.skeletonTextLarge} />
        <SkeletonBlock style={styles.skeletonTextMedium} />
        <SkeletonBlock style={styles.skeletonTextSmall} />
      </View>
    </View>
  );
}

function ProductGridSkeleton({ count = 6 }) {
  return (
    <View style={styles.productGrid}>
      {Array.from({ length: count }).map((_, index) => <ProductCardSkeleton key={`product-skeleton-${index}`} variant="homeFrame" />)}
    </View>
  );
}

function HorizontalProductSkeleton({ count = 4 }) {
  return (
    <ScrollView {...horizontalScrollProps} contentContainerStyle={styles.horizontalList}>
      {Array.from({ length: count }).map((_, index) => <ProductCardSkeleton key={`horizontal-product-skeleton-${index}`} variant="carousel" />)}
    </ScrollView>
  );
}

function HomeProductSkeletonGrid({ count = 4 }) {
  return Array.from({ length: count }).map((_, index) => (
    <View key={`home-product-skeleton-${index}`} style={styles.homeProductCard}>
      <View style={styles.homeProductImageWrap}>
        <SkeletonBlock style={styles.skeletonFill} />
      </View>
      <SkeletonBlock style={[styles.skeletonTextSmall, styles.homeSkeletonLine]} />
      <SkeletonBlock style={[styles.skeletonTextLarge, styles.homeSkeletonLine]} />
      <SkeletonBlock style={[styles.skeletonTextMedium, styles.homeSkeletonLine]} />
    </View>
  ));
}

function HomeJournalSkeletonGrid({ count = 4 }) {
  return (
    <View style={styles.homeJournalGrid}>
      {Array.from({ length: count }).map((_, index) => (
        <View key={`home-journal-skeleton-${index}`} style={styles.homeJournalProductCard}>
          <View style={styles.homeJournalImageFrame}>
            <SkeletonBlock style={styles.skeletonFill} />
          </View>
          <View style={styles.homeJournalProductBody}>
            <SkeletonBlock style={styles.skeletonTextSmall} />
            <SkeletonBlock style={styles.skeletonTextLarge} />
            <SkeletonBlock style={styles.skeletonTextMedium} />
          </View>
        </View>
      ))}
    </View>
  );
}

function WardrobeGridSkeleton({ count = 4 }) {
  return (
    <View style={styles.closetGrid}>
      {Array.from({ length: count }).map((_, index) => (
        <View key={`wardrobe-skeleton-${index}`} style={styles.closetItemCard}>
          <View style={styles.closetItemImage}>
            <SkeletonBlock style={styles.skeletonFill} />
          </View>
          <View style={styles.closetItemBody}>
            <SkeletonBlock style={styles.skeletonTextLarge} />
            <SkeletonBlock style={styles.skeletonTextMedium} />
            <SkeletonBlock style={styles.skeletonTextSmall} />
          </View>
        </View>
      ))}
    </View>
  );
}

function CreditHistorySkeleton({ rows = 3 }) {
  return Array.from({ length: rows }).map((_, index) => (
    <View key={`credit-history-skeleton-${index}`} style={styles.profileCreditHistoryRow}>
      <SkeletonBlock style={[styles.profileCreditSkeletonCell, styles.profileCreditActionColumn]} />
      <SkeletonBlock style={[styles.profileCreditSkeletonCell, styles.profileCreditProductColumn]} />
      <SkeletonBlock style={[styles.profileCreditSkeletonCell, styles.profileCreditDateColumn]} />
      <SkeletonBlock style={[styles.profileCreditSkeletonCell, styles.profileCreditTokenColumn]} />
    </View>
  ));
}

const profileCreditPreviewLimit = 4;

function creditHistoryProductLabel(event = {}) {
  const title = String(event.productTitle || '').trim();
  const isCustomTryOn = /custom/i.test(String(event.action || ''));
  if (!title || title === 'Product') return isCustomTryOn ? 'Custom upload' : 'Product';
  if (isCustomTryOn && /^[^/\s]+\.(?:jpe?g|png|webp|avif)$/i.test(title)) return 'Custom upload';
  return title;
}

function creditHistoryAmountLabel(event = {}) {
  const amount = Math.abs(Number(event.tokens) || 0);
  if (!amount) return '0';
  return event.direction === 'credit' ? `+${amount}` : `-${amount}`;
}

function addDays(date, count) {
  const next = new Date(date);
  next.setDate(next.getDate() + count);
  return next;
}

function formatCreditRate(plan = {}) {
  const rate = Number(plan.ratePerCredit);
  if (!Number.isFinite(rate) || rate <= 0) return '';
  return `${formatMoney(rate, plan.currency)} / credit${plan.billingFrequency === 'monthly' ? ' monthly' : ''}`;
}

function mobilePaymentReturnUrl() {
  return 'lookmefy://tokens';
}

function merchantOrderIdFromUrl(value = '') {
  try {
    const url = new URL(String(value || ''));
    return url.searchParams.get('merchantOrderId') || url.searchParams.get('orderId') || '';
  } catch {
    return '';
  }
}

function mobileRouteFromUrl(value = '') {
  try {
    const url = new URL(String(value || ''));
    const path = url.protocol === 'http:' || url.protocol === 'https:'
      ? url.pathname
      : `/${url.host}${url.pathname}`;
    if (/^\/tokens(?:\/|$)/i.test(path)) return { name: 'tokens', params: {} };
  } catch {
    return null;
  }
  return null;
}

function AiPreviewNote({ style }) {
  return (
    <View style={[styles.aiPreviewNote, style]}>
      <Ionicons name="information-circle-outline" size={16} color="#8c4d50" />
      <Text style={styles.aiPreviewNoteText}>{aiPreviewDisclaimer}</Text>
    </View>
  );
}

const ProductCard = memo(function ProductCard({ product, tryOn, loading, videoLoading, error, videoError, locked, onPress, onTryOn, onTryOnVideo, onAddToWishlist, isWishlisted, variant = 'grid' }) {
  const price = Number(product?.price);
  const hasPrice = Number.isFinite(price);
  const hasDiscount = hasPrice && product?.compareAtPrice && product.compareAtPrice > product.price;
  const discount = hasDiscount ? `${Math.round(((product.compareAtPrice - product.price) / product.compareAtPrice) * 100)}% off` : '';
  const videoUri = imageUrl(tryOn?.videoUrl);
  const hasTryOnImage = Boolean(tryOn?.imageUrl);
  const useHomeImageFrame = variant === 'homeFrame';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={product?.title || product?.name || 'Open product'}
      style={({ pressed }) => [styles.productCard, useHomeImageFrame && styles.productCardHomeFrame, variant === 'carousel' && styles.productCardCarousel, pressed && !locked && styles.productCardPressed, locked && styles.lockedCard]}
      onPress={locked ? undefined : onPress}
    >
      <View style={[styles.productImageWrap, useHomeImageFrame && styles.homeProductImageWrap]}>
        {videoUri ? (
          <TryOnVideoPlayer uri={videoUri} style={styles.productImage} nativeControls={false} />
        ) : (
          <ProductImage product={product} tryOn={tryOn} style={styles.productImage} alt={product?.title || product?.name} />
        )}
        {locked ? <View style={styles.lockOverlay}><Ionicons name="lock-closed" size={22} color="#fff" /></View> : null}
        {hasTryOnImage ? <Text style={styles.badge}>{videoUri ? 'Video Try-On' : 'AI Try-On'}</Text> : product?.isNew ? <Text style={styles.badge}>New</Text> : product?.badge ? <Text style={styles.badge}>{product.badge}</Text> : null}
        {onAddToWishlist && !locked ? <WishlistDoneButton saved={isWishlisted} compact={variant === 'carousel'} onPress={() => onAddToWishlist(product)} /> : null}
        {loading || videoLoading ? <TryOnLoading text={videoLoading ? 'Video' : 'Generating'} /> : null}
      </View>
      <View style={styles.productBody}>
        <Text style={styles.productTitle} numberOfLines={2}>{product?.title || product?.name || 'Untitled product'}</Text>
        <Text style={styles.productBrand} numberOfLines={1}>{product?.displayLabel || titleCase(product?.category || 'Catalog')}</Text>
        <View style={styles.ratingRow}>
          <Ionicons name="star" size={13} color="#f59e0b" />
          <Text style={styles.ratingText}>{Number(product?.rating || 0).toFixed(1)} {product?.ratingCount ? `(${product.ratingCount})` : ''}</Text>
        </View>
        <View style={styles.priceRow}>
          <Text style={styles.price}>{hasPrice ? formatMoney(price, product?.currency) : 'Price unavailable'}</Text>
          {discount ? <Text style={styles.discount}>{discount}</Text> : null}
        </View>
        {product?.colors?.length ? (
          <View style={styles.productSwatchPreviewRow}>
            {product.colors.slice(0, 4).map((color) => <View key={`${product.id}-${color.name}`} style={[styles.productSwatchPreview, { backgroundColor: color.value }]} />)}
            {product.colors.length > 4 ? <Text style={styles.productSwatchMore}>+{product.colors.length - 4}</Text> : null}
          </View>
        ) : null}
        {onTryOn ? (
          <AppButton
            label={loading ? 'Generating...' : hasTryOnImage ? 'Generate Again' : 'Try On'}
            icon="sparkles-outline"
            disabled={loading}
            onPress={onTryOn}
            style={styles.cardButton}
          />
        ) : null}
        {hasTryOnImage && onTryOnVideo ? (
          <AppButton
            label={videoLoading ? 'Video...' : videoUri ? 'New Video' : 'Video Try-On'}
            icon="videocam-outline"
            variant="secondary"
            disabled={loading || videoLoading}
            onPress={onTryOnVideo}
            style={styles.cardButton}
          />
        ) : null}
        {error ? <Text style={styles.errorText}>{error}</Text> : null}
        {videoError ? <Text style={styles.errorText}>{videoError}</Text> : null}
      </View>
    </Pressable>
  );
});

function ProductRow({ title, state, onNavigate, user, token, onAddToWishlist, wishlistIds }) {
  const products = (state.products || []).slice(0, 6);
  const [tryOns] = useTryOns(user, products, token);
  const keyExtractor = useCallback((item) => String(item.id), []);
  const renderProduct = useCallback(({ item }) => (
    <ProductCard
      variant="carousel"
      product={item}
      tryOn={tryOns[item.id]}
      onPress={() => onNavigate('product', { id: item.id })}
      onAddToWishlist={onAddToWishlist}
      isWishlisted={wishlistIds?.has(item.id)}
    />
  ), [onNavigate, onAddToWishlist, wishlistIds, tryOns]);
  return (
    <View style={styles.section}>
      <View style={styles.sectionHead}>
        <Text style={styles.sectionTitle}>{title}</Text>
        <TouchableOpacity onPress={() => onNavigate('shop')}>
          <Text style={styles.viewAll}>View all</Text>
        </TouchableOpacity>
      </View>
      {state.loading ? <HorizontalProductSkeleton /> : (
        <>
          <StatusPanel error={state.error} empty={!products.length} text="No products found yet." />
          {products.length ? (
            <FlatList
              horizontal
              data={products}
              keyExtractor={keyExtractor}
              showsHorizontalScrollIndicator={false}
              directionalLockEnabled
              nestedScrollEnabled
              scrollEventThrottle={16}
              initialNumToRender={4}
              maxToRenderPerBatch={4}
              windowSize={3}
              removeClippedSubviews={Platform.OS === 'android'}
              updateCellsBatchingPeriod={40}
              contentContainerStyle={styles.horizontalList}
              renderItem={renderProduct}
            />
          ) : null}
        </>
      )}
    </View>
  );
}

const homeCategoryItems = [
  { label: 'TOPS', image: 'category-generated/tops.png', params: { category: 'tops' } },
  { label: 'BOTTOMS', image: 'category-generated/bottomwear.png', params: { category: 'bottoms' } },
  { label: 'T-SHIRTS', image: 'category-generated/tshirts.png', params: { category: 't-shirts' } },
  { label: 'SHOES', image: 'category-generated/sneakers.png', params: { category: 'shoes' } },
  { label: 'EYEWEAR', image: 'category-generated/eyewear.png', params: { category: 'eyewear' } }
];
const homeCategoryItemsByGender = {
  men: [
    { label: 'SHIRTS', image: 'category-generated/men-shirts.png', params: { category: 'shirts', gender: 'men' } },
    { label: 'T-SHIRTS', image: 'category-generated/tshirts.png', params: { category: 't-shirts', gender: 'men' } },
    { label: 'PANTS', image: 'category-generated/bottomwear.png', params: { category: 'pants', gender: 'men' } },
    { label: 'SHOES', image: 'category-generated/men-footwear.png', params: { category: 'shoes', gender: 'men' } },
    { label: 'WATCHES', image: 'category-generated/watches.png', params: { category: 'watches', gender: 'men' } },
    { label: 'EYEWEAR', image: 'category-generated/eyewear.png', params: { category: 'eyewear', gender: 'men' } }
  ],
  women: [
    { label: 'TOPS', image: 'category-generated/tops.png', params: { category: 'tops', gender: 'women' } },
    { label: 'DRESSES', image: 'category-generated/dresses.png', params: { category: 'dresses', gender: 'women' } },
    { label: 'KURTIS', image: 'category-generated/kurti-dress-material.png', params: { q: 'kurti', gender: 'women' } },
    { label: 'SAREES', image: 'category-generated/saree.png', params: { q: 'saree', gender: 'women' } },
    { label: 'SHOES', image: 'category-generated/women-footwear.png', params: { category: 'shoes', gender: 'women' } },
    { label: 'JEWELLERY', image: 'category-generated/jewellery.png', params: { category: 'accessories', gender: 'women' } }
  ]
};

const shopCategoryItems = [
  ['Tops', 'category-generated/tops.png', 'tops'],
  ['Bottoms', 'category-generated/bottomwear.png', 'bottoms'],
  ['Shirts', 'category-generated/men-shirts.png', 'shirts'],
  ['Shoes', 'category-generated/sneakers.png', 'shoes'],
  ['Eyewear', 'category-generated/eyewear.png', 'eyewear']
];
const categoryRailItems = [
  { key: 'popular', label: 'Popular', icon: 'star', iconColor: '#f0b429' },
  { key: 'ethnic', label: 'Kurti, Saree\n& Lehenga', image: 'category-generated/kurti-dress-material.png' },
  { key: 'western', label: 'Women\nWestern', image: 'category-generated/tops.png' },
  { key: 'lingerie', label: 'Lingerie', image: 'category-generated/innerwear.png' },
  { key: 'men', label: 'Men', image: 'category-generated/men-shirts.png' },
  { key: 'beauty', label: 'Beauty', image: 'category-generated/beauty.png' },
  { key: 'footwear', label: 'Footwear', image: 'category-generated/sneakers.png' }
];
const categoryPageContent = {
  popular: {
    kicker: 'POPULAR',
    title: 'Featured On Lookmefy',
    featured: [
      { label: 'Top Brands', image: 'category-generated/new-arrivals.png', params: { sort: 'newest' } },
      { label: 'Premium\nCollection', image: 'category-generated/dresses.png', params: { category: 'dresses', gender: 'women' } },
      { label: 'New Arrivals', image: 'category-generated/new-arrivals.png', params: { sort: 'newest' } },
      { label: 'Accessories', image: 'category-generated/accessories.png', params: { category: 'accessories' } }
    ],
    sectionTitle: 'All Popular',
    items: [
      { label: 'Kurtis & Dress\nMaterials', image: 'category-generated/kurti-dress-material.png', params: { category: 'ethnic wear', gender: 'women' } },
      { label: 'Sarees', image: 'category-generated/saree.png', params: { q: 'saree', gender: 'women' } },
      { label: 'Westernwear', image: 'category-generated/tops.png', params: { gender: 'women' } },
      { label: 'Jewellery', image: 'category-generated/jewellery.png', params: { category: 'accessories' } },
      { label: 'Men Fashion', image: 'category-generated/men-shirts.png', params: { gender: 'men' } },
      { label: 'Footwear', image: 'category-generated/sneakers.png', params: { category: 'shoes' } },
      { label: 'Beauty &\nPersonal Care', image: 'category-generated/beauty.png', params: { q: 'beauty' } },
      { label: 'Watches', image: 'category-generated/watches.png', params: { category: 'watches' } },
      { label: 'Eyewear', image: 'category-generated/eyewear.png', params: { category: 'eyewear' } },
      { label: 'Bottomwear', image: 'category-generated/bottomwear.png', params: { category: 'bottoms' } },
      { label: 'Shirts', image: 'category-generated/men-shirts.png', params: { category: 'shirts' } }
    ]
  },
  ethnic: {
    kicker: 'ETHNIC',
    title: 'Occasion Ready',
    featured: [
      { label: 'Kurtis', image: 'category-generated/kurti-dress-material.png', params: { category: 'ethnic wear', gender: 'women' } },
      { label: 'Dress Sets', image: 'category-generated/dresses.png', params: { category: 'dresses', gender: 'women' } },
      { label: 'Premium Sarees', image: 'category-generated/saree.png', params: { q: 'saree', gender: 'women' } }
    ],
    sectionTitle: 'All Ethnic Wear',
    items: [
      { label: 'Daily Kurtis', image: 'category-generated/kurti-dress-material.png', params: { q: 'kurti', gender: 'women' } },
      { label: 'Festive Looks', image: 'category-generated/saree.png', params: { category: 'dresses', gender: 'women' } },
      { label: 'Ethnic Tops', image: 'category-generated/kurti-dress-material.png', params: { category: 'tops', gender: 'women' } },
      { label: 'Jewellery', image: 'category-generated/jewellery.png', params: { category: 'accessories', gender: 'women' } },
      { label: 'Footwear', image: 'category-generated/women-footwear.png', params: { category: 'shoes', gender: 'women' } },
      { label: 'New In', image: 'category-generated/new-arrivals.png', params: { sort: 'newest', gender: 'women' } }
    ]
  },
  western: {
    kicker: 'WESTERN',
    title: 'Modern Wardrobe',
    featured: [
      { label: 'Tops', image: 'category-generated/tops.png', params: { category: 'tops', gender: 'women' } },
      { label: 'Jeans', image: 'category-generated/jeans.png', params: { category: 'jeans', gender: 'women' } },
      { label: 'Dresses', image: 'category-generated/dresses.png', params: { category: 'dresses', gender: 'women' } }
    ],
    sectionTitle: 'All Women Western',
    items: [
      { label: 'T-Shirts', image: 'category-generated/tshirts.png', params: { category: 't-shirts', gender: 'women' } },
      { label: 'Tops', image: 'category-generated/tops.png', params: { category: 'tops', gender: 'women' } },
      { label: 'Jeans', image: 'category-generated/jeans.png', params: { category: 'jeans', gender: 'women' } },
      { label: 'Jackets', image: 'category-generated/jackets.png', params: { category: 'jackets', gender: 'women' } },
      { label: 'Bottomwear', image: 'category-generated/bottomwear.png', params: { category: 'bottoms', gender: 'women' } },
      { label: 'Eyewear', image: 'category-generated/eyewear.png', params: { category: 'eyewear', gender: 'women' } }
    ]
  },
  lingerie: {
    kicker: 'LINGERIE',
    title: 'Innerwear Essentials',
    featured: [
      { label: 'Innerwear', image: 'category-generated/innerwear.png', params: { category: 'innerwear', gender: 'women' } },
      { label: 'Sleepwear', image: 'category-generated/sleepwear.png', params: { category: 'sleepwear', gender: 'women' } },
      { label: 'Soft Basics', image: 'category-generated/lounge.png', params: { q: 'basic', gender: 'women' } }
    ],
    sectionTitle: 'All Lingerie',
    items: [
      { label: 'Everyday Wear', image: 'category-generated/innerwear.png', params: { category: 'innerwear', gender: 'women' } },
      { label: 'Nightwear', image: 'category-generated/sleepwear.png', params: { category: 'sleepwear', gender: 'women' } },
      { label: 'Lounge Sets', image: 'category-generated/lounge.png', params: { q: 'lounge', gender: 'women' } },
      { label: 'New In', image: 'category-generated/innerwear.png', params: { sort: 'newest', gender: 'women' } }
    ]
  },
  men: {
    kicker: 'MEN',
    title: 'Featured For Men',
    featured: [
      { label: 'Shirts', image: 'category-generated/men-shirts.png', params: { category: 'shirts', gender: 'men' } },
      { label: 'T-Shirts', image: 'category-generated/tshirts.png', params: { category: 't-shirts', gender: 'men' } },
      { label: 'Shoes', image: 'category-generated/men-footwear.png', params: { category: 'shoes', gender: 'men' } }
    ],
    sectionTitle: 'All Men Fashion',
    items: [
      { label: 'Shirts', image: 'category-generated/men-shirts.png', params: { category: 'shirts', gender: 'men' } },
      { label: 'Pants', image: 'category-generated/bottomwear.png', params: { category: 'pants', gender: 'men' } },
      { label: 'Jeans', image: 'category-generated/jeans.png', params: { category: 'jeans', gender: 'men' } },
      { label: 'Jackets', image: 'category-generated/jackets.png', params: { category: 'jackets', gender: 'men' } },
      { label: 'Watches', image: 'category-generated/watches.png', params: { category: 'watches', gender: 'men' } },
      { label: 'Eyewear', image: 'category-generated/eyewear.png', params: { category: 'eyewear', gender: 'men' } }
    ]
  },
  beauty: {
    kicker: 'BEAUTY',
    title: 'Beauty Picks',
    featured: [
      { label: 'Personal Care', image: 'category-generated/beauty.png', params: { q: 'beauty' } },
      { label: 'Accessories', image: 'category-generated/accessories.png', params: { category: 'accessories' } },
      { label: 'Premium Edit', image: 'category-generated/beauty.png', params: { sort: 'newest' } }
    ],
    sectionTitle: 'All Beauty',
    items: [
      { label: 'Beauty &\nPersonal Care', image: 'category-generated/beauty.png', params: { q: 'beauty' } },
      { label: 'Jewellery', image: 'category-generated/jewellery.png', params: { category: 'accessories' } },
      { label: 'Eyewear', image: 'category-generated/eyewear.png', params: { category: 'eyewear' } },
      { label: 'Watches', image: 'category-generated/watches.png', params: { category: 'watches' } }
    ]
  },
  footwear: {
    kicker: 'FOOTWEAR',
    title: 'Step Into Style',
    featured: [
      { label: 'Sneakers', image: 'category-generated/sneakers.png', params: { category: 'shoes' } },
      { label: 'Women Shoes', image: 'category-generated/women-footwear.png', params: { category: 'shoes', gender: 'women' } },
      { label: 'Men Shoes', image: 'category-generated/men-footwear.png', params: { category: 'shoes', gender: 'men' } }
    ],
    sectionTitle: 'All Footwear',
    items: [
      { label: 'Shoes', image: 'category-generated/sneakers.png', params: { category: 'shoes' } },
      { label: 'Women Footwear', image: 'category-generated/women-footwear.png', params: { category: 'shoes', gender: 'women' } },
      { label: 'Men Footwear', image: 'category-generated/men-footwear.png', params: { category: 'shoes', gender: 'men' } },
      { label: 'New Arrivals', image: 'category-generated/sneakers.png', params: { category: 'shoes', sort: 'newest' } }
    ]
  }
};
const homeProductFeedPageSize = 24;
const shopProductGridLimit = 50;
const searchQuickSuggestions = ['short kurti', 'saree', 'kurti', 'tshirt', 'earring', 'top for women', 'slipper', 'watch', 'top', 'kurti set', 'shoes', 'eyewear'];

function ShopTopBar({ onNavigate, user }) {
  return <AppHeader onNavigate={onNavigate} user={user} compact />;
}

function CategoryBubble({ item, size = 'large', active = false }) {
  const imageSource = item.image ? images[item.image] : null;
  const frameStyle = size === 'rail' ? styles.categoryRailImageFrame : styles.categoryContentImageFrame;
  const imageStyle = size === 'rail' ? styles.categoryRailImage : styles.categoryContentImage;
  const iconSize = size === 'rail' ? 30 : 38;

  return (
    <View style={[frameStyle, active && styles.categoryRailImageFrameActive]}>
      {imageSource ? (
        <Image source={imageSource} style={imageStyle} resizeMode="contain" />
      ) : (
        <Ionicons name={item.icon || 'sparkles'} size={iconSize} color={item.iconColor || '#9b5658'} />
      )}
    </View>
  );
}

function CategoryLandingScreen({ selectedCategory, onSelectCategory, onNavigate, user }) {
  const content = categoryPageContent[selectedCategory] || categoryPageContent.popular;
  const openTile = (item) => onNavigate('shop', item.params || { sort: 'newest' });

  return (
    <View style={styles.categoryScreen}>
      <ShopTopBar onNavigate={onNavigate} user={user} />
      <View style={styles.categoryBrowser}>
        <ScrollView style={styles.categoryRail} contentContainerStyle={styles.categoryRailContent} showsVerticalScrollIndicator={false}>
          {categoryRailItems.map((item) => {
            const active = item.key === selectedCategory;
            return (
              <TouchableOpacity
                key={item.key}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                activeOpacity={0.86}
                style={[styles.categoryRailItem, active && styles.categoryRailItemActive]}
                onPress={() => onSelectCategory(item.key)}
              >
                {active ? <View style={styles.categoryRailAccent} /> : null}
                <CategoryBubble item={item} size="rail" active={active} />
                <Text style={[styles.categoryRailLabel, active && styles.categoryRailLabelActive]} numberOfLines={3}>{item.label}</Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>

        <ScrollView style={styles.categoryMain} contentContainerStyle={styles.categoryMainContent} showsVerticalScrollIndicator={false}>
          <View style={styles.categoryKickerRow}>
            <Text style={styles.categoryKicker}>{content.kicker}</Text>
            <View style={styles.categoryKickerLine} />
          </View>
          <Text style={styles.categoryHeadline}>{content.title}</Text>

          <View style={styles.categoryTileGrid}>
            {content.featured.map((item) => (
              <TouchableOpacity key={`${content.kicker}-${item.label}`} accessibilityRole="button" activeOpacity={0.86} style={styles.categoryTile} onPress={() => openTile(item)}>
                <CategoryBubble item={item} />
                <Text style={styles.categoryTileLabel} numberOfLines={2}>{item.label}</Text>
              </TouchableOpacity>
            ))}
          </View>

          <Text style={styles.categorySectionTitle}>{content.sectionTitle}</Text>
          <View style={styles.categoryTileGrid}>
            {content.items.map((item) => (
              <TouchableOpacity key={`${content.sectionTitle}-${item.label}`} accessibilityRole="button" activeOpacity={0.86} style={styles.categoryTile} onPress={() => openTile(item)}>
                <CategoryBubble item={item} />
                <Text style={styles.categoryTileLabel} numberOfLines={2}>{item.label}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </ScrollView>
      </View>
    </View>
  );
}

function CurationProductCard({ product, onPress, onAddToWishlist, isWishlisted }) {
  const price = Number(product.price);
  return (
    <TouchableOpacity style={styles.homeProductCard} onPress={onPress}>
      <View style={styles.homeProductImageWrap}>
        <ProductImage product={product} style={styles.homeProductImage} alt={product.title || product.name} />
        {product.isNew ? <Text style={styles.homeNewBadge}>NEW</Text> : null}
        {onAddToWishlist ? <WishlistDoneButton saved={isWishlisted} compact onPress={() => onAddToWishlist(product)} /> : null}
      </View>
      <Text style={styles.homeProductEyebrow} numberOfLines={1}>{product.displayLabel || titleCase(product.category || 'Catalog')}</Text>
      <Text style={styles.homeProductTitle} numberOfLines={2}>{product.title || product.name}</Text>
      <Text style={styles.homeProductPrice}>{Number.isFinite(price) ? formatMoney(price, product.currency) : 'Price unavailable'}</Text>
    </TouchableOpacity>
  );
}

function ProductTopBar({ onNavigate, user }) {
  return <AppHeader onNavigate={onNavigate} user={user} compact />;
}

function ProductActionButton({ label, icon, active, disabled, onPress }) {
  return (
    <TouchableOpacity style={[styles.productActionButton, active && styles.productActionButtonActive, disabled && styles.disabledButton]} activeOpacity={0.85} disabled={disabled} onPress={onPress}>
      <Ionicons name={icon} size={15} color={active ? '#ffffff' : '#4f4a48'} />
      <Text style={[styles.productActionText, active && styles.productActionTextActive]}>{label}</Text>
    </TouchableOpacity>
  );
}

function CompleteLookCard({ product, fallback, onPress, onAddToWishlist, isWishlisted }) {
  const source = product ? productImageSource(product) : images[fallback.image];
  const price = Number(product?.price);
  return (
    <TouchableOpacity style={styles.completeLookCard} activeOpacity={0.86} onPress={onPress}>
      <View style={styles.completeLookImageWrap}>
        {product ? <ProductImage product={product} style={styles.completeLookImage} alt={product.title || product.name} /> : <ResilientImage source={source} fallbackSource={images.hero} style={styles.completeLookImage} resizeMode="cover" fallbackIcon="shirt-outline" />}
        {product && onAddToWishlist ? <WishlistDoneButton saved={isWishlisted} compact onPress={() => onAddToWishlist(product)} /> : null}
      </View>
      <Text style={styles.completeLookBrand} numberOfLines={1}>{product?.displayLabel || fallback?.brand}</Text>
      <Text style={styles.completeLookName} numberOfLines={2}>{product?.title || product?.name || fallback?.name}</Text>
      <Text style={styles.completeLookPrice}>{product ? (Number.isFinite(price) ? formatMoney(price, product.currency) : 'Price unavailable') : fallback?.price}</Text>
    </TouchableOpacity>
  );
}

function ConciergeSuggestionCard({ product, fallback, featured, onShop, onTryOn, onPreview, tryOn, tryOnLoading, tryOnError, actionLabel = 'Generate Try-On' }) {
  const source = product ? productImageSource(product) : images[fallback.image];
  const price = Number(product?.price);
  const canPreview = Boolean(tryOn?.imageUrl && onPreview);
  const handleCardPress = canPreview ? onPreview : (onTryOn || onShop);
  return (
    <TouchableOpacity style={styles.conciergeSuggestionCard} activeOpacity={0.88} onPress={handleCardPress}>
      <View style={styles.conciergeSuggestionImageWrap}>
        {product ? <ProductImage product={product} tryOn={tryOn} style={styles.conciergeSuggestionImage} alt={product.title || product.name} /> : <ResilientImage source={source} fallbackSource={images.hero} style={styles.conciergeSuggestionImage} resizeMode="cover" fallbackIcon="shirt-outline" />}
        {tryOn?.imageUrl ? <Text style={styles.badge}>AI Try-On</Text> : null}
        {tryOnLoading ? <TryOnLoading text="Generating" /> : null}
        {featured ? (
          <TouchableOpacity style={styles.conciergeSparkButton} onPress={onTryOn || onShop}>
            <Ionicons name="sparkles" size={24} color="#050505" />
          </TouchableOpacity>
        ) : null}
      </View>
      <View style={styles.conciergeSuggestionBody}>
        <Text style={styles.conciergeSuggestionBrand} numberOfLines={1}>{product?.displayLabel || fallback?.brand}</Text>
        <Text style={styles.conciergeSuggestionName} numberOfLines={2}>{product?.title || product?.name || fallback?.name}</Text>
        <Text style={styles.conciergeSuggestionPrice}>{product ? (Number.isFinite(price) ? formatMoney(price, product.currency) : 'Price unavailable') : fallback?.price}</Text>
        <TouchableOpacity style={[styles.conciergeShopButton, tryOnLoading && styles.disabledButton]} disabled={tryOnLoading} onPress={onTryOn || onShop}>
          <Text style={styles.conciergeShopText}>{tryOnLoading ? 'Generating...' : actionLabel}</Text>
        </TouchableOpacity>
        {tryOn?.imageUrl ? <AiPreviewNote /> : null}
        {tryOnError ? <Text style={styles.errorText}>{tryOnError}</Text> : null}
        {product?.affiliateLink && onShop ? (
          <TouchableOpacity style={styles.conciergeExternalLink} onPress={onShop}>
            <Text style={styles.conciergeExternalLinkText}>View on Amazon</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    </TouchableOpacity>
  );
}

function HomeScreen({ onNavigate, user, token, onAddToWishlist, wishlistIds, registerTourTarget, tourFocusRequest }) {
  const { width } = useWindowDimensions();
  const homeHeroWidth = Math.max(1, width - 32);
  const heroCarouselRef = useRef(null);
  const homeScrollRef = useRef(null);
  const [heroIndex, setHeroIndex] = useState(0);
  const preferredGender = productGenderForUser(user);
  const preferredHomeCategories = homeCategoryItemsByGender[preferredGender] || homeCategoryItems;
  const curated = useProducts({ sort: 'newest', limit: homeProductFeedPageSize, gender: preferredGender }, token);
  const shopLookQuery = preferredGender === 'women'
    ? { category: 'dresses', gender: 'women', sort: 'newest', limit: 8 }
    : preferredGender === 'men'
      ? { gender: 'men', sort: 'newest', limit: 8 }
      : { sort: 'newest', limit: 8 };
  const shopLooks = useProducts(shopLookQuery, token);
  const curatedProducts = curated.products;
  const lookCategories = preferredGender === 'men'
    ? new Set(['shirts', 't-shirts', 'pants', 'jeans', 'jackets', 'suits', 'shoes'])
    : preferredGender === 'women'
      ? new Set(['dresses', 'tops', 'ethnic wear', 'ethnic', 'shoes', 'accessories', 'jeans', 't-shirts'])
      : null;
  const shopLookProducts = shopLooks.products.filter((product) => (!lookCategories || lookCategories.has(product.category)) && (product.imageUrl || product.imageUrls?.length));
  const lookLabels = preferredGender === 'men'
    ? ['Office Sharp', 'Weekend Fit', 'Denim Day', 'Sneaker Edit', 'Layered Look', 'Evening Ready']
    : ['Dinner Ready', 'Soft Floral', 'Denim Day', 'Party Edit', 'Vacation', 'Weekend'];
  const homeCurationTitle = preferredGender === 'men' ? "Men's New Arrivals" : preferredGender === 'women' ? "Women's New Arrivals" : 'All Products';
  const journalTitle = preferredGender === 'men' ? "Men's Style Edit" : 'Shop by Look';
  const journalKicker = preferredGender === 'men' ? 'MENSWEAR EDIT' : 'DRESS EDIT';
  const journalIntro = preferredGender === 'men'
    ? 'Sharp menswear picks from the live catalog, selected for quick outfit discovery.'
    : preferredGender === 'women'
      ? 'Real dress picks from the live catalog, selected for quick outfit discovery.'
      : 'Live catalog picks selected for quick outfit discovery.';
  const journalViewParams = preferredGender === 'women'
    ? { category: 'dresses', gender: 'women' }
    : preferredGender === 'men'
      ? { gender: 'men', sort: 'newest' }
      : { sort: 'newest' };
  const catalogTourTarget = useTourTarget('home-catalog', registerTourTarget, { request: tourFocusRequest, scrollRef: homeScrollRef, scrollOffset: 92 });
  const handleHeroMomentumEnd = useCallback((event) => {
    const nextIndex = Math.round(event.nativeEvent.contentOffset.x / homeHeroWidth);
    setHeroIndex(Math.min(homeHeroSlides.length - 1, Math.max(0, nextIndex)));
  }, [homeHeroWidth]);

  useEffect(() => {
    if (homeHeroSlides.length < 2) return undefined;
    const timer = setInterval(() => {
      setHeroIndex((currentIndex) => {
        const nextIndex = (currentIndex + 1) % homeHeroSlides.length;
        heroCarouselRef.current?.scrollTo({ x: nextIndex * homeHeroWidth, animated: true });
        return nextIndex;
      });
    }, homeHeroSlideIntervalMs);
    return () => clearInterval(timer);
  }, [homeHeroWidth]);

  return (
    <View style={styles.homeScreen}>
      <AppHeader onNavigate={onNavigate} user={user} compact />
      <ScrollView ref={homeScrollRef} style={styles.homeScroll} contentContainerStyle={styles.homeContent} {...screenScrollProps}>
      <View style={styles.homeHero}>
        <ScrollView
          ref={heroCarouselRef}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          bounces={false}
          overScrollMode="never"
          scrollEventThrottle={16}
          onMomentumScrollEnd={handleHeroMomentumEnd}
        >
          {homeHeroSlides.map((slide) => (
            <View key={slide.key} style={[styles.homeHeroSlide, { width: homeHeroWidth }]}>
              <Image source={images[slide.image]} style={styles.homeHeroImage} resizeMode="cover" />
              <View style={styles.homeHeroShade} />
              <View style={styles.homeHeroCopy}>
                <Text style={styles.homeHeroTitle}>{slide.title}</Text>
                <TouchableOpacity style={styles.homeHeroButton} onPress={() => onNavigate(slide.route)}>
                  <Text style={styles.homeHeroButtonText}>{slide.cta}</Text>
                </TouchableOpacity>
              </View>
            </View>
          ))}
        </ScrollView>
        <View pointerEvents="none" style={styles.homeHeroDots}>
          {homeHeroSlides.map((slide, index) => (
            <View key={`${slide.key}-dot`} style={[styles.homeHeroDot, index === heroIndex && styles.homeHeroDotActive]} />
          ))}
        </View>
      </View>

      <View ref={catalogTourTarget.ref} onLayout={catalogTourTarget.onLayout} style={styles.homeSection}>
        <View style={styles.homeSectionHead}>
          <Text style={styles.homeSectionTitle}>Categories</Text>
          <TouchableOpacity onPress={() => onNavigate('shop')}>
            <Text style={styles.homeViewAll}>VIEW ALL</Text>
          </TouchableOpacity>
        </View>
        <ScrollView
          {...horizontalScrollProps}
          contentContainerStyle={styles.homeCategoryTrack}
          decelerationRate="fast"
          snapToInterval={homeCategorySnapInterval}
          snapToAlignment="start"
        >
          {preferredHomeCategories.map((item) => (
            <TouchableOpacity key={item.label} activeOpacity={0.86} style={styles.homeCategoryItem} onPress={() => onNavigate('shop', item.params || {})}>
              <View style={styles.homeCategoryImageFrame}>
                <Image source={images[item.image]} style={styles.homeCategoryImage} resizeMode="contain" />
              </View>
              <Text style={styles.homeCategoryLabel} numberOfLines={1}>{item.label}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>

      <Text style={styles.homeCurationTitle}>{homeCurationTitle}</Text>
      <View style={styles.homeCuratedGrid}>
        {curated.loading ? (
          <HomeProductSkeletonGrid />
        ) : curated.error || !curatedProducts.length ? (
          <StatusPanel error={curated.error} empty={!curatedProducts.length} text="No products found yet." />
        ) : curatedProducts.map((product) => {
          return (
            <CurationProductCard
              key={product.id}
              product={product}
              onPress={() => onNavigate('product', { id: product.id })}
              onAddToWishlist={onAddToWishlist}
              isWishlisted={wishlistIds?.has(product.id)}
            />
          );
        })}
      </View>

      <View style={styles.homeJournalBand}>
        <View style={styles.homeJournalHead}>
          <View>
            <Text style={styles.homeJournalKicker}>{journalKicker}</Text>
            <Text style={styles.homeJournalTitle}>{journalTitle}</Text>
          </View>
          <TouchableOpacity style={styles.homeJournalLink} activeOpacity={0.82} onPress={() => onNavigate('shop', journalViewParams)}>
            <Text style={styles.homeJournalLinkText}>View all</Text>
            <Ionicons name="arrow-forward" size={14} color="#9b5658" />
          </TouchableOpacity>
        </View>
        <Text style={styles.homeJournalIntro}>{journalIntro}</Text>
        {shopLooks.loading ? (
          <HomeJournalSkeletonGrid />
        ) : shopLooks.error || !shopLookProducts.length ? (
          <StatusPanel error={shopLooks.error} empty={!shopLookProducts.length} text={preferredGender === 'men' ? 'No men looks found yet.' : 'No looks found yet.'} />
        ) : (
          <View style={styles.homeJournalGrid}>
            {shopLookProducts.slice(0, 6).map((product, index) => {
              const price = Number(product.price);
              return (
                <TouchableOpacity key={product.id} style={styles.homeJournalProductCard} activeOpacity={0.86} onPress={() => onNavigate('product', { id: product.id })}>
                  <View style={styles.homeJournalImageFrame}>
                    <ProductImage product={product} style={styles.homeJournalImage} resizeMode="cover" alt={product.title || product.name} />
                    {onAddToWishlist ? <WishlistDoneButton saved={wishlistIds?.has(product.id)} compact onPress={() => onAddToWishlist(product)} /> : null}
                    <View style={styles.homeJournalOverlay}>
                      <Text style={styles.homeJournalLookLabel} numberOfLines={1}>{lookLabels[index % lookLabels.length]}</Text>
                    </View>
                  </View>
                  <View style={styles.homeJournalProductBody}>
                    <Text style={styles.homeJournalProductLabel} numberOfLines={1}>{product.displayLabel || titleCase(product.category || 'Catalog')}</Text>
                    <Text style={styles.homeJournalProductTitle} numberOfLines={2}>{product.title || product.name}</Text>
                    <Text style={styles.homeJournalProductPrice}>{Number.isFinite(price) ? formatMoney(price, product.currency) : 'Price unavailable'}</Text>
                  </View>
                </TouchableOpacity>
              );
            })}
          </View>
        )}
      </View>
      </ScrollView>
    </View>
  );
}

function FilterChips({ selected, options, onSelect, compact, wrap }) {
  const content = options.map((option) => {
    const value = Array.isArray(option) ? option[0] : option;
    const label = Array.isArray(option) ? option[1] : titleCase(option);
    const active = selected === value;
    return (
      <TouchableOpacity
        key={`${value || 'all'}-${label}`}
        accessibilityRole="button"
        style={[styles.chip, active && styles.activeChip, compact && styles.compactChip, wrap && styles.wrappedChip]}
        onPress={() => onSelect(value)}
      >
        <Text style={[styles.chipText, active && styles.activeChipText]}>{label}</Text>
      </TouchableOpacity>
    );
  });

  if (wrap) return <View style={[styles.chipRow, styles.wrappedChipRow]}>{content}</View>;

  return (
    <ScrollView {...horizontalScrollProps} contentContainerStyle={styles.chipRow}>
      {content}
    </ScrollView>
  );
}

function FilterDropdown({ label, selected, options, onSelect }) {
  const [open, setOpen] = useState(false);
  const selectedOption = options.find((option) => (Array.isArray(option) ? option[0] : option) === selected) || options[0];
  const selectedLabel = String(Array.isArray(selectedOption) ? selectedOption[1] : titleCase(selectedOption || '') || label);
  const hasValue = Boolean(selected) || label === 'Sort';

  return (
    <>
      <TouchableOpacity accessibilityRole="button" activeOpacity={0.82} style={[styles.dropdownButton, hasValue && styles.dropdownButtonActive]} onPress={() => setOpen(true)}>
        <View style={styles.dropdownCopy}>
          <Text style={styles.dropdownLabel}>{label}</Text>
          <Text style={styles.dropdownValue} numberOfLines={1}>{selectedLabel}</Text>
        </View>
        <Ionicons name="chevron-down" size={14} color={hasValue ? '#8c4d50' : '#6f6863'} />
      </TouchableOpacity>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.dropdownBackdrop} onPress={() => setOpen(false)}>
          <Pressable style={styles.dropdownSheet} onPress={(event) => event.stopPropagation()}>
            <View style={styles.dropdownHandle} />
            <Text style={styles.dropdownTitle}>{label}</Text>
            <ScrollView style={styles.dropdownOptions} {...screenScrollProps}>
              {options.map((option) => {
                const value = Array.isArray(option) ? option[0] : option;
                const optionLabel = Array.isArray(option) ? option[1] : titleCase(option);
                const active = selected === value;
                return (
                  <TouchableOpacity
                    key={`${value || 'all'}-${optionLabel}`}
                    style={[styles.dropdownOption, active && styles.dropdownOptionActive]}
                    onPress={() => {
                      setOpen(false);
                      onSelect(value);
                    }}
                  >
                    <Text style={[styles.dropdownOptionText, active && styles.dropdownOptionTextActive]}>{optionLabel}</Text>
                    {active ? <Ionicons name="checkmark" size={18} color="#0f766e" /> : null}
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

function TryOnVideoPlayer({ uri, style, nativeControls = true }) {
  const player = useVideoPlayer(uri, (instance) => {
    instance.loop = true;
    instance.muted = true;
    instance.play();
  });

  return (
    <View style={[style || styles.detailVideo, styles.videoSurface]}>
      <VideoView
        player={player}
        style={styles.videoSurfacePlayer}
        nativeControls={nativeControls}
        contentFit="contain"
        allowsFullscreen
        allowsPictureInPicture
      />
    </View>
  );
}

function SearchScreen({ initial = {}, user, token, onNavigate, onBack, onAddToWishlist, wishlistIds }) {
  const inputRef = useRef(null);
  const initialQuery = String(initial.q || '');
  const [query, setQuery] = useState(initialQuery);
  const [submittedQuery, setSubmittedQuery] = useState(initialQuery.trim());
  const [recentSearches, setRecentSearches] = useState([]);
  const hasSubmittedQuery = Boolean(submittedQuery);
  const state = useProducts({ q: submittedQuery, limit: shopProductGridLimit, enabled: hasSubmittedQuery }, token);
  const products = state.products || [];
  const recentKey = useMemo(() => recentSearchStorageKey(user), [user?.id, user?._id, user?.phone, user?.username]);

  useEffect(() => {
    const nextQuery = String(initial.q || '');
    setQuery(nextQuery);
    setSubmittedQuery(nextQuery.trim());
  }, [JSON.stringify(initial || {})]);

  useEffect(() => {
    let alive = true;
    async function loadRecentSearches() {
      const stored = await loadStoredRecentSearches(recentKey);
      let synced = [];
      if (user && token) {
        try {
          const data = await api(`/recommendations/recent-searches?limit=${recentSearchLimit}`);
          synced = normalizeRecentSearches(data.searches || []);
        } catch {
          synced = [];
        }
      }
      const nextSearches = synced.length ? synced : stored;
      if (!alive) return;
      setRecentSearches(nextSearches);
      if (synced.length) saveStoredRecentSearches(recentKey, synced);
    }
    loadRecentSearches();
    return () => {
      alive = false;
    };
  }, [recentKey, token, user?.id, user?._id]);

  const runSearch = useCallback((nextValue = query) => {
    const nextQuery = String(nextValue || '').trim();
    setQuery(nextQuery);
    setSubmittedQuery(nextQuery);
    if (nextQuery) {
      setRecentSearches((current) => {
        const nextSearches = normalizeRecentSearches([nextQuery, ...current]);
        saveStoredRecentSearches(recentKey, nextSearches);
        return nextSearches;
      });
      if (user && token) {
        api('/recommendations/events', {
          method: 'POST',
          body: JSON.stringify({ type: 'search', query: nextQuery })
        }).catch(() => {});
      }
    }
  }, [query, recentKey, token, user?.id, user?._id]);

  const clearSearch = () => {
    setQuery('');
    setSubmittedQuery('');
    inputRef.current?.focus?.();
  };
  const closeSearch = () => {
    if (!onBack?.()) onNavigate('home');
  };

  return (
    <View style={styles.searchScreen}>
      <View style={styles.searchTopBar}>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="Go back" style={styles.searchBackButton} onPress={closeSearch}>
          <Ionicons name="chevron-back" size={27} color="#302b34" />
        </TouchableOpacity>
        <View style={styles.searchCompactInputWrap}>
          <Ionicons name="search-outline" size={23} color="#9e99ad" />
          <TextInput
            ref={inputRef}
            value={query}
            onChangeText={setQuery}
            placeholder="Search by Keyword or Product ID"
            placeholderTextColor="#8d8a99"
            returnKeyType="search"
            onSubmitEditing={() => runSearch()}
            style={styles.searchCompactInput}
          />
          {query ? (
            <TouchableOpacity accessibilityRole="button" accessibilityLabel="Clear search" style={styles.searchTopIconButton} onPress={clearSearch}>
              <Ionicons name="close-circle" size={20} color="#9e99ad" />
            </TouchableOpacity>
          ) : null}
        </View>
      </View>

      <ScrollView contentContainerStyle={styles.searchContent} {...screenScrollProps}>
        {!hasSubmittedQuery ? (
          <>
            <View style={styles.searchUtilitySection}>
              <Text style={styles.searchUtilityTitle}>Your Recent Searches</Text>
              {recentSearches.length ? (
                <View style={styles.recentSearchList}>
                  {recentSearches.map((item) => (
                    <TouchableOpacity key={item} style={styles.recentSearchRow} activeOpacity={0.76} onPress={() => runSearch(item)}>
                      <Ionicons name="time-outline" size={24} color="#4e4a54" />
                      <Text style={styles.recentSearchText}>{item}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              ) : (
                <Text style={styles.recentSearchEmpty}>Your searches will appear here.</Text>
              )}
            </View>
            <View style={styles.searchPopularBlock}>
              <Text style={styles.searchUtilityTitle}>Popular Searches</Text>
              <View style={styles.searchSuggestionGrid}>
                {searchQuickSuggestions.map((suggestion) => (
                  <TouchableOpacity key={suggestion} style={styles.searchSuggestionChip} activeOpacity={0.82} onPress={() => runSearch(suggestion)}>
                    <Text style={styles.searchSuggestionText}>{suggestion}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>
            <TouchableOpacity style={styles.searchPromoBanner} activeOpacity={0.86} onPress={() => runSearch('saree earrings')}>
              <View style={styles.searchPromoCopy}>
                <Text style={styles.searchPromoTitle}>Jhumka Bareilly ka ya Saree Banarasi</Text>
                <Text style={styles.searchPromoText}>Shop what you love</Text>
              </View>
              <View style={styles.searchPromoImageCluster}>
                <Image source={images['category-generated/jewellery.png']} style={[styles.searchPromoImage, styles.searchPromoImageSmall]} resizeMode="contain" />
                <Image source={images['category-generated/saree.png']} style={[styles.searchPromoImage, styles.searchPromoImageLarge]} resizeMode="contain" />
              </View>
            </TouchableOpacity>
          </>
        ) : (
          <>
            <View style={styles.searchResultsHead}>
              <Text style={styles.searchResultsTitle}>Results for "{submittedQuery}"</Text>
              <Text style={styles.searchResultsMeta}>{state.loading ? 'Searching...' : `${state.total || products.length} products`}</Text>
            </View>
            {state.loading ? <ProductGridSkeleton /> : null}
            {state.error ? <StatusPanel error={state.error} /> : null}
            {!state.loading && !state.error && !products.length ? (
              <View style={styles.searchEmptyCard}>
                <Ionicons name="search-outline" size={25} color="#9b5658" />
                <Text style={styles.searchEmptyTitle}>No results found</Text>
                <Text style={styles.searchEmptyText}>Try a broader term, another category, or a different spelling.</Text>
              </View>
            ) : null}
            {!state.loading && products.length ? (
              <View style={styles.productGrid}>
                {products.map((product) => (
                  <ProductCard
                    key={product.id}
                    variant="homeFrame"
                    product={product}
                    onPress={() => onNavigate('product', { id: product.id })}
                    onAddToWishlist={onAddToWishlist}
                    isWishlisted={wishlistIds?.has(product.id)}
                  />
                ))}
              </View>
            ) : null}
          </>
        )}
      </ScrollView>
    </View>
  );
}

function ShopScreen({ initial = {}, tryOnMode, user, setUser, token, onNavigate, onRequireAuth, onAddToWishlist, wishlistIds }) {
  if (tryOnMode) {
    return <StyleBotScreen user={user} setUser={setUser} token={token} onNavigate={onNavigate} onRequireAuth={onRequireAuth} />;
  }

  const [draft, setDraft] = useState(initial.q || '');
  const [filters, setFilters] = useState({
    q: initial.q || '',
    category: initial.category || '',
    brand: '',
    gender: initial.gender || '',
    sort: initial.sort || '',
    newArrival: initial.newArrival || ''
  });
  const preferredCategorySection = defaultCategorySectionForUser(user);
  const explicitCategorySection = initial.section || initial.categoryGroup || '';
  const [selectedCategory, setSelectedCategory] = useState(explicitCategorySection || preferredCategorySection);
  const [tryOnLoading, setTryOnLoading] = useState({});
  const [tryOnVideoLoading, setTryOnVideoLoading] = useState({});
  const [tryOnErrors, setTryOnErrors] = useState({});
  const [tryOnVideoErrors, setTryOnVideoErrors] = useState({});
  const state = useProducts({ ...filters, limit: shopProductGridLimit }, token);
  const [tryOns, setTryOns] = useTryOns(user, state.products, token);
  const resultTitle = shopResultTitle(filters, false);
  const searchPlaceholder = filters.category
    ? `Search in ${titleCase(filters.category)}`
    : filters.q
      ? `Search ${String(filters.q).toLowerCase()}, brands, colours`
      : 'Search products, brands, colours';

  useEffect(() => {
    setDraft(initial.q || '');
    setFilters({
      q: initial.q || '',
      category: initial.category || '',
      brand: initial.brand || '',
      gender: initial.gender || '',
      sort: initial.sort || '',
      newArrival: initial.newArrival || ''
    });
  }, [JSON.stringify(initial || {}), tryOnMode]);

  useEffect(() => {
    if (initial.section || initial.categoryGroup || initial.q || initial.category || initial.gender || initial.brand || initial.newArrival) return;
    setSelectedCategory(preferredCategorySection);
  }, [JSON.stringify(initial || {}), preferredCategorySection]);

  const hasSearchIntent = Boolean(filters.q || filters.category || filters.brand || filters.gender || filters.newArrival);
  const allowTryOnTrial = tryOnMode || hasSearchIntent;
  const visibleProducts = state.products;

  const runSearch = () => {
    setFilters((current) => ({ ...current, q: draft.trim() }));
  };

  const generateTryOn = useCallback(async (product) => {
    if (!user) {
      onRequireAuth?.('Log in with your mobile number to try this product on.');
      return;
    }
    if (!product?.id || tryOnLoading[product.id]) return;
    const profileMessage = tryOnProfileBlockMessage(user);
    if (profileMessage) {
      setTryOnErrors((current) => ({ ...current, [product.id]: profileMessage }));
      return;
    }
    const existing = tryOns[product.id];
    setTryOnLoading((current) => ({ ...current, [product.id]: true }));
    setTryOnErrors((current) => ({ ...current, [product.id]: '' }));
    try {
      const data = await api(`/tryons/${product.id}`, {
        method: 'POST',
        body: existing?.imageUrl ? JSON.stringify({ force: true }) : undefined
      });
      let nextTryOn = data.tryOn || null;
      if (!nextTryOn?.imageUrl) nextTryOn = await fetchProductTryOn(product.id, { waitForImage: true });
      if (nextTryOn) setTryOns((current) => ({ ...current, [product.id]: nextTryOn }));
      if (data.user) setUser(data.user);
    } catch (error) {
      setTryOnErrors((current) => ({ ...current, [product.id]: aiFeatureErrorMessage(error, 'Could not generate this AI try-on. Try again in a moment.') }));
    } finally {
      setTryOnLoading((current) => ({ ...current, [product.id]: false }));
    }
  }, [user, tryOnLoading, tryOns, onRequireAuth]);

  const generateTryOnVideo = useCallback(async (product) => {
    const existing = tryOns[product?.id];
    if (!user) {
      onRequireAuth?.('Log in with your mobile number to create a video try-on.');
      return;
    }
    if (!product?.id || tryOnVideoLoading[product.id] || !existing?.imageUrl) return;
    const profileMessage = tryOnProfileBlockMessage(user);
    if (profileMessage) {
      setTryOnVideoErrors((current) => ({ ...current, [product.id]: profileMessage }));
      return;
    }
    setTryOnVideoLoading((current) => ({ ...current, [product.id]: true }));
    setTryOnVideoErrors((current) => ({ ...current, [product.id]: '' }));
    try {
      const data = await api(`/tryons/${product.id}/video`, {
        method: 'POST',
        body: existing.videoUrl ? JSON.stringify({ force: true }) : undefined,
        timeoutMs: 180000
      });
      setTryOns((current) => ({ ...current, [product.id]: data.tryOn }));
      if (data.user) setUser(data.user);
    } catch (error) {
      setTryOnVideoErrors((current) => ({ ...current, [product.id]: aiFeatureErrorMessage(error, 'Could not generate this video try-on. Try again in a moment.') }));
    } finally {
      setTryOnVideoLoading((current) => ({ ...current, [product.id]: false }));
    }
  }, [user, tryOnVideoLoading, tryOns, onRequireAuth]);

  const showStorefront = !tryOnMode && !hasSearchIntent && !filters.sort;

  if (showStorefront) {
    return (
      <CategoryLandingScreen
        selectedCategory={selectedCategory}
        onSelectCategory={setSelectedCategory}
        onNavigate={onNavigate}
        user={user}
      />
    );
  }

  return (
    <View style={styles.shopScreen}>
      <ShopTopBar onNavigate={onNavigate} user={user} />
      <ScrollView contentContainerStyle={styles.scrollContent} {...screenScrollProps}>
      <View style={styles.searchPanel}>
        <View style={styles.searchRow}>
          <Ionicons name="search-outline" size={19} color="#66748a" />
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder={searchPlaceholder}
            placeholderTextColor="#68768c"
            returnKeyType="search"
            onSubmitEditing={runSearch}
            style={styles.searchInput}
          />
          <TouchableOpacity style={styles.searchButton} onPress={runSearch}>
            <Ionicons name="arrow-forward" size={18} color="#fff" />
          </TouchableOpacity>
        </View>
        <View style={styles.filterRail}>
          <FilterDropdown label="Category" selected={filters.category} options={[['', 'All'], ...categories.map(([label, , value]) => [value, label])]} onSelect={(category) => {
            setFilters((current) => ({ ...current, category }));
          }} />
          <FilterDropdown label="Gender" selected={filters.gender} options={[['', 'All genders'], ...genders.map((gender) => [gender, titleCase(gender)])]} onSelect={(gender) => {
            setFilters((current) => ({ ...current, gender }));
          }} />
          <FilterDropdown label="Sort" selected={filters.sort} options={sortOptions} onSelect={(sort) => {
            setFilters((current) => ({ ...current, sort }));
          }} />
        </View>
      </View>

      <View style={styles.resultsHead}>
        <View>
          <Text style={styles.screenTitle}>{titleCase(resultTitle)}</Text>
          <Text style={styles.muted}>{state.loading ? 'Searching...' : `${state.total} products`}</Text>
        </View>
      </View>

      {state.loading ? <ProductGridSkeleton /> : (
        <>
          <StatusPanel error={state.error} empty={!state.products.length} text="Try a different search or browse another category." />
          <View style={styles.productGrid}>
            {visibleProducts.map((product, index) => (
              <ProductCard
                key={product.id}
                variant="homeFrame"
                product={product}
                tryOn={tryOns[product.id]}
                loading={Boolean(tryOnLoading[product.id])}
                videoLoading={Boolean(tryOnVideoLoading[product.id])}
                error={tryOnErrors[product.id]}
                videoError={tryOnVideoErrors[product.id]}
                onPress={() => onNavigate('product', { id: product.id })}
                onAddToWishlist={onAddToWishlist}
                isWishlisted={wishlistIds?.has(product.id)}
                onTryOn={allowTryOnTrial && index < 4 ? () => generateTryOn(product) : undefined}
                onTryOnVideo={allowTryOnTrial && tryOns[product.id]?.imageUrl ? () => generateTryOnVideo(product) : undefined}
              />
            ))}
          </View>
        </>
      )}
      {Object.values(tryOns).some((item) => item?.imageUrl || item?.videoUrl) ? <AiPreviewNote /> : null}
      </ScrollView>
    </View>
  );
}

function ProductScreen({ id, user, setUser, token, onNavigate, onRequireAuth, onAddToWishlist, wishlistIds }) {
  const { width } = useWindowDimensions();
  const [state, setState] = useState({ product: null, loading: true, error: '' });
  const [tryOn, setTryOn] = useState(null);
  const [tryOnLoading, setTryOnLoading] = useState(false);
  const [tryOnVideoLoading, setTryOnVideoLoading] = useState(false);
  const [tryOnError, setTryOnError] = useState('');
  const [tryOnVideoError, setTryOnVideoError] = useState('');
  const [selectedSize, setSelectedSize] = useState('Medium');
  const [lightbox, setLightbox] = useState(null);
  const mediaScrollRef = useRef(null);
  const mediaWidth = Math.max(1, Math.round(width - 28));
  const related = useProducts({ category: state.product?.category || '', limit: 5 }, token);
  const relatedProducts = related.products.filter((item) => item.id !== id).slice(0, 4);
  const [relatedTryOns] = useTryOns(user, relatedProducts, token);

  useEffect(() => {
    let alive = true;
    setState({ product: null, loading: true, error: '' });
    api(`/products/${encodeURIComponent(id)}`)
      .then((data) => alive && setState({ product: data.product ? normalizeProduct(data.product) : null, loading: false, error: '' }))
      .catch((error) => alive && setState({ product: null, loading: false, error: error.message }));
    return () => {
      alive = false;
    };
  }, [id, token]);

  useEffect(() => {
    if (!user || !id) {
      setTryOn(null);
      return undefined;
    }
    let alive = true;
    fetchProductTryOn(id)
      .then((data) => alive && setTryOn(data || null))
      .catch(() => alive && setTryOn(null));
    return () => {
      alive = false;
    };
  }, [id, user?.id, user?.bodyPhotoUrl, token]);

  useEffect(() => {
    if (!tryOn?.imageUrl && !tryOn?.videoUrl) return undefined;
    const timer = setTimeout(() => {
      mediaScrollRef.current?.scrollTo?.({ x: 0, animated: true });
    }, 80);
    return () => clearTimeout(timer);
  }, [tryOn?.id, tryOn?.imageUrl, tryOn?.videoUrl, tryOn?.updatedAt, tryOn?.videoGeneratedAt, mediaWidth]);

  const generate = async () => {
    if (!user) {
      onRequireAuth?.('Log in with your mobile number to generate AI try-ons.');
      return;
    }
    if (tryOnLoading || !state.product?.id) return;
    const profileMessage = tryOnProfileBlockMessage(user);
    if (profileMessage) {
      setTryOnError(profileMessage);
      return;
    }
    setTryOnLoading(true);
    setTryOnError('');
    try {
      const regenerate = Boolean(tryOn?.imageUrl);
      const data = await api(`/tryons/${state.product.id}`, {
        method: 'POST',
        body: regenerate ? JSON.stringify({ force: true }) : undefined,
        timeoutMs: 180000
      });
      let nextTryOn = data.tryOn || null;
      if (!nextTryOn?.imageUrl) nextTryOn = await fetchProductTryOn(state.product.id, { waitForImage: true });
      if (nextTryOn) setTryOn(nextTryOn);
      if (regenerate && data.reused) setTryOnError('Existing try-on was reused. Restart the backend with the latest code, then try again.');
      if (data.user) setUser(data.user);
    } catch (error) {
      setTryOnError(aiFeatureErrorMessage(error, 'Could not generate this AI try-on. Try again in a moment.'));
    } finally {
      setTryOnLoading(false);
    }
  };

  const generateVideo = async () => {
    if (!user) {
      onRequireAuth?.('Log in with your mobile number to create a video try-on.');
      return;
    }
    if (tryOnVideoLoading || !tryOn?.imageUrl || !state.product?.id) return;
    const profileMessage = tryOnProfileBlockMessage(user);
    if (profileMessage) {
      setTryOnVideoError(profileMessage);
      return;
    }
    setTryOnVideoLoading(true);
    setTryOnVideoError('');
    try {
      const regenerate = Boolean(tryOn?.videoUrl);
      const data = await api(`/tryons/${state.product.id}/video`, {
        method: 'POST',
        body: regenerate ? JSON.stringify({ force: true }) : undefined,
        timeoutMs: 180000
      });
      setTryOn(data.tryOn);
      if (regenerate && data.reused) setTryOnVideoError('Existing video was reused. Restart the backend with the latest code, then try again.');
      if (data.user) setUser(data.user);
    } catch (error) {
      setTryOnVideoError(aiFeatureErrorMessage(error, 'Could not generate this video try-on. Try again in a moment.'));
    } finally {
      setTryOnVideoLoading(false);
    }
  };

  if (state.loading || state.error || !state.product) {
    return (
      <View style={styles.productDetailScreen}>
        <ProductTopBar onNavigate={onNavigate} user={user} />
        <ScrollView contentContainerStyle={styles.scrollContent} {...screenScrollProps}>
          <StatusPanel loading={state.loading} error={state.error} empty={!state.loading && !state.product} text="This item may have been removed from the catalog." />
        </ScrollView>
      </View>
    );
  }

  const product = state.product;
  const originalUri = imageUrl(product.imageUrl);
  const tryOnUri = tryOnImageUrl(tryOn);
  const tryOnVideoUri = tryOnVideoUrl(tryOn);
  const mediaItems = [
    tryOnVideoUri ? { key: 'video', label: 'Video Try-On', type: 'video', uri: tryOnVideoUri } : null,
    tryOnUri ? { key: 'tryon', label: 'AI Try-On', source: { uri: tryOnUri }, uri: tryOnUri } : null,
    { key: 'original', label: 'Original Product', source: originalUri ? { uri: originalUri } : null, uri: originalUri, product }
  ].filter(Boolean);
  const detailTags = [
    titleCase(product.category || ''),
    product.fit || '',
    titleCase(product.gender || '')
  ].filter(Boolean).slice(0, 3);
  const colorLabel = product.colors?.[0]?.name ? product.colors[0].name.toString().toUpperCase() : '';
  const sizeOptions = product.sizes?.length ? product.sizes : [];
  const detailRows = ['PRODUCT DETAILS', 'FIT & CARE', 'SHIPPING & RETURNS'];
  const mediaHeight = Math.min(520, Math.max(360, Math.round((width - 28) * 1.31)));
  const openShop = () => {
    if (!user) {
      onRequireAuth?.('Log in with your mobile number to shop this brand.');
      return;
    }
    if (product.affiliateLink) openExternalWebUrl(product.affiliateLink);
    else onNavigate('shop');
  };

  return (
    <View style={styles.productDetailScreen}>
      <ProductTopBar onNavigate={onNavigate} user={user} />
      <ScrollView contentContainerStyle={styles.productDetailContent} {...screenScrollProps}>
      <View style={[styles.productHeroMedia, { height: mediaHeight, width: mediaWidth }]}>
        <ScrollView ref={mediaScrollRef} {...horizontalScrollProps} pagingEnabled contentContainerStyle={styles.productMediaTrack}>
          {mediaItems.map((item, index) => (
            <Pressable key={item.key} style={[styles.productMediaSlide, { width: mediaWidth }]} onPress={() => item.type !== 'video' && item.uri && setLightbox(item.uri)}>
              {item.type === 'video' ? (
                <TryOnVideoPlayer uri={item.uri} style={styles.productHeroVideo} nativeControls />
              ) : item.source ? (
                <Image source={item.source} style={styles.productHeroImage} resizeMode="contain" />
              ) : (
                <ProductImage product={item.product} style={styles.productHeroImage} resizeMode="contain" alt={product.title} />
              )}
              <Text style={styles.productMediaBadge}>{item.label}</Text>
              {mediaItems.length > 1 ? <Text style={styles.productMediaCount}>{index + 1}/{mediaItems.length}</Text> : null}
            </Pressable>
          ))}
        </ScrollView>
        <TouchableOpacity style={styles.productFavoriteButton}>
          <Ionicons name="heart-outline" size={24} color="#5d5754" />
        </TouchableOpacity>
        {mediaItems.length > 1 ? (
          <View style={styles.productSwipeHint}>
            <Ionicons name="swap-horizontal-outline" size={14} color="#111111" />
            <Text style={styles.productSwipeText}>Slide to compare</Text>
          </View>
        ) : null}
        {tryOnLoading || tryOnVideoLoading ? <TryOnLoading text={tryOnVideoLoading ? 'Generating video' : 'Generating try-on'} large /> : null}
      </View>

      <View style={styles.productSummary}>
        <View style={styles.productSummaryTop}>
          <View style={styles.productSummaryTitleBlock}>
            <Text style={styles.productBrandLabel}>{product.displayLabel || titleCase(product.category || 'Catalog')}</Text>
            <Text style={styles.productNameText}>{product.title || product.name}</Text>
          </View>
          <View style={styles.productPriceBlock}>
            <Text style={styles.productDetailPrice}>{Number.isFinite(Number(product.price)) ? formatMoney(Number(product.price), product.currency) : 'Price unavailable'}</Text>
            {product.rating ? (
              <View style={styles.productRatingLine}>
                <Ionicons name="star" size={12} color="#9b5658" />
                <Text style={styles.productRatingText}>{Number(product.rating).toFixed(1)} {product.ratingCount ? `(${product.ratingCount})` : ''}</Text>
              </View>
            ) : null}
          </View>
        </View>
        <View style={styles.productTagRow}>
          {detailTags.map((tag) => <Text key={tag} style={styles.productSoftTag}>{tag}</Text>)}
        </View>
        {product.category ? (
          <TouchableOpacity style={styles.productCategoryMeta} activeOpacity={0.76} onPress={() => onNavigate('shop', { category: product.category })}>
            <Ionicons name="pricetag-outline" size={13} color="#8c817c" />
            <Text style={styles.productCategoryMetaLabel}>Category</Text>
            <Text style={styles.productCategoryMetaValue}>{titleCase(product.category)}</Text>
          </TouchableOpacity>
        ) : null}

        {colorLabel ? (
          <>
            <Text style={styles.productOptionLabel}>COLOR: <Text style={styles.productOptionValue}>{colorLabel}</Text></Text>
            <View style={styles.productSwatchRow}>
              {product.colors.slice(0, 6).map((color, index) => <View key={color.name} style={[styles.productColorSwatch, index === 0 && styles.productColorSwatchActive, { backgroundColor: color.value }]} />)}
            </View>
          </>
        ) : null}

        {sizeOptions.length ? (
          <>
            <View style={styles.productSizeHead}>
              <Text style={styles.productOptionLabel}>SELECT SIZE</Text>
              <TouchableOpacity><Text style={styles.productSizeGuide}>Size Guide</Text></TouchableOpacity>
            </View>
            <View style={styles.productSizeRow}>
              {sizeOptions.map((size) => (
                <TouchableOpacity key={size} style={[styles.productSizeButton, selectedSize === size && styles.productSizeButtonActive]} onPress={() => setSelectedSize(size)}>
                  <Text style={[styles.productSizeText, selectedSize === size && styles.productSizeTextActive]}>{size}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </>
        ) : null}

        <View style={styles.productActionRow}>
          <ProductActionButton label="Shop" icon="bag-handle-outline" active onPress={openShop} />
          <ProductActionButton
            label={tryOnLoading ? 'Trying...' : tryOn?.imageUrl ? 'Again' : 'Try On'}
            icon="sparkles-outline"
            disabled={tryOnLoading}
            onPress={generate}
          />
          <ProductActionButton
            label={tryOnVideoLoading ? 'Video...' : tryOn?.videoUrl ? 'New Video' : 'Video'}
            icon="play-circle-outline"
            disabled={tryOnLoading || tryOnVideoLoading || !tryOn?.imageUrl}
            onPress={generateVideo}
          />
        </View>
        {tryOn?.imageUrl || tryOn?.videoUrl ? <AiPreviewNote /> : null}
        {tryOnError ? <Text style={styles.errorText}>{tryOnError}</Text> : null}
        {tryOnVideoError ? <Text style={styles.errorText}>{tryOnVideoError}</Text> : null}
      </View>

      <View style={styles.productAccordion}>
        {detailRows.map((row) => (
          <TouchableOpacity key={row} style={styles.productAccordionRow}>
            <Text style={styles.productAccordionText}>{row}</Text>
            <Ionicons name="add" size={17} color="#4f4a48" />
          </TouchableOpacity>
        ))}
      </View>

      <View style={styles.productStorySection}>
        <Text style={styles.productStoryTitle}>Product Notes</Text>
        <Text style={styles.productStoryText}>
          {product.description || 'No additional product description is available yet.'}
        </Text>
        <ProductImage product={product} style={styles.productStoryImage} resizeMode="cover" alt={product.title} />
      </View>

      <View style={styles.completeLookSection}>
        <View style={styles.completeLookHead}>
          <Text style={styles.completeLookTitle}>Complete the Look</Text>
          <TouchableOpacity onPress={() => onNavigate('shop', { category: product.category })}>
            <Text style={styles.completeLookAll}>SHOP ALL</Text>
          </TouchableOpacity>
        </View>
        <View style={styles.completeLookGrid}>
          {relatedProducts.length ? relatedProducts.slice(0, 2).map((item) => {
            return (
              <CompleteLookCard
                key={item.id}
                product={item}
                onPress={() => onNavigate('product', { id: item.id })}
                onAddToWishlist={onAddToWishlist}
                isWishlisted={wishlistIds?.has(item.id)}
              />
            );
          }) : <StatusPanel empty text="No related products found yet." />}
        </View>
      </View>
      </ScrollView>
      <ImageLightbox uri={lightbox} onClose={() => setLightbox(null)} />
    </View>
  );
}

const phoneAuthPerks = [
  { label: 'Try-on', icon: 'sparkles-outline' },
  { label: 'Wishlist', icon: 'heart-outline' },
  { label: 'Wardrobe', icon: 'shirt-outline' }
];

function AuthPasswordField({ value, onChangeText, placeholder, visible, onToggle, fieldHeight, autoComplete = 'password' }) {
  return (
    <View style={[styles.loginInputWrap, { minHeight: fieldHeight }]}>
      <Ionicons name="lock-closed-outline" size={23} color="#555a5d" />
      <TextInput
        style={styles.loginInput}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor="#6f7687"
        secureTextEntry={!visible}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete={autoComplete}
        textContentType={autoComplete === 'new-password' ? 'newPassword' : 'password'}
      />
      <TouchableOpacity style={styles.passwordVisibilityButton} activeOpacity={0.72} onPress={onToggle}>
        <Ionicons name={visible ? 'eye-off-outline' : 'eye-outline'} size={21} color="#5d5754" />
      </TouchableOpacity>
    </View>
  );
}

function AuthScreen({ mode, setUser, setToken, onNavigate }) {
  const isSignup = mode === 'signup';
  const { width, height } = useWindowDimensions();
  const [phone, setPhone] = useState('');
  const [otp, setOtp] = useState('');
  const [otpSent, setOtpSent] = useState(false);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [signupStage, setSignupStage] = useState('otp');
  const [signupToken, setSignupToken] = useState('');
  const [resetStage, setResetStage] = useState('idle');
  const [resetToken, setResetToken] = useState('');
  const [detailName, setDetailName] = useState('');
  const [detailGender, setDetailGender] = useState('');
  const [detailPhoto, setDetailPhoto] = useState(null);
  const authScreenPadding = clamp(width * 0.064, 20, 30);
  const titleSize = clamp(width * 0.082, 31, 38);
  const fieldHeight = clamp(height * 0.052, 54, 60);
  const authEditorialHeight = clamp(height * 0.17, 118, 158);
  const phoneValue = normalizePhoneInput(phone);
  const completingSignup = isSignup && signupStage === 'details';
  const resetOtpStage = !isSignup && resetStage === 'otp';
  const resetPasswordStage = !isSignup && resetStage === 'password';
  const baseLoginStage = !isSignup && resetStage === 'idle';

  useEffect(() => {
    setOtp('');
    setOtpSent(false);
    setPassword('');
    setConfirmPassword('');
    setShowPassword(false);
    setShowConfirmPassword(false);
    setMessage('');
    setSignupStage('otp');
    setSignupToken('');
    setResetStage('idle');
    setResetToken('');
  }, [mode]);

  const finishAuthenticated = async (data) => {
    await saveToken(data.token);
    setToken(data.token);
    setUser(data.user);
    onNavigate('home');
  };

  const sendSignupOtp = async () => {
    if (phoneValue.length !== 10) {
      setMessage('Enter a valid 10 digit mobile number.');
      return;
    }
    setLoading(true);
    setMessage('Sending OTP...');
    try {
      const data = await api('/auth/otp/send', {
        method: 'POST',
        body: JSON.stringify({ phone: phoneValue, purpose: 'signup' })
      });
      setOtp('');
      setOtpSent(true);
      setMessage(data.message ? `${data.message}. Enter the code from SMS.` : 'OTP sent. Enter the code from SMS.');
    } catch (error) {
      setMessage(error.message);
    } finally {
      setLoading(false);
    }
  };

  const verifySignupOtp = async () => {
    const cleanOtp = normalizeOtpInput(otp);
    if (phoneValue.length !== 10 || !cleanOtp) {
      setMessage('Enter your mobile number and OTP.');
      return;
    }
    setLoading(true);
    setMessage('Verifying OTP...');
    try {
      const data = await api('/auth/otp/verify', {
        method: 'POST',
        body: JSON.stringify({ phone: phoneValue, otp: cleanOtp, purpose: 'signup' })
      });
      setSignupToken(data.signupToken || '');
      setDetailName('');
      setDetailGender('');
      setDetailPhoto(null);
      setPassword('');
      setConfirmPassword('');
      setSignupStage('details');
      setMessage('');
    } catch (error) {
      setMessage(error.message);
    } finally {
      setLoading(false);
    }
  };

  const loginWithPassword = async () => {
    if (phoneValue.length !== 10) {
      setMessage('Enter a valid 10 digit mobile number.');
      return;
    }
    if (!password) {
      setMessage('Enter your password.');
      return;
    }
    setLoading(true);
    setMessage('Logging in...');
    try {
      const data = await api('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ phone: phoneValue, password })
      });
      await finishAuthenticated(data);
    } catch (error) {
      setMessage(error.message);
    } finally {
      setLoading(false);
    }
  };

  const startPasswordReset = async () => {
    if (phoneValue.length !== 10) {
      setMessage('Enter your mobile number first.');
      return;
    }
    setLoading(true);
    setMessage('Sending reset OTP...');
    try {
      const data = await api('/auth/otp/send', {
        method: 'POST',
        body: JSON.stringify({ phone: phoneValue, purpose: 'password-reset' })
      });
      setOtp('');
      setOtpSent(true);
      setResetStage('otp');
      setMessage(data.message ? `${data.message}. Enter the code from SMS.` : 'OTP sent. Enter the code from SMS.');
    } catch (error) {
      setMessage(error.message);
    } finally {
      setLoading(false);
    }
  };

  const verifyPasswordResetOtp = async () => {
    const cleanOtp = normalizeOtpInput(otp);
    if (phoneValue.length !== 10 || !cleanOtp) {
      setMessage('Enter your mobile number and OTP.');
      return;
    }
    setLoading(true);
    setMessage('Verifying OTP...');
    try {
      const data = await api('/auth/otp/verify', {
        method: 'POST',
        body: JSON.stringify({ phone: phoneValue, otp: cleanOtp, purpose: 'password-reset' })
      });
      setResetToken(data.resetToken || '');
      setResetStage('password');
      setOtp('');
      setOtpSent(false);
      setPassword('');
      setConfirmPassword('');
      setMessage('');
    } catch (error) {
      setMessage(error.message);
    } finally {
      setLoading(false);
    }
  };

  const completePasswordReset = async () => {
    const passwordError = passwordValidationMessage(password);
    if (passwordError) {
      setMessage(passwordError);
      return;
    }
    if (password !== confirmPassword) {
      setMessage('Passwords do not match.');
      return;
    }
    if (!resetToken) {
      setMessage('Verify the OTP before setting a new password.');
      setResetStage('otp');
      return;
    }
    setLoading(true);
    setMessage('Saving password...');
    try {
      const data = await api('/auth/password/reset', {
        method: 'POST',
        body: JSON.stringify({ resetToken, password, confirmPassword }),
        timeoutMs: 60000
      });
      await finishAuthenticated(data);
    } catch (error) {
      setMessage(error.message);
    } finally {
      setLoading(false);
    }
  };

  const changeSignupMobile = () => {
    setOtpSent(false);
    setOtp('');
    setSignupToken('');
    setMessage('');
  };

  const returnToLogin = () => {
    setResetStage('idle');
    setResetToken('');
    setOtp('');
    setOtpSent(false);
    setPassword('');
    setConfirmPassword('');
    setMessage('');
  };

  const exitSignupDetails = async () => {
    await clearToken();
    setSignupToken('');
    setSignupStage('otp');
    setPassword('');
    setConfirmPassword('');
    setMessage('');
    onNavigate('home');
  };

  const pickDetailPhoto = async () => {
    const asset = await pickImage();
    if (asset?.uri) setDetailPhoto(asset);
  };

  const completeSignupDetails = async () => {
    const cleanName = detailName.trim().replace(/\s+/g, ' ');
    if (cleanName.length < 2) {
      setMessage('Enter your full name.');
      return;
    }
    if (!detailGender) {
      setMessage('Choose your gender preference.');
      return;
    }
    if (!detailPhoto?.uri) {
      setMessage('Upload a profile photo.');
      return;
    }
    const passwordError = passwordValidationMessage(password);
    if (passwordError) {
      setMessage(passwordError);
      return;
    }
    if (password !== confirmPassword) {
      setMessage('Passwords do not match.');
      return;
    }

    setLoading(true);
    setMessage('Saving your profile...');
    try {
      const form = new FormData();
      form.append('signupToken', signupToken);
      form.append('name', cleanName);
      form.append('genderPreference', detailGender);
      form.append('password', password);
      form.append('confirmPassword', confirmPassword);
      form.append('requireBodyPhoto', 'true');
      form.append('profilePhotoMode', 'ai-full-body');
      form.append('bodyPhoto', filePart(detailPhoto, 'body-photo.jpg'));
      const data = await api('/auth/signup/complete', { method: 'POST', body: form, timeoutMs: 60000 });
      const nextUser = data.user;
      if (nextUser) {
        try {
          await AsyncStorage.setItem(onboardingPendingStorageKey, onboardingSeenStorageKey(nextUser));
        } catch {
          // Onboarding is optional; profile completion should keep moving.
        }
      }
      await finishAuthenticated(data);
      setSignupToken('');
      setSignupStage('otp');
      setMessage('');
    } catch (error) {
      setMessage(isMissingRouteError(error.message) ? 'Profile setup is not active on the running backend. Restart the backend, then try again.' : error.message);
    } finally {
      setLoading(false);
    }
  };

  const submit = isSignup
    ? (otpSent ? verifySignupOtp : sendSignupOtp)
    : resetOtpStage
      ? verifyPasswordResetOtp
      : resetPasswordStage
        ? completePasswordReset
        : loginWithPassword;
  const actionLabel = isSignup
    ? (otpSent ? 'Verify & Continue' : 'Continue')
    : resetOtpStage
      ? 'Verify OTP'
      : resetPasswordStage
        ? 'Save Password'
        : 'Login';
  const authTitle = isSignup
    ? 'Create Account'
    : resetOtpStage
      ? 'Reset Password'
      : resetPasswordStage
        ? 'Set New Password'
        : 'Welcome Back';
  const authSubtitle = isSignup
    ? 'Verify your mobile number once, then set a password for future logins.'
    : resetOtpStage
      ? 'Enter the OTP sent to your mobile number.'
      : resetPasswordStage
        ? 'Choose a password you will use with your mobile number.'
        : 'Log in with your mobile number and password.';
  const authIcon = isSignup ? 'phone-portrait-outline' : resetStage === 'idle' ? 'lock-closed-outline' : 'keypad-outline';

  if (completingSignup) {
    const genderOptions = [
      ['male', 'Male', 'man-outline'],
      ['female', 'Female', 'woman-outline'],
      ['other', 'Other', 'accessibility-outline']
    ];

    return (
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.loginScreen}>
        <ScrollView
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          contentContainerStyle={[styles.phoneAuthContent, { paddingHorizontal: authScreenPadding, paddingTop: clamp(height * 0.06, 46, 72) }]}
          {...screenScrollProps}
        >
          <View style={styles.phoneAuthTopRow}>
            <TouchableOpacity style={styles.phoneAuthClose} activeOpacity={0.78} onPress={exitSignupDetails}>
              <Ionicons name="close" size={20} color="#2b2321" />
            </TouchableOpacity>
          </View>

          <View style={styles.signupDetailsCard}>
            <View style={styles.phoneAuthIcon}>
              <Ionicons name="person-add-outline" size={26} color="#9b5658" />
            </View>
            <Text style={[styles.loginTitle, { fontSize: titleSize * 0.86, lineHeight: titleSize }]}>Complete your profile</Text>
            <Text style={styles.phoneAuthSubtitle}>Add your details and set the password you will use for future mobile login.</Text>

            <View style={styles.signupDetailsFieldStack}>
              <View style={[styles.loginInputWrap, { minHeight: fieldHeight }]}>
                <Ionicons name="person-outline" size={23} color="#555a5d" />
                <TextInput
                  style={styles.loginInput}
                  value={detailName}
                  onChangeText={setDetailName}
                  placeholder="Full name"
                  placeholderTextColor="#6f7687"
                  autoCapitalize="words"
                  autoComplete="name"
                />
              </View>

              <View>
                <Text style={styles.signupDetailsLabel}>Gender preference</Text>
                <View style={styles.signupDetailsGenderRow}>
                  {genderOptions.map(([value, label, icon]) => {
                    const active = detailGender === value;
                    return (
                      <TouchableOpacity key={value} style={[styles.signupDetailsGenderButton, active && styles.signupDetailsGenderButtonActive]} activeOpacity={0.84} onPress={() => setDetailGender(value)}>
                        <Ionicons name={icon} size={18} color={active ? '#ffffff' : '#5d5754'} />
                        <Text style={[styles.signupDetailsGenderText, active && styles.signupDetailsGenderTextActive]}>{label}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>

              <AuthPasswordField
                value={password}
                onChangeText={setPassword}
                placeholder="Create password"
                visible={showPassword}
                onToggle={() => setShowPassword((value) => !value)}
                fieldHeight={fieldHeight}
                autoComplete="new-password"
              />

              <AuthPasswordField
                value={confirmPassword}
                onChangeText={setConfirmPassword}
                placeholder="Confirm password"
                visible={showConfirmPassword}
                onToggle={() => setShowConfirmPassword((value) => !value)}
                fieldHeight={fieldHeight}
                autoComplete="new-password"
              />

              <TouchableOpacity style={styles.signupDetailsUploadBox} activeOpacity={0.84} onPress={pickDetailPhoto}>
                {detailPhoto?.uri ? (
                  <>
                    <Image source={{ uri: detailPhoto.uri }} style={styles.signupDetailsUploadImage} resizeMode="cover" />
                    <View style={styles.signupDetailsUploadOverlay}>
                      <Ionicons name="camera-outline" size={18} color="#ffffff" />
                      <Text style={styles.signupDetailsUploadOverlayText}>Change photo</Text>
                    </View>
                  </>
                ) : (
                  <View style={styles.signupDetailsUploadCopy}>
                    <View style={styles.signupDetailsUploadIcon}>
                      <Ionicons name="cloud-upload-outline" size={27} color="#9b5658" />
                    </View>
                    <Text style={styles.signupDetailsUploadTitle}>Upload profile photo</Text>
                    <Text style={styles.signupDetailsUploadText}>Tap or drag and drop a clear standing photo for try-on previews.</Text>
                  </View>
                )}
              </TouchableOpacity>
            </View>

            <TouchableOpacity style={[styles.loginSubmit, loading && styles.signupSubmitDisabled]} activeOpacity={0.88} disabled={loading} onPress={completeSignupDetails}>
              {loading ? <ActivityIndicator size="small" color="#ffffff" /> : null}
              <Text style={styles.loginSubmitText}>{loading ? 'Saving profile' : 'Finish Signup'}</Text>
              {!loading ? <Ionicons name="arrow-forward" size={22} color="#ffffff" /> : null}
            </TouchableOpacity>

            <Text style={styles.signupDetailsLegalText}>
              By signing up, you agree to Lookmefy's{' '}
              <Text style={styles.signupDetailsLegalLink} onPress={() => Alert.alert('Terms & Conditions', 'Lookmefy uses your account, credits, shopping activity, and AI try-on tools to provide the service.')}>Terms & Conditions</Text>
              {' '}and{' '}
              <Text style={styles.signupDetailsLegalLink} onPress={() => Alert.alert('Privacy Policy', 'Your profile photo and generated try-on assets are handled as personal styling data for your Lookmefy account.')}>Privacy Policy</Text>
              .
            </Text>

            {message ? <Text style={[styles.formMessage, styles.signupMessage, /saving/i.test(message) ? styles.phoneAuthMessage : styles.errorText]}>{message}</Text> : null}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    );
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.loginScreen}>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[styles.phoneAuthContent, { paddingHorizontal: authScreenPadding, paddingTop: clamp(height * 0.065, 46, 70) }]}
        {...screenScrollProps}
      >
        <View style={styles.phoneAuthTopRow}>
          <TouchableOpacity style={styles.phoneAuthClose} activeOpacity={0.78} onPress={() => onNavigate('home')}>
            <Ionicons name="close" size={20} color="#2b2321" />
          </TouchableOpacity>
        </View>

        <View style={styles.phoneAuthCard}>
          <View style={styles.phoneAuthIcon}>
            <Ionicons name={authIcon} size={26} color="#9b5658" />
          </View>
          <Text style={[styles.loginTitle, { fontSize: titleSize, lineHeight: titleSize * 1.18 }]}>
            {authTitle}
          </Text>
          <Text style={styles.phoneAuthSubtitle}>{authSubtitle}</Text>

          <View style={styles.phoneAuthFieldStack}>
            <View style={[styles.loginInputWrap, { minHeight: fieldHeight }]}>
              <Ionicons name="call-outline" size={23} color="#555a5d" />
              <TextInput
                style={styles.loginInput}
                value={phone}
                onChangeText={(value) => setPhone(normalizePhoneInput(value))}
                placeholder="Mobile number"
                placeholderTextColor="#6f7687"
                keyboardType="phone-pad"
                autoComplete="tel"
                maxLength={10}
                editable={!loading && !resetPasswordStage}
              />
            </View>

            {baseLoginStage ? (
              <AuthPasswordField
                value={password}
                onChangeText={setPassword}
                placeholder="Password"
                visible={showPassword}
                onToggle={() => setShowPassword((value) => !value)}
                fieldHeight={fieldHeight}
              />
            ) : null}

            {(isSignup && otpSent) || resetOtpStage ? (
              <View style={styles.phoneAuthOtpBlock}>
                <View style={[styles.loginInputWrap, { minHeight: fieldHeight }]}>
                  <Ionicons name="keypad-outline" size={23} color="#555a5d" />
                  <TextInput
                    style={styles.loginInput}
                    value={otp}
                    onChangeText={(value) => setOtp(normalizeOtpInput(value))}
                    placeholder="Enter OTP"
                    placeholderTextColor="#6f7687"
                    keyboardType="number-pad"
                    autoComplete="one-time-code"
                    maxLength={8}
                  />
                </View>
              </View>
            ) : null}

            {resetPasswordStage ? (
              <>
                <AuthPasswordField
                  value={password}
                  onChangeText={setPassword}
                  placeholder="New password"
                  visible={showPassword}
                  onToggle={() => setShowPassword((value) => !value)}
                  fieldHeight={fieldHeight}
                  autoComplete="new-password"
                />
                <AuthPasswordField
                  value={confirmPassword}
                  onChangeText={setConfirmPassword}
                  placeholder="Confirm new password"
                  visible={showConfirmPassword}
                  onToggle={() => setShowConfirmPassword((value) => !value)}
                  fieldHeight={fieldHeight}
                  autoComplete="new-password"
                />
              </>
            ) : null}
          </View>

          <TouchableOpacity style={[styles.loginSubmit, loading && styles.signupSubmitDisabled]} activeOpacity={0.88} disabled={loading} onPress={submit}>
            {loading ? <ActivityIndicator size="small" color="#ffffff" /> : null}
            <Text style={styles.loginSubmitText}>{loading ? 'Please wait' : actionLabel}</Text>
            {!loading ? <Ionicons name="arrow-forward" size={22} color="#ffffff" /> : null}
          </TouchableOpacity>

          {isSignup && otpSent ? (
            <TouchableOpacity style={styles.phoneAuthTextButton} activeOpacity={0.75} onPress={changeSignupMobile}>
              <Ionicons name="call-outline" size={17} color="#2b2321" />
              <Text style={styles.phoneAuthTextButtonLabel}>Change mobile number</Text>
            </TouchableOpacity>
          ) : null}

          {baseLoginStage ? (
            <TouchableOpacity style={styles.phoneAuthTextButton} activeOpacity={0.75} onPress={startPasswordReset}>
              <Ionicons name="refresh-outline" size={17} color="#2b2321" />
              <Text style={styles.phoneAuthTextButtonLabel}>Set or reset password</Text>
            </TouchableOpacity>
          ) : null}

          {!isSignup && resetStage !== 'idle' ? (
            <TouchableOpacity style={styles.phoneAuthTextButton} activeOpacity={0.75} onPress={returnToLogin}>
              <Ionicons name="arrow-back" size={17} color="#2b2321" />
              <Text style={styles.phoneAuthTextButtonLabel}>Back to login</Text>
            </TouchableOpacity>
          ) : null}

          {message ? <Text style={[styles.formMessage, styles.signupMessage, /sent|Verifying|Sending|Preparing|Logging|Saving/i.test(message) ? styles.phoneAuthMessage : styles.errorText]}>{message}</Text> : null}

          <View style={styles.authModeSwitch}>
            <Text style={styles.authModeSwitchText}>{isSignup ? 'Already have an account?' : 'New to Lookmefy?'}</Text>
            <TouchableOpacity activeOpacity={0.75} onPress={() => onNavigate(isSignup ? 'login' : 'signup')}>
              <Text style={styles.authModeSwitchLink}>{isSignup ? 'Log in' : 'Create account'}</Text>
            </TouchableOpacity>
          </View>
        </View>

        <View style={styles.phoneAuthEditorial}>
          <View style={[styles.phoneAuthEditorialImageFrame, { height: authEditorialHeight }]}>
            <Image source={images.homeSliderAtelier} style={styles.phoneAuthEditorialImage} resizeMode="cover" />
            <View style={styles.phoneAuthEditorialShade} />
            <View style={styles.phoneAuthEditorialBadge}>
              <Ionicons name="sparkles-outline" size={15} color="#111111" />
              <Text style={styles.phoneAuthEditorialBadgeText}>Styled profile</Text>
            </View>
          </View>
          <Text style={styles.phoneAuthEditorialTitle}>Save looks, generate try-ons, and keep your wardrobe in one place.</Text>
          <View style={styles.phoneAuthPerkRow}>
            {phoneAuthPerks.map((item) => (
              <View key={item.label} style={styles.phoneAuthPerk}>
                <Ionicons name={item.icon} size={15} color="#2b2321" />
                <Text style={styles.phoneAuthPerkText}>{item.label}</Text>
              </View>
            ))}
          </View>
        </View>

        <TouchableOpacity style={styles.phoneAuthBrowseButton} activeOpacity={0.75} onPress={() => onNavigate('home')}>
          <Text style={styles.phoneAuthBrowseText}>Continue browsing products</Text>
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const authEntryFeatures = ['Virtual AI Try-On', 'Smart Digital Closet', 'AI Studio Fashion Search'];
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function AuthEntryScreen({ onNavigate }) {
  const { width, height } = useWindowDimensions();
  const compact = height < 720 || width < 360;
  const framePaddingX = clamp(width * 0.068, 18, 32);
  const framePaddingTop = clamp(height * 0.025, 12, 28);
  const framePaddingBottom = clamp(height * 0.022, 12, 24);
  const logoSize = clamp(width * 0.168, 50, 70);
  const taglineSize = clamp(width * 0.05, 15, 21);
  const taglineSpace = clamp(width * 0.01, 2.4, 4);
  const featureHeight = clamp(height * 0.104, 70, 92);
  const featureGap = clamp(height * 0.027, 14, 28);
  const featurePaddingX = clamp(width * 0.08, 18, 33);
  const featureIconSize = clamp(width * 0.072, 24, 30);
  const featureTextSize = clamp(width * 0.056, 18, 22);
  const ctaHeight = clamp(height * 0.085, 62, 78);
  const ctaFontSize = clamp(width * 0.052, 17, 20);
  const exploreFontSize = clamp(width * 0.055, 18, 22);
  const exploreLetterSpacing = clamp(width * 0.012, 3, 5);
  const indicatorWidth = clamp(width * 0.16, 48, 66);
  const backgroundScale = width < 360 ? 1.1 : 1.05;

  return (
    <ScrollView
      style={styles.authEntryScroll}
      contentContainerStyle={[
        styles.authEntryContent,
        {
          paddingHorizontal: framePaddingX,
          paddingTop: framePaddingTop,
          paddingBottom: framePaddingBottom
        }
      ]}
      showsVerticalScrollIndicator={false}
      {...screenScrollProps}
    >
      <Image source={images.hero} style={[styles.authEntryBackground, { transform: [{ scale: backgroundScale }] }]} resizeMode="cover" />
      <View style={styles.authEntryImageWash} />
      <View style={styles.authEntryShadow} />

      <View style={[styles.authEntryMain, compact && styles.authEntryMainCompact]}>
        <View style={styles.authEntryBrand}>
          <BrandLogo
            light
            style={styles.authEntryLogoMark}
            symbolStyle={{ width: logoSize * 0.9, height: logoSize * 0.9 }}
            dividerStyle={{ height: logoSize * 0.72 }}
            textStyle={{ fontSize: logoSize * 0.72, lineHeight: logoSize * 0.86 }}
          />
          <Text style={[styles.authEntryTagline, { fontSize: taglineSize, lineHeight: taglineSize * 1.48, letterSpacing: taglineSpace }]}>AI-POWERED FASHION</Text>
          <Text style={[styles.authEntryTagline, { fontSize: taglineSize, lineHeight: taglineSize * 1.48, letterSpacing: taglineSpace }]}>EXPERIENCE</Text>
        </View>

        <View style={[styles.authEntryFeatureList, { gap: featureGap }]}>
          {authEntryFeatures.map((feature) => (
            <View key={feature} style={[styles.authEntryFeature, { minHeight: featureHeight, paddingHorizontal: featurePaddingX, gap: clamp(width * 0.065, 16, 32) }]}>
              <View style={[styles.authEntryCheck, { width: featureIconSize, height: featureIconSize, borderRadius: featureIconSize / 2 }]}>
                <Ionicons name="checkmark" size={featureIconSize * 0.68} color="#6f3e36" />
              </View>
              <Text style={[styles.authEntryFeatureText, { fontSize: featureTextSize, lineHeight: featureTextSize * 1.25 }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.84}>
                {feature}
              </Text>
            </View>
          ))}
        </View>

        <TouchableOpacity style={[styles.authEntryCta, { minHeight: ctaHeight, borderRadius: ctaHeight / 2 }]} activeOpacity={0.88} onPress={() => onNavigate('signup')}>
          <Text style={[styles.authEntryCtaText, { fontSize: ctaFontSize }]}>GET STARTED</Text>
          <Ionicons name="arrow-forward" size={ctaFontSize + 1} color="#151515" />
        </TouchableOpacity>

        <TouchableOpacity style={styles.authEntryExplore} activeOpacity={0.75} onPress={() => onNavigate('home')}>
          <Text style={[styles.authEntryExploreText, { fontSize: exploreFontSize, lineHeight: exploreFontSize * 1.28, letterSpacing: exploreLetterSpacing }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.78}>
            EXPLORE LOOKMEFY
          </Text>
        </TouchableOpacity>

        <View style={[styles.authEntryHomeIndicator, { width: indicatorWidth }]} />
      </View>
    </ScrollView>
  );
}

const closetCategories = ['tops', 'bottoms', 'dresses', 'suits', 'outerwear', 'shoes', 'accessories', 'activewear', 'ethnic', 'other'];
const closetOccasions = ['today casual', 'office meeting', 'date night', 'party', 'wedding function', 'college day', 'travel', 'rainy weather'];
const closetSceneOptions = {
  backdrop: ['neutral studio', 'office lobby', 'cafe', 'outdoor street', 'wedding venue'],
  pose: ['front facing', 'relaxed standing', 'walking pose', 'three-quarter angle'],
  lighting: ['natural light', 'studio softbox', 'evening warm', 'bright daylight']
};
const closetComboSlots = [
  { key: 'topwear', label: 'Topwear', helper: 'Shirts, tops, kurtas', short: 'To', categories: ['tops', 'outerwear', 'ethnic'] },
  { key: 'bottomwear', label: 'Bottomwear', helper: 'Pants, denim, skirts', short: 'Bo', categories: ['bottoms'] },
  { key: 'goggles', label: 'Goggles', helper: 'Glasses and shades', short: 'Go', categories: ['accessories'], keywords: ['goggle', 'goggles', 'glass', 'glasses', 'sunglass', 'eyewear'] },
  { key: 'cap', label: 'Cap', helper: 'Caps and hats', short: 'Ca', categories: ['accessories'], keywords: ['cap', 'hat'] },
  { key: 'footwear', label: 'Footwear', helper: 'Shoes, boots, sandals', short: 'Fo', categories: ['shoes'] }
];
const wardrobeCategoryTabs = [
  { key: 'tops', label: 'Tops', icon: 'shirt-outline', slot: 'topwear' },
  { key: 'bottoms', label: 'Bottoms', icon: 'accessibility-outline', slot: 'bottomwear' },
  { key: 'outerwear', label: 'Outerwear', icon: 'body-outline', slot: 'topwear' },
  { key: 'shoes', label: 'Shoes', icon: 'walk-outline', slot: 'footwear' },
  { key: 'accessories', label: 'Accessori', icon: 'sparkles-outline', slot: 'goggles' }
];
const wardrobeFallbackRecommendations = [
  { title: 'Urban Sophisticate', images: ['trending-2.jpg', 'category-3.jpg', 'category-6.jpg'] },
  { title: 'Neutral Casual', images: ['arrival-1.jpg', 'arrival-2.jpg', 'category-8.jpg'] },
  { title: 'Soft Gallery Fit', images: ['arrival-4.jpg', 'category-4.jpg', 'category-6.jpg'] }
];

function WardrobeTopBar({ user, onNavigate }) {
  return <AppHeader onNavigate={onNavigate} user={user} compact />;
}

function WardrobeRecommendationCard({ suggestion, fallback, onPress }) {
  const suggestionItems = suggestion?.items || [];
  const title = suggestion?.title || fallback.title;
  const fallbackSources = fallback.images.map((image) => images[image] || images.hero);
  const thumbnails = suggestionItems.length
    ? suggestionItems.slice(0, 3).map((item, index) => ({
        key: item.id,
        source: item.imageUrl ? { uri: imageUrl(item.imageUrl) } : fallbackSources[index] || images.hero,
        fallbackSource: fallbackSources[index] || images.hero
      }))
    : fallbackSources.map((source, index) => ({ key: fallback.images[index], source, fallbackSource: images.hero }));

  return (
    <TouchableOpacity style={styles.wardrobeRecommendationCard} activeOpacity={0.86} onPress={onPress}>
      <View style={styles.wardrobeRecommendationImages}>
        {thumbnails.map((thumb) => (
          <ResilientImage
            key={thumb.key}
            source={thumb.source}
            fallbackSource={thumb.fallbackSource}
            style={styles.wardrobeRecommendationImage}
            resizeMode="cover"
            fallbackIcon="shirt-outline"
          />
        ))}
      </View>
      <View style={styles.wardrobeRecommendationFooter}>
        <Text style={styles.wardrobeRecommendationTitle} numberOfLines={1}>{title}</Text>
        <Ionicons name="chevron-forward" size={25} color="#111111" />
      </View>
    </TouchableOpacity>
  );
}

function slotMatchesItem(slot, item, strict = false) {
  if (!slot?.categories?.includes(item?.category)) return false;
  if (!slot.keywords?.length) return true;
  const text = [item.name, item.category, item.color, item.formality, ...(item.tags || []), ...(item.occasions || [])]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  const keywordMatch = slot.keywords.some((keyword) => text.includes(keyword));
  return strict ? keywordMatch : keywordMatch || slot.categories.includes(item.category);
}

function optionsForSlot(slot, items) {
  const exactOptions = items.filter((item) => slotMatchesItem(slot, item, true));
  return exactOptions.length ? exactOptions : items.filter((item) => slotMatchesItem(slot, item));
}

function ClosetDetectionCard({ detection, fields, compact = false }) {
  if (!detection) return null;
  const loading = detection.status === 'loading';
  const failed = detection.status === 'error';
  const ready = detection.status === 'ready';
  const title = loading ? 'Analyzing clothing photo' : failed ? 'Detection unavailable' : detection.source === 'vision' ? 'AI details detected' : 'Basic details detected';
  const detail = detection.message || (ready ? 'Review and edit before saving.' : 'Fill the fields manually.');

  return (
    <View style={[styles.itemDetectionCard, compact && styles.itemDetectionCardCompact, failed && styles.itemDetectionCardError]}>
      <View style={styles.itemDetectionHead}>
        <View style={[styles.itemDetectionIcon, failed && styles.itemDetectionIconError]}>
          {loading ? <ActivityIndicator size="small" color="#9b5658" /> : <Ionicons name={failed ? 'alert-circle-outline' : 'sparkles-outline'} size={18} color={failed ? '#b4232a' : '#9b5658'} />}
        </View>
        <View style={styles.itemDetectionCopy}>
          <Text style={styles.itemDetectionTitle}>{title}</Text>
          <Text style={styles.itemDetectionText}>{detail}</Text>
        </View>
      </View>
      {ready && fields?.length ? (
        <View style={styles.itemDetectionPills}>
          {fields.slice(0, 6).map(([label, value]) => (
            <View key={`${label}-${value}`} style={styles.itemDetectionPill}>
              <Text style={styles.itemDetectionPillText}>{label}: {value}</Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

function ClosetScreen({ user, setUser, setToken, token, onNavigate, initial = {}, registerTourTarget, tourFocusRequest }) {
  const { height } = useWindowDimensions();
  const addStudioScrollRef = useRef(null);
  const emptyCloset = { items: [], outfits: [], suggestions: [], stats: {} };
  const closet = useApiState('/closet', token, Boolean(user), emptyCloset);
  const [closetView, setClosetView] = useState(initial.view === 'add' ? 'add' : 'stylist');
  const [selectedIds, setSelectedIds] = useState([]);
  const [comboSlots, setComboSlots] = useState({});
  const [activeSlot, setActiveSlot] = useState('topwear');
  const [filter, setFilter] = useState('all');
  const [itemPhoto, setItemPhoto] = useState(null);
  const [itemName, setItemName] = useState('');
  const [itemCategory, setItemCategory] = useState(initial.view === 'add' ? 'dresses' : 'tops');
  const [itemColor, setItemColor] = useState('');
  const [itemFabric, setItemFabric] = useState('');
  const [itemPattern, setItemPattern] = useState('');
  const [itemSeason, setItemSeason] = useState(initial.view === 'add' ? 'summer' : 'all-season');
  const [itemFormality, setItemFormality] = useState('any');
  const [itemOccasions, setItemOccasions] = useState('');
  const [itemTags, setItemTags] = useState('');
  const [itemDetection, setItemDetection] = useState(null);
  const [occasion, setOccasion] = useState('today casual');
  const [weather, setWeather] = useState('');
  const [mood, setMood] = useState('');
  const [plannedFor, setPlannedFor] = useState(dateInputValue());
  const [backdrop, setBackdrop] = useState('neutral studio');
  const [pose, setPose] = useState('front facing');
  const [lighting, setLighting] = useState('natural light');
  const [stylistText, setStylistText] = useState('');
  const [chat, setChat] = useState([
    { role: 'assistant', text: 'Ask what to wear today, for an occasion, or which pants fit a shirt from your closet.' }
  ]);
  const [suggestionOverrides, setSuggestionOverrides] = useState(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState('');
  const [lightbox, setLightbox] = useState(null);
  const wardrobeUploadTourTarget = useTourTarget('wardrobe-upload', registerTourTarget, { request: tourFocusRequest, scrollRef: addStudioScrollRef, scrollOffset: 116 });

  useEffect(() => {
    if (initial.view === 'add') setClosetView('add');
    else setClosetView((current) => current === 'add' ? 'stylist' : current);
  }, [initial.view]);

  if (!user) return <AuthScreen mode="signup" setUser={setUser} setToken={setToken} onNavigate={onNavigate} />;

  const isAddStudio = initial.view === 'add' || closetView === 'add';

  const items = closet.data.items || [];
  const outfits = closet.data.outfits || [];
  const suggestions = suggestionOverrides || closet.data.suggestions || [];
  const latestOutfit = outfits[0];
  const selectedItems = selectedIds.map((id) => items.find((item) => item.id === id)).filter(Boolean);
  const filteredItems = items.filter((item) => filter === 'all' || item.category === filter);
  const selectedKey = selectedIds.slice().sort().join(':');
  const comboPreviewItems = (selectedItems.length ? selectedItems : items.filter((item) => ['tops', 'bottoms', 'suits', 'outerwear', 'shoes'].includes(item.category))).slice(0, 4);
  const mainPreview = user.bodyPhotoUrl || latestOutfit?.imageUrl || comboPreviewItems[0]?.imageUrl || null;
  const lookbookCards = outfits.length
    ? outfits.slice(0, 5).map((outfit) => ({ id: outfit.id, title: outfit.title, imageUrl: outfit.imageUrl, items: outfit.items || [] }))
    : suggestions.slice(0, 5).map((suggestion, index) => ({ id: suggestion.key || `${suggestion.title}-${index}`, title: suggestion.title, items: suggestion.items || [] }));
  const slotItems = closetComboSlots.map((slot) => ({
    ...slot,
    selected: items.find((item) => item.id === comboSlots[slot.key]) || null,
    options: optionsForSlot(slot, items)
  }));
  const activeWardrobeSlot = slotItems.find((slot) => slot.key === activeSlot) || slotItems[0];
  const selectionCards = [
    {
      key: 'add',
      step: '01',
      title: 'Add Clothes',
      copy: 'Upload wardrobe photos and save category, color, fabric, season and occasion tags.',
      meta: `${closet.data.stats?.total || items.length} saved`,
      action: 'Open Add',
      icon: 'cloud-upload-outline',
      tone: '#0f5132',
      items: items.slice(0, 3)
    },
    {
      key: 'combo',
      step: '02',
      title: 'Build Combo',
      copy: 'Select which pant fits which shirt, add shoes or accessories, then generate it on you.',
      meta: selectedItems.length ? `${selectedItems.length} selected` : 'Shirt + pant picker',
      action: 'Choose Items',
      icon: 'shirt-outline',
      tone: '#7c4f2b',
      items: comboPreviewItems
    },
    {
      key: 'wardrobe',
      step: '03',
      title: 'Your Closet',
      copy: 'Browse saved clothes with filters and send selected pieces to the combo builder.',
      meta: `${closetCategories.length} filters`,
      action: 'View Wardrobe',
      icon: 'grid-outline',
      tone: '#5b4b7a',
      items: items.slice(0, 4)
    }
  ];
  const activeWardrobeCategory = wardrobeCategoryTabs.find((tab) => tab.key === filter) || wardrobeCategoryTabs.find((tab) => tab.slot === activeSlot) || wardrobeCategoryTabs[0];
  const wardrobePreviewSource = mainPreview
    ? { uri: imageUrl(mainPreview) }
    : null;
  const comboSlotSelectedIds = [...new Set(Object.values(comboSlots).filter(Boolean))];
  const tryThisLookIds = selectedIds.length
    ? selectedIds
    : comboSlotSelectedIds.length
      ? comboSlotSelectedIds
      : comboPreviewItems.map((item) => item.id).filter(Boolean);
  const wardrobePreviewHeight = clamp(height * 0.62, 470, 620);
  const recommendationSource = suggestions.slice(0, 3);
  const detectionSummaryFields = [
    ['Name', itemName],
    ['Type', titleCase(itemCategory || '')],
    ['Color', itemColor],
    ['Fabric', itemFabric],
    ['Pattern', itemPattern],
    ['Occasion', itemOccasions],
    ['Tags', itemTags]
  ].filter(([, value]) => String(value || '').trim());

  const toggleItem = (id) => {
    setSelectedIds((current) => current.includes(id) ? current.filter((itemId) => itemId !== id) : [...current, id].slice(-5));
  };

  const selectedIdsFromSlots = (slots) => [...new Set(Object.values(slots).filter(Boolean))];

  const slotsFromItems = (entries = []) => {
    const next = {};
    closetComboSlots.forEach((slot) => {
      const item = entries.find((entry) => slotMatchesItem(slot, entry));
      if (item) next[slot.key] = item.id;
    });
    return next;
  };

  const applySuggestion = (suggestion) => {
    const suggestionItems = suggestion.items || (suggestion.itemIds || []).map((id) => items.find((item) => item.id === id)).filter(Boolean);
    setSelectedIds((suggestion.itemIds || suggestionItems.map((item) => item.id)).filter(Boolean));
    setComboSlots(slotsFromItems(suggestionItems));
    setOccasion(suggestion.title || 'today');
    setClosetView('combo');
    setMessage(suggestion.reason || 'Suggestion selected.');
  };

  const applyComboItems = (entries = []) => {
    const nextSlots = slotsFromItems(entries);
    setComboSlots(nextSlots);
    setSelectedIds(entries.map((item) => item.id).filter(Boolean).slice(0, 5));
    setClosetView('combo');
  };

  const setSlotItem = (slotKey, itemId) => {
    setComboSlots((current) => ({ ...current, [slotKey]: itemId }));
    setSelectedIds((current) => {
      const slot = closetComboSlots.find((entry) => entry.key === slotKey);
      const replaced = current.filter((id) => {
        const item = items.find((entry) => entry.id === id);
        return !slot || !item || !slotMatchesItem(slot, item);
      });
      return itemId ? [...replaced, itemId].slice(-5) : replaced;
    });
  };

  const chooseSlotItem = (slotKey, item) => {
    setComboSlots((current) => {
      const next = { ...current };
      if (!item) delete next[slotKey];
      else next[slotKey] = item.id;
      setSelectedIds(selectedIdsFromSlots(next).slice(0, 5));
      return next;
    });
  };

  const applyDetectedItemFields = (fields = {}) => {
    const nextCategory = closetCategories.includes(fields.category) ? fields.category : '';
    if (fields.name) setItemName(fields.name);
    if (nextCategory) setItemCategory(nextCategory);
    if (fields.color) setItemColor(fields.color);
    if (fields.fabric) setItemFabric(fields.fabric);
    if (fields.pattern) setItemPattern(fields.pattern);
    if (fields.season) setItemSeason(fields.season);
    if (fields.formality) setItemFormality(fields.formality);
    if (Array.isArray(fields.occasions)) setItemOccasions(fields.occasions.join(', '));
    else if (fields.occasions) setItemOccasions(String(fields.occasions));
    if (Array.isArray(fields.tags)) setItemTags(fields.tags.join(', '));
    else if (fields.tags) setItemTags(String(fields.tags));
  };

  const pickClosetItemPhoto = async () => {
    const asset = await pickImage();
    if (!asset?.uri) return;
    setItemPhoto(asset);
    setItemDetection({ status: 'loading', message: 'Reading item type, color, material, pattern, and tags.' });
    setBusy('analyze-item');
    setMessage('Analyzing clothing photo...');
    try {
      const form = new FormData();
      form.append('item', filePart(asset, 'closet-item.jpg'));
      form.append('name', itemName);
      form.append('tags', itemTags);
      const data = await api('/closet/items/analyze', { method: 'POST', body: form, timeoutMs: 45000 });
      const detection = data.detection || {};
      applyDetectedItemFields(detection.fields || {});
      setItemDetection({
        status: 'ready',
        source: detection.source || 'basic',
        confidence: detection.confidence,
        message: detection.message || 'Review and edit before saving.'
      });
      setMessage(detection.message || 'Detected details added. Review and edit before saving.');
    } catch (error) {
      const missingRoute = isMissingRouteError(error.message);
      const detectionMessage = missingRoute
        ? 'Detection service is not active on the running backend. Restart the backend, then try again.'
        : error.message || 'AI detection is unavailable. You can still fill the details manually.';
      setItemDetection({
        status: 'error',
        message: detectionMessage
      });
      setMessage(detectionMessage);
    } finally {
      setBusy('');
    }
  };

  const clearItemPhoto = () => {
    setItemPhoto(null);
    setItemDetection(null);
  };

  const swapSelected = (item) => {
    const replacement = items
      .filter((candidate) => candidate.id !== item.id && candidate.category === item.category && !selectedIds.includes(candidate.id))
      .sort((a, b) => Number(b.favorite) - Number(a.favorite) || new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0))[0];
    if (!replacement) {
      setMessage(`No other ${item.category} item is available to swap.`);
      return;
    }
    setSelectedIds((current) => current.map((id) => (id === item.id ? replacement.id : id)));
    setComboSlots((current) => {
      const matchedSlot = closetComboSlots.find((slot) => slotMatchesItem(slot, item));
      if (!matchedSlot || current[matchedSlot.key] !== item.id) return current;
      return { ...current, [matchedSlot.key]: replacement.id };
    });
    setMessage(`Swapped ${item.name} with ${replacement.name}.`);
  };

  const updateItem = async (item, updates) => {
    setBusy(`update-${item.id}`);
    try {
      await api(`/closet/items/${encodeURIComponent(item.id)}`, {
        method: 'PATCH',
        body: JSON.stringify(updates)
      });
      closet.reload();
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy('');
    }
  };

  const addItem = async () => {
    if (busy === 'analyze-item') {
      setMessage('Wait for item detection to finish, then review and save.');
      return;
    }
    if (!itemPhoto) {
      setMessage('Upload a closet item photo first.');
      return;
    }
    setBusy('add');
    setMessage('Saving closet item...');
    try {
      const form = new FormData();
      form.append('item', filePart(itemPhoto, 'closet-item.jpg'));
      form.append('name', itemName || itemPhoto.fileName || 'Closet item');
      form.append('category', itemCategory);
      form.append('color', itemColor);
      form.append('fabric', itemFabric);
      form.append('pattern', itemPattern);
      form.append('season', itemSeason);
      form.append('formality', itemFormality);
      form.append('occasions', itemOccasions);
      form.append('tags', itemTags);
      await api('/closet/items', { method: 'POST', body: form });
      setSuggestionOverrides(null);
      setItemPhoto(null);
      setItemDetection(null);
      setItemName('');
      setItemColor('');
      setItemFabric('');
      setItemPattern('');
      setItemSeason('all-season');
      setItemFormality('any');
      setItemOccasions('');
      setItemTags('');
      setMessage('Closet item added.');
      closet.reload();
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy('');
    }
  };

  const generateOutfit = async (ids = selectedIds, details = {}) => {
    if (!ids.length) {
      setMessage('Select at least one closet item first.');
      return;
    }
    const profileMessage = tryOnProfileBlockMessage(user);
    if (profileMessage) {
      setMessage(profileMessage);
      return;
    }
    setBusy('generate');
    setMessage('Generating your closet look with FitRoom...');
    try {
      const data = await api('/closet/outfits/generate', {
        method: 'POST',
        body: JSON.stringify({
          itemIds: ids,
          occasion: details.occasion || occasion,
          weather,
          mood,
          plannedFor,
          backdrop,
          pose,
          lighting,
          notes: [backdrop, pose, lighting].filter(Boolean).join(' | '),
          title: details.title || `Closet look for ${details.occasion || occasion || 'today'}`
        })
      });
      if (data.user) setUser(data.user);
      setSuggestionOverrides(null);
      setMessage('Closet look is ready.');
      setSelectedIds(ids);
      closet.reload();
      if (data.outfit?.imageUrl) setLightbox(imageUrl(data.outfit.imageUrl));
    } catch (error) {
      setMessage(aiFeatureErrorMessage(error, 'Could not generate the closet look. Try again in a moment.'));
    } finally {
      setBusy('');
    }
  };

  const askForSuggestions = async (nextOccasion = occasion) => {
    setOccasion(nextOccasion);
    setBusy('suggest');
    setMessage('Finding the best combos from your closet...');
    try {
      const data = await api('/closet/suggest', {
        method: 'POST',
        body: JSON.stringify({ occasion: nextOccasion, weather, mood })
      });
      setSuggestionOverrides(data.suggestions || []);
      setMessage('Suggestions ready.');
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy('');
    }
  };

  const askStylist = async () => {
    const prompt = stylistText.trim();
    if (!prompt) return;
    setBusy('chat');
    setMessage('Building closet ideas...');
    setChat((current) => [...current, { role: 'user', text: prompt }]);
    try {
      const data = await api('/closet/chat', { method: 'POST', body: JSON.stringify({ message: prompt }) });
      const reply = data.reply || 'Look ideas are ready.';
      setChat((current) => [...current, { role: 'assistant', text: reply }]);
      setMessage(reply);
      if (data.suggestions?.[0]) setSelectedIds(data.suggestions[0].itemIds || []);
      if (data.suggestions) setSuggestionOverrides(data.suggestions);
      setStylistText('');
    } catch (error) {
      const messageText = aiFeatureErrorMessage(error, 'Closet stylist could not respond right now.');
      setChat((current) => [...current, { role: 'assistant', text: messageText }]);
      setMessage(messageText);
    } finally {
      setBusy('');
    }
  };

  const removeItem = async (id) => {
    setBusy(`delete-${id}`);
    setMessage('Removing item...');
    try {
      await api(`/closet/items/${encodeURIComponent(id)}`, { method: 'DELETE' });
      setSuggestionOverrides(null);
      setSelectedIds((current) => current.filter((itemId) => itemId !== id));
      setComboSlots((current) => Object.fromEntries(Object.entries(current).filter(([, itemId]) => itemId !== id)));
      setMessage('Closet item removed.');
      closet.reload();
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy('');
    }
  };

  const discardAddDraft = () => {
    setItemPhoto(null);
    setItemDetection(null);
    setItemName('');
    setItemColor('');
    setItemFabric('');
    setItemPattern('');
    setItemSeason('all-season');
    setItemFormality('any');
    setItemOccasions('');
    setItemTags('');
    setMessage('');
    onNavigate('closet');
  };

  const cycleItemCategory = () => {
    const order = ['dresses', 'tops', 'bottoms', 'outerwear', 'shoes', 'accessories'];
    const currentIndex = order.indexOf(itemCategory);
    setItemCategory(order[(currentIndex + 1) % order.length]);
  };

  if (isAddStudio) {
    return (
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.addStudioScreen}>
        <ScrollView ref={addStudioScrollRef} contentContainerStyle={styles.addStudioContent} {...screenScrollProps}>
          <View style={styles.addStudioTopBar}>
            <TouchableOpacity style={styles.addStudioTopButton} onPress={discardAddDraft}>
              <Ionicons name="close" size={24} color="#171412" />
            </TouchableOpacity>
            <BrandLogo compact style={styles.addStudioBrandLogo} />
            <TouchableOpacity style={styles.addStudioTopButton} onPress={() => onNavigate('closet')}>
              <Ionicons name="cube-outline" size={22} color="#171412" />
            </TouchableOpacity>
          </View>

          <View style={styles.addStudioIntro}>
            <Text style={styles.addStudioTitle}>Curate Your Studio</Text>
            <Text style={styles.addStudioSubtitle}>Build your Atelier Digital. High-fidelity archives enable precise AI styling and virtual try-on sessions.</Text>
          </View>

          <TouchableOpacity ref={wardrobeUploadTourTarget.ref} onLayout={wardrobeUploadTourTarget.onLayout} style={styles.addStudioUploadBox} activeOpacity={0.84} onPress={pickClosetItemPhoto}>
            {itemPhoto?.uri ? (
              <>
                <Image source={{ uri: itemPhoto.uri }} style={styles.addStudioUploadImage} resizeMode="cover" />
                {busy === 'analyze-item' ? (
                  <View style={styles.addStudioAnalyzeOverlay}>
                    <ActivityIndicator size="small" color="#ffffff" />
                    <Text style={styles.addStudioAnalyzeText}>Analyzing item</Text>
                  </View>
                ) : null}
              </>
            ) : (
              <View style={styles.addStudioUploadCopy}>
                <Ionicons name="camera-outline" size={32} color="#57514f" />
                <Text style={styles.addStudioUploadTitle}>Upload Clothing Photo</Text>
                <Text style={styles.addStudioUploadText}>High resolution, neutral background preferred</Text>
              </View>
            )}
          </TouchableOpacity>

          <View style={styles.addStudioThumbRow}>
            <TouchableOpacity style={styles.addStudioAddThumb} onPress={pickClosetItemPhoto}>
              <Ionicons name="add" size={24} color="#171412" />
            </TouchableOpacity>
            {itemPhoto?.uri ? [({ uri: itemPhoto.uri })].map((source, index) => (
              <View key={index} style={styles.addStudioThumbWrap}>
                <Image source={source} style={styles.addStudioThumbImage} resizeMode="cover" />
                <TouchableOpacity style={styles.addStudioThumbClose} onPress={clearItemPhoto}>
                  <Ionicons name="close" size={12} color="#6c625e" />
                </TouchableOpacity>
              </View>
            )) : null}
          </View>

          <ClosetDetectionCard detection={itemDetection} fields={detectionSummaryFields} />

          <View style={styles.addStudioArchiveHead}>
            <Text style={styles.addStudioArchiveTitle}>Archive Entry: {titleCase(itemCategory || 'Dress').replace(/s$/, '')}</Text>
            <View style={styles.addStudioArchiveLine} />
          </View>

          <Text style={styles.addStudioSectionLabel}>ITEM SPECIFICATIONS</Text>
          <View style={styles.addStudioForm}>
            <Text style={styles.addStudioFieldLabel}>Item Name</Text>
            <TextInput style={styles.addStudioInput} value={itemName} onChangeText={setItemName} placeholder="Black ribbed dress" placeholderTextColor="#2b2a29" />

            <View style={styles.addStudioTwoCol}>
              <View style={styles.addStudioFieldHalf}>
                <Text style={styles.addStudioFieldLabel}>Type</Text>
                <TouchableOpacity style={styles.addStudioSelectInput} onPress={cycleItemCategory}>
                  <Text style={styles.addStudioInputText}>{titleCase(itemCategory || 'dresses')}</Text>
                  <Ionicons name="chevron-down" size={18} color="#6f7680" />
                </TouchableOpacity>
              </View>
              <View style={styles.addStudioFieldHalf}>
                <Text style={styles.addStudioFieldLabel}>Color</Text>
                <View style={styles.addStudioColorInput}>
                  <View style={styles.addStudioColorDot} />
                  <TextInput style={styles.addStudioColorTextInput} value={itemColor} onChangeText={setItemColor} placeholder="Charcoal" placeholderTextColor="#2b2a29" />
                </View>
              </View>
            </View>

            <View style={styles.addStudioTwoCol}>
              <View style={styles.addStudioFieldHalf}>
                <Text style={styles.addStudioFieldLabel}>Fabric</Text>
                <TextInput style={styles.addStudioInput} value={itemFabric} onChangeText={setItemFabric} placeholder="Heavy Crepe Silk" placeholderTextColor="#2b2a29" />
              </View>
              <View style={styles.addStudioFieldHalf}>
                <Text style={styles.addStudioFieldLabel}>Pattern</Text>
                <TextInput style={styles.addStudioInput} value={itemPattern} onChangeText={setItemPattern} placeholder="Solid" placeholderTextColor="#2b2a29" />
              </View>
            </View>

            <Text style={styles.addStudioFieldLabel}>Season</Text>
            <View style={styles.addStudioSegmented}>
              {[
                ['summer', 'S/S'],
                ['winter', 'A/W'],
                ['resort', 'Resort'],
                ['all-season', 'All']
              ].map(([value, label]) => {
                const active = itemSeason === value;
                return (
                  <TouchableOpacity key={value} style={[styles.addStudioSegment, active && styles.addStudioSegmentActive]} onPress={() => setItemSeason(value)}>
                    <Text style={[styles.addStudioSegmentText, active && styles.addStudioSegmentTextActive]}>{label}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <View style={styles.addStudioTwoCol}>
              <View style={styles.addStudioFieldHalf}>
                <Text style={styles.addStudioFieldLabel}>Vibe</Text>
                <TextInput style={styles.addStudioInput} value={itemFormality === 'any' ? '' : itemFormality} onChangeText={setItemFormality} placeholder="E.g. Brutalist" placeholderTextColor="#9ca3af" />
              </View>
              <View style={styles.addStudioFieldHalf}>
                <Text style={styles.addStudioFieldLabel}>Occasion</Text>
                <TextInput style={styles.addStudioInput} value={itemOccasions} onChangeText={setItemOccasions} placeholder="Gala" placeholderTextColor="#2b2a29" />
              </View>
            </View>

            <Text style={styles.addStudioFieldLabel}>Metadata Tags</Text>
            <View style={styles.addStudioTagInput}>
              <TextInput style={styles.addStudioTagTextInput} value={itemTags} onChangeText={setItemTags} placeholder="Add tags..." placeholderTextColor="#8d939f" />
              <TouchableOpacity style={styles.addStudioTagAdd}>
                <Ionicons name="add" size={17} color="#4f4a48" />
              </TouchableOpacity>
            </View>
            <View style={styles.addStudioTagRow}>
              {['#minimalism', '#architectural'].map((tag) => (
                <View key={tag} style={styles.addStudioTagPill}>
                  <Text style={styles.addStudioTagPillText}>{tag}</Text>
                  <Ionicons name="close" size={12} color="#6f6864" />
                </View>
              ))}
            </View>
          </View>

          {message ? <Text style={[styles.formMessage, styles.addStudioMessage, /failed|missing|error|upload/i.test(message) ? styles.errorText : null]}>{message}</Text> : null}
        </ScrollView>

        <View style={styles.addStudioFooter}>
          <TouchableOpacity style={styles.addStudioDiscardButton} onPress={discardAddDraft}>
            <Text style={styles.addStudioDiscardText}>DISCARD DRAFT</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.addStudioSaveButton, (busy === 'add' || busy === 'analyze-item') && styles.disabledButton]} disabled={busy === 'add' || busy === 'analyze-item'} onPress={addItem}>
            <Text style={styles.addStudioSaveText}>{busy === 'analyze-item' ? 'ANALYZING...' : busy === 'add' ? 'SAVING...' : 'SAVE CLOTHING\nITEM'}</Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    );
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.wardrobeScreen}>
      <ScrollView contentContainerStyle={styles.wardrobeContent} {...screenScrollProps}>
        <WardrobeTopBar user={user} onNavigate={onNavigate} />

        <View style={styles.wardrobeHeroHead}>
          <View>
            <Text style={styles.wardrobeTitle}>My Wardrobe</Text>
            <Text style={styles.wardrobeSubtitle}>Curated Collection</Text>
          </View>
          <TouchableOpacity style={styles.wardrobeAddButton} activeOpacity={0.85} onPress={() => onNavigate('closet', { view: 'add' })}>
            <Ionicons name="add" size={22} color="#ffffff" />
            <Text style={styles.wardrobeAddText}>Add Item</Text>
          </TouchableOpacity>
        </View>

        <ScrollView {...horizontalScrollProps} contentContainerStyle={styles.wardrobeCategoryTrack}>
          {wardrobeCategoryTabs.map((tab) => {
            const active = activeWardrobeCategory.key === tab.key;
            return (
              <TouchableOpacity
                key={tab.key}
                style={styles.wardrobeCategoryButton}
                activeOpacity={0.82}
                onPress={() => {
                  setActiveSlot(tab.slot);
                  setFilter(tab.key);
                }}
              >
                <View style={[styles.wardrobeCategoryIcon, active && styles.wardrobeCategoryIconActive]}>
                  <Ionicons name={tab.icon} size={28} color="#444444" />
                </View>
                <Text style={[styles.wardrobeCategoryLabel, active && styles.wardrobeCategoryLabelActive]}>{tab.label}</Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>

        {closetView === 'stylist' ? (
          <>
            <View style={styles.wardrobePreviewWrap}>
              <Pressable style={[styles.wardrobePreviewCard, { height: wardrobePreviewHeight }]} onPress={() => mainPreview && setLightbox(imageUrl(mainPreview))}>
                {wardrobePreviewSource ? (
                  <ResilientImage source={wardrobePreviewSource} style={styles.wardrobePreviewImage} resizeMode="contain" fallbackIcon="shirt-outline" />
                ) : null}
                {busy === 'generate' ? <View style={styles.previewGenerating}><ActivityIndicator color="#fff" /><Text style={styles.previewGeneratingText}>Generating look</Text></View> : null}
              </Pressable>
              <TouchableOpacity
                style={[styles.wardrobeTryButton, (!tryThisLookIds.length || busy === 'generate') && styles.disabledButton]}
                disabled={!tryThisLookIds.length || busy === 'generate'}
                onPress={() => generateOutfit(tryThisLookIds, { title: 'My wardrobe look' })}
              >
                <Text style={styles.wardrobeTryText}>{busy === 'generate' ? 'Generating...' : 'Try This Look'}</Text>
              </TouchableOpacity>
            </View>

            <View style={styles.wardrobeRecommendationsHead}>
              <Text style={styles.wardrobeSectionTitle}>AI Recommendations</Text>
              <TouchableOpacity style={styles.wardrobeGenerateLink} onPress={() => askForSuggestions('today casual')} disabled={busy === 'suggest'}>
                <Ionicons name="refresh-outline" size={22} color="#9b5658" />
                <Text style={styles.wardrobeGenerateText}>{busy === 'suggest' ? 'Generating' : 'Generate Look'}</Text>
              </TouchableOpacity>
            </View>

            <ScrollView {...horizontalScrollProps} contentContainerStyle={styles.wardrobeRecommendationTrack}>
              {recommendationSource.length ? recommendationSource.map((suggestion, index) => {
                const fallback = wardrobeFallbackRecommendations[index % wardrobeFallbackRecommendations.length];
                return (
                  <WardrobeRecommendationCard
                    key={suggestion?.key || suggestion?.title || fallback.title}
                    suggestion={suggestion}
                    fallback={fallback}
                    onPress={() => suggestion ? applySuggestion(suggestion) : askForSuggestions('today casual')}
                  />
                );
              }) : (
                <TouchableOpacity style={styles.wardrobeEmptyRecommendation} onPress={() => askForSuggestions('today casual')} disabled={busy === 'suggest'}>
                  <Ionicons name="sparkles-outline" size={22} color="#9b5658" />
                  <Text style={styles.wardrobeEmptyRecommendationTitle}>{busy === 'suggest' ? 'Generating suggestions...' : 'No AI recommendations yet'}</Text>
                  <Text style={styles.wardrobeEmptyRecommendationText}>Generate ideas from your uploaded closet.</Text>
                </TouchableOpacity>
              )}
            </ScrollView>
          </>
        ) : (
          <View style={styles.wardrobeModeTabs}>
            <FilterChips
              selected={closetView}
              options={[['stylist', 'Preview'], ['combo', 'Combo'], ['add', 'Add'], ['wardrobe', 'Wardrobe'], ['looks', 'Looks']]}
              onSelect={setClosetView}
              compact
            />
          </View>
        )}

        {closetView === 'add' ? <View style={styles.closetPanel}>
          <Text style={styles.sectionTitle}>Add Clothing</Text>
          <TouchableOpacity style={styles.uploadBox} onPress={pickClosetItemPhoto}>
            {itemPhoto?.uri ? <Image source={{ uri: itemPhoto.uri }} style={styles.uploadPreview} /> : <Ionicons name="cloud-upload-outline" size={30} color="#0f766e" />}
            <View style={styles.uploadCopy}>
              <Text style={styles.uploadTitle}>{busy === 'analyze-item' ? 'Analyzing clothing photo' : itemPhoto ? 'Closet photo selected' : 'Upload clothing photo'}</Text>
              <Text style={styles.photoGuideText}>{itemPhoto ? 'Detected details will be filled below for review.' : 'Use one clear item per photo for best combo selection.'}</Text>
            </View>
          </TouchableOpacity>
          <ClosetDetectionCard detection={itemDetection} fields={detectionSummaryFields} compact />
          <TextInput style={styles.input} value={itemName} onChangeText={setItemName} placeholder="Item name" placeholderTextColor="#94a3b8" />
          <FilterChips selected={itemCategory} options={closetCategories.map((item) => [item, titleCase(item)])} onSelect={setItemCategory} compact />
          <View style={styles.twoColumnInputs}>
            <TextInput style={[styles.input, styles.halfInput]} value={itemColor} onChangeText={setItemColor} placeholder="Color" placeholderTextColor="#94a3b8" />
            <TextInput style={[styles.input, styles.halfInput]} value={itemFabric} onChangeText={setItemFabric} placeholder="Fabric" placeholderTextColor="#94a3b8" />
          </View>
          <View style={styles.twoColumnInputs}>
            <TextInput style={[styles.input, styles.halfInput]} value={itemPattern} onChangeText={setItemPattern} placeholder="Pattern" placeholderTextColor="#94a3b8" />
            <TextInput style={[styles.input, styles.halfInput]} value={itemOccasions} onChangeText={setItemOccasions} placeholder="Occasions" placeholderTextColor="#94a3b8" />
          </View>
          <Text style={styles.formLabel}>Season</Text>
          <FilterChips selected={itemSeason} options={['all-season', 'summer', 'winter', 'rainy'].map((item) => [item, titleCase(item)])} onSelect={setItemSeason} compact />
          <Text style={styles.formLabel}>Vibe</Text>
          <FilterChips selected={itemFormality} options={['any', 'casual', 'smart-casual', 'formal', 'party', 'active'].map((item) => [item, titleCase(item)])} onSelect={setItemFormality} compact />
          <TextInput style={styles.input} value={itemTags} onChangeText={setItemTags} placeholder="Tags or occasions" placeholderTextColor="#94a3b8" />
          <AppButton label={busy === 'analyze-item' ? 'Analyzing...' : busy === 'add' ? 'Saving...' : 'Add To Closet'} icon="add-circle-outline" disabled={busy === 'add' || busy === 'analyze-item'} onPress={addItem} />
        </View> : null}

        {closetView === 'combo' ? <View style={styles.closetPanel}>
          <Text style={styles.sectionTitle}>Combo Builder</Text>
          <Text style={styles.muted}>Pick pieces by slot, then generate the selected outfit on your profile.</Text>
          <View style={styles.twoColumnInputs}>
            <TextInput style={[styles.input, styles.halfInput]} value={occasion} onChangeText={setOccasion} placeholder="Occasion" placeholderTextColor="#94a3b8" />
            <TextInput style={[styles.input, styles.halfInput]} value={weather} onChangeText={setWeather} placeholder="Weather" placeholderTextColor="#94a3b8" />
          </View>
          <View style={styles.twoColumnInputs}>
            <TextInput style={[styles.input, styles.halfInput]} value={mood} onChangeText={setMood} placeholder="Mood" placeholderTextColor="#94a3b8" />
            <TextInput style={[styles.input, styles.halfInput]} value={plannedFor} onChangeText={setPlannedFor} placeholder="YYYY-MM-DD" placeholderTextColor="#94a3b8" />
          </View>
          <Text style={styles.formLabel}>Backdrop</Text>
          <FilterChips selected={backdrop} options={closetSceneOptions.backdrop.map((item) => [item, titleCase(item)])} onSelect={setBackdrop} compact />
          <Text style={styles.formLabel}>Pose</Text>
          <FilterChips selected={pose} options={closetSceneOptions.pose.map((item) => [item, titleCase(item)])} onSelect={setPose} compact />
          <Text style={styles.formLabel}>Lighting</Text>
          <FilterChips selected={lighting} options={closetSceneOptions.lighting.map((item) => [item, titleCase(item)])} onSelect={setLighting} compact />
          <AppButton label={busy === 'suggest' ? 'Finding Ideas...' : 'Suggest Combos'} icon="sparkles-outline" variant="secondary" disabled={busy === 'suggest' || !items.length} onPress={() => askForSuggestions()} />
          <View style={styles.comboSlotGrid}>
            {closetComboSlots.map((slot) => {
              const selectedItem = items.find((item) => item.id === comboSlots[slot.key]);
              const isActive = activeSlot === slot.key;
              return (
                <TouchableOpacity key={slot.key} style={[styles.comboSlot, isActive && styles.comboSlotActive]} onPress={() => setActiveSlot(slot.key)}>
                  <Text style={styles.comboSlotLabel}>{slot.label}</Text>
                  <Text style={styles.comboSlotValue} numberOfLines={1}>{selectedItem?.name || slot.helper}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
          {closetComboSlots.map((slot) => {
            if (slot.key !== activeSlot) return null;
            const options = optionsForSlot(slot, items);
            return (
              <View key={slot.key} style={styles.slotOptions}>
                <Text style={styles.formLabel}>{slot.label}</Text>
                {options.length ? (
                  <ScrollView {...horizontalScrollProps} contentContainerStyle={styles.suggestionRow}>
                    {options.map((item) => {
                      const active = comboSlots[slot.key] === item.id;
                      return (
                        <TouchableOpacity key={item.id} style={[styles.slotOptionCard, active && styles.slotOptionActive]} onPress={() => setSlotItem(slot.key, item.id)}>
                          <ResilientImage source={item.imageUrl ? { uri: imageUrl(item.imageUrl) } : null} style={styles.slotOptionImage} resizeMode="cover" fallbackIcon="shirt-outline" />
                          <Text style={styles.slotOptionName} numberOfLines={2}>{item.name}</Text>
                        </TouchableOpacity>
                      );
                    })}
                  </ScrollView>
                ) : <Text style={styles.muted}>Add a {slot.helper.toLowerCase()} item to fill this slot.</Text>}
                {comboSlots[slot.key] ? <AppButton label="Clear Slot" icon="close-circle-outline" variant="secondary" onPress={() => setSlotItem(slot.key, '')} /> : null}
              </View>
            );
          })}
          {selectedItems.length ? (
            <View style={styles.selectedComboStrip}>
              {selectedItems.map((item) => (
                <View key={item.id} style={styles.selectedChipCard}>
                  <ResilientImage source={item.imageUrl ? { uri: imageUrl(item.imageUrl) } : null} style={styles.selectedChipImage} resizeMode="cover" fallbackIcon="shirt-outline" />
                  <Text style={styles.selectedChipName} numberOfLines={1}>{item.name}</Text>
                  <TouchableOpacity onPress={() => swapSelected(item)}><Text style={styles.selectedChipAction}>Swap</Text></TouchableOpacity>
                  <TouchableOpacity onPress={() => toggleItem(item.id)}><Text style={styles.selectedChipAction}>Remove</Text></TouchableOpacity>
                </View>
              ))}
            </View>
          ) : null}
          <AppButton label={busy === 'generate' ? 'Generating...' : `Generate Combo On Me (${selectedIds.length})`} icon="sparkles-outline" disabled={busy === 'generate' || !selectedIds.length} onPress={() => generateOutfit()} />
          <View style={styles.comboSuggestionList}>
            <Text style={styles.formLabel}>Combo Selection</Text>
            {suggestions.length ? suggestions.slice(0, 6).map((combo, index) => {
              const comboIds = combo.itemIds || [];
              const active = comboIds.slice().sort().join(':') === selectedKey;
              return (
                <TouchableOpacity key={combo.key || combo.title || index} style={[styles.comboSuggestionCard, active && styles.comboSuggestionActive]} onPress={() => applyComboItems(combo.items || [])}>
                  <Text style={styles.comboNumber}>{String(index + 1).padStart(2, '0')}</Text>
                  <View style={styles.comboThumbs}>
                    {(combo.items || []).slice(0, 4).map((item) => (
                      <ResilientImage key={item.id} source={item.imageUrl ? { uri: imageUrl(item.imageUrl) } : null} style={styles.comboThumb} resizeMode="cover" fallbackIcon="shirt-outline" />
                    ))}
                  </View>
                  <View style={styles.comboSuggestionCopy}>
                    <Text style={styles.suggestionTitle}>{combo.title || `Combo ${index + 1}`}</Text>
                    <Text style={styles.suggestionCopy} numberOfLines={2}>{combo.reason || 'AI-picked from your closet'}</Text>
                  </View>
                </TouchableOpacity>
              );
            }) : (
              <TouchableOpacity style={styles.comboSuggestionCard} onPress={() => askForSuggestions()}>
                <Text style={styles.comboNumber}>AI</Text>
                <View style={styles.comboSuggestionCopy}>
                  <Text style={styles.suggestionTitle}>Create combos</Text>
                  <Text style={styles.suggestionCopy}>Get recommendations from your uploaded closet.</Text>
                </View>
              </TouchableOpacity>
            )}
          </View>
        </View> : null}

        {closetView === 'combo' ? <View style={styles.closetPanel}>
          <View style={styles.panelHeaderRow}>
            <View>
              <Text style={styles.sectionTitle}>Look Preview</Text>
              <Text style={styles.muted}>Your clothes only</Text>
            </View>
            <Text style={styles.statPill}>{user.tokens} tokens</Text>
          </View>
          <View style={styles.chatTranscript}>
            {chat.map((entry, index) => (
              <View key={`${entry.role}-${index}`} style={[styles.chatBubble, entry.role === 'user' && styles.chatBubbleUser]}>
                <Text style={[styles.chatBubbleText, entry.role === 'user' && styles.chatBubbleUserText]}>{entry.text}</Text>
              </View>
            ))}
          </View>
          <View style={styles.searchRow}>
            <TextInput style={styles.searchInput} value={stylistText} onChangeText={setStylistText} placeholder="Describe a look: office, date, rain..." placeholderTextColor="#94a3b8" />
            <TouchableOpacity style={[styles.searchButton, busy === 'chat' && styles.disabledButton]} disabled={busy === 'chat'} onPress={askStylist}>
              <Ionicons name="sparkles-outline" size={20} color="#fff" />
            </TouchableOpacity>
          </View>
          {suggestions.length ? (
            <ScrollView {...horizontalScrollProps} contentContainerStyle={styles.suggestionRow}>
              {suggestions.map((suggestion) => (
                <TouchableOpacity key={suggestion.key || suggestion.title} style={styles.suggestionCard} onPress={() => applySuggestion(suggestion)}>
                  <Text style={styles.suggestionTitle}>{suggestion.title}</Text>
                  <Text style={styles.suggestionCopy} numberOfLines={2}>{suggestion.reason}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          ) : null}
        </View> : null}

        {closetView !== 'stylist' && !closet.loading && closet.error ? <StatusPanel error={closet.error} /> : null}
        {closetView !== 'stylist' && !closet.loading && !closet.error && !items.length ? (
          <View style={styles.closetEmptyWrap}>
            <EmptyStateCard
              icon="shirt-outline"
              title="No clothes yet"
              text="Upload your first item and Lookmefy will read the type, colour, fabric, pattern, and tags."
              actionLabel="Add Clothes"
              actionIcon="add"
              onAction={() => setClosetView('add')}
            />
          </View>
        ) : null}
        {closetView === 'wardrobe' ? <View style={styles.closetPanel}>
          <View style={styles.panelHeaderRow}>
            <View>
              <Text style={styles.sectionTitle}>Your Closet</Text>
              <Text style={styles.muted}>Browse, save favorites, remove old items, or send selected pieces to combo.</Text>
            </View>
            {selectedIds.length ? <TouchableOpacity style={styles.smallOutlineButton} onPress={() => setClosetView('combo')}><Text style={styles.smallOutlineText}>Build ({selectedIds.length})</Text></TouchableOpacity> : null}
          </View>
          <FilterChips selected={filter} options={[['all', 'All'], ...closetCategories.map((item) => [item, titleCase(item)])]} onSelect={setFilter} compact />
        </View> : null}
        {closetView === 'wardrobe' || closetView === 'combo' ? closet.loading ? <WardrobeGridSkeleton /> : items.length ? (
          <View style={styles.closetGrid}>
            {(closetView === 'wardrobe' ? filteredItems : items).map((item) => {
              const selected = selectedIds.includes(item.id);
              return (
                <Pressable key={item.id} style={[styles.closetItemCard, selected && styles.closetItemSelected]} onPress={() => toggleItem(item.id)}>
                  <ResilientImage source={item.imageUrl ? { uri: imageUrl(item.imageUrl) } : null} style={styles.closetItemImage} resizeMode="cover" fallbackIcon="shirt-outline" />
                  <View style={styles.closetItemBody}>
                    <Text style={styles.productTitle} numberOfLines={1}>{item.name}</Text>
                    <Text style={styles.productBrand} numberOfLines={2}>{[item.color, item.fabric, item.category, item.formality].filter(Boolean).map(titleCase).join(' | ')}</Text>
                    <View style={styles.closetItemActions}>
                      <Text style={[styles.selectText, selected && styles.selectTextActive]}>{selected ? 'Selected' : 'Tap to select'}</Text>
                      <TouchableOpacity onPress={() => updateItem(item, { favorite: !item.favorite })} disabled={busy === `update-${item.id}`}>
                        <Ionicons name={item.favorite ? 'heart' : 'heart-outline'} size={17} color={item.favorite ? '#b91c1c' : '#64748b'} />
                      </TouchableOpacity>
                      <TouchableOpacity onPress={() => removeItem(item.id)} disabled={busy === `delete-${item.id}`}>
                        <Ionicons name="trash-outline" size={17} color="#b91c1c" />
                      </TouchableOpacity>
                    </View>
                  </View>
                </Pressable>
              );
            })}
            {closetView === 'wardrobe' && !filteredItems.length ? (
              <EmptyStateCard compact icon="filter-outline" title="No matches" text="Try another category filter or add a new wardrobe item." />
            ) : null}
          </View>
        ) : null : null}
        {closetView === 'looks' ? (
          <View style={styles.looksList}>
            {outfits.map((outfit) => (
              <Pressable key={outfit.id} style={styles.latestOutfitCard} onPress={() => outfit.imageUrl && setLightbox(imageUrl(outfit.imageUrl))}>
                <ResilientImage source={outfit.imageUrl ? { uri: imageUrl(outfit.imageUrl) } : null} style={styles.latestOutfitImage} resizeMode="cover" fallbackIcon="shirt-outline" />
                <View style={styles.latestOutfitCopy}>
                  <Text style={styles.latestOutfitTitle}>{outfit.title || 'Generated outfit'}</Text>
                  <Text style={styles.muted}>{outfit.items?.map((item) => item.name).join(' + ') || outfit.occasion || 'Saved closet look'}</Text>
                </View>
              </Pressable>
            ))}
            {!outfits.length ? <StatusPanel empty text="Generated closet looks will appear here." /> : null}
          </View>
        ) : null}
        {message ? <Text style={[styles.formMessage, styles.closetMessage, /failed|missing|error|not enough|upload|select/i.test(message) ? styles.errorText : null]}>{message}</Text> : null}
      </ScrollView>
      <ImageLightbox uri={lightbox} onClose={() => setLightbox(null)} />
    </KeyboardAvoidingView>
  );
}

function CustomTryOnScreen({ user, setUser, setToken, token, onNavigate, refreshUser }) {
  const [garment, setGarment] = useState(null);
  const [result, setResult] = useState(null);
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [lightbox, setLightbox] = useState(null);
  const latestCustom = useApiState('/tryons/custom/latest', token, Boolean(user), { tryOn: null });

  if (!user) return <AuthScreen mode="signup" setUser={setUser} setToken={setToken} onNavigate={onNavigate} />;

  const avatarUri = userAvatarUrl(user);
  const bodyProfileUri = user.bodyPhotoUrl ? imageUrl(user.bodyPhotoUrl) : '';
  const avatarProfileUri = avatarUri ? imageUrl(avatarUri) : '';
  const profilePreviewUri = bodyProfileUri || avatarProfileUri;
  const profilePreviewIsFullBody = Boolean(bodyProfileUri && user.bodyPhotoSource === 'fal-full-body');
  const generatedUri = result?.imageUrl ? imageUrl(result.imageUrl) : '';
  const hasGenerated = Boolean(generatedUri);
  const latestCustomTryOn = latestCustom.data?.tryOn;

  useEffect(() => {
    if (garment || result || loading || !latestCustomTryOn?.imageUrl) return;
    setResult(latestCustomTryOn);
  }, [garment, latestCustomTryOn, loading, result]);

  const chooseGarment = async () => {
    const selected = await pickImage();
    if (!selected) return;
    setGarment(selected);
    setResult(null);
    setMessage('');
  };

  const submit = async () => {
    if (!garment) {
      setMessage('Upload a clothing photo first.');
      return;
    }
    const profileMessage = tryOnProfileBlockMessage(user);
    if (profileMessage) {
      setMessage(profileMessage);
      return;
    }
    setLoading(true);
    setMessage(hasGenerated ? 'Regenerating custom try-on...' : 'Generating custom try-on...');
    try {
      const form = new FormData();
      form.append('garment', filePart(garment, 'garment.jpg'));
      const data = await api('/tryons/custom', { method: 'POST', body: form, timeoutMs: 180000, jobTimeoutMs: 240000 });
      const nextTryOn = data.tryOn;
      setResult(nextTryOn);
      if (data.user) {
        setUser(data.user);
      }
      refreshUser?.().catch(() => {});
      latestCustom.reload?.();
      setMessage('Custom try-on ready.');
    } catch (error) {
      setMessage(aiFeatureErrorMessage(error, 'Could not generate custom try-on. Try again in a moment.'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <ScrollView style={styles.customTryOnScreen} contentContainerStyle={styles.customTryOnContent} {...screenScrollProps}>
      <View style={styles.customHeroPanel}>
        <View style={styles.customHeroMetaRow}>
          <Text style={styles.kicker}>Custom Try-On</Text>
          <View style={styles.customTokenPill}>
            <Ionicons name="sparkles" size={12} color="#9b5658" />
            <Text style={styles.customTokenText}>1 token</Text>
          </View>
        </View>
        <Text style={styles.screenTitle}>Try on any clothing photo.</Text>
        <Text style={styles.description}>Upload a garment image and Lookmefy will generate it on your saved profile photo with FitRoom.</Text>
      </View>

      <View style={styles.customUploadRow}>
        <Pressable style={styles.customProfileCard} onPress={() => profilePreviewUri && setLightbox(profilePreviewUri)}>
          {profilePreviewUri ? (
            <ResilientImage source={{ uri: profilePreviewUri }} style={styles.customProfileImage} resizeMode={profilePreviewIsFullBody ? 'contain' : 'cover'} fallbackIcon="person-outline" />
          ) : (
            <View style={styles.customProfileEmpty}>
              <Ionicons name="person-outline" size={24} color="#8d8682" />
              <Text style={styles.customProfileEmptyText}>Add profile photo</Text>
            </View>
          )}
          <View style={styles.customProfileCaption}>
            <Text style={styles.customProfileLabel}>{profilePreviewIsFullBody ? 'Full-body profile' : 'Profile photo'}</Text>
            <Text style={styles.customProfileSub} numberOfLines={1}>{user.bodyPhotoStatus === 'generating' ? 'Preparing' : 'Saved'}</Text>
          </View>
        </Pressable>
        <TouchableOpacity style={[styles.customGarmentDrop, garment?.uri && styles.customGarmentDropReady]} activeOpacity={0.86} onPress={chooseGarment}>
          {garment?.uri ? (
            <>
              <Image source={{ uri: garment.uri }} style={styles.customGarmentImage} resizeMode="cover" />
              <View style={styles.customGarmentOverlay}>
                <Ionicons name="camera-outline" size={16} color="#ffffff" />
                <Text style={styles.customGarmentOverlayText}>Change garment</Text>
              </View>
            </>
          ) : (
            <View style={styles.customGarmentCopy}>
              <View style={styles.customGarmentIcon}>
                <Ionicons name="cloud-upload-outline" size={26} color="#9b5658" />
              </View>
              <Text style={styles.customGarmentTitle}>Upload garment</Text>
              <Text style={styles.customGarmentHelp}>Use a clear product or clothing photo.</Text>
            </View>
          )}
        </TouchableOpacity>
      </View>

      <View style={styles.customResultCard}>
        <View style={styles.customResultHead}>
          <View>
            <Text style={styles.customResultTitle}>Generated try-on</Text>
            <Text style={styles.customResultSub}>{hasGenerated ? 'Generated preview' : 'Your result will appear here'}</Text>
          </View>
          {hasGenerated ? (
            <TouchableOpacity style={styles.customResultOpen} onPress={() => setLightbox(generatedUri)}>
              <Ionicons name="expand-outline" size={16} color="#111111" />
            </TouchableOpacity>
          ) : null}
        </View>
        <Pressable style={styles.customResultFrame} onPress={() => hasGenerated && setLightbox(generatedUri)}>
          {hasGenerated ? (
            <ResilientImage
              source={{ uri: generatedUri }}
              style={styles.customResultImage}
              resizeMode="cover"
              fallbackIcon="alert-circle-outline"
              fallbackText="Result unavailable. Generate again."
            />
          ) : null}
          {loading ? (
            <View style={[styles.customResultState, hasGenerated && styles.customResultStateOverlay]}>
              <TryOnLoading text={hasGenerated ? 'Regenerating' : 'Generating'} large />
            </View>
          ) : !hasGenerated ? (
            <View style={styles.customResultState}>
              <Ionicons name="sparkles-outline" size={27} color="#8d8682" />
              <Text style={styles.previewPlaceholder}>Generated try-on</Text>
            </View>
          ) : null}
        </Pressable>
      </View>

      {hasGenerated ? <AiPreviewNote style={styles.customAiPreviewNote} /> : null}
      <AppButton
        label={loading ? (hasGenerated ? 'Regenerating...' : 'Generating...') : hasGenerated ? 'Regenerate Custom Try-On' : 'Generate Custom Try-On'}
        icon="sparkles-outline"
        disabled={loading}
        onPress={submit}
        style={styles.customGenerateButton}
      />
      {message ? <Text style={[styles.formMessage, styles.customTryOnMessage, /ready|generating|regenerating/i.test(message) ? null : styles.errorText]}>{message}</Text> : null}
      <ImageLightbox uri={lightbox} onClose={() => setLightbox(null)} />
    </ScrollView>
  );
}

function StyleBotScreen({
  user,
  setUser,
  setToken,
  token,
  onNavigate,
  registerTourTarget,
  tourFocusRequest,
  aiStudioMessages,
  setAiStudioMessages,
  aiStudioTryOns,
  setAiStudioTryOns,
  aiStudioTryOnErrors,
  setAiStudioTryOnErrors
}) {
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [chatTryOnLoading, setChatTryOnLoading] = useState({});
  const [lightbox, setLightbox] = useState(null);
  const scrollRef = useRef(null);
  const composerTourTarget = useTourTarget('ai-studio-composer', registerTourTarget, { request: tourFocusRequest, scrollOffset: 84 });
  const messages = aiStudioMessages?.length ? aiStudioMessages : initialAiStudioMessages(user);
  const setMessages = setAiStudioMessages;
  const chatTryOns = aiStudioTryOns || {};
  const setChatTryOns = setAiStudioTryOns;
  const chatTryOnErrors = aiStudioTryOnErrors || {};
  const setChatTryOnErrors = setAiStudioTryOnErrors;

  const submit = async (preset) => {
    const prompt = String(preset || query || '').trim();
    if (!prompt || busy) return;
    const userMessage = { id: `user-${Date.now()}`, role: 'user', text: prompt };
    const assistantId = `assistant-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const loadingMessage = { id: assistantId, role: 'assistant', text: 'AI Studio is searching fashion...', loading: true };

    setQuery('');
    setBusy(true);
    setMessages((current) => [...current, userMessage, loadingMessage]);

    try {
      const data = await api('/recommendations/studio-chat', {
        method: 'POST',
        headers: { 'x-fitlook-sync': '1' },
        timeoutMs: 70000,
        body: JSON.stringify({
          message: prompt,
          history: messages.slice(-8).map((message) => ({ role: message.role, text: message.text }))
        })
      });
      const products = normalizeProducts(data.products || []);
      setMessages((current) => current.map((message) => (
        message.id === assistantId
          ? { ...message, text: data.reply || 'I found a few directions for you.', products, suggestions: data.suggestions || [], loading: false }
          : message
      )));
    } catch (error) {
      const messageText = isMissingRouteError(error.message)
        ? 'AI Studio is not active on the running backend. Restart the backend, then try again.'
        : error.message || 'AI Studio could not respond right now.';
      setMessages((current) => current.map((message) => (
        message.id === assistantId
          ? { ...message, text: messageText, error: true, loading: false }
          : message
      )));
    } finally {
      setBusy(false);
    }
  };

  const generateChatTryOn = async (product) => {
    const key = chatProductKey(product);
    if (!product || chatTryOnLoading[key]) return;
    const profileMessage = tryOnProfileBlockMessage(user);
    if (profileMessage) {
      setChatTryOnErrors((current) => ({ ...current, [key]: profileMessage }));
      return;
    }
    setChatTryOnLoading((current) => ({ ...current, [key]: true }));
    setChatTryOnErrors((current) => ({ ...current, [key]: '' }));
    try {
      const isExternalProduct = Boolean(product.external || product.sourceUrl || product.affiliateLink);
      const regenerate = Boolean(chatTryOns[key]?.imageUrl);
      const data = await api(isExternalProduct ? '/tryons/external' : `/tryons/${product.id}`, {
        method: 'POST',
        timeoutMs: 180000,
        body: JSON.stringify(isExternalProduct ? { product, force: regenerate } : { force: regenerate })
      });
      setChatTryOns((current) => ({ ...current, [key]: data.tryOn }));
      if (regenerate && data.reused) {
        setChatTryOnErrors((current) => ({ ...current, [key]: 'Existing try-on was reused. Restart the backend with the latest code, then try again.' }));
      }
      if (data.user) setUser(data.user);
    } catch (error) {
      setChatTryOnErrors((current) => ({ ...current, [key]: aiFeatureErrorMessage(error, 'Could not generate try-on.') }));
    } finally {
      setChatTryOnLoading((current) => ({ ...current, [key]: false }));
    }
  };

  useEffect(() => {
    const timer = setTimeout(() => scrollRef.current?.scrollToEnd?.({ animated: true }), 80);
    return () => clearTimeout(timer);
  }, [messages.length, busy]);

  useEffect(() => {
    if (user && !aiStudioMessages?.length) setMessages(initialAiStudioMessages(user));
  }, [aiStudioMessages?.length, setMessages, user?.id, user?._id, user?.phone]);

  if (!user) return <AuthScreen mode="signup" setUser={setUser} setToken={setToken} onNavigate={onNavigate} />;

  const hasUserMessages = messages.some((message) => message.role === 'user');

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.aiStudioScreen}>
      <ProductTopBar onNavigate={onNavigate} user={user} />
      <ScrollView ref={scrollRef} contentContainerStyle={styles.aiStudioContent} {...screenScrollProps}>
        <View style={styles.aiChatThread}>
          {messages.map((message) => {
            const userBubble = message.role === 'user';
            return (
              <View key={message.id} style={styles.aiMessageBlock}>
                <View style={[styles.aiMessageBubble, userBubble ? styles.aiMessageBubbleUser : styles.aiMessageBubbleAssistant, message.error && styles.aiMessageBubbleError]}>
                  {message.loading ? <ActivityIndicator size="small" color="#9b5658" /> : null}
                  <Text style={[styles.aiMessageText, userBubble && styles.aiMessageTextUser, message.error && styles.aiMessageTextError]}>{message.text}</Text>
                </View>
                {message.products?.length ? (
                  <ScrollView {...horizontalScrollProps} contentContainerStyle={styles.aiSuggestionProductsTrack}>
                    {message.products.map((product) => {
                      const key = chatProductKey(product);
                      const tryOn = chatTryOns[key];
                      return (
                        <ConciergeSuggestionCard
                          key={key}
                          product={product}
                          actionLabel={tryOn?.imageUrl ? 'Generate Again' : 'Generate Try-On'}
                          tryOn={tryOn}
                          tryOnLoading={Boolean(chatTryOnLoading[key])}
                          tryOnError={chatTryOnErrors[key]}
                          onPreview={tryOn?.imageUrl ? () => setLightbox(imageUrl(tryOn.imageUrl)) : null}
                          onShop={() => product.affiliateLink ? openExternalWebUrl(product.affiliateLink) : onNavigate('product', { id: product.id })}
                          onTryOn={() => generateChatTryOn(product)}
                        />
                      );
                    })}
                  </ScrollView>
                ) : null}
                {message.suggestions?.length ? (
                  <View style={styles.aiFollowUpRow}>
                    {message.suggestions.map((suggestion) => (
                      <TouchableOpacity key={suggestion} style={styles.aiFollowUpChip} activeOpacity={0.82} onPress={() => submit(suggestion)}>
                        <Text style={styles.aiFollowUpText}>{suggestion}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                ) : null}
              </View>
            );
          })}
        </View>

        {!hasUserMessages ? (
          <View style={styles.aiStarterPanel}>
            <Text style={styles.aiStarterTitle}>Try a fashion search</Text>
            <View style={styles.aiStarterGrid}>
              {aiStudioStarterPrompts.map((starter) => (
                <TouchableOpacity key={starter.prompt} style={styles.aiStarterCard} activeOpacity={0.82} onPress={() => submit(starter.prompt)}>
                  <View style={styles.aiStarterIcon}>
                    <Ionicons name={starter.icon} size={19} color="#9b5658" />
                  </View>
                  <View style={styles.aiStarterCopy}>
                    <Text style={styles.aiStarterCardTitle}>{starter.title}</Text>
                    <Text style={styles.aiStarterCardText}>{starter.text}</Text>
                  </View>
                  <Ionicons name="arrow-forward" size={17} color="#9b5658" />
                </TouchableOpacity>
              ))}
            </View>
          </View>
        ) : null}
      </ScrollView>

      <View ref={composerTourTarget.ref} onLayout={composerTourTarget.onLayout} style={styles.aiComposer}>
        <TextInput style={styles.aiComposerInput} value={query} onChangeText={setQuery} placeholder="Search shirts, shoes, jackets..." placeholderTextColor="#8d8682" returnKeyType="send" onSubmitEditing={() => submit()} />
        <TouchableOpacity style={[styles.aiSendButton, (!query.trim() || busy) && styles.disabledButton]} disabled={!query.trim() || busy} onPress={() => submit()}>
          <Ionicons name={busy ? 'hourglass-outline' : 'send'} size={22} color="#ffffff" />
        </TouchableOpacity>
      </View>
      <ImageLightbox uri={lightbox} onClose={() => setLightbox(null)} />
    </KeyboardAvoidingView>
  );
}

const fallbackSubscriptionPlan = {
  id: 'monthly_150_credits',
  type: 'subscription',
  purchaseType: 'subscription_setup',
  name: 'FitLook Monthly',
  headline: '150 credits every month',
  amount: 49900,
  currency: 'INR',
  tokens: 150,
  credits: 150,
  billingFrequency: 'monthly',
  cadence: 'Monthly',
  ratePerCredit: 3.33,
  appStoreProductId: STOREKIT_MONTHLY_SUBSCRIPTION_PRODUCT_ID,
  description: '150 credits every month for AI try-on images, videos, and styling work.',
  summary: 'Cancel future monthly billing before the next renewal from your account or by contacting support.'
};

const fallbackTopUpPlans = [
  { id: 'top_up_50_credits', type: 'top_up', name: 'Top-up', headline: '50 credits', amount: 19900, currency: 'INR', tokens: 50, credits: 50, billingFrequency: 'one_time', cadence: 'One-time', ratePerCredit: 3.98, description: 'One-time refill for extra image try-ons and videos.' },
  { id: 'top_up_75_credits', type: 'top_up', name: 'Top-up', headline: '75 credits', amount: 29900, currency: 'INR', tokens: 75, credits: 75, billingFrequency: 'one_time', cadence: 'One-time', ratePerCredit: 3.99, description: 'One-time refill for extra image try-ons and videos.' },
  { id: 'top_up_110_credits', type: 'top_up', name: 'Top-up', headline: '110 credits', amount: 39900, currency: 'INR', tokens: 110, credits: 110, billingFrequency: 'one_time', cadence: 'One-time', ratePerCredit: 3.63, description: 'Better value for product batches and style exploration.' },
  { id: 'top_up_135_credits', type: 'top_up', name: 'Top-up', headline: '135 credits', amount: 49900, currency: 'INR', tokens: 135, credits: 135, billingFrequency: 'one_time', cadence: 'One-time', ratePerCredit: 3.7, description: 'Better value for product batches and style exploration.' },
  { id: 'top_up_400_credits', type: 'top_up', name: 'Top-up', headline: '400 credits', amount: 99900, currency: 'INR', tokens: 400, credits: 400, billingFrequency: 'one_time', cadence: 'One-time', ratePerCredit: 2.5, badge: 'Best value', description: 'Best value for bulk catalog work and repeated video trials.' }
];

const fallbackPaymentCatalog = {
  subscription: fallbackSubscriptionPlan,
  topUps: fallbackTopUpPlans,
  appStoreProductIds: {
    monthlySubscription: STOREKIT_MONTHLY_SUBSCRIPTION_PRODUCT_ID,
    credits150: STOREKIT_CREDITS_150_PRODUCT_ID
  },
  creditCosts: { starterCredits: 8, image: 1, customTryOn: 1, video: 3 }
};

function normalizePaymentPlan(plan = {}, fallback = {}) {
  const amount = Number(plan.amount ?? fallback.amount) || 0;
  const credits = Number(plan.credits ?? plan.tokens ?? fallback.credits ?? fallback.tokens) || 0;
  const rate = Number(plan.ratePerCredit ?? fallback.ratePerCredit);
  return {
    ...fallback,
    ...plan,
    amount,
    tokens: credits,
    credits,
    currency: plan.currency || fallback.currency || 'INR',
    ratePerCredit: Number.isFinite(rate) && rate > 0 ? rate : Number((amount / 100 / Math.max(1, credits)).toFixed(2))
  };
}

function PaymentSummaryLine({ label, value, strong }) {
  return (
    <View style={styles.paymentSummaryLine}>
      <Text style={styles.paymentSummaryLabel}>{label}</Text>
      <Text style={[styles.paymentSummaryValue, strong && styles.paymentSummaryValueStrong]} numberOfLines={2}>{value}</Text>
    </View>
  );
}

function MonthlyCreditCard({ plan, selected, active, onPress }) {
  return (
    <TouchableOpacity activeOpacity={0.88} style={[styles.creditMandateCard, selected && styles.creditMandateCardSelected]} onPress={onPress}>
      <View style={styles.creditSelectedRow}>
        {selected ? <Text style={styles.creditSelectedPill}>SELECTED</Text> : null}
        {active ? <Text style={styles.creditActivePill}>ACTIVE</Text> : null}
      </View>
      <Text style={styles.creditCardKicker}>FITLOOK MONTHLY</Text>
      <Text style={styles.creditMandateTitle}>{plan.headline || `${plan.credits} credits every month`}</Text>
      <Text style={styles.creditMandateSub}>{plan.credits} credits every month</Text>
      <Text style={styles.creditMutedText}>{formatCreditRate(plan)}</Text>
      <Text style={styles.creditCapsText}>{formatMoney((Number(plan.amount) || 0) / 100, plan.currency)}/month</Text>
      <Text style={styles.creditCardDescription}>{plan.summary || 'Cancel future monthly billing before the next renewal.'}</Text>
    </TouchableOpacity>
  );
}

function AddMoreCard({ selected, onPress }) {
  return (
    <TouchableOpacity activeOpacity={0.88} style={[styles.creditAddMoreCard, selected && styles.creditMandateCardSelected]} onPress={onPress}>
      <Text style={styles.creditCardKicker}>TOP-UP</Text>
      <Text style={styles.creditAddMoreTitle}>Add more</Text>
      <Text style={styles.creditMandateSub}>One-time packs</Text>
      <Text style={styles.creditCapsText}>NO SUBSCRIPTION CHANGE</Text>
      <Text style={styles.creditCardDescription}>Choose 50, 75, 110, 135, or 400 extra credits for image try-ons and videos.</Text>
    </TouchableOpacity>
  );
}

function TopUpCreditCard({ plan, selected, onPress }) {
  return (
    <TouchableOpacity activeOpacity={0.88} style={[styles.topUpCreditCard, selected && styles.creditMandateCardSelected]} onPress={onPress}>
      {selected ? <Text style={styles.creditSelectedPill}>SELECTED</Text> : null}
      {plan.badge ? <Text style={styles.topUpBestValue}>{String(plan.badge).toUpperCase()}</Text> : null}
      <Text style={styles.creditCardKicker}>TOP-UP</Text>
      <Text style={styles.topUpPrice}>{formatMoney((Number(plan.amount) || 0) / 100, plan.currency)}</Text>
      <Text style={styles.creditMandateSub}>{plan.credits} credits</Text>
      <Text style={styles.creditMutedText}>{formatCreditRate(plan)}</Text>
      <Text style={styles.creditCapsText}>{String(plan.cadence || 'One-time').toUpperCase()}</Text>
      <Text style={styles.creditCardDescription}>{plan.description}</Text>
    </TouchableOpacity>
  );
}

function loadExpoIapModule() {
  if (Platform.OS !== 'ios') return null;
  try {
    return require('expo-iap');
  } catch {
    return null;
  }
}

function storeKitProductPrice(product) {
  return product?.displayPrice || product?.localizedPriceIOS || product?.localizedPrice || '';
}

function storeKitProductTitle(product, fallback) {
  return product?.displayName || product?.displayNameIOS || product?.title || fallback;
}

function findStoreKitProduct(items, productId) {
  return (Array.isArray(items) ? items : []).find((item) => item?.id === productId || item?.productId === productId) || null;
}

function isStoreKitCancel(error) {
  return /cancel/i.test(String(error?.code || error?.message || ''));
}

function applePurchaseServerPayload(purchase = {}) {
  return {
    id: purchase.id || '',
    productId: purchase.productId || purchase.currentPlanId || '',
    transactionId: purchase.transactionId || purchase.id || '',
    transactionDate: purchase.transactionDate || null,
    purchaseToken: purchase.purchaseToken || '',
    transactionReceipt: purchase.transactionReceipt || '',
    appAccountToken: purchase.appAccountToken || '',
    environmentIOS: purchase.environmentIOS || purchase.environmentIos || '',
    expirationDateIOS: purchase.expirationDateIOS || purchase.expirationDateIos || null,
    originalTransactionIdentifierIOS: purchase.originalTransactionIdentifierIOS || purchase.originalTransactionIdentifierIos || '',
    webOrderLineItemIdIOS: purchase.webOrderLineItemIdIOS || '',
    revocationDateIOS: purchase.revocationDateIOS || null,
    revocationReasonIOS: purchase.revocationReasonIOS || '',
    reasonIOS: purchase.reasonIOS || purchase.transactionReasonIOS || '',
    store: purchase.store || 'app-store'
  };
}

function isLookmefyStoreKitPurchase(purchase = {}) {
  const productId = String(purchase.productId || purchase.currentPlanId || '').trim();
  return productId === STOREKIT_MONTHLY_SUBSCRIPTION_PRODUCT_ID || productId === STOREKIT_CREDITS_150_PRODUCT_ID;
}

function useAppleStoreKitPayments({ enabled, user, setUser, onRequireAuth }) {
  const [state, setState] = useState({
    available: enabled,
    connected: false,
    loading: enabled,
    syncing: false,
    restoring: false,
    verifying: false,
    purchasePending: false,
    purchasingProductId: '',
    statusMessage: '',
    error: '',
    unavailableReason: '',
    subscriptionProduct: null,
    creditsProduct: null,
    activeSubscriptions: []
  });
  const iapRef = useRef(null);
  const processingRef = useRef(new Set());

  const updateState = useCallback((patch) => {
    setState((current) => ({ ...current, ...patch }));
  }, []);

  const finishStoreKitTransaction = useCallback(async (purchase) => {
    const iap = iapRef.current;
    if (!iap?.finishTransaction) return;
    try {
      await iap.finishTransaction({
        purchase,
        isConsumable: String(purchase?.productId || '') === STOREKIT_CREDITS_150_PRODUCT_ID
      });
    } catch (error) {
      updateState({ error: `Apple verified the purchase, but finishing it failed: ${error.message}` });
    }
  }, [updateState]);

  const refreshProducts = useCallback(async () => {
    if (!enabled) return;
    const iap = iapRef.current;
    if (!iap) {
      updateState({
        loading: false,
        available: false,
        unavailableReason: 'StoreKit is unavailable in this build.'
      });
      return;
    }

    updateState({ loading: true, error: '', unavailableReason: '' });
    try {
      const [subscriptionProducts, consumableProducts, activeSubscriptions] = await Promise.all([
        iap.fetchProducts({ skus: [STOREKIT_MONTHLY_SUBSCRIPTION_PRODUCT_ID], type: 'subs' }),
        iap.fetchProducts({ skus: [STOREKIT_CREDITS_150_PRODUCT_ID], type: 'in-app' }),
        iap.getActiveSubscriptions ? iap.getActiveSubscriptions([STOREKIT_MONTHLY_SUBSCRIPTION_PRODUCT_ID]).catch(() => []) : []
      ]);
      const subscriptionProduct = findStoreKitProduct(subscriptionProducts, STOREKIT_MONTHLY_SUBSCRIPTION_PRODUCT_ID);
      const creditsProduct = findStoreKitProduct(consumableProducts, STOREKIT_CREDITS_150_PRODUCT_ID);
      updateState({
        loading: false,
        connected: true,
        subscriptionProduct,
        creditsProduct,
        activeSubscriptions: Array.isArray(activeSubscriptions) ? activeSubscriptions : [],
        unavailableReason: !subscriptionProduct || !creditsProduct ? 'App Store products are not available for this Apple ID/build yet.' : ''
      });
    } catch (error) {
      updateState({
        loading: false,
        connected: false,
        error: error.message || 'Could not load App Store products.',
        unavailableReason: 'App Store products could not be loaded.'
      });
    }
  }, [enabled, updateState]);

  const syncCurrentEntitlements = useCallback(async ({ silent = false } = {}) => {
    if (!enabled || !user) return;
    const iap = iapRef.current;
    if (!iap) return;

    updateState({
      syncing: !silent,
      error: '',
      ...(silent ? {} : { statusMessage: 'Syncing App Store status...' })
    });
    try {
      const availablePurchases = iap.getAvailablePurchases
        ? await iap.getAvailablePurchases({ onlyIncludeActiveItemsIOS: false, alsoPublishToEventListenerIOS: false })
        : [];
      const relevantPurchases = (Array.isArray(availablePurchases) ? availablePurchases : []).filter(isLookmefyStoreKitPurchase);
      if (relevantPurchases.length) {
        const restoreResult = await api('/payments/apple/restore', {
          method: 'POST',
          body: JSON.stringify({ purchases: relevantPurchases.map(applePurchaseServerPayload) })
        });
        if (restoreResult.user) setUser(restoreResult.user);
        for (const purchase of relevantPurchases) await finishStoreKitTransaction(purchase);
      }

      const statusResult = await api('/payments/apple/status', { noCache: true });
      if (statusResult.user) setUser(statusResult.user);
      updateState({
        syncing: false,
        error: '',
        ...(silent ? {} : { statusMessage: 'App Store status is up to date.' })
      });
    } catch (error) {
      updateState({
        syncing: false,
        error: error.message || 'Could not sync App Store status.'
      });
    }
  }, [enabled, finishStoreKitTransaction, setUser, updateState, user]);

  const verifyPurchase = useCallback(async (purchase, source = 'purchase') => {
    if (!enabled || !isLookmefyStoreKitPurchase(purchase)) return false;
    if (!user) {
      onRequireAuth?.('Log in with your mobile number before completing an App Store purchase.');
      updateState({ purchasePending: false, purchasingProductId: '', error: 'Log in before completing this App Store purchase.' });
      return false;
    }

    const key = String(purchase.transactionId || purchase.id || purchase.purchaseToken || purchase.productId || '');
    if (key && processingRef.current.has(key)) return false;
    if (key) processingRef.current.add(key);

    updateState({
      verifying: true,
      purchasePending: false,
      statusMessage: 'Verifying App Store purchase...',
      error: ''
    });

    try {
      const result = await api('/payments/apple/transactions', {
        method: 'POST',
        body: JSON.stringify({
          source,
          purchase: applePurchaseServerPayload(purchase)
        })
      });
      if (result.user) setUser(result.user);
      await finishStoreKitTransaction(purchase);
      updateState({
        verifying: false,
        purchasingProductId: '',
        statusMessage: result.grantedCredits
          ? `Apple purchase verified. ${result.grantedCredits} credits added.`
          : 'Apple purchase verified.',
        error: ''
      });
      return true;
    } catch (error) {
      updateState({
        verifying: false,
        purchasingProductId: '',
        error: error.message || 'Apple purchase verification failed.'
      });
      return false;
    } finally {
      if (key) processingRef.current.delete(key);
    }
  }, [enabled, finishStoreKitTransaction, onRequireAuth, setUser, updateState, user]);

  useEffect(() => {
    if (!enabled) return undefined;
    const iap = loadExpoIapModule();
    iapRef.current = iap;
    if (!iap) {
      updateState({
        available: false,
        loading: false,
        unavailableReason: 'StoreKit is unavailable in this build. Create a development or App Store build with expo-iap.'
      });
      return undefined;
    }

    let alive = true;
    const purchaseSubscription = iap.purchaseUpdatedListener?.((purchase) => {
      if (alive) verifyPurchase(purchase, 'purchase');
    });
    const errorSubscription = iap.purchaseErrorListener?.((error) => {
      if (!alive) return;
      updateState({
        purchasePending: false,
        purchasingProductId: '',
        statusMessage: isStoreKitCancel(error) ? 'Purchase cancelled.' : '',
        error: isStoreKitCancel(error) ? '' : error.message || 'Apple purchase failed.'
      });
    });

    iap.initConnection()
      .then(() => {
        if (!alive) return;
        updateState({ connected: true });
        refreshProducts();
      })
      .catch((error) => {
        if (!alive) return;
        updateState({
          available: false,
          loading: false,
          connected: false,
          error: error.message || 'Could not connect to the App Store.',
          unavailableReason: 'Could not connect to the App Store.'
        });
      });

    return () => {
      alive = false;
      purchaseSubscription?.remove?.();
      errorSubscription?.remove?.();
      iap.endConnection?.().catch?.(() => {});
    };
  }, [enabled, refreshProducts, updateState, verifyPurchase]);

  useEffect(() => {
    if (enabled && state.connected && user?.id) {
      syncCurrentEntitlements({ silent: true });
    }
  }, [enabled, state.connected, syncCurrentEntitlements, user?.id]);

  const requestStoreKitPurchase = useCallback(async ({ productId, type }) => {
    if (!enabled) return;
    if (!user) {
      onRequireAuth?.('Log in with your mobile number to buy credits.');
      return;
    }
    const iap = iapRef.current;
    if (!iap || !state.connected) {
      updateState({ error: 'App Store payments are not ready yet.' });
      return;
    }
    const product = productId === STOREKIT_MONTHLY_SUBSCRIPTION_PRODUCT_ID ? state.subscriptionProduct : state.creditsProduct;
    if (!product) {
      updateState({ error: 'This App Store product is unavailable for the current build or Apple ID.' });
      return;
    }
    const appAccountToken = storeKitAppAccountTokenForUser(user);
    if (!appAccountToken) {
      updateState({ error: 'Could not link this App Store purchase to your Lookmefy account.' });
      return;
    }

    updateState({
      purchasePending: true,
      purchasingProductId: productId,
      statusMessage: 'Opening App Store purchase sheet...',
      error: ''
    });

    try {
      await iap.requestPurchase({
        request: {
          apple: {
            sku: productId,
            appAccountToken,
            quantity: productId === STOREKIT_CREDITS_150_PRODUCT_ID ? 1 : undefined,
            andDangerouslyFinishTransactionAutomatically: false
          }
        },
        type
      });
      updateState({ statusMessage: 'Waiting for App Store confirmation...' });
    } catch (error) {
      updateState({
        purchasePending: false,
        purchasingProductId: '',
        statusMessage: isStoreKitCancel(error) ? 'Purchase cancelled.' : '',
        error: isStoreKitCancel(error) ? '' : error.message || 'Could not start App Store purchase.'
      });
    }
  }, [enabled, onRequireAuth, state.connected, state.creditsProduct, state.subscriptionProduct, updateState, user]);

  const restorePurchases = useCallback(async () => {
    if (!enabled || !user) {
      onRequireAuth?.('Log in with your mobile number to restore App Store purchases.');
      return;
    }
    updateState({ restoring: true, statusMessage: 'Restoring App Store purchases...', error: '' });
    await syncCurrentEntitlements({ silent: false });
    updateState({ restoring: false });
  }, [enabled, onRequireAuth, syncCurrentEntitlements, updateState, user]);

  const manageSubscription = useCallback(async () => {
    const iap = iapRef.current;
    try {
      await iap?.deepLinkToSubscriptions?.();
    } catch (error) {
      updateState({ error: error.message || 'Could not open App Store subscription settings.' });
    }
  }, [updateState]);

  return {
    ...state,
    purchaseMonthly: () => requestStoreKitPurchase({ productId: STOREKIT_MONTHLY_SUBSCRIPTION_PRODUCT_ID, type: 'subs' }),
    purchaseCredits: () => requestStoreKitPurchase({ productId: STOREKIT_CREDITS_150_PRODUCT_ID, type: 'in-app' }),
    restorePurchases,
    syncCurrentEntitlements,
    refreshProducts,
    manageSubscription
  };
}

function AppleStoreKitCreditCard({ selected, active, product, title, kicker, headline, subhead, description, onPress }) {
  const price = storeKitProductPrice(product);
  return (
    <TouchableOpacity activeOpacity={0.88} style={[styles.creditMandateCard, selected && styles.creditMandateCardSelected]} onPress={onPress}>
      <View style={styles.creditSelectedRow}>
        {selected ? <Text style={styles.creditSelectedPill}>SELECTED</Text> : null}
        {active ? <Text style={styles.creditActivePill}>ACTIVE</Text> : null}
      </View>
      <Text style={styles.creditCardKicker}>{kicker}</Text>
      <Text style={styles.creditMandateTitle}>{headline}</Text>
      <Text style={styles.creditMandateSub}>{subhead}</Text>
      <Text style={styles.creditMutedText}>{price || 'Unavailable'}</Text>
      <Text style={styles.creditCapsText}>{storeKitProductTitle(product, title)}</Text>
      <Text style={styles.creditCardDescription}>{description}</Text>
    </TouchableOpacity>
  );
}

function AppleStoreKitActions({ mode, appleStoreKit, activeMonthly }) {
  const buyingSubscription = appleStoreKit.purchasingProductId === STOREKIT_MONTHLY_SUBSCRIPTION_PRODUCT_ID;
  const buyingCredits = appleStoreKit.purchasingProductId === STOREKIT_CREDITS_150_PRODUCT_ID;
  const busy = appleStoreKit.loading || appleStoreKit.verifying || appleStoreKit.purchasePending || appleStoreKit.syncing || appleStoreKit.restoring;
  const selectedProduct = mode === 'top_up' ? appleStoreKit.creditsProduct : appleStoreKit.subscriptionProduct;
  const disabled = busy || !appleStoreKit.connected || !selectedProduct || (mode === 'subscription' && activeMonthly);
  let label = mode === 'top_up' ? 'BUY 150 CREDITS' : 'SUBSCRIBE WITH APPLE';
  if (appleStoreKit.loading) label = 'LOADING APP STORE';
  else if (appleStoreKit.restoring) label = 'RESTORING PURCHASES';
  else if (appleStoreKit.syncing) label = 'SYNCING STATUS';
  else if (buyingSubscription || buyingCredits || appleStoreKit.purchasePending) label = 'WAITING FOR APP STORE';
  else if (appleStoreKit.verifying) label = 'VERIFYING PURCHASE';
  else if (mode === 'subscription' && activeMonthly) label = 'MONTHLY ACTIVE';

  return (
    <>
      <TouchableOpacity
        style={[styles.secureCheckoutButton, disabled && styles.disabledButton]}
        activeOpacity={0.88}
        disabled={disabled}
        onPress={mode === 'top_up' ? appleStoreKit.purchaseCredits : appleStoreKit.purchaseMonthly}
      >
        <Text style={styles.secureCheckoutText}>{label}</Text>
      </TouchableOpacity>

      <View style={styles.appleStoreActionRow}>
        <TouchableOpacity style={styles.appleStoreActionButton} activeOpacity={0.82} disabled={busy} onPress={appleStoreKit.restorePurchases}>
          <Ionicons name="cloud-download-outline" size={16} color="#5e3335" />
          <Text style={styles.verifyPaymentText}>RESTORE</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.appleStoreActionButton} activeOpacity={0.82} disabled={busy} onPress={() => appleStoreKit.syncCurrentEntitlements({ silent: false })}>
          <Ionicons name="refresh" size={16} color="#5e3335" />
          <Text style={styles.verifyPaymentText}>SYNC STATUS</Text>
        </TouchableOpacity>
      </View>

      {activeMonthly ? (
        <TouchableOpacity style={styles.verifyPaymentButton} activeOpacity={0.82} onPress={appleStoreKit.manageSubscription}>
          <Ionicons name="settings-outline" size={16} color="#5e3335" />
          <Text style={styles.verifyPaymentText}>MANAGE APP STORE SUBSCRIPTION</Text>
        </TouchableOpacity>
      ) : null}
    </>
  );
}

function TokensScreen({ user, setUser, onNavigate, onRequireAuth }) {
  const [checkoutLoading, setCheckoutLoading] = useState(false);
  const [cancelLoading, setCancelLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [catalog, setCatalog] = useState(fallbackPaymentCatalog);
  const [plansLoading, setPlansLoading] = useState(true);
  const [mode, setMode] = useState('subscription');
  const [selectedTopUpId, setSelectedTopUpId] = useState(fallbackTopUpPlans[0].id);
  const [pendingOrderId, setPendingOrderId] = useState('');
  const verifyingOrderRef = useRef('');
  const appStateRef = useRef(AppState.currentState);

  const subscriptionPlan = useMemo(() => normalizePaymentPlan(catalog.subscription, fallbackSubscriptionPlan), [catalog.subscription]);
  const topUpPlans = useMemo(() => {
    const plans = Array.isArray(catalog.topUps) && catalog.topUps.length ? catalog.topUps : fallbackTopUpPlans;
    return plans.map((item, index) => normalizePaymentPlan(item, fallbackTopUpPlans[index] || fallbackTopUpPlans[0]));
  }, [catalog.topUps]);
  const selectedTopUp = topUpPlans.find((item) => item.id === selectedTopUpId) || topUpPlans[0];
  const selectedPlan = mode === 'top_up' ? selectedTopUp : subscriptionPlan;
  const selectedAmount = (Number(selectedPlan.amount) || 0) / 100;
  const creditCosts = catalog.creditCosts || fallbackPaymentCatalog.creditCosts;
  const subscription = user?.subscription;
  const subscriptionStatus = String(subscription?.status || '').toLowerCase();
  const subscriptionPeriodActive = !subscription?.currentPeriodEnd || new Date(subscription.currentPeriodEnd) > new Date();
  const activeMonthly = ['active', 'billing_grace'].includes(subscriptionStatus) && subscriptionPeriodActive;
  const isAppleCheckout = Platform.OS === 'ios';
  const activeAppleMonthly = isAppleCheckout && subscription?.provider === 'apple' && activeMonthly;
  const appleStoreKit = useAppleStoreKitPayments({ enabled: isAppleCheckout, user, setUser, onRequireAuth });
  const appleSelectedProduct = mode === 'top_up' ? appleStoreKit.creditsProduct : appleStoreKit.subscriptionProduct;
  const appleSelectedPrice = storeKitProductPrice(appleSelectedProduct) || 'Unavailable';
  const appleSelectedProductId = mode === 'top_up' ? STOREKIT_CREDITS_150_PRODUCT_ID : STOREKIT_MONTHLY_SUBSCRIPTION_PRODUCT_ID;
  const visibleMessage = isAppleCheckout
    ? appleStoreKit.error || appleStoreKit.statusMessage || appleStoreKit.unavailableReason
    : message;
  const firstPaymentDate = formatDate(addDays(new Date(), 1));
  const messageIsError = isAppleCheckout
    ? Boolean(appleStoreKit.error || appleStoreKit.unavailableReason)
    : /failed|missing|not|error|could not|unavailable/i.test(message);

  useEffect(() => {
    let alive = true;
    setPlansLoading(true);
    api('/payments/plans')
      .then((data) => {
        if (!alive) return;
        const topUps = Array.isArray(data?.topUps) && data.topUps.length
          ? data.topUps
          : Array.isArray(data?.plans)
            ? data.plans.filter((item) => item.type === 'top_up')
            : [];
        const subscriptionFromPlans = data?.subscription || (Array.isArray(data?.plans) ? data.plans.find((item) => item.type === 'subscription') : null);
        setCatalog({
          subscription: subscriptionFromPlans || fallbackSubscriptionPlan,
          topUps: topUps.length ? topUps : fallbackTopUpPlans,
          appStoreProductIds: data?.appStoreProductIds || fallbackPaymentCatalog.appStoreProductIds,
          creditCosts: data?.creditCosts || fallbackPaymentCatalog.creditCosts
        });
        if (topUps[0]?.id) setSelectedTopUpId(topUps[0].id);
        setMessage('');
      })
      .catch((error) => {
        if (alive) setMessage(error.message);
      })
      .finally(() => {
        if (alive) setPlansLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const verifyPaymentOrder = useCallback(async (merchantOrderId, silent = false) => {
    if (!user || !merchantOrderId || verifyingOrderRef.current === merchantOrderId) return;
    verifyingOrderRef.current = merchantOrderId;
    if (!silent) setMessage('Verifying payment with PhonePe...');
    try {
      const data = await api(`/payments/orders/${encodeURIComponent(merchantOrderId)}/status`, { noCache: true });
      if (data.user) setUser(data.user);
      const state = data.order?.status;
      const credits = Number(data.order?.tokens) || Number(selectedPlan.credits) || 0;
      if (state === 'completed') {
        setPendingOrderId('');
        setMessage(`${data.order?.purchaseType === 'top_up' ? 'Top-up confirmed' : 'Monthly mandate confirmed'}. ${credits} credits have been added.`);
      } else if (state === 'failed') {
        setPendingOrderId('');
        setMessage('Payment was not completed. You can try again when ready.');
      } else {
        setPendingOrderId(merchantOrderId);
        setMessage('Payment is still pending. Return here again in a moment to refresh.');
      }
    } catch (error) {
      setMessage(error.message);
    } finally {
      verifyingOrderRef.current = '';
    }
  }, [selectedPlan.credits, setUser, user]);

  useEffect(() => {
    const handleUrl = ({ url }) => {
      const merchantOrderId = merchantOrderIdFromUrl(url);
      if (merchantOrderId) verifyPaymentOrder(merchantOrderId);
    };

    Linking.getInitialURL().then((url) => {
      const merchantOrderId = merchantOrderIdFromUrl(url);
      if (merchantOrderId) verifyPaymentOrder(merchantOrderId);
    }).catch(() => {});
    const subscriptionHandle = Linking.addEventListener('url', handleUrl);
    return () => subscriptionHandle.remove();
  }, [verifyPaymentOrder]);

  useEffect(() => {
    const subscriptionHandle = AppState.addEventListener('change', (nextState) => {
      const wasAway = /inactive|background/.test(appStateRef.current || '');
      appStateRef.current = nextState;
      if (nextState === 'active' && wasAway && pendingOrderId) {
        verifyPaymentOrder(pendingOrderId, true);
      }
    });
    return () => subscriptionHandle.remove();
  }, [pendingOrderId, verifyPaymentOrder]);

  const startCheckout = useCallback(async () => {
    if (!user) {
      onRequireAuth?.('Log in with your mobile number to buy credits.');
      return;
    }
    if (!selectedPlan?.id) return;

    setCheckoutLoading(true);
    setMessage(mode === 'top_up' ? 'Opening PhonePe checkout...' : 'Opening PhonePe mandate setup...');
    try {
      const endpoint = mode === 'top_up' ? '/payments/phonepe/top-up' : '/payments/phonepe/subscription';
      const data = await api(endpoint, {
        method: 'POST',
        body: JSON.stringify({
          planId: selectedPlan.id,
          platform: Platform.OS,
          redirectUrl: mobilePaymentReturnUrl()
        })
      });
      const paymentUrl = data.paymentUrl || data.redirectUrl;
      const merchantOrderId = data.order?.merchantOrderId || '';
      if (merchantOrderId) setPendingOrderId(merchantOrderId);
      if (paymentUrl) {
        await Linking.openURL(paymentUrl);
        setMessage('Complete payment in PhonePe, then return to Lookmefy.');
      } else {
        setMessage('PhonePe did not return a checkout link. Please try again.');
      }
    } catch (error) {
      setMessage(error.message);
    } finally {
      setCheckoutLoading(false);
    }
  }, [mode, onRequireAuth, selectedPlan?.id, user]);

  const cancelSubscription = useCallback(() => {
    if (!activeMonthly || cancelLoading) return;
    Alert.alert(
      'Cancel monthly billing?',
      'Your current credits stay available. Future monthly PhonePe debits will be cancelled.',
      [
        { text: 'Keep Plan', style: 'cancel' },
        {
          text: 'Cancel Billing',
          style: 'destructive',
          onPress: async () => {
            setCancelLoading(true);
            setMessage('Cancelling monthly mandate...');
            try {
              const data = await api('/payments/subscriptions/current/cancel', { method: 'POST', noCache: true });
              if (data.user) setUser(data.user);
              setMessage('Monthly billing has been cancelled.');
            } catch (error) {
              setMessage(error.message);
            } finally {
              setCancelLoading(false);
            }
          }
        }
      ]
    );
  }, [activeMonthly, cancelLoading, setUser]);

  return (
    <ScrollView style={styles.creditsScreen} contentContainerStyle={styles.creditsContent} {...screenScrollProps}>
      <AppHeader onNavigate={onNavigate} user={user} compact />

      <View style={styles.creditsHero}>
        <View style={styles.creditsHeroCopy}>
          <Text style={styles.creditsEyebrow}>{mode === 'top_up' ? 'ONE-TIME REFILL' : 'TOKEN ACCESS'}</Text>
          <Text style={styles.creditsHeroTitle}>{mode === 'top_up' ? 'Top-ups' : 'Credits'}</Text>
          {mode === 'top_up' ? (
            <TouchableOpacity activeOpacity={0.78} onPress={() => setMode('subscription')}>
              <Text style={styles.creditsBackLink}>BACK TO MANDATE</Text>
            </TouchableOpacity>
          ) : null}
        </View>
        <Text style={styles.creditsHeroText}>
          {mode === 'top_up'
            ? 'Choose a one-time credit pack when you want extra image try-ons or videos on top of the monthly membership.'
            : `Pick the monthly mandate setup or open one-time top-ups. Starter accounts include ${creditCosts.starterCredits} credits, images use ${creditCosts.image} credit, and videos use ${creditCosts.video} credits.`}
        </Text>
      </View>

      {plansLoading || (isAppleCheckout && appleStoreKit.loading) ? <ActivityIndicator style={styles.creditsLoader} size="small" color="#9b5658" /> : null}

      {mode === 'top_up' ? (
        isAppleCheckout ? (
          <View style={styles.topUpGrid}>
            <AppleStoreKitCreditCard
              product={appleStoreKit.creditsProduct}
              selected
              title="150 credit top-up"
              kicker="TOP-UP"
              headline="150 credits"
              subhead="Pay-as-you-go credits"
              description="One-time consumable App Store purchase. Credits are added only after the server verifies the Apple transaction."
              onPress={() => {}}
            />
          </View>
        ) : (
          <View style={styles.topUpGrid}>
            {topUpPlans.map((planItem) => (
              <TopUpCreditCard
                key={planItem.id}
                plan={planItem}
                selected={selectedPlan.id === planItem.id}
                onPress={() => setSelectedTopUpId(planItem.id)}
              />
            ))}
          </View>
        )
      ) : (
        <View style={styles.creditChoiceGrid}>
          {isAppleCheckout ? (
            <AppleStoreKitCreditCard
              product={appleStoreKit.subscriptionProduct}
              selected={mode === 'subscription'}
              active={activeAppleMonthly}
              title="Lookmefy Premium Monthly"
              kicker="LOOKMEFY PREMIUM"
              headline="150 credits every month"
              subhead="Auto-renewable monthly subscription"
              description="Renews through your Apple ID. Monthly credits are added once per verified Apple subscription period."
              onPress={() => setMode('subscription')}
            />
          ) : (
            <MonthlyCreditCard plan={subscriptionPlan} selected={mode === 'subscription'} active={activeMonthly} onPress={() => setMode('subscription')} />
          )}
          <AddMoreCard selected={false} onPress={() => setMode('top_up')} />
        </View>
      )}

      <View style={styles.creditsDivider} />

      <Text style={styles.creditsSectionLabel}>Payment Method</Text>
      <View style={styles.paymentMethodCard}>
        <View style={styles.paymentMethodLeft}>
          {isAppleCheckout ? (
            <View style={styles.appStoreMark}>
              <Ionicons name="logo-apple" size={19} color="#ffffff" />
            </View>
          ) : (
            <View style={styles.phonePeMark}>
              <Text style={styles.phonePeMarkText}>P</Text>
            </View>
          )}
          <View>
            <Text style={styles.paymentMethodText}>{isAppleCheckout ? 'App Store' : 'PhonePe'}</Text>
            <Text style={styles.paymentMethodSubText}>{isAppleCheckout ? 'Apple ID billing' : 'UPI, cards, and net banking'}</Text>
          </View>
        </View>
        <Text style={styles.paymentSelectedText}>Selected</Text>
      </View>

      <View style={styles.orderSummaryCard}>
        <Text style={styles.orderSummaryTitle}>Order Summary</Text>
        <Text style={styles.orderSummaryKicker}>SELECTED PACK</Text>
        <View style={styles.orderSummaryDivider} />
        {isAppleCheckout ? (
          <>
            <PaymentSummaryLine label="Credit Package" value={mode === 'top_up' ? '150 credit top-up' : storeKitProductTitle(appleStoreKit.subscriptionProduct, 'Lookmefy Premium Monthly')} strong />
            <PaymentSummaryLine label="Tokens" value={mode === 'top_up' ? '150 credits' : '150 credits every month'} strong />
            <PaymentSummaryLine label="Apple Price" value={appleSelectedPrice} strong />
            <PaymentSummaryLine label="Billing" value={mode === 'top_up' ? 'One-time consumable' : 'Monthly auto-renewing'} strong />
            <PaymentSummaryLine label="Product ID" value={appleSelectedProductId} strong />
          </>
        ) : (
          <>
            <PaymentSummaryLine label="Credit Package" value={mode === 'top_up' ? 'Top-up' : subscriptionPlan.name} strong />
            <PaymentSummaryLine label="Tokens" value={mode === 'top_up' ? `${selectedPlan.credits} credits` : `${subscriptionPlan.credits} credits every month`} strong />
            <PaymentSummaryLine label="Rate" value={formatCreditRate(selectedPlan)} strong />
            {mode === 'top_up' ? (
              <>
                <PaymentSummaryLine label="Billing" value="One-time" strong />
                <PaymentSummaryLine label="Processing Fee" value="Free" strong />
              </>
            ) : (
              <>
                <PaymentSummaryLine label="First recurring payment" value={`${formatMoney(selectedAmount, selectedPlan.currency)} on ${firstPaymentDate}`} strong />
                <PaymentSummaryLine label="Then" value={`${formatMoney(selectedAmount, selectedPlan.currency)}/month`} strong />
                <PaymentSummaryLine label="Billing frequency" value="Monthly" strong />
              </>
            )}
          </>
        )}
        <View style={styles.orderSummaryDivider} />
        <View style={styles.orderSummaryTotalRow}>
          <Text style={styles.totalAmountLabel}>{isAppleCheckout ? 'APP STORE PRICE' : mode === 'top_up' ? 'TOTAL AMOUNT' : 'MONTHLY AMOUNT'}</Text>
          <Text style={styles.totalAmountValue}>{isAppleCheckout ? appleSelectedPrice : formatMoney(selectedAmount, selectedPlan.currency)}</Text>
        </View>
      </View>

      {!isAppleCheckout && activeMonthly && mode === 'subscription' ? (
        <TouchableOpacity style={[styles.cancelMandateButton, cancelLoading && styles.disabledButton]} activeOpacity={0.82} disabled={cancelLoading} onPress={cancelSubscription}>
          <Text style={styles.cancelMandateText}>{cancelLoading ? 'CANCELLING...' : 'CANCEL MONTHLY BILLING'}</Text>
        </TouchableOpacity>
      ) : null}

      {visibleMessage ? <Text style={[styles.creditsMessage, messageIsError ? styles.errorText : null]}>{visibleMessage}</Text> : null}

      {isAppleCheckout ? (
        <AppleStoreKitActions mode={mode} appleStoreKit={appleStoreKit} activeMonthly={activeAppleMonthly} />
      ) : (
        <TouchableOpacity style={[styles.secureCheckoutButton, checkoutLoading && styles.disabledButton]} activeOpacity={0.88} disabled={checkoutLoading} onPress={startCheckout}>
          <Text style={styles.secureCheckoutText}>{checkoutLoading ? 'OPENING PHONEPE' : mode === 'top_up' ? 'SECURE CHECKOUT' : 'SET UP MANDATE'}</Text>
        </TouchableOpacity>
      )}

      {!isAppleCheckout && pendingOrderId ? (
        <TouchableOpacity style={styles.verifyPaymentButton} activeOpacity={0.82} onPress={() => verifyPaymentOrder(pendingOrderId)}>
          <Ionicons name="refresh" size={16} color="#5e3335" />
          <Text style={styles.verifyPaymentText}>VERIFY PHONEPE PAYMENT</Text>
        </TouchableOpacity>
      ) : null}

      <View style={styles.creditsFooterLinks}>
        <TouchableOpacity activeOpacity={0.75} onPress={() => onNavigate('info', { page: 'returns' })}>
          <Text style={styles.creditsFooterLink}>REFUNDS</Text>
        </TouchableOpacity>
        <TouchableOpacity activeOpacity={0.75} onPress={() => onNavigate('info', { page: 'cancellation' })}>
          <Text style={styles.creditsFooterLink}>CANCELLATION</Text>
        </TouchableOpacity>
        <TouchableOpacity activeOpacity={0.75} onPress={() => onNavigate('info', { page: 'support' })}>
          <Text style={styles.creditsFooterLink}>HELP CENTER</Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

function formatDate(value) {
  if (!value) return 'Not available';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Not available';
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatFileSize(value) {
  const size = Number(value);
  if (!Number.isFinite(size) || size <= 0) return 'Saved';
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function WishlistScreen({ onNavigate, token, wishlistProducts = [], user }) {
  const recommended = useProducts({ sort: 'newest', limit: 6 }, token);
  return (
    <ScrollView style={styles.wishlistScreen} contentContainerStyle={styles.wishlistContent} {...screenScrollProps}>
      <AppHeader onNavigate={onNavigate} user={user} compact />

      <View style={styles.wishlistBody}>
        <Text style={styles.wishlistTitle}>My Wishlist <Text style={styles.wishlistCount}>({wishlistProducts.length})</Text></Text>
        <View style={styles.wishlistActionRow}>
          <TouchableOpacity style={styles.wishlistCreateButton}>
            <Ionicons name="add" size={18} color="#ffffff" />
            <Text style={styles.wishlistCreateText}>Create Collection</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.wishlistShareButton}>
            <Ionicons name="share-social-outline" size={16} color="#111111" />
            <Text style={styles.wishlistShareText}>Share</Text>
          </TouchableOpacity>
        </View>

        <ScrollView {...horizontalScrollProps} contentContainerStyle={styles.wishlistTabs}>
          {['All Items', 'Clothing', 'Footwear', 'Accessories'].map((tab, index) => (
            <TouchableOpacity key={tab} style={styles.wishlistTab}>
              <Text style={[styles.wishlistTabText, index === 0 && styles.wishlistTabTextActive]}>{tab}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>

        <View style={styles.wishlistSortRow}>
          <Text style={styles.wishlistSortText}>Sort: <Text style={styles.wishlistSortStrong}>Recently Added</Text></Text>
          <View style={styles.wishlistViewToggle}>
            <Ionicons name="grid-outline" size={17} color="#3f3937" />
            <Ionicons name="list-outline" size={19} color="#3f3937" />
          </View>
        </View>

        <View style={styles.wishlistGrid}>
          {wishlistProducts.length ? wishlistProducts.map((product) => (
            <WishlistProductCard key={product.id} product={product} onPress={() => onNavigate('product', { id: product.id })} />
          )) : (
            <EmptyStateCard
              icon="heart-outline"
              title="No saved styles yet"
              text="Heart products while browsing and your favourites will stay here."
              actionLabel="Start Shopping"
              onAction={() => onNavigate('shop')}
            />
          )}
        </View>

        <View style={styles.wishlistProCard}>
          <Text style={styles.wishlistProBadge}>PRO FEATURE</Text>
          <Text style={styles.wishlistProTitle}>Unlock Smart Wardrobe AI</Text>
          <Text style={styles.wishlistProText}>Get virtual try-on access for all wishlist items and personalized fit recommendations.</Text>
          <TouchableOpacity style={styles.wishlistUpgradeButton} onPress={() => onNavigate('tokens')}>
            <Text style={styles.wishlistUpgradeText}>Upgrade Now</Text>
          </TouchableOpacity>
        </View>

        <Text style={styles.wishlistSectionTitle}>You May Also Like</Text>
        <ScrollView {...horizontalScrollProps} contentContainerStyle={styles.wishlistRecommendedTrack}>
          {recommended.loading ? (
            Array.from({ length: 4 }).map((_, index) => (
              <View key={`wishlist-recommended-skeleton-${index}`} style={styles.wishlistRecommendedCard}>
                <View style={styles.wishlistRecommendedImage}>
                  <SkeletonBlock style={styles.skeletonFill} />
                </View>
                <SkeletonBlock style={[styles.skeletonTextMedium, styles.wishlistRecommendedSkeletonLine]} />
                <SkeletonBlock style={[styles.skeletonTextSmall, styles.wishlistRecommendedSkeletonLine]} />
              </View>
            ))
          ) : recommended.error || !recommended.products.length ? (
            <StatusPanel error={recommended.error} empty={!recommended.products.length} text="No recommended products yet." />
          ) : recommended.products.slice(0, 4).map((product) => {
            const price = Number(product.price);
            return (
            <TouchableOpacity key={product.id} style={styles.wishlistRecommendedCard} onPress={() => onNavigate('product', { id: product.id })}>
              <ProductImage product={product} style={styles.wishlistRecommendedImage} alt={product.title || product.name} />
              <Text style={styles.wishlistRecommendedBrand} numberOfLines={1}>{product.displayLabel || titleCase(product.category || 'Catalog')}</Text>
              <Text style={styles.wishlistRecommendedPrice}>{Number.isFinite(price) ? formatMoney(price, product.currency) : 'Price unavailable'}</Text>
            </TouchableOpacity>
            );
          })}
        </ScrollView>
      </View>
    </ScrollView>
  );
}

function WishlistProductCard({ product, onPress }) {
  const price = Number(product?.price);
  return (
    <TouchableOpacity style={styles.wishlistProductCard} activeOpacity={0.86} onPress={onPress}>
      <View style={styles.wishlistProductImageWrap}>
        <ProductImage product={product} style={styles.wishlistProductImage} resizeMode="cover" alt={product?.title || product?.name} />
        <TouchableOpacity style={styles.wishlistHeartButton}>
          <Ionicons name="heart" size={22} color="#9b5658" />
        </TouchableOpacity>
      </View>
      <Text style={styles.wishlistProductBrand} numberOfLines={1}>{product?.displayLabel || titleCase(product?.category || 'Catalog')}</Text>
      <Text style={styles.wishlistProductName} numberOfLines={2}>{product?.title || product?.name}</Text>
      <Text style={styles.wishlistProductPrice}>{Number.isFinite(price) ? formatMoney(price, product?.currency) : 'Price unavailable'}</Text>
      <TouchableOpacity style={styles.wishlistMoveButton} onPress={onPress}>
        <Text style={styles.wishlistMoveText}>View Product</Text>
      </TouchableOpacity>
    </TouchableOpacity>
  );
}

function OrdersScreen({ onNavigate, token, user }) {
  const popular = useProducts({ limit: 4, sort: 'newest' }, token);
  const popularProducts = popular.products.slice(0, 4);

  return (
    <ScrollView style={styles.ordersScreen} contentContainerStyle={styles.ordersContent} {...screenScrollProps}>
      <AppHeader onNavigate={onNavigate} user={user} compact />
      <View style={styles.ordersBody}>
        <Text style={styles.wishlistTitle}>My Orders</Text>
        <EmptyStateCard
          icon="receipt-outline"
          title="No orders yet"
          text="Your future favourites will show up here."
          actionLabel="Start Shopping"
          onAction={() => onNavigate('shop')}
        />

        <View style={styles.ordersPopularSection}>
          <Text style={styles.ordersPopularTitle}>Popular right now</Text>
          {popular.loading ? (
            <View style={styles.ordersPopularGrid}>
              {Array.from({ length: 4 }).map((_, index) => (
                <View key={`orders-popular-skeleton-${index}`} style={styles.ordersPopularCard}>
                  <SkeletonBlock style={styles.ordersPopularImage} />
                  <SkeletonBlock style={styles.ordersPopularSkeletonLine} />
                  <SkeletonBlock style={styles.ordersPopularSkeletonShort} />
                </View>
              ))}
            </View>
          ) : popularProducts.length ? (
            <View style={styles.ordersPopularGrid}>
              {popularProducts.map((product) => {
                const price = Number(product.price);
                return (
                  <TouchableOpacity key={product.id} style={styles.ordersPopularCard} activeOpacity={0.86} onPress={() => onNavigate('product', { id: product.id })}>
                    <ProductImage product={product} style={styles.ordersPopularImage} resizeMode="cover" alt={product.title || product.name} />
                    <Text style={styles.ordersPopularBrand} numberOfLines={1}>{product.displayLabel || titleCase(product.category || 'Catalog')}</Text>
                    <Text style={styles.ordersPopularName} numberOfLines={2}>{product.title || product.name}</Text>
                    <Text style={styles.ordersPopularPrice}>{Number.isFinite(price) ? formatMoney(price, product.currency) : 'Price unavailable'}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          ) : (
            <Text style={styles.ordersPopularEmpty}>{popular.error || 'Popular picks are unavailable right now.'}</Text>
          )}
        </View>
      </View>
    </ScrollView>
  );
}

function GenerationHistoryPreview({ items = [], total = 0, loading, error, onNavigate }) {
  const previewItems = items.slice(0, 4);
  const savedCount = Math.max(Number(total) || 0, previewItems.length);

  return (
    <View style={styles.generationPreviewCard}>
      <View style={styles.generationPreviewHead}>
        <View style={styles.generationPreviewTitleBlock}>
          <Text style={styles.generationPreviewTitle}>Generation History</Text>
          <Text style={styles.generationPreviewSubtitle}>View all AI try-on images you've created.</Text>
        </View>
        <View style={styles.generationPreviewIcon}>
          <Ionicons name="sparkles" size={16} color="#2b2321" />
        </View>
      </View>

      <View style={styles.generationPreviewThumbRow}>
        {loading ? Array.from({ length: 3 }).map((_, index) => (
          <SkeletonBlock key={`history-preview-skeleton-${index}`} style={styles.generationPreviewThumb} />
        )) : null}
        {!loading && previewItems.length ? previewItems.map((item) => (
          <Pressable key={item.id} style={styles.generationPreviewThumb} onPress={() => onNavigate('generation-history')}>
            <ResilientImage
              source={item.imageUrl ? { uri: imageUrl(item.imageUrl) } : null}
              fallbackSource={item.sourceImageUrl ? { uri: imageUrl(item.sourceImageUrl) } : null}
              style={styles.generationPreviewImage}
              resizeMode="cover"
              fallbackIcon="sparkles-outline"
            />
          </Pressable>
        )) : null}
        {!loading && !previewItems.length ? (
          <View style={styles.generationPreviewEmpty}>
            <Ionicons name="images-outline" size={20} color="#9b8f89" />
            <Text style={styles.generationPreviewEmptyText}>{error || 'Your saved try-ons will appear here.'}</Text>
          </View>
        ) : null}
      </View>

      <View style={styles.generationPreviewDivider} />
      <View style={styles.generationPreviewFooter}>
        <Text style={styles.generationPreviewCount}>{savedCount} saved creation{savedCount === 1 ? '' : 's'}</Text>
        <TouchableOpacity style={styles.generationPreviewButton} activeOpacity={0.84} onPress={() => onNavigate('generation-history')}>
          <Text style={styles.generationPreviewButtonText}>View History</Text>
          <Ionicons name="arrow-forward" size={14} color="#2b2321" />
        </TouchableOpacity>
      </View>
    </View>
  );
}

function GenerationHistoryScreen({ user, setUser, setToken, token, onNavigate }) {
  const history = useApiState('/tryons/history?limit=60', token, Boolean(user), { items: [], total: 0 });
  const [lightbox, setLightbox] = useState(null);

  if (!user) return <AuthScreen mode="login" setUser={setUser} setToken={setToken} onNavigate={onNavigate} />;

  const items = history.data?.items || [];
  const total = Math.max(Number(history.data?.total) || 0, items.length);

  const renderHistoryItem = ({ item }) => {
    const imageSource = item.imageUrl ? { uri: imageUrl(item.imageUrl) } : null;
    const fallbackSource = item.sourceImageUrl ? { uri: imageUrl(item.sourceImageUrl) } : null;
    return (
      <View style={styles.generationGridCard}>
        <Pressable style={styles.generationGridImageWrap} onPress={() => item.imageUrl && setLightbox(imageUrl(item.imageUrl))}>
          <ResilientImage
            source={imageSource}
            fallbackSource={fallbackSource}
            style={styles.generationGridImage}
            resizeMode="cover"
            alt={item.title || 'Generated try-on'}
            fallbackIcon="sparkles-outline"
          />
          <View style={styles.generationGridBadge}>
            <Text style={styles.generationGridBadgeText}>{item.label || 'AI Try-On'}</Text>
          </View>
        </Pressable>
        <View style={styles.generationGridCopy}>
          <Text style={styles.generationGridTitle} numberOfLines={2}>{item.title || 'Generated try-on'}</Text>
          <Text style={styles.generationGridMeta} numberOfLines={1}>{item.subtitle || formatDate(item.createdAt)}</Text>
          <View style={styles.generationGridFooter}>
            <Text style={styles.generationGridDate}>{formatDate(item.createdAt)}</Text>
            {item.productId ? (
              <TouchableOpacity style={styles.generationGridProductButton} onPress={() => onNavigate('product', { id: item.productId })}>
                <Ionicons name="open-outline" size={13} color="#2b2321" />
              </TouchableOpacity>
            ) : null}
          </View>
        </View>
      </View>
    );
  };

  return (
    <View style={styles.generationHistoryScreen}>
      <AppHeader onNavigate={onNavigate} user={user} compact />
      <FlatList
        data={items}
        keyExtractor={(item) => item.id}
        numColumns={2}
        renderItem={renderHistoryItem}
        columnWrapperStyle={items.length > 1 ? styles.generationGridRow : undefined}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.generationHistoryContent}
        ListHeaderComponent={(
          <View style={styles.generationHistoryHeader}>
            <View>
              <Text style={styles.generationHistoryTitle}>Generation History</Text>
              <Text style={styles.generationHistorySubtitle}>Your AI Try-On creations, all in one place.</Text>
              <Text style={styles.generationHistoryTotal}>{total} saved creation{total === 1 ? '' : 's'}</Text>
            </View>
            <TouchableOpacity style={styles.generationHistoryRefresh} activeOpacity={0.84} onPress={history.reload}>
              <Ionicons name="refresh" size={18} color="#2b2321" />
            </TouchableOpacity>
          </View>
        )}
        ListFooterComponent={history.loading && items.length ? (
          <Text style={styles.generationHistoryFootnote}>Refreshing history...</Text>
        ) : null}
        ListEmptyComponent={history.loading ? (
          <View style={styles.generationGridSkeleton}>
            {Array.from({ length: 4 }).map((_, index) => (
              <View key={`generation-history-skeleton-${index}`} style={styles.generationGridCard}>
                <SkeletonBlock style={styles.generationGridImage} />
                <SkeletonBlock style={styles.generationGridSkeletonLine} />
                <SkeletonBlock style={styles.generationGridSkeletonShort} />
              </View>
            ))}
          </View>
        ) : (
          <EmptyStateCard
            icon={history.error ? 'alert-circle-outline' : 'sparkles-outline'}
            title={history.error ? 'History unavailable' : 'No generations yet'}
            text={history.error || 'Generate a try-on from any product or AI Studio to save it here.'}
            actionLabel="Start Trying On"
            onAction={() => onNavigate('tryon')}
          />
        )}
      />
      <ImageLightbox uri={lightbox} onClose={() => setLightbox(null)} />
    </View>
  );
}

function ProfileScreen({ user, setUser, setToken, token, onNavigate, onLogout, registerTourTarget, tourFocusRequest }) {
  const [photo, setPhoto] = useState(null);
  const [profilePhotoMode, setProfilePhotoMode] = useState('ai-full-body');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [lightbox, setLightbox] = useState(null);
  const [editVisible, setEditVisible] = useState(false);
  const [editName, setEditName] = useState('');
  const [editGender, setEditGender] = useState('');
  const [editMessage, setEditMessage] = useState('');
  const [profileSaving, setProfileSaving] = useState(false);
  const [passwordSheetVisible, setPasswordSheetVisible] = useState(false);
  const [passwordStage, setPasswordStage] = useState('idle');
  const [passwordOtp, setPasswordOtp] = useState('');
  const [passwordResetToken, setPasswordResetToken] = useState('');
  const [profilePassword, setProfilePassword] = useState('');
  const [profileConfirmPassword, setProfileConfirmPassword] = useState('');
  const [showProfilePassword, setShowProfilePassword] = useState(false);
  const [showProfileConfirmPassword, setShowProfileConfirmPassword] = useState(false);
  const [passwordMessage, setPasswordMessage] = useState('');
  const [passwordLoading, setPasswordLoading] = useState(false);
  const [creditHistoryExpanded, setCreditHistoryExpanded] = useState(false);
  const [avatarAdjustVisible, setAvatarAdjustVisible] = useState(false);
  const [avatarCropDraft, setAvatarCropDraft] = useState(null);
  const [avatarAdjustMessage, setAvatarAdjustMessage] = useState('');
  const [avatarCropSaving, setAvatarCropSaving] = useState(false);
  const [accountDeleting, setAccountDeleting] = useState(false);
  const profileScrollRef = useRef(null);
  const profileAvatarTourTarget = useTourTarget('profile-avatar', registerTourTarget, { request: tourFocusRequest, scrollRef: profileScrollRef, scrollOffset: 94 });
  const creditHistory = useApiState('/tryons/credit-history?limit=20', token, Boolean(user), { events: [] });
  const generationHistory = useApiState('/tryons/history?limit=12', token, Boolean(user), { items: [], total: 0 });

  if (!user) return <AuthScreen mode="signup" setUser={setUser} setToken={setToken} onNavigate={onNavigate} />;

  const avatarUri = userAvatarUrl(user);
  const previewUri = photo?.uri || (avatarUri ? imageUrl(avatarUri) : '');
  const photoSource = previewUri ? { uri: previewUri } : null;
  const avatarAdjustmentUser = photo?.uri ? { ...user, bodyPhotoSource: 'upload', bodyPhotoUrl: '', avatarCrop: null } : user;
  const profilePhotoResizeMode = photo?.uri ? 'cover' : userAvatarResizeMode(user);
  const profilePhotoImageStyle = photo?.uri ? styles.profileFaceImage : avatarImageStyleForUser(user, 76);
  const profilePhotoImageBaseStyle = photo?.uri ? null : avatarImageBaseStyleForUser(user);
  const avatarAdjustCrop = avatarCropDraft || avatarCropForUser(avatarAdjustmentUser);
  const avatarAdjustPreviewSize = 132;
  const avatarAdjustPreviewResizeMode = userAvatarResizeMode(avatarAdjustmentUser);
  const avatarAdjustPreviewImageStyle = avatarImageStyleForUser(avatarAdjustmentUser, avatarAdjustPreviewSize, avatarAdjustCrop);
  const avatarAdjustPreviewImageBaseStyle = avatarImageBaseStyleForUser(avatarAdjustmentUser);
  const avatarAdjustMoveStep = isGeneratedFullBodyAvatar(avatarAdjustmentUser) ? 8 : 5;
  const avatarAdjustZoomStep = isGeneratedFullBodyAvatar(avatarAdjustmentUser) ? 0.16 : 0.08;
  const username = user.username || (user.email ? user.email.split('@')[0] : '');
  const displayName = user.name || username || 'Lookmefy member';
  const displayEmail = /@phone\.(?:fitlook|lookmefy)\.local$/i.test(user.email || '') ? '' : user.email;
  const accountPhone = normalizePhoneInput(user.phone || '');
  const accountPhoneLabel = accountPhone.length === 10 ? `mobile ending ${accountPhone.slice(-4)}` : 'your saved mobile number';
  const remainingCredits = Math.max(0, Number(user.tokens) || 0);
  const monthlyAllowance = Number(user.subscription?.tokensPerMonth) || 0;
  const creditTotal = monthlyAllowance > 0 ? Math.max(monthlyAllowance, remainingCredits) : null;
  const creditProgress = `${creditTotal ? calculateCreditPercentage(remainingCredits, creditTotal) : 100}%`;
  const creditEvents = creditHistory.data?.events || [];
  const visibleCreditEvents = creditHistoryExpanded ? creditEvents : creditEvents.slice(0, profileCreditPreviewLimit);
  const hiddenCreditEvents = Math.max(0, creditEvents.length - visibleCreditEvents.length);
  const avatarPortraitUri = user.avatarPhotoUrl ? imageUrl(user.avatarPhotoUrl) : '';
  const bodyPortraitUri = user.bodyPhotoUrl ? imageUrl(user.bodyPhotoUrl) : '';
  const portraitSeen = new Set();
  const portraitCards = [
    photo?.uri ? { uri: photo.uri, label: 'New photo', resizeMode: 'cover' } : null,
    bodyPortraitUri ? {
      uri: bodyPortraitUri,
      label: user.bodyPhotoSource === 'fal-full-body' ? 'Full-body' : user.bodyPhotoStatus === 'generating' ? 'Preparing' : 'Saved',
      resizeMode: user.bodyPhotoSource === 'fal-full-body' ? 'contain' : 'cover'
    } : null,
    avatarPortraitUri ? { uri: avatarPortraitUri, label: 'Profile', resizeMode: 'cover' } : null
  ].filter((item) => {
    if (!item?.uri || portraitSeen.has(item.uri)) return false;
    portraitSeen.add(item.uri);
    return true;
  });
  const featuredPortrait = portraitCards[0] || null;
  const portraitPhotoCount = portraitCards.length;

  const chooseProfilePhoto = async () => {
    const selected = await pickImage();
    if (!selected) return;
    setPhoto(selected);
    setMessage('');
    setAvatarAdjustVisible(false);
    setAvatarCropDraft(null);
  };

  const openAvatarAdjuster = () => {
    if (!photoSource) {
      chooseProfilePhoto();
      return;
    }
    setAvatarCropDraft(avatarCropForUser(avatarAdjustmentUser));
    setAvatarAdjustMessage('');
    setMessage('');
    setAvatarAdjustVisible(true);
  };

  const updateAvatarCropDraft = (delta = {}) => {
    setAvatarCropDraft((current) => {
      const base = current || avatarCropForUser(avatarAdjustmentUser);
      return avatarCropForUser(avatarAdjustmentUser, {
        scale: base.scale + (delta.scale || 0),
        translateX: base.translateX + (delta.translateX || 0),
        translateY: base.translateY + (delta.translateY || 0)
      });
    });
  };

  const resetAvatarCropDraft = () => {
    setAvatarCropDraft(defaultAvatarCrop(avatarAdjustmentUser));
    setAvatarAdjustMessage('');
  };

  const saveAvatarCrop = async () => {
    if (photo?.uri) {
      setAvatarAdjustMessage('Save the new portrait before saving its position.');
      return;
    }
    const crop = avatarCropForUser(user, avatarCropDraft || avatarCropForUser(user));
    setAvatarCropSaving(true);
    setAvatarAdjustMessage('Saving position...');
    try {
      const data = await api('/auth/avatar-crop', {
        method: 'PATCH',
        body: JSON.stringify({ avatarCrop: crop })
      });
      if (data.user) setUser(data.user);
      setAvatarAdjustVisible(false);
      setAvatarCropDraft(null);
      setMessage('Profile photo position saved.');
    } catch (error) {
      setAvatarAdjustMessage(error.message);
    } finally {
      setAvatarCropSaving(false);
    }
  };

  const replaceProfilePhotoFromAdjuster = async () => {
    if (avatarCropSaving) return;
    await chooseProfilePhoto();
  };

  const updatePhoto = async () => {
    if (!photo) {
      setMessage('Choose a new profile photo first.');
      return;
    }
    setLoading(true);
    setMessage('Uploading profile photo...');
    try {
      const form = new FormData();
      form.append('bodyPhoto', filePart(photo, 'body-photo.jpg'));
      form.append('profilePhotoMode', profilePhotoMode);
      const data = await api('/auth/body-photo', { method: 'POST', body: form });
      if (data.user) setUser(data.user);
      setPhoto(null);
      setMessage(data.user?.bodyPhotoStatus === 'generating' ? 'Photo saved. Full-body try-on profile is preparing in the background.' : 'Profile photo updated.');
    } catch (error) {
      setMessage(error.message);
    } finally {
      setLoading(false);
    }
  };

  const openProfileEditor = () => {
    setEditName(displayName === 'Lookmefy member' ? '' : displayName);
    setEditGender(user.genderPreference || 'other');
    setEditMessage('');
    setMessage('');
    setEditVisible(true);
  };

  const saveProfileDetails = async () => {
    const nextName = editName.trim().replace(/\s+/g, ' ');
    if (nextName.length < 2) {
      setEditMessage('Enter your full name.');
      return;
    }
    if (!editGender) {
      setEditMessage('Choose your gender preference.');
      return;
    }
    setProfileSaving(true);
    setEditMessage('Saving profile...');
    try {
      const data = await api('/auth/profile', {
        method: 'PATCH',
        timeoutMs: 30000,
        body: JSON.stringify({
          name: nextName,
          genderPreference: editGender,
          requireBodyPhoto: false
        })
      });
      if (data.user) setUser(data.user);
      setEditVisible(false);
      setEditMessage('');
      setMessage('Profile updated.');
    } catch (error) {
      setEditMessage(error.message);
    } finally {
      setProfileSaving(false);
    }
  };

  const resetPasswordSheet = () => {
    setPasswordStage('idle');
    setPasswordOtp('');
    setPasswordResetToken('');
    setProfilePassword('');
    setProfileConfirmPassword('');
    setShowProfilePassword(false);
    setShowProfileConfirmPassword(false);
    setPasswordMessage('');
  };

  const openPasswordSheet = () => {
    if (accountPhone.length !== 10) {
      setMessage('Add a valid mobile number before changing your password.');
      return;
    }
    resetPasswordSheet();
    setMessage('');
    setPasswordSheetVisible(true);
  };

  const closePasswordSheet = () => {
    if (passwordLoading) return;
    setPasswordSheetVisible(false);
    resetPasswordSheet();
  };

  const sendProfilePasswordOtp = async () => {
    if (accountPhone.length !== 10) {
      setPasswordMessage('Your account needs a valid 10 digit mobile number.');
      return;
    }
    setPasswordLoading(true);
    setPasswordMessage('Sending OTP...');
    try {
      const data = await api('/auth/otp/send', {
        method: 'POST',
        body: JSON.stringify({ phone: accountPhone, purpose: 'password-reset' })
      });
      setPasswordOtp('');
      setPasswordResetToken('');
      setPasswordStage('otp');
      setPasswordMessage(data.message ? `${data.message}. Enter the code from SMS.` : 'OTP sent. Enter the code from SMS.');
    } catch (error) {
      setPasswordMessage(error.message);
    } finally {
      setPasswordLoading(false);
    }
  };

  const verifyProfilePasswordOtp = async () => {
    const cleanOtp = normalizeOtpInput(passwordOtp);
    if (!cleanOtp) {
      setPasswordMessage('Enter the OTP sent to your mobile.');
      return;
    }
    setPasswordLoading(true);
    setPasswordMessage('Verifying OTP...');
    try {
      const data = await api('/auth/otp/verify', {
        method: 'POST',
        body: JSON.stringify({ phone: accountPhone, otp: cleanOtp, purpose: 'password-reset' })
      });
      setPasswordResetToken(data.resetToken || '');
      setPasswordOtp('');
      setProfilePassword('');
      setProfileConfirmPassword('');
      setPasswordStage('password');
      setPasswordMessage('');
    } catch (error) {
      setPasswordMessage(error.message);
    } finally {
      setPasswordLoading(false);
    }
  };

  const completeProfilePasswordReset = async () => {
    const passwordError = passwordValidationMessage(profilePassword);
    if (passwordError) {
      setPasswordMessage(passwordError);
      return;
    }
    if (profilePassword !== profileConfirmPassword) {
      setPasswordMessage('Passwords do not match.');
      return;
    }
    if (!passwordResetToken) {
      setPasswordMessage('Verify the OTP before setting a new password.');
      setPasswordStage('otp');
      return;
    }
    setPasswordLoading(true);
    setPasswordMessage('Saving password...');
    try {
      const data = await api('/auth/password/reset', {
        method: 'POST',
        body: JSON.stringify({
          resetToken: passwordResetToken,
          password: profilePassword,
          confirmPassword: profileConfirmPassword
        }),
        timeoutMs: 60000
      });
      await saveToken(data.token);
      setToken(data.token);
      if (data.user) setUser(data.user);
      setPasswordSheetVisible(false);
      resetPasswordSheet();
      setMessage('Password updated.');
    } catch (error) {
      setPasswordMessage(error.message);
    } finally {
      setPasswordLoading(false);
    }
  };

  const deleteAccount = async () => {
    setAccountDeleting(true);
    setMessage('Deleting account...');
    let deleted = false;
    try {
      await api('/auth/me', { method: 'DELETE', timeoutMs: 60000 });
      await clearToken();
      deleted = true;
    } catch (error) {
      setMessage(error.message);
    } finally {
      setAccountDeleting(false);
    }

    if (deleted) {
      setToken(null);
      setUser(null);
      Alert.alert('Account deleted', 'Your Lookmefy account deletion request has been completed.');
      onNavigate('home');
    }
  };

  const confirmDeleteAccount = () => {
    Alert.alert(
      'Delete account?',
      'This permanently removes your profile, photos, try-on history, wardrobe, credits, and account access. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete Account', style: 'destructive', onPress: deleteAccount }
      ]
    );
  };

  return (
    <ScrollView ref={profileScrollRef} style={styles.profileScreen} contentContainerStyle={styles.profileContent} {...screenScrollProps}>
      <AppHeader onNavigate={onNavigate} user={user} compact />

      <View style={styles.profileHero}>
        <TouchableOpacity ref={profileAvatarTourTarget.ref} onLayout={profileAvatarTourTarget.onLayout} style={styles.profilePhotoWrap} onPress={openAvatarAdjuster}>
          {photoSource ? <ResilientImage source={photoSource} style={styles.profilePhoto} imageStyle={profilePhotoImageStyle} imageBaseStyle={profilePhotoImageBaseStyle} resizeMode={profilePhotoResizeMode} fallbackIcon="person-outline" /> : (
            <InitialsAvatar user={user} style={[styles.profilePhoto, styles.profileAvatarFallback]} textStyle={styles.profileAvatarInitials} />
          )}
          <View style={styles.profilePhotoAction}>
            <Ionicons name="create-outline" size={13} color="#ffffff" />
          </View>
        </TouchableOpacity>
        <Text style={styles.profileName}>{displayName}</Text>
        <Text style={styles.profileRole}>{titleCase(user.genderPreference || 'Lookmefy profile')}</Text>
        <Text style={styles.profileBio}>{user.joinedAt ? `Member since ${formatDate(user.joinedAt)}.` : 'Your saved profile powers product previews and wardrobe try-ons.'}</Text>
        <TouchableOpacity style={styles.profileEditButton} onPress={openProfileEditor}>
          <Text style={styles.profileEditText}>Edit Profile</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.profileCreditsCard}>
        <View style={styles.profileCreditsHead}>
          <Text style={styles.profileCreditsLabel}>Remaining Credits</Text>
          <Ionicons name="sparkles" size={23} color="#9b5658" />
        </View>
        <View style={styles.profileCreditsAmountRow}>
          <Text style={styles.profileCreditsAmount}>{user.devMode ? 'Unlimited' : remainingCredits}</Text>
          <Text style={styles.profileCreditsTotal}>{user.devMode ? '' : creditTotal ? ` / ${creditTotal}` : ' available'}</Text>
        </View>
        {!user.devMode ? (
          <View style={styles.profileCreditTrack}>
            <View style={[styles.profileCreditFill, { width: creditProgress }]} />
          </View>
        ) : null}
        <TouchableOpacity style={styles.profileBuyButton} onPress={() => onNavigate('tokens')}>
          <Text style={styles.profileBuyText}>Buy More Credits</Text>
        </TouchableOpacity>
        <View style={styles.profileCreditHistory}>
          <View style={styles.profileCreditHistoryHead}>
            <Text style={styles.profileCreditHistoryTitle}>Credit History</Text>
            {creditHistory.loading ? <SkeletonBlock style={styles.profileCreditHeadSkeleton} /> : null}
            {!creditHistory.loading && !creditHistory.error && creditEvents.length > profileCreditPreviewLimit ? (
              <TouchableOpacity style={styles.profileCreditHistoryAction} activeOpacity={0.78} onPress={() => setCreditHistoryExpanded((current) => !current)}>
                <Text style={styles.profileCreditHistoryActionText}>{creditHistoryExpanded ? 'Show less' : `View all ${creditEvents.length}`}</Text>
              </TouchableOpacity>
            ) : null}
          </View>
          <View style={styles.profileCreditHistoryHeaderRow}>
            <Text style={[styles.profileCreditColumnLabel, styles.profileCreditActionColumn]}>Action</Text>
            <Text style={[styles.profileCreditColumnLabel, styles.profileCreditProductColumn]}>Product</Text>
            <Text style={[styles.profileCreditColumnLabel, styles.profileCreditDateColumn]}>Date</Text>
            <Text style={[styles.profileCreditColumnLabel, styles.profileCreditTokenColumn]}>Tokens</Text>
          </View>
          {creditHistory.error ? <Text style={[styles.profileCreditEmptyText, styles.errorText]}>{creditHistory.error}</Text> : null}
          {creditHistory.loading ? <CreditHistorySkeleton /> : null}
          {!creditHistory.loading && !creditHistory.error && visibleCreditEvents.length ? visibleCreditEvents.map((event) => (
            <View key={event.id} style={styles.profileCreditHistoryRow}>
              <Text style={[styles.profileCreditCell, styles.profileCreditActionColumn]} numberOfLines={1}>{event.action || 'Try-on'}</Text>
              <Text style={[styles.profileCreditCell, styles.profileCreditProductColumn]} numberOfLines={1}>{creditHistoryProductLabel(event)}</Text>
              <Text style={[styles.profileCreditCell, styles.profileCreditDateColumn]} numberOfLines={1}>{formatDate(event.createdAt)}</Text>
              <Text style={[styles.profileCreditCell, styles.profileCreditTokenColumn, event.direction === 'credit' ? styles.profileCreditAddedText : styles.profileCreditTokenText]} numberOfLines={1}>{creditHistoryAmountLabel(event)}</Text>
            </View>
          )) : null}
          {!creditHistory.loading && !creditHistory.error && !creditHistoryExpanded && hiddenCreditEvents ? (
            <Text style={styles.profileCreditEmptyText}>{hiddenCreditEvents} older item{hiddenCreditEvents === 1 ? '' : 's'} hidden.</Text>
          ) : null}
          {!creditHistory.loading && !creditHistory.error && !creditEvents.length ? <Text style={styles.profileCreditEmptyText}>No credit activity yet.</Text> : null}
        </View>
      </View>

      <GenerationHistoryPreview
        items={generationHistory.data?.items || []}
        total={generationHistory.data?.total || 0}
        loading={generationHistory.loading}
        error={generationHistory.error}
        onNavigate={onNavigate}
      />

      <View style={styles.profileSection}>
        <View style={styles.profileSectionHead}>
          <Text style={styles.profileSectionTitle}>Try-On Portraits</Text>
          <Text style={styles.profilePhotoCount}>{portraitPhotoCount} Photo{portraitPhotoCount === 1 ? '' : 's'}</Text>
        </View>
        <View style={styles.profilePortraitPanel}>
          <Pressable style={styles.profilePortraitFeatured} onPress={() => featuredPortrait?.uri && setLightbox(featuredPortrait.uri)}>
            {featuredPortrait?.uri ? (
              <>
                <ResilientImage source={{ uri: featuredPortrait.uri }} style={styles.profilePortraitFeaturedImage} resizeMode={featuredPortrait.resizeMode} fallbackIcon="person-outline" />
                <View style={styles.profilePortraitBadge}>
                  <Text style={styles.profilePortraitBadgeText} numberOfLines={1}>{featuredPortrait.label}</Text>
                </View>
              </>
            ) : (
              <View style={styles.profilePortraitEmpty}>
                <Ionicons name="person-outline" size={24} color="#8d8682" />
                <Text style={styles.profilePortraitEmptyText}>No photo yet</Text>
              </View>
            )}
          </Pressable>
          <TouchableOpacity style={styles.profileUploadPortraitLarge} onPress={chooseProfilePhoto}>
            <View style={styles.profileUploadPortraitIcon}>
              <Ionicons name="camera-outline" size={24} color="#7d7a79" />
            </View>
            <Text style={styles.profileUploadPortraitText}>Upload New Photo</Text>
            <Text style={styles.profileUploadPortraitHelp}>Use a clear full-body or portrait photo.</Text>
          </TouchableOpacity>
        </View>
        {!portraitPhotoCount ? <Text style={styles.profileInlineMessage}>Upload a portrait to start trying on outfits.</Text> : null}
        {photo ? (
          <TouchableOpacity style={[styles.profileSavePhotoButton, loading && styles.disabledButton]} disabled={loading} onPress={updatePhoto}>
            <Text style={styles.profileSavePhotoText}>{loading ? 'Saving Photo...' : 'Save New Portrait'}</Text>
          </TouchableOpacity>
        ) : null}
        {user.bodyPhotoStatus === 'generating' ? <Text style={styles.profileInlineMessage}>Full-body try-on profile is preparing in the background.</Text> : null}
        {user.bodyPhotoStatus === 'failed' ? <Text style={[styles.profileInlineMessage, styles.errorText]}>Full-body profile generation failed. Upload a clearer profile photo.</Text> : null}
        {message ? <Text style={[styles.profileInlineMessage, /updated|saved|saving|uploading/i.test(message) ? null : styles.errorText]}>{message}</Text> : null}
      </View>

      <View style={styles.profileQuickOptions}>
        <TouchableOpacity style={styles.profileQuickCard} activeOpacity={0.86} onPress={() => onNavigate('orders')}>
          <View style={styles.profileQuickIcon}>
            <Ionicons name="receipt-outline" size={23} color="#9b5658" />
          </View>
          <View style={styles.profileQuickCopy}>
            <Text style={styles.profileQuickTitle}>My Orders</Text>
            <Text style={styles.profileQuickSub}>Track purchases</Text>
          </View>
          <Ionicons name="chevron-forward" size={20} color="#77716f" />
        </TouchableOpacity>
        <TouchableOpacity style={styles.profileQuickCard} activeOpacity={0.86} onPress={() => onNavigate('wishlist')}>
          <View style={styles.profileQuickIcon}>
            <Ionicons name="heart-outline" size={23} color="#9b5658" />
          </View>
          <View style={styles.profileQuickCopy}>
            <Text style={styles.profileQuickTitle}>My Wishlist</Text>
            <Text style={styles.profileQuickSub}>Saved styles</Text>
          </View>
          <Ionicons name="chevron-forward" size={20} color="#77716f" />
        </TouchableOpacity>
      </View>

      <View style={styles.profileSection}>
        <Text style={styles.profileSectionTitle}>Payment Methods</Text>
        <TouchableOpacity style={styles.profilePaymentCard} onPress={() => onNavigate('tokens')}>
          <View style={styles.profileVisaBadge}>
            <Text style={styles.profileVisaText}>PAY</Text>
          </View>
          <View style={styles.profilePaymentCopy}>
            <Text style={styles.profilePaymentTitle}>PhonePe checkout</Text>
            <Text style={styles.profilePaymentSub}>{user.subscription?.status === 'active' ? 'Monthly mandate active' : 'Add credits when needed'}</Text>
          </View>
          <Ionicons name="chevron-forward" size={22} color="#55514f" />
        </TouchableOpacity>
      </View>

      <ProfileSettingsSection
        title="Account Settings"
        rows={[
          { label: 'Username', value: username ? `@${username}` : 'Not added' },
          { label: 'Mobile Number', value: user.phone || 'Not added' },
          { label: 'Email Address', value: displayEmail || 'Not added' },
          { label: 'Change Password', value: 'OTP verification', onPress: openPasswordSheet }
        ]}
      />

      <ProfileSettingsSection
        title="Security & Legal"
        rows={[
          { label: 'Support Center', onPress: () => onNavigate('info', { page: 'support' }) },
          { label: 'Return and Refund Policy', onPress: () => onNavigate('info', { page: 'returns' }) },
          { label: 'Cancellation Policy', onPress: () => onNavigate('info', { page: 'cancellation' }) },
          { label: 'Account & Data Deletion', onPress: () => onNavigate('info', { page: 'deletion' }) },
          { label: 'Data & Privacy', onPress: () => onNavigate('info', { page: 'privacy' }) },
          { label: 'Terms of Service', onPress: () => onNavigate('info', { page: 'terms' }) },
          { label: 'Privacy Policy', onPress: () => onNavigate('info', { page: 'privacy' }) }
        ]}
      />

      <TouchableOpacity style={styles.profileLogoutButton} onPress={onLogout}>
        <Text style={styles.profileLogoutText}>Logout</Text>
      </TouchableOpacity>
      <TouchableOpacity style={[styles.profileDeleteButton, accountDeleting && styles.disabledButton]} disabled={accountDeleting} onPress={confirmDeleteAccount}>
        {accountDeleting ? <ActivityIndicator size="small" color="#ffffff" /> : <Text style={styles.profileDeleteText}>Delete Account</Text>}
      </TouchableOpacity>
      <Modal visible={avatarAdjustVisible} transparent animationType="fade" onRequestClose={() => !avatarCropSaving && setAvatarAdjustVisible(false)}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.profileEditOverlay}>
          <Pressable style={styles.profileEditBackdrop} onPress={() => !avatarCropSaving && setAvatarAdjustVisible(false)} />
          <View style={styles.profileEditSheet}>
            <View style={styles.profileEditHandle} />
            <View style={styles.profileEditHead}>
              <View>
                <Text style={styles.profileEditSheetTitle}>Adjust Profile Photo</Text>
                <Text style={styles.profileEditSheetSub}>Move and zoom the image inside your profile circle.</Text>
              </View>
              <TouchableOpacity style={styles.profileEditClose} disabled={avatarCropSaving} onPress={() => setAvatarAdjustVisible(false)}>
                <Ionicons name="close" size={21} color="#2b2321" />
              </TouchableOpacity>
            </View>

            <View style={styles.avatarAdjustPreviewWrap}>
              <View style={styles.avatarAdjustPreviewFrame}>
                {photoSource ? (
                  <ResilientImage
                    source={photoSource}
                    style={styles.avatarAdjustPreviewImage}
                    imageStyle={avatarAdjustPreviewImageStyle}
                    imageBaseStyle={avatarAdjustPreviewImageBaseStyle}
                    resizeMode={avatarAdjustPreviewResizeMode}
                    fallbackIcon="person-outline"
                  />
                ) : (
                  <InitialsAvatar user={user} style={styles.avatarAdjustPreviewImage} textStyle={styles.profileAvatarInitials} />
                )}
              </View>
            </View>

            <View style={styles.avatarAdjustControls}>
              <View style={styles.avatarAdjustRow}>
                <TouchableOpacity style={styles.avatarAdjustIconButton} onPress={() => updateAvatarCropDraft({ translateY: -avatarAdjustMoveStep })}>
                  <Ionicons name="chevron-up" size={20} color="#2b2321" />
                </TouchableOpacity>
              </View>
              <View style={styles.avatarAdjustRow}>
                <TouchableOpacity style={styles.avatarAdjustIconButton} onPress={() => updateAvatarCropDraft({ translateX: -avatarAdjustMoveStep })}>
                  <Ionicons name="chevron-back" size={20} color="#2b2321" />
                </TouchableOpacity>
                <TouchableOpacity style={styles.avatarAdjustIconButton} onPress={() => updateAvatarCropDraft({ scale: -avatarAdjustZoomStep })}>
                  <Ionicons name="remove" size={20} color="#2b2321" />
                </TouchableOpacity>
                <TouchableOpacity style={styles.avatarAdjustIconButton} onPress={() => updateAvatarCropDraft({ scale: avatarAdjustZoomStep })}>
                  <Ionicons name="add" size={20} color="#2b2321" />
                </TouchableOpacity>
                <TouchableOpacity style={styles.avatarAdjustIconButton} onPress={() => updateAvatarCropDraft({ translateX: avatarAdjustMoveStep })}>
                  <Ionicons name="chevron-forward" size={20} color="#2b2321" />
                </TouchableOpacity>
              </View>
              <View style={styles.avatarAdjustRow}>
                <TouchableOpacity style={styles.avatarAdjustIconButton} onPress={() => updateAvatarCropDraft({ translateY: avatarAdjustMoveStep })}>
                  <Ionicons name="chevron-down" size={20} color="#2b2321" />
                </TouchableOpacity>
                <TouchableOpacity style={styles.avatarAdjustIconButton} onPress={resetAvatarCropDraft}>
                  <Ionicons name="refresh" size={18} color="#2b2321" />
                </TouchableOpacity>
              </View>
            </View>

            {avatarAdjustMessage ? <Text style={[styles.profileEditMessage, /saving|saved/i.test(avatarAdjustMessage) ? null : styles.errorText]}>{avatarAdjustMessage}</Text> : null}

            <View style={styles.profileEditActions}>
              <TouchableOpacity style={styles.profileEditCancelButton} disabled={avatarCropSaving} onPress={replaceProfilePhotoFromAdjuster}>
                <Text style={styles.profileEditCancelText}>Replace Photo</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.profileEditSaveButton, avatarCropSaving && styles.disabledButton]} disabled={avatarCropSaving} onPress={saveAvatarCrop}>
                {avatarCropSaving ? <ActivityIndicator size="small" color="#ffffff" /> : <Text style={styles.profileEditSaveText}>Save Position</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
      <Modal visible={editVisible} transparent animationType="fade" onRequestClose={() => setEditVisible(false)}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.profileEditOverlay}>
          <Pressable style={styles.profileEditBackdrop} onPress={() => setEditVisible(false)} />
          <View style={styles.profileEditSheet}>
            <View style={styles.profileEditHandle} />
            <View style={styles.profileEditHead}>
              <View>
                <Text style={styles.profileEditSheetTitle}>Edit Profile</Text>
                <Text style={styles.profileEditSheetSub}>Update the name and shopping preference shown in your account.</Text>
              </View>
              <TouchableOpacity style={styles.profileEditClose} onPress={() => setEditVisible(false)}>
                <Ionicons name="close" size={21} color="#2b2321" />
              </TouchableOpacity>
            </View>

            <Text style={styles.profileEditLabel}>Name</Text>
            <TextInput
              style={styles.profileEditInput}
              value={editName}
              onChangeText={setEditName}
              placeholder="Your name"
              placeholderTextColor="#9a918d"
              autoCapitalize="words"
              returnKeyType="done"
            />

            <Text style={styles.profileEditLabel}>Gender preference</Text>
            <View style={styles.profileGenderGrid}>
              {profileGenderOptions.map((option) => {
                const selected = editGender === option.value;
                return (
                  <TouchableOpacity key={option.value} style={[styles.profileGenderOption, selected && styles.profileGenderOptionActive]} activeOpacity={0.84} onPress={() => setEditGender(option.value)}>
                    <Ionicons name={option.icon} size={18} color={selected ? '#ffffff' : '#9b5658'} />
                    <Text style={[styles.profileGenderText, selected && styles.profileGenderTextActive]}>{option.label}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            {editMessage ? <Text style={[styles.profileEditMessage, /saving|updated|saved/i.test(editMessage) ? null : styles.errorText]}>{editMessage}</Text> : null}

            <View style={styles.profileEditActions}>
              <TouchableOpacity style={styles.profileEditCancelButton} activeOpacity={0.84} onPress={() => setEditVisible(false)}>
                <Text style={styles.profileEditCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.profileEditSaveButton, profileSaving && styles.disabledButton]} activeOpacity={0.88} disabled={profileSaving} onPress={saveProfileDetails}>
                {profileSaving ? <ActivityIndicator size="small" color="#ffffff" /> : <Text style={styles.profileEditSaveText}>Save</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
      <Modal visible={passwordSheetVisible} transparent animationType="fade" onRequestClose={closePasswordSheet}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.profileEditOverlay}>
          <Pressable style={styles.profileEditBackdrop} onPress={closePasswordSheet} />
          <View style={styles.profileEditSheet}>
            <View style={styles.profileEditHandle} />
            <View style={styles.profileEditHead}>
              <View>
                <Text style={styles.profileEditSheetTitle}>Change Password</Text>
                <Text style={styles.profileEditSheetSub}>
                  {passwordStage === 'password'
                    ? 'Set a new password for your Lookmefy account.'
                    : passwordStage === 'otp'
                      ? `Enter the OTP sent to ${accountPhoneLabel}.`
                      : `Send a reset OTP to ${accountPhoneLabel}.`}
                </Text>
              </View>
              <TouchableOpacity style={styles.profileEditClose} disabled={passwordLoading} onPress={closePasswordSheet}>
                <Ionicons name="close" size={21} color="#2b2321" />
              </TouchableOpacity>
            </View>

            {passwordStage === 'idle' ? (
              <>
                <View style={styles.profilePasswordNotice}>
                  <Ionicons name="phone-portrait-outline" size={18} color="#9b5658" />
                  <Text style={styles.profilePasswordNoticeText}>We will verify this change with an OTP before saving a new password.</Text>
                </View>
                <TouchableOpacity style={[styles.profileEditSaveButton, styles.profilePasswordPrimaryButton, passwordLoading && styles.disabledButton]} disabled={passwordLoading} onPress={sendProfilePasswordOtp}>
                  {passwordLoading ? <ActivityIndicator size="small" color="#ffffff" /> : <Text style={styles.profileEditSaveText}>Send OTP</Text>}
                </TouchableOpacity>
              </>
            ) : null}

            {passwordStage === 'otp' ? (
              <>
                <Text style={styles.profileEditLabel}>OTP</Text>
                <TextInput
                  style={styles.profileEditInput}
                  value={passwordOtp}
                  onChangeText={(value) => setPasswordOtp(normalizeOtpInput(value))}
                  placeholder="Enter OTP"
                  placeholderTextColor="#9a918d"
                  keyboardType="number-pad"
                  autoComplete="one-time-code"
                  textContentType="oneTimeCode"
                  maxLength={8}
                />
                <View style={styles.profileEditActions}>
                  <TouchableOpacity style={styles.profileEditCancelButton} disabled={passwordLoading} onPress={sendProfilePasswordOtp}>
                    <Text style={styles.profileEditCancelText}>Resend</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={[styles.profileEditSaveButton, passwordLoading && styles.disabledButton]} disabled={passwordLoading} onPress={verifyProfilePasswordOtp}>
                    {passwordLoading ? <ActivityIndicator size="small" color="#ffffff" /> : <Text style={styles.profileEditSaveText}>Verify</Text>}
                  </TouchableOpacity>
                </View>
              </>
            ) : null}

            {passwordStage === 'password' ? (
              <>
                <Text style={styles.profileEditLabel}>New password</Text>
                <AuthPasswordField
                  value={profilePassword}
                  onChangeText={setProfilePassword}
                  placeholder="New password"
                  visible={showProfilePassword}
                  onToggle={() => setShowProfilePassword((current) => !current)}
                  fieldHeight={54}
                  autoComplete="new-password"
                />
                <Text style={styles.profileEditLabel}>Confirm password</Text>
                <AuthPasswordField
                  value={profileConfirmPassword}
                  onChangeText={setProfileConfirmPassword}
                  placeholder="Confirm password"
                  visible={showProfileConfirmPassword}
                  onToggle={() => setShowProfileConfirmPassword((current) => !current)}
                  fieldHeight={54}
                  autoComplete="new-password"
                />
                <View style={styles.profileEditActions}>
                  <TouchableOpacity style={styles.profileEditCancelButton} disabled={passwordLoading} onPress={() => setPasswordStage('otp')}>
                    <Text style={styles.profileEditCancelText}>Back</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={[styles.profileEditSaveButton, passwordLoading && styles.disabledButton]} disabled={passwordLoading} onPress={completeProfilePasswordReset}>
                    {passwordLoading ? <ActivityIndicator size="small" color="#ffffff" /> : <Text style={styles.profileEditSaveText}>Save Password</Text>}
                  </TouchableOpacity>
                </View>
              </>
            ) : null}

            {passwordMessage ? <Text style={[styles.profileEditMessage, /sending|sent|verifying|saving|updated/i.test(passwordMessage) ? null : styles.errorText]}>{passwordMessage}</Text> : null}
          </View>
        </KeyboardAvoidingView>
      </Modal>
      <ImageLightbox uri={lightbox} onClose={() => setLightbox(null)} />
    </ScrollView>
  );
}

function ProfileSettingsSection({ title, rows }) {
  return (
    <View style={styles.profileSection}>
      <Text style={styles.profileSectionTitle}>{title}</Text>
      <View style={styles.profileSettingsList}>
        {rows.map((row) => {
          const item = Array.isArray(row) ? { label: row[0], value: row[1], onPress: row[2] } : row;
          const actionable = typeof item.onPress === 'function';
          return (
            <TouchableOpacity key={item.label} style={styles.profileSettingsRow} activeOpacity={actionable ? 0.8 : 1} disabled={!actionable} onPress={item.onPress}>
              <View style={styles.profileSettingsCopy}>
                <Text style={styles.profileSettingsLabel}>{item.label}</Text>
                {item.value ? <Text style={styles.profileSettingsValue}>{item.value}</Text> : null}
              </View>
              {actionable ? <Ionicons name="chevron-forward" size={21} color="#55514f" /> : null}
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

function HowItWorksScreen({ user, onNavigate }) {
  const steps = [
    [user ? 'Use your profile' : 'Create your profile', user ? 'Your account is ready, so you can move straight into browsing products.' : 'Upload one clear standing photo once, then keep using it for try-on previews.'],
    ['Choose a product', 'Open any product from the catalog and review the brand, price, image, colors, and details.'],
    ['Generate the try-on', 'Use tokens to preview how selected pieces look on your profile before leaving Lookmefy.'],
    ['Compare and shop', 'Shortlist the looks that work, then continue to the brand store when you are ready.']
  ];
  return (
    <ScrollView contentContainerStyle={styles.scrollContent} {...screenScrollProps}>
      <View style={styles.toolHero}>
        <Text style={styles.kicker}>How Lookmefy Works</Text>
        <Text style={styles.screenTitle}>Four simple steps.</Text>
        <Text style={styles.description}>From profile photo to product preview, the whole flow is built around making online shopping feel less like guessing.</Text>
        <AppButton label={user ? 'Start Shopping' : 'Create Profile'} onPress={() => onNavigate(user ? 'shop' : 'signup')} />
      </View>
      {steps.map(([title, text], index) => (
        <View key={title} style={styles.stepCard}>
          <Text style={styles.stepNumber}>{String(index + 1).padStart(2, '0')}</Text>
          <Text style={styles.stepTitle}>{title}</Text>
          <Text style={styles.muted}>{text}</Text>
        </View>
      ))}
    </ScrollView>
  );
}

function InfoScreen({ page, user, onNavigate }) {
  const policy = policyPages[page];
  const meta = policy ? [policy.kicker, policy.title, policy.lead, policy.image] : infoPages[page];
  if (!meta) return <NotFoundScreen user={user} onNavigate={onNavigate} />;

  if (policy) {
    const emailSubject = policy.emailSubject || 'Lookmefy support request';
    return (
      <ScrollView contentContainerStyle={styles.scrollContent} {...screenScrollProps}>
        <View style={styles.pageHero}>
          <Image source={images[policy.image] || images.hero} style={styles.pageImage} />
          <View style={styles.pageCopy}>
            <Text style={styles.kicker}>{policy.kicker}</Text>
            <Text style={styles.screenTitle}>{policy.title}</Text>
            <Text style={styles.policyUpdated}>Last updated: {policy.updated}</Text>
            <Text style={styles.description}>{policy.lead}</Text>
            <AppButton label="Email Support" icon="mail-outline" onPress={() => openSupportEmail(emailSubject)} />
          </View>
        </View>

        <View style={styles.policyGrid}>
          {policy.sections.map((section) => (
            <View key={section.title} style={styles.policyCard}>
              <Text style={styles.policySectionTitle}>{section.title}</Text>
              {section.body.map((text, index) => (
                <PolicyText key={`${section.title}-${index}`} text={text} emailSubject={emailSubject} />
              ))}
            </View>
          ))}

          {policy.related?.length ? (
            <View style={styles.policyRelated}>
              <Text style={styles.policyRelatedTitle}>Related pages</Text>
              {policy.related.map(([label, targetPage]) => (
                <TouchableOpacity key={targetPage} style={styles.policyRelatedRow} activeOpacity={0.8} onPress={() => onNavigate('info', { page: targetPage })}>
                  <Text style={styles.policyRelatedText}>{label}</Text>
                  <Ionicons name="chevron-forward" size={19} color="#55514f" />
                </TouchableOpacity>
              ))}
            </View>
          ) : null}
        </View>
      </ScrollView>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.scrollContent} {...screenScrollProps}>
      <View style={styles.pageHero}>
        <Image source={images[meta[3]] || images.hero} style={styles.pageImage} />
        <View style={styles.pageCopy}>
          <Text style={styles.kicker}>{meta[0]}</Text>
          <Text style={styles.screenTitle}>{meta[1]}</Text>
          <Text style={styles.description}>{meta[2]}</Text>
          <AppButton label={user ? 'Browse Products' : 'Create Profile'} onPress={() => onNavigate(user ? 'shop' : 'signup')} />
        </View>
      </View>
      <View style={styles.infoGrid}>
        <InfoCard title="AI try-on ready" text="Preview selected products on your profile." />
        <InfoCard title="Catalog shopping" text="Explore styles, categories, and new arrivals." />
        <InfoCard title="Token powered" text="Use tokens only when generating previews." />
        <InfoCard title="Privacy aware" text="Your full-body photo is part of your personal profile." />
      </View>
    </ScrollView>
  );
}

function PolicyText({ text, emailSubject }) {
  const value = String(text || '');
  if (!value.includes(supportEmail)) {
    return <Text style={styles.policyText}>{value}</Text>;
  }
  const parts = value.split(supportEmail);
  return (
    <Text style={styles.policyText}>
      {parts.map((part, index) => (
        <Text key={`${part}-${index}`}>
          {part}
          {index < parts.length - 1 ? (
            <Text style={styles.policyEmail} onPress={() => openSupportEmail(emailSubject)}>{supportEmail}</Text>
          ) : null}
        </Text>
      ))}
    </Text>
  );
}

function NotFoundScreen({ user, onNavigate }) {
  return (
    <ScrollView contentContainerStyle={styles.notFoundContent} {...screenScrollProps}>
      <View style={styles.notFoundMark}>
        <Text style={styles.notFoundCode}>404</Text>
        <View style={styles.notFoundIcon}>
          <Ionicons name="search-outline" size={28} color="#9b5658" />
        </View>
      </View>
      <Text style={styles.notFoundTitle}>Page not found</Text>
      <Text style={styles.notFoundText}>This link may have moved, expired, or never existed. Let’s get you back to shopping.</Text>
      <View style={styles.notFoundActions}>
        <AppButton label="Go Home" icon="home-outline" onPress={() => onNavigate('home')} style={styles.notFoundButton} />
        <AppButton label="Search" icon="search-outline" variant="secondary" onPress={() => onNavigate('search')} style={styles.notFoundButton} />
      </View>
      <TouchableOpacity style={styles.notFoundShopLink} activeOpacity={0.82} onPress={() => onNavigate(user ? 'shop' : 'home')}>
        <Text style={styles.notFoundShopText}>{user ? 'Browse latest products' : 'Continue browsing Lookmefy'}</Text>
        <Ionicons name="arrow-forward" size={17} color="#9b5658" />
      </TouchableOpacity>
    </ScrollView>
  );
}

function FeatureBand() {
  return (
    <View style={styles.featureBand}>
      {['AI Try-On', 'Top Brands', 'Secure & Private', 'Easy Returns'].map((item) => (
        <View key={item} style={styles.featureItem}>
          <Ionicons name="checkmark-circle-outline" size={21} color="#0f766e" />
          <Text style={styles.featureTitle}>{item}</Text>
        </View>
      ))}
    </View>
  );
}

function InfoCard({ title, text }) {
  return (
    <View style={styles.infoCard}>
      <Text style={styles.infoTitle}>{title}</Text>
      <Text style={styles.muted}>{text}</Text>
    </View>
  );
}

function TryOnLoading({ text = 'Generating', large }) {
  return (
    <View pointerEvents="none" style={[styles.tryOnLoading, large && styles.tryOnLoadingLarge]}>
      <ActivityIndicator size="small" color="#ffffff" />
      <Text style={styles.tryOnLoadingText}>{text}</Text>
    </View>
  );
}

function WishlistDoneButton({ saved, onPress, compact }) {
  const handlePress = (event) => {
    event?.stopPropagation?.();
    onPress?.();
  };
  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel={saved ? 'Remove product from wishlist' : 'Add product to wishlist'}
      activeOpacity={0.84}
      style={[styles.wishlistDoneButton, compact && styles.wishlistDoneButtonCompact, saved && styles.wishlistDoneButtonSaved]}
      onPress={handlePress}
    >
      <Ionicons name={saved ? 'heart' : 'heart-outline'} size={compact ? 17 : 19} color={saved ? '#ffffff' : '#111111'} />
    </TouchableOpacity>
  );
}

function OnboardingTour({ visible, step, targetRects = {}, currentRouteName, onNext, onBack, onSkip, onDone }) {
  const { width, height } = useWindowDimensions();
  const [tourCardLayout, setTourCardLayout] = useState({ key: '', height: 0 });
  const total = onboardingTourSteps.length;
  const safeStep = Math.min(Math.max(step, 0), total - 1);
  const active = onboardingTourSteps[safeStep] || onboardingTourSteps[0];
  const intro = safeStep === 0;
  const last = safeStep === total - 1;
  const measuredTarget = !intro && active.targetKey ? targetRects[active.targetKey] : null;
  const measuredMatchesRoute = measuredTarget && (!active.route?.name || measuredTarget.route === active.route.name || measuredTarget.route === currentRouteName);
  const waitingForMeasuredTarget = !intro && active.targetKey && active.route?.name === currentRouteName && !measuredMatchesRoute;
  const rawTarget = !intro && measuredMatchesRoute
    ? measuredTarget
    : (!intro && !waitingForMeasuredTarget && typeof active.target === 'function' ? active.target({ width, height }) : null);
  const target = rawTarget ? {
    x: clamp(rawTarget.x, 8, Math.max(8, width - 56)),
    y: clamp(rawTarget.y, 28, Math.max(28, height - 80)),
    width: clamp(rawTarget.width, 48, Math.max(48, width - 16)),
    height: clamp(rawTarget.height, 48, Math.max(48, height - 56))
  } : null;
  if (target) {
    target.width = Math.min(target.width, width - target.x - 8);
    target.height = Math.min(target.height, height - target.y - 8);
    if (target.height > height * 0.36) {
      const nextHeight = Math.max(96, Math.min(target.height, height * 0.3));
      target.y += (target.height - nextHeight) / 2;
      target.height = nextHeight;
    }
  }
  const spotlightPadding = 8;
  const spotlight = target ? {
    x: Math.max(8, target.x - spotlightPadding),
    y: Math.max(28, target.y - spotlightPadding),
    width: Math.min(width - 16, target.width + spotlightPadding * 2),
    height: Math.min(height - 36, target.height + spotlightPadding * 2)
  } : null;
  if (spotlight) {
    spotlight.width = Math.min(spotlight.width, width - spotlight.x - 8);
    spotlight.height = Math.min(spotlight.height, height - spotlight.y - 8);
  }
  const shouldPlaceAbove = spotlight && (active.placement === 'above' || spotlight.y > height * 0.54);
  const measuredCardHeight = tourCardLayout.key === active.key ? tourCardLayout.height : 0;
  const cardHeight = Math.max(measuredCardHeight, intro ? 286 : 372);
  const cardGap = 18;
  const cardSafeTop = 34;
  const cardSafeBottom = bottomNavigationHeight + 18;
  const maxCardTop = Math.max(cardSafeTop, height - cardSafeBottom - cardHeight);
  const aboveTop = spotlight ? spotlight.y - cardHeight - cardGap : undefined;
  const belowTop = spotlight ? spotlight.y + spotlight.height + cardGap : undefined;
  const aboveFits = spotlight ? aboveTop >= cardSafeTop : false;
  const belowFits = spotlight ? belowTop + cardHeight <= height - cardSafeBottom : false;
  const aboveSpace = spotlight ? spotlight.y - cardSafeTop - cardGap : 0;
  const belowSpace = spotlight ? height - cardSafeBottom - (spotlight.y + spotlight.height) - cardGap : 0;
  const placeAbove = spotlight
    ? shouldPlaceAbove
      ? (aboveFits || !belowFits || aboveSpace >= belowSpace)
      : (!belowFits && (aboveFits || aboveSpace > belowSpace))
    : false;
  const preferredCardTop = spotlight ? (placeAbove ? aboveTop : belowTop) : undefined;
  const cardTop = spotlight
    ? clamp(preferredCardTop, cardSafeTop, maxCardTop)
    : undefined;
  const cardWidth = Math.min(360, width - 40);
  const anchoredCardStyle = spotlight ? [styles.tourCardAnchored, { top: cardTop, left: (width - cardWidth) / 2, width: cardWidth }] : null;
  const handleTourCardLayout = useCallback((event) => {
    const nextHeight = event.nativeEvent.layout.height;
    setTourCardLayout((current) => (
      current.key === active.key && Math.abs(current.height - nextHeight) < 1
        ? current
        : { key: active.key, height: nextHeight }
    ));
  }, [active.key]);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onSkip}>
      <View style={styles.tourOverlay}>
        {spotlight ? (
          <>
            <View style={[styles.tourDimPiece, { left: 0, right: 0, top: 0, height: spotlight.y }]} />
            <View style={[styles.tourDimPiece, { left: 0, top: spotlight.y, width: spotlight.x, height: spotlight.height }]} />
            <View style={[styles.tourDimPiece, { left: spotlight.x + spotlight.width, right: 0, top: spotlight.y, height: spotlight.height }]} />
            <View style={[styles.tourDimPiece, { left: 0, right: 0, top: spotlight.y + spotlight.height, bottom: 0 }]} />
            <View pointerEvents="none" style={[styles.tourSpotlight, { left: spotlight.x, top: spotlight.y, width: spotlight.width, height: spotlight.height }]} />
          </>
        ) : <View style={styles.tourBackdrop} />}
        <View key={active.key} style={[styles.tourCard, intro && styles.tourIntroCard, anchoredCardStyle]} onLayout={handleTourCardLayout}>
          <TouchableOpacity accessibilityRole="button" accessibilityLabel="Skip onboarding tour" style={styles.tourCloseButton} activeOpacity={0.78} onPress={onSkip}>
            <Ionicons name="close" size={17} color="#5d5754" />
          </TouchableOpacity>
          <View style={styles.tourIcon}>
            <Ionicons name={active.icon} size={23} color="#9b5658" />
          </View>
          <Text style={styles.tourEyebrow}>{active.eyebrow}</Text>
          <Text style={styles.tourTitle}>{active.title}</Text>
          <Text style={styles.tourText}>{active.text}</Text>
          {!intro ? (
            <View style={styles.tourHintRow}>
              <Ionicons name="scan-outline" size={16} color="#9b5658" />
              <Text style={styles.tourHintText}>{waitingForMeasuredTarget ? 'Bringing this feature into view...' : 'The highlighted area is where this feature lives.'}</Text>
            </View>
          ) : null}
          <View style={styles.tourDots}>
            {onboardingTourSteps.map((item, index) => (
              <View key={item.key} style={[styles.tourDot, index === safeStep && styles.tourDotActive]} />
            ))}
          </View>
          <View style={styles.tourActions}>
            {!intro ? (
              <TouchableOpacity style={styles.tourSecondaryButton} activeOpacity={0.82} onPress={onBack}>
                <Text style={styles.tourSecondaryText}>Back</Text>
              </TouchableOpacity>
            ) : null}
            <TouchableOpacity style={[styles.tourPrimaryButton, intro && styles.tourPrimaryButtonFull]} activeOpacity={0.88} onPress={last ? onDone : onNext}>
              <Text style={styles.tourPrimaryText}>{active.primary || 'Next'}</Text>
              {!last ? <Ionicons name="arrow-forward" size={18} color="#ffffff" /> : null}
            </TouchableOpacity>
          </View>
          <TouchableOpacity style={styles.tourSkipButton} activeOpacity={0.75} onPress={onSkip}>
            <Text style={styles.tourSkipText}>Skip this tour</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

function AuthPromptModal({ visible, message, onContinue, onClose }) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.authPromptBackdrop} onPress={onClose}>
        <Pressable style={styles.authPromptSheet} onPress={(event) => event.stopPropagation()}>
          <BrandLogo
            compact
            style={styles.authPromptBrand}
            symbolStyle={styles.authPromptBrandSymbol}
            textStyle={styles.authPromptBrandText}
            dividerStyle={styles.authPromptBrandDivider}
          />
          <View style={styles.authPromptIcon}>
            <Ionicons name="lock-closed-outline" size={21} color="#2b2321" />
          </View>
          <Text style={styles.authPromptTitle}>Sign in to continue</Text>
          <Text style={styles.authPromptText}>{message || 'Log in with your mobile number to continue.'}</Text>
          <View style={styles.authPromptChipRow}>
            <View style={styles.authPromptChip}>
              <Ionicons name="heart-outline" size={14} color="#2b2321" />
              <Text style={styles.authPromptChipText}>Wishlist</Text>
            </View>
            <View style={styles.authPromptChip}>
              <Ionicons name="sparkles-outline" size={14} color="#2b2321" />
              <Text style={styles.authPromptChipText}>Try-on</Text>
            </View>
          </View>
          <TouchableOpacity style={styles.authPromptPrimary} activeOpacity={0.88} onPress={onContinue}>
            <Text style={styles.authPromptPrimaryText}>Continue</Text>
            <Ionicons name="arrow-forward" size={19} color="#ffffff" />
          </TouchableOpacity>
          <TouchableOpacity style={styles.authPromptSecondary} activeOpacity={0.75} onPress={onClose}>
            <Text style={styles.authPromptSecondaryText}>Not now</Text>
          </TouchableOpacity>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function ImageLightbox({ uri, onClose }) {
  return (
    <Modal visible={Boolean(uri)} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.lightbox} onPress={onClose}>
        <TouchableOpacity style={styles.closeButton} onPress={onClose}>
          <Ionicons name="close" size={24} color="#fff" />
        </TouchableOpacity>
        {uri ? <Image source={{ uri }} style={styles.lightboxImage} resizeMode="contain" /> : null}
      </Pressable>
    </Modal>
  );
}

export default function App() {
  const [fontsLoaded, fontLoadError] = useFonts(fontAssets);
  const [routeStack, setRouteStack] = useState([{ name: 'home', params: {} }]);
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(null);
  const [ready, setReady] = useState(false);
  const [wishlistProducts, setWishlistProducts] = useState([]);
  const [authPrompt, setAuthPrompt] = useState(null);
  const [onboardingVisible, setOnboardingVisible] = useState(false);
  const [onboardingStep, setOnboardingStep] = useState(0);
  const [tourTargetRects, setTourTargetRects] = useState({});
  const [tourFocusRequest, setTourFocusRequest] = useState(null);
  const [aiStudioOwnerKey, setAiStudioOwnerKey] = useState('');
  const [aiStudioMessages, setAiStudioMessages] = useState([]);
  const [aiStudioTryOns, setAiStudioTryOns] = useState({});
  const [aiStudioTryOnErrors, setAiStudioTryOnErrors] = useState({});
  const wishlistIds = useMemo(() => new Set(wishlistProducts.map((product) => product.id)), [wishlistProducts]);

  const currentRoute = normalizeRoute(routeStack[routeStack.length - 1]?.name, routeStack[routeStack.length - 1]?.params);
  const routeParamsKey = JSON.stringify(currentRoute.params || {});
  const registerTourTarget = useCallback((key, rect) => {
    if (!key || !rect) return;
    const nextRect = {
      x: Number(rect.x) || 0,
      y: Number(rect.y) || 0,
      width: Number(rect.width) || 0,
      height: Number(rect.height) || 0,
      route: currentRoute.name
    };
    if (nextRect.width <= 0 || nextRect.height <= 0) return;
    setTourTargetRects((current) => {
      const previous = current[key];
      if (
        previous &&
        previous.route === nextRect.route &&
        Math.abs(previous.x - nextRect.x) < 1 &&
        Math.abs(previous.y - nextRect.y) < 1 &&
        Math.abs(previous.width - nextRect.width) < 1 &&
        Math.abs(previous.height - nextRect.height) < 1
      ) {
        return current;
      }
      return { ...current, [key]: nextRect };
    });
  }, [currentRoute.name]);
  const navigate = useCallback((name, params = {}) => {
    const next = normalizeRoute(name, params);
    setRouteStack((current) => {
      const active = normalizeRoute(current[current.length - 1]?.name, current[current.length - 1]?.params);
      if (active.name === next.name && JSON.stringify(active.params || {}) === JSON.stringify(next.params || {})) return current;
      return [...current, next];
    });
  }, []);
  useEffect(() => {
    const openRouteFromUrl = (url) => {
      const nextRoute = mobileRouteFromUrl(url);
      if (nextRoute) navigate(nextRoute.name, nextRoute.params);
    };
    Linking.getInitialURL().then(openRouteFromUrl).catch(() => {});
    const subscription = Linking.addEventListener('url', ({ url }) => openRouteFromUrl(url));
    return () => subscription.remove();
  }, [navigate]);
  const replaceRoute = useCallback((name, params = {}) => {
    setRouteStack([normalizeRoute(name, params)]);
  }, []);
  const requestAuth = useCallback((message = 'Log in with your mobile number to continue.') => {
    setAuthPrompt({ message });
  }, []);
  const guardedNavigate = useCallback((name, params = {}) => {
    const protectedMessages = {
      closet: 'Log in with your mobile number to use your wardrobe.',
      tryon: 'Log in with your mobile number to use AI Studio.',
      stylebot: 'Log in with your mobile number to use AI Studio.',
      profile: 'Log in with your mobile number to open your profile.',
      wishlist: 'Log in with your mobile number to view your wishlist.',
      orders: 'Log in with your mobile number to view your orders.'
    };
    if (!user && protectedMessages[name]) {
      requestAuth(protectedMessages[name]);
      return;
    }
    navigate(name, params);
  }, [navigate, requestAuth, user]);
  const goBack = useCallback(() => {
    if (routeStack.length <= 1) return false;
    setRouteStack((current) => {
      if (current.length <= 1) return current;
      return current.slice(0, -1);
    });
    return true;
  }, [routeStack.length]);
  const addToWishlist = useCallback((product) => {
    if (!product?.id) return;
    if (!user) {
      requestAuth('Log in with your mobile number to save products to your wishlist.');
      return;
    }
    setWishlistProducts((current) => {
      if (current.some((item) => item.id === product.id)) return current.filter((item) => item.id !== product.id);
      return [product, ...current];
    });
  }, [requestAuth, user]);

  const refreshUser = useCallback(async (options = {}) => {
    const data = await api('/auth/me', { timeoutMs: options.timeoutMs || 5000, noCache: true });
    if (data?.user) {
      setUser(data.user);
      return data.user;
    }
    return null;
  }, []);

  useEffect(() => {
    let alive = true;
    getToken()
      .then(async (storedToken) => {
        if (!alive) return;
        setToken(storedToken);
        if (!storedToken) return;
        const data = await api('/auth/me', { timeoutMs: 3500, noCache: true });
        if (!alive) return;
        if (data?.user) setUser(data.user);
        setRouteStack((current) => (current.length === 1 && current[0]?.name === 'auth' ? [normalizeRoute('home')] : current));
      })
      .catch(() => {})
      .finally(() => alive && setReady(true));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => goBack());
    return () => subscription.remove();
  }, [goBack]);

  useEffect(() => {
    if (user?.bodyPhotoStatus !== 'generating') return undefined;
    const timer = setInterval(() => {
      refreshUser()
        .catch(() => {});
    }, 7000);
    return () => clearInterval(timer);
  }, [refreshUser, user?.bodyPhotoStatus]);

  useEffect(() => {
    const nextOwnerKey = user ? String(user.id || user._id || user.phone || user.username || 'user') : '';
    if (!nextOwnerKey) {
      if (aiStudioOwnerKey) setAiStudioOwnerKey('');
      if (aiStudioMessages.length) setAiStudioMessages([]);
      if (Object.keys(aiStudioTryOns).length) setAiStudioTryOns({});
      if (Object.keys(aiStudioTryOnErrors).length) setAiStudioTryOnErrors({});
      return;
    }
    if (nextOwnerKey === aiStudioOwnerKey) return;
    setAiStudioOwnerKey(nextOwnerKey);
    setAiStudioMessages(initialAiStudioMessages(user));
    setAiStudioTryOns({});
    setAiStudioTryOnErrors({});
  }, [aiStudioMessages.length, aiStudioOwnerKey, aiStudioTryOnErrors, aiStudioTryOns, user?.id, user?._id, user?.phone, user?.username]);

  useEffect(() => {
    if (!ready || !user) return undefined;
    let alive = true;
    const seenKey = onboardingSeenStorageKey(user);
    Promise.all([
      AsyncStorage.getItem(onboardingPendingStorageKey),
      AsyncStorage.getItem(seenKey)
    ])
      .then(([pending, seen]) => {
        if (!alive || !pending || seen) return;
        if (pending !== '1' && pending !== seenKey) return;
        setOnboardingStep(0);
        setOnboardingVisible(true);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [ready, user?.id, user?._id, user?.phone, user?.username]);

  const performLogout = async () => {
    await clearToken();
    setToken(null);
    setUser(null);
    setOnboardingVisible(false);
    replaceRoute('home');
  };

  const logout = () => {
    Alert.alert('Log out?', 'You can sign in again anytime.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Log out', style: 'destructive', onPress: performLogout }
    ]);
  };

  const showOnboardingStep = useCallback((nextStep) => {
    const safeStep = Math.min(Math.max(nextStep, 0), onboardingTourSteps.length - 1);
    const step = onboardingTourSteps[safeStep];
    const targetRoute = step?.route;
    if (step?.targetKey) {
      setTourTargetRects((current) => {
        if (!current[step.targetKey]) return current;
        const next = { ...current };
        delete next[step.targetKey];
        return next;
      });
      setTourFocusRequest({ targetKey: step.targetKey, routeName: targetRoute?.name || currentRoute.name, nonce: Date.now() });
    }
    setOnboardingStep(safeStep);
    if (targetRoute) replaceRoute(targetRoute.name, targetRoute.params || {});
  }, [currentRoute.name, replaceRoute]);

  const completeOnboarding = useCallback(async () => {
    setOnboardingVisible(false);
    setOnboardingStep(0);
    try {
      const writes = [AsyncStorage.removeItem(onboardingPendingStorageKey)];
      if (user) writes.push(AsyncStorage.setItem(onboardingSeenStorageKey(user), '1'));
      await Promise.all(writes);
    } catch {
      // A storage failure should not trap the user in the tour.
    }
  }, [user]);

  const nextOnboardingStep = useCallback(() => {
    if (onboardingStep >= onboardingTourSteps.length - 1) {
      completeOnboarding();
      return;
    }
    showOnboardingStep(onboardingStep + 1);
  }, [completeOnboarding, onboardingStep, showOnboardingStep]);

  const previousOnboardingStep = useCallback(() => {
    showOnboardingStep(onboardingStep - 1);
  }, [onboardingStep, showOnboardingStep]);

  const screen = useMemo(() => {
    const routeParams = currentRoute.params || {};
    switch (currentRoute.name) {
      case 'auth':
        return user ? <HomeScreen onNavigate={guardedNavigate} user={user} token={token} onAddToWishlist={addToWishlist} wishlistIds={wishlistIds} registerTourTarget={registerTourTarget} tourFocusRequest={tourFocusRequest} /> : <AuthEntryScreen onNavigate={navigate} />;
      case 'home':
        return <HomeScreen onNavigate={guardedNavigate} user={user} token={token} onAddToWishlist={addToWishlist} wishlistIds={wishlistIds} registerTourTarget={registerTourTarget} tourFocusRequest={tourFocusRequest} />;
      case 'shop':
        return <ShopScreen initial={routeParams} user={user} setUser={setUser} token={token} onNavigate={guardedNavigate} onRequireAuth={requestAuth} onAddToWishlist={addToWishlist} wishlistIds={wishlistIds} />;
      case 'search':
        return <SearchScreen initial={routeParams} user={user} token={token} onNavigate={guardedNavigate} onBack={goBack} onAddToWishlist={addToWishlist} wishlistIds={wishlistIds} />;
      case 'tryon':
        return user ? <StyleBotScreen user={user} setUser={setUser} setToken={setToken} token={token} onNavigate={guardedNavigate} onRequireAuth={requestAuth} registerTourTarget={registerTourTarget} tourFocusRequest={tourFocusRequest} aiStudioMessages={aiStudioMessages} setAiStudioMessages={setAiStudioMessages} aiStudioTryOns={aiStudioTryOns} setAiStudioTryOns={setAiStudioTryOns} aiStudioTryOnErrors={aiStudioTryOnErrors} setAiStudioTryOnErrors={setAiStudioTryOnErrors} /> : <AuthScreen mode="signup" setUser={setUser} setToken={setToken} onNavigate={navigate} />;
      case 'closet':
        return <ClosetScreen initial={routeParams} user={user} setUser={setUser} setToken={setToken} token={token} onNavigate={guardedNavigate} registerTourTarget={registerTourTarget} tourFocusRequest={tourFocusRequest} />;
      case 'custom':
        return <CustomTryOnScreen user={user} setUser={setUser} setToken={setToken} token={token} onNavigate={guardedNavigate} refreshUser={refreshUser} />;
      case 'stylebot':
        return <StyleBotScreen user={user} setUser={setUser} setToken={setToken} token={token} onNavigate={guardedNavigate} registerTourTarget={registerTourTarget} tourFocusRequest={tourFocusRequest} aiStudioMessages={aiStudioMessages} setAiStudioMessages={setAiStudioMessages} aiStudioTryOns={aiStudioTryOns} setAiStudioTryOns={setAiStudioTryOns} aiStudioTryOnErrors={aiStudioTryOnErrors} setAiStudioTryOnErrors={setAiStudioTryOnErrors} />;
      case 'tokens':
        return <TokensScreen user={user} setUser={setUser} onNavigate={guardedNavigate} onRequireAuth={requestAuth} />;
      case 'profile':
        return <ProfileScreen user={user} setUser={setUser} setToken={setToken} token={token} onNavigate={guardedNavigate} onLogout={logout} registerTourTarget={registerTourTarget} tourFocusRequest={tourFocusRequest} />;
      case 'generation-history':
        return user ? <GenerationHistoryScreen user={user} setUser={setUser} setToken={setToken} token={token} onNavigate={guardedNavigate} /> : <AuthScreen mode="login" setUser={setUser} setToken={setToken} onNavigate={navigate} />;
      case 'wishlist':
        return user ? <WishlistScreen onNavigate={guardedNavigate} token={token} wishlistProducts={wishlistProducts} user={user} /> : <AuthScreen mode="login" setUser={setUser} setToken={setToken} onNavigate={navigate} />;
      case 'orders':
        return user ? <OrdersScreen onNavigate={guardedNavigate} token={token} user={user} /> : <AuthScreen mode="login" setUser={setUser} setToken={setToken} onNavigate={navigate} />;
      case 'product':
        return routeParams.id ? <ProductScreen id={routeParams.id} user={user} setUser={setUser} token={token} onNavigate={guardedNavigate} onRequireAuth={requestAuth} onAddToWishlist={addToWishlist} wishlistIds={wishlistIds} /> : <ShopScreen initial={{}} user={user} setUser={setUser} token={token} onNavigate={guardedNavigate} onRequireAuth={requestAuth} onAddToWishlist={addToWishlist} wishlistIds={wishlistIds} />;
      case 'signup':
        return <AuthScreen mode="signup" setUser={setUser} setToken={setToken} onNavigate={navigate} />;
      case 'login':
        return <AuthScreen mode="login" setUser={setUser} setToken={setToken} onNavigate={navigate} />;
      case 'how':
        return <HowItWorksScreen user={user} onNavigate={navigate} />;
      case 'info':
        return <InfoScreen page={routeParams.page} user={user} onNavigate={navigate} />;
      default:
        return <InfoScreen page="missing" user={user} onNavigate={navigate} />;
    }
  }, [currentRoute.name, routeParamsKey, user, token, navigate, guardedNavigate, requestAuth, addToWishlist, wishlistIds, wishlistProducts, registerTourTarget, tourFocusRequest, aiStudioMessages, aiStudioTryOns, aiStudioTryOnErrors, refreshUser]);

  if (!ready || (!fontsLoaded && !fontLoadError)) {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.boot}>
          <ActivityIndicator size="small" color="#9b5658" />
          <Text style={styles.bootText}>Loading Lookmefy</Text>
        </View>
      </SafeAreaView>
    );
  }

  const authOnlyRoute = !user && ['auth', 'login', 'signup'].includes(currentRoute.name);
  const welcomeRoute = !user && currentRoute.name === 'auth';
  const signupRoute = !user && currentRoute.name === 'signup';
  const loginRoute = !user && currentRoute.name === 'login';
  const homeRoute = currentRoute.name === 'home';
  const shopRoute = currentRoute.name === 'shop';
  const searchRoute = currentRoute.name === 'search';
  const closetRoute = currentRoute.name === 'closet';
  const closetAddRoute = closetRoute && currentRoute.params?.view === 'add';
  const productRoute = currentRoute.name === 'product';
  const aiStudioRoute = currentRoute.name === 'tryon';
  const tokensRoute = currentRoute.name === 'tokens';
  const profileRoute = currentRoute.name === 'profile';
  const generationHistoryRoute = currentRoute.name === 'generation-history';
  const wishlistRoute = currentRoute.name === 'wishlist';
  const ordersRoute = currentRoute.name === 'orders';
  const accountChildRoute = wishlistRoute || ordersRoute || generationHistoryRoute;

  return (
    <SafeAreaView style={[styles.safe, welcomeRoute && styles.authEntrySafe, signupRoute && styles.signupSafe, loginRoute && styles.loginSafe, homeRoute && styles.homeSafe, shopRoute && styles.shopSafe, searchRoute && styles.shopSafe, closetRoute && styles.wardrobeSafe, productRoute && styles.productSafe, aiStudioRoute && styles.aiStudioSafe, tokensRoute && styles.creditsSafe, profileRoute && styles.profileSafe, accountChildRoute && styles.profileSafe]}>
      <StatusBar style={welcomeRoute ? 'light' : 'dark'} />
      {authOnlyRoute || homeRoute || shopRoute || searchRoute || closetRoute || productRoute || aiStudioRoute || tokensRoute || profileRoute || accountChildRoute ? null : <AppHeader onNavigate={guardedNavigate} user={user} compact />}
      <View style={styles.content}>
        <ScreenErrorBoundary routeName={currentRoute.name} onHome={() => navigate('home')}>
          {screen}
        </ScreenErrorBoundary>
      </View>
      {authOnlyRoute || searchRoute || closetAddRoute || tokensRoute ? null : <View style={styles.bottomNavFrame}><BottomNav route={currentRoute} onNavigate={guardedNavigate} /></View>}
      <AuthPromptModal
        visible={Boolean(authPrompt)}
        message={authPrompt?.message}
        onClose={() => setAuthPrompt(null)}
        onContinue={() => {
          setAuthPrompt(null);
          navigate('login');
        }}
      />
      <OnboardingTour
        visible={onboardingVisible && Boolean(user)}
        step={onboardingStep}
        targetRects={tourTargetRects}
        currentRouteName={currentRoute.name}
        onNext={nextOnboardingStep}
        onBack={previousOnboardingStep}
        onSkip={completeOnboarding}
        onDone={completeOnboarding}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: '#f8fafc'
  },
  authEntrySafe: {
    backgroundColor: '#111111'
  },
  signupSafe: {
    backgroundColor: '#fbf7f6'
  },
  loginSafe: {
    backgroundColor: '#fbf7f6'
  },
  homeSafe: {
    backgroundColor: '#fbf7f6'
  },
  shopSafe: {
    backgroundColor: '#fbf7f6'
  },
  wardrobeSafe: {
    backgroundColor: '#fbf7f6'
  },
  productSafe: {
    backgroundColor: '#fbf7f6'
  },
  aiStudioSafe: {
    backgroundColor: '#fbf7f6'
  },
  creditsSafe: {
    backgroundColor: '#fbf7f6'
  },
  profileSafe: {
    backgroundColor: '#fbf7f6'
  },
  flex: {
    flex: 1
  },
  boot: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingHorizontal: 28,
    backgroundColor: '#fbf7f6'
  },
  bootText: {
    ...typography.caption,
    color: '#5d5754',
    fontSize: 13,
    lineHeight: 18
  },
  bootBrand: {
    ...typography.display,
    color: '#211c1a',
    lineHeight: 36
  },
  bootCard: {
    width: '100%',
    maxWidth: 260,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#eee3dc',
    backgroundColor: '#fffdfb',
    padding: 18,
    gap: 10,
    shadowColor: '#2a211d',
    shadowOpacity: 0.08,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 3
  },
  content: {
    flex: 1,
    maxWidth: 520,
    width: '100%',
    alignSelf: 'center',
    backgroundColor: '#fbf7f6'
  },
  scrollContent: {
    paddingBottom: Platform.OS === 'android' ? 118 : 132,
    paddingHorizontal: 16
  },
  appHeader: {
    minHeight: Platform.OS === 'android' ? appTopInset + 58 : 60,
    paddingHorizontal: 16,
    paddingTop: Platform.OS === 'android' ? appTopInset + 10 : 8,
    paddingBottom: 8,
    backgroundColor: '#fbf7f6',
    borderBottomWidth: 1,
    borderBottomColor: '#ece5e1',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between'
  },
  appHeaderCompact: {
    minHeight: Platform.OS === 'android' ? (NativeStatusBar.currentHeight || 24) + 42 : 52,
    paddingTop: Platform.OS === 'android' ? Math.max(8, (NativeStatusBar.currentHeight || 24) - 10) : 6,
    paddingBottom: 4,
    zIndex: 10
  },
  appHeaderAction: {
    width: 40,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center'
  },
  appHeaderSide: {
    width: 168,
    minHeight: 42,
    flexDirection: 'row',
    alignItems: 'center'
  },
  appHeaderLeftSide: {
    justifyContent: 'flex-start'
  },
  appHeaderRightSide: {
    justifyContent: 'flex-end'
  },
  appHeaderBrandWrap: {
    minHeight: 42,
    justifyContent: 'center',
    alignItems: 'center',
    flex: 1
  },
  appHeaderBrandWrapLeft: {
    alignItems: 'flex-start'
  },
  appHeaderBrand: {
    ...typography.h3,
    color: '#111111',
    fontSize: 20,
    lineHeight: 24
  },
  brandLogo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    maxWidth: '100%'
  },
  brandLogoCompact: {
    gap: 8
  },
  brandLogoSymbol: {
    width: 42,
    height: 42
  },
  brandLogoSymbolCompact: {
    width: 32,
    height: 32
  },
  brandLogoSymbolLight: {
    tintColor: '#ffffff'
  },
  brandLogoDivider: {
    width: 1,
    height: 31,
    backgroundColor: '#cfc7c2'
  },
  brandLogoDividerCompact: {
    height: 25
  },
  brandLogoDividerLight: {
    backgroundColor: 'rgba(255, 255, 255, 0.58)'
  },
  brandLogoText: {
    color: '#050505',
    fontFamily: fontFamilies.logo,
    fontSize: 28,
    lineHeight: 34,
    fontWeight: '400',
    letterSpacing: 0
  },
  brandLogoTextCompact: {
    fontSize: 25,
    lineHeight: 30
  },
  brandLogoTextLight: {
    color: '#ffffff'
  },
  appHeaderAvatar: {
    width: 32,
    height: 32,
    borderRadius: 16
  },
  appHeaderAvatarInitials: {
    fontSize: 12,
    lineHeight: 16
  },
  avatarFaceImage: {
    transform: [{ scale: 1.04 }]
  },
  header: {
    paddingHorizontal: 18,
    paddingTop: Platform.OS === 'android' ? 38 : 12,
    paddingBottom: 12,
    backgroundColor: '#ffffff',
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between'
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    flex: 1
  },
  headerSub: {
    ...typography.caption,
    marginTop: 1,
    color: '#64748b',
    fontWeight: '700'
  },
  headerNotice: {
    ...typography.caption,
    marginTop: 2,
    color: '#0f766e',
    fontSize: 11,
    fontWeight: '700'
  },
  headerActions: {
    flexDirection: 'row',
    gap: 8
  },
  iconButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center'
  },
  headerAvatar: {
    width: 34,
    height: 34,
    borderRadius: 17
  },
  headerAvatarInitials: {
    fontSize: 12,
    lineHeight: 16
  },
  bottomNavFrame: {
    width: '100%',
    alignItems: 'center',
    backgroundColor: '#fbf7f6',
    borderTopWidth: 1,
    borderTopColor: 'rgba(236, 229, 225, 0.72)',
    shadowColor: '#1f1714',
    shadowOpacity: 0.08,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: -8 },
    elevation: 10
  },
  bottomNav: {
    width: '100%',
    maxWidth: 520,
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingTop: 10,
    paddingBottom: Platform.OS === 'ios' ? 22 : 12,
    paddingHorizontal: 10,
    backgroundColor: '#fffdfb'
  },
  navItem: {
    flex: 1,
    minWidth: 0,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    minHeight: 60
  },
  navIconWrap: {
    width: 44,
    height: 30,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent'
  },
  navIconWrapCenter: {
    width: 44,
    height: 30,
    borderRadius: 0,
    borderWidth: 0,
    backgroundColor: 'transparent'
  },
  navText: {
    ...typography.nav,
    fontSize: 11,
    lineHeight: 14,
    color: '#8d8682',
    fontWeight: '600'
  },
  navTextActive: {
    color: '#111111',
    fontFamily: fontFamilies.bodyBold,
    fontWeight: '700'
  },
  navActiveUnderline: {
    width: 42,
    height: 3,
    borderRadius: 2,
    marginTop: 5,
    backgroundColor: 'transparent'
  },
  navActiveUnderlineVisible: {
    backgroundColor: '#111111'
  },
  homeScreen: {
    flex: 1,
    backgroundColor: '#fbf7f6'
  },
  homeScroll: {
    flex: 1,
    backgroundColor: '#fbf7f6'
  },
  homeContent: {
    paddingBottom: screenBottomInset,
    backgroundColor: '#fbf7f6'
  },
  homeTopBar: {
    height: 52,
    paddingHorizontal: 16,
    backgroundColor: '#fbf7f6',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between'
  },
  homeTopIcon: {
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center'
  },
  homeBrand: {
    ...typography.h3,
    color: '#111111',
    fontSize: 19,
    lineHeight: 23
  },
  homeHero: {
    marginHorizontal: 16,
    height: 184,
    overflow: 'hidden',
    backgroundColor: '#d8c5b6'
  },
  homeHeroSlide: {
    height: '100%'
  },
  homeHeroImage: {
    width: '100%',
    height: '100%'
  },
  homeHeroShade: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0, 0, 0, 0.22)'
  },
  homeHeroCopy: {
    position: 'absolute',
    left: 20,
    bottom: 20
  },
  homeHeroTitle: {
    ...typography.h2,
    color: '#ffffff',
    fontSize: 24,
    lineHeight: 29
  },
  homeHeroButton: {
    marginTop: 12,
    alignSelf: 'flex-start',
    minWidth: 132,
    minHeight: 44,
    borderRadius: 6,
    backgroundColor: '#1f1f1f',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20
  },
  homeHeroButtonText: {
    ...typography.label,
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '700'
  },
  homeHeroDots: {
    position: 'absolute',
    right: 16,
    bottom: 14,
    flexDirection: 'row',
    alignItems: 'center'
  },
  homeHeroDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginLeft: 6,
    backgroundColor: 'rgba(255, 255, 255, 0.45)'
  },
  homeHeroDotActive: {
    width: 18,
    backgroundColor: '#ffffff'
  },
  homeSection: {
    marginTop: 26,
    paddingHorizontal: 18
  },
  homeSectionHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between'
  },
  homeSectionTitle: {
    ...typography.h3,
    color: '#1f1b19',
    fontSize: 20,
    lineHeight: 26
  },
  homeViewAll: {
    ...typography.caption,
    color: '#1f1b19',
    fontSize: 10,
    fontWeight: '700',
    textDecorationLine: 'underline',
    letterSpacing: 0
  },
  homeCategoryTrack: {
    paddingTop: 20,
    gap: 10,
    paddingRight: 2
  },
  homeCategoryItem: {
    width: 60,
    alignItems: 'center'
  },
  homeCategoryImageFrame: {
    width: 58,
    height: 58,
    borderRadius: 29,
    padding: 2,
    borderWidth: 1,
    borderColor: '#eee3dc',
    backgroundColor: '#fffdfb',
    shadowColor: '#2a211d',
    shadowOpacity: 0.1,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 7 },
    elevation: 3
  },
  homeCategoryImageFrameActive: {
    borderColor: '#b66d70',
    backgroundColor: '#fff8f6',
    shadowColor: '#9b5658',
    shadowOpacity: 0.16
  },
  homeCategoryImage: {
    width: '100%',
    height: '100%',
    borderRadius: 27,
    backgroundColor: '#f3eee9'
  },
  homeCategoryLabel: {
    ...typography.caption,
    width: '100%',
    marginTop: 11,
    color: '#25201d',
    fontSize: 10,
    lineHeight: 13,
    fontWeight: '700',
    textAlign: 'center'
  },
  homeCategoryLabelActive: {
    color: '#9b5658'
  },
  homeCurationTitle: {
    ...typography.h2,
    marginTop: 28,
    marginBottom: 20,
    color: '#1f1b19',
    textAlign: 'center',
    fontSize: 22,
    lineHeight: 28,
    fontWeight: '600'
  },
  homeCuratedGrid: {
    paddingHorizontal: 18,
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    rowGap: 24
  },
  homeProductCard: {
    width: '47%'
  },
  homeProductImageWrap: {
    aspectRatio: productImageAspectRatio,
    borderRadius: 9,
    overflow: 'hidden',
    backgroundColor: '#eee7e2',
    position: 'relative'
  },
  homeProductImage: {
    width: '100%',
    height: '100%'
  },
  homeNewBadge: {
    ...typography.caption,
    position: 'absolute',
    left: 8,
    top: 8,
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 999,
    overflow: 'hidden',
    backgroundColor: '#8e343c',
    color: '#fff',
    fontSize: 8,
    fontWeight: '700'
  },
  homeProductEyebrow: {
    ...typography.caption,
    marginTop: 9,
    color: '#a39b96',
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 0
  },
  homeProductTitle: {
    ...typography.productTitle,
    marginTop: 3,
    color: '#171717',
    fontSize: 13,
    lineHeight: 17,
    fontWeight: '500',
    letterSpacing: 0
  },
  homeProductPrice: {
    ...typography.price,
    marginTop: 3,
    color: '#171717',
    fontSize: 12,
    fontWeight: '700'
  },
  homeJournalBand: {
    marginTop: 34,
    paddingTop: 26,
    paddingHorizontal: 16,
    paddingBottom: 48,
    backgroundColor: '#f6efeb'
  },
  homeJournalHead: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    gap: 14
  },
  homeJournalKicker: {
    ...typography.label,
    color: '#9b5658',
    fontSize: 10,
    lineHeight: 13,
    fontWeight: '700',
    letterSpacing: 0
  },
  homeJournalTitle: {
    ...typography.h2,
    color: '#1f1b19',
    lineHeight: 30
  },
  homeJournalLink: {
    minHeight: 34,
    borderRadius: 17,
    borderWidth: 1,
    borderColor: '#dfd2cd',
    backgroundColor: '#fffaf7',
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5
  },
  homeJournalLinkText: {
    ...typography.caption,
    color: '#9b5658',
    fontSize: 11,
    fontWeight: '700'
  },
  homeJournalIntro: {
    ...typography.smallBody,
    marginTop: 10,
    maxWidth: 310,
    color: '#706762',
    fontSize: 13,
    lineHeight: 19,
    fontWeight: '500'
  },
  homeJournalGrid: {
    marginTop: 18,
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    rowGap: 16
  },
  homeJournalProductCard: {
    width: '47.6%',
    borderRadius: 10,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#eadfdb',
    backgroundColor: '#fffdfb'
  },
  homeJournalImageFrame: {
    width: '100%',
    aspectRatio: productImageAspectRatio,
    overflow: 'hidden',
    backgroundColor: '#e7ded7',
    position: 'relative'
  },
  homeJournalImage: {
    width: '100%',
    height: '100%',
    backgroundColor: '#e7ded7'
  },
  homeJournalOverlay: {
    position: 'absolute',
    left: 8,
    right: 8,
    bottom: 8,
    minHeight: 28,
    borderRadius: 14,
    backgroundColor: 'rgba(255, 253, 251, 0.92)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8
  },
  homeJournalLookLabel: {
    ...typography.caption,
    color: '#5b514d',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0
  },
  homeJournalProductBody: {
    minHeight: 88,
    paddingHorizontal: 10,
    paddingTop: 9,
    paddingBottom: 11
  },
  homeJournalProductLabel: {
    ...typography.caption,
    color: '#9b5658',
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 0
  },
  homeJournalProductTitle: {
    ...typography.productTitle,
    marginTop: 3,
    color: '#211c1a',
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '700'
  },
  homeJournalProductPrice: {
    ...typography.price,
    marginTop: 4,
    color: '#211c1a',
    fontSize: 11,
    fontWeight: '700'
  },
  shopScreen: {
    flex: 1,
    backgroundColor: '#fbf7f6'
  },
  shopContent: {
    paddingBottom: screenBottomInset,
    backgroundColor: '#fbf7f6'
  },
  categoryScreen: {
    flex: 1,
    backgroundColor: '#ffffff'
  },
  categoryTopBar: {
    minHeight: Platform.OS === 'android' ? appTopInset + 64 : 66,
    paddingTop: Platform.OS === 'android' ? appTopInset + 10 : 10,
    paddingBottom: 10,
    paddingLeft: 22,
    paddingRight: 12,
    backgroundColor: '#ffffff',
    borderBottomWidth: 1,
    borderBottomColor: '#dad9df',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between'
  },
  categoryTopTitle: {
    ...typography.h4,
    color: '#302b34',
    fontSize: 18,
    lineHeight: 23,
    fontWeight: '700'
  },
  categoryTopActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11
  },
  categoryTopAction: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center'
  },
  categoryBrowser: {
    flex: 1,
    flexDirection: 'row',
    backgroundColor: '#ffffff'
  },
  categoryRail: {
    width: 78,
    maxWidth: 78,
    flexBasis: 78,
    flexGrow: 0,
    flexShrink: 0,
    backgroundColor: '#f6f6f9',
    borderRightWidth: 1,
    borderRightColor: '#e2e1e7'
  },
  categoryRailContent: {
    paddingBottom: 18
  },
  categoryRailItem: {
    minHeight: 82,
    paddingVertical: 8,
    paddingHorizontal: 5,
    alignItems: 'center',
    justifyContent: 'center',
    borderBottomWidth: 1,
    borderBottomColor: '#e5e4ea',
    position: 'relative'
  },
  categoryRailItemActive: {
    backgroundColor: '#ffffff'
  },
  categoryRailAccent: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: 4,
    borderTopRightRadius: 5,
    borderBottomRightRadius: 5,
    backgroundColor: '#9b5658'
  },
  categoryRailImageFrame: {
    width: 44,
    height: 44,
    borderRadius: 22,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#ffffff'
  },
  categoryRailImageFrameActive: {
    backgroundColor: '#fff5f3'
  },
  categoryRailImage: {
    width: '100%',
    height: '100%',
    borderRadius: 22,
    backgroundColor: '#f1eef4'
  },
  categoryRailLabel: {
    marginTop: 6,
    color: '#6b6570',
    fontSize: 11,
    lineHeight: 14,
    fontWeight: '600',
    textAlign: 'center',
    letterSpacing: 0
  },
  categoryRailLabelActive: {
    color: '#9b5658',
    fontWeight: '700'
  },
  categoryMain: {
    flex: 1,
    backgroundColor: '#ffffff'
  },
  categoryMainContent: {
    paddingTop: 18,
    paddingHorizontal: 16,
    paddingBottom: 28
  },
  categoryKickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: 7
  },
  categoryKicker: {
    color: '#9d98a5',
    fontSize: 13,
    lineHeight: 16,
    fontWeight: '700',
    letterSpacing: 0
  },
  categoryKickerLine: {
    flex: 1,
    height: 1,
    backgroundColor: '#cac8cf'
  },
  categoryHeadline: {
    color: '#302c35',
    fontSize: 21,
    lineHeight: 27,
    fontWeight: '700',
    letterSpacing: 0
  },
  categoryTileGrid: {
    marginTop: 16,
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    rowGap: 20
  },
  categoryTile: {
    width: '31.5%',
    minHeight: 126,
    alignItems: 'center'
  },
  categoryContentImageFrame: {
    width: 70,
    height: 70,
    borderRadius: 35,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#fbf8fb',
    borderWidth: 1,
    borderColor: '#eeeef2'
  },
  categoryContentImage: {
    width: '100%',
    height: '100%',
    borderRadius: 35,
    backgroundColor: '#f4f1f5'
  },
  categoryTileLabel: {
    width: '100%',
    marginTop: 8,
    color: '#68636f',
    fontSize: 14,
    lineHeight: 17,
    fontWeight: '600',
    textAlign: 'center',
    letterSpacing: 0
  },
  categorySectionTitle: {
    ...typography.h2,
    marginTop: 21,
    color: '#302c35',
    fontSize: 22,
    lineHeight: 28,
    fontWeight: '700'
  },
  shopTopBar: {
    height: 52,
    paddingHorizontal: 16,
    backgroundColor: '#fbf7f6',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between'
  },
  shopTopIcon: {
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center'
  },
  shopBrand: {
    ...typography.h3,
    color: '#111111',
    fontSize: 19,
    lineHeight: 23,
    fontWeight: '700'
  },
  shopHero: {
    height: 214,
    overflow: 'hidden',
    backgroundColor: '#d7cabe'
  },
  shopHeroImage: {
    width: '100%',
    height: '100%'
  },
  shopHeroShade: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(255, 249, 246, 0.18)'
  },
  shopHeroCopy: {
    position: 'absolute',
    left: 18,
    right: 18,
    top: 22,
    alignItems: 'center'
  },
  shopHeroTitle: {
    ...typography.display,
    color: '#070707',
    textAlign: 'center',
    lineHeight: 36,
    fontWeight: '700'
  },
  shopHeroText: {
    ...typography.caption,
    marginTop: 12,
    maxWidth: 236,
    color: 'rgba(25, 24, 23, 0.68)',
    textAlign: 'center',
    fontSize: 12,
    lineHeight: 18,
    fontWeight: '600'
  },
  shopHeroButton: {
    marginTop: 18,
    width: '100%',
    maxWidth: 308,
    minHeight: 42,
    borderRadius: 8,
    backgroundColor: '#050505',
    alignItems: 'center',
    justifyContent: 'center'
  },
  shopHeroButtonText: {
    ...typography.label,
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0
  },
  shopCategorySection: {
    marginTop: -1,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 18,
    backgroundColor: '#ffffff'
  },
  shopSectionHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between'
  },
  shopSectionTitle: {
    ...typography.h3,
    color: '#191513',
    fontSize: 21,
    lineHeight: 27,
    fontWeight: '600'
  },
  shopSectionSub: {
    ...typography.caption,
    marginTop: 2,
    color: '#645f5c',
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '500'
  },
  shopViewAll: {
    ...typography.caption,
    color: '#4a4643',
    fontSize: 12,
    fontWeight: '700'
  },
  shopCategoryRow: {
    marginTop: 18,
    flexDirection: 'row',
    justifyContent: 'space-between'
  },
  shopCategoryItem: {
    width: 66,
    alignItems: 'center'
  },
  shopCategoryImageFrame: {
    width: 60,
    height: 60,
    borderRadius: 30,
    padding: 3,
    borderWidth: 1,
    borderColor: '#eee3dc',
    backgroundColor: '#fffdfb',
    shadowColor: '#2a211d',
    shadowOpacity: 0.1,
    shadowRadius: 13,
    shadowOffset: { width: 0, height: 7 },
    elevation: 3
  },
  shopCategoryImageFrameActive: {
    borderColor: '#9b5658',
    backgroundColor: '#fff7f4',
    shadowColor: '#9b5658',
    shadowOpacity: 0.16
  },
  shopCategoryImage: {
    width: '100%',
    height: '100%',
    borderRadius: 27,
    backgroundColor: '#f3eee9'
  },
  shopCategoryLabel: {
    width: '100%',
    marginTop: 11,
    color: '#25201d',
    fontSize: 10,
    lineHeight: 13,
    fontWeight: '700',
    letterSpacing: 0,
    textAlign: 'center'
  },
  shopCategoryLabelActive: {
    color: '#9b5658'
  },
  shopArrivalsSection: {
    paddingHorizontal: 16,
    paddingTop: 34
  },
  shopArrivalsHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 20
  },
  shopPager: {
    flexDirection: 'row',
    gap: 14
  },
  shopPagerButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#ece5e1',
    alignItems: 'center',
    justifyContent: 'center'
  },
  shopArrivalGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    rowGap: 26
  },
  shopArrivalCard: {
    width: '47%'
  },
  shopArrivalImageWrap: {
    height: 106,
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: '#ece4df',
    position: 'relative'
  },
  shopArrivalImage: {
    width: '100%',
    height: '100%'
  },
  shopArrivalBrand: {
    marginTop: 10,
    color: '#55504d',
    fontSize: 9,
    fontWeight: '700'
  },
  shopArrivalName: {
    marginTop: 4,
    color: '#171412',
    fontSize: 13,
    lineHeight: 17,
    fontWeight: '600'
  },
  shopArrivalPrice: {
    marginTop: 5,
    color: '#a5676b',
    fontSize: 12,
    fontWeight: '600'
  },
  shopSwatches: {
    marginTop: 8,
    flexDirection: 'row',
    gap: 8
  },
  shopSwatch: {
    width: 10,
    height: 10,
    borderRadius: 5,
    borderWidth: 1,
    borderColor: 'rgba(17, 17, 17, 0.05)'
  },
  shopDiscountCard: {
    marginTop: 34,
    marginHorizontal: 16,
    minHeight: 112,
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: '#090909',
    flexDirection: 'row'
  },
  shopDiscountCopy: {
    width: '54%',
    paddingLeft: 23,
    paddingVertical: 21,
    justifyContent: 'center',
    zIndex: 1
  },
  shopDiscountImage: {
    position: 'absolute',
    right: 0,
    top: 0,
    bottom: 0,
    width: '58%',
    height: '100%',
    opacity: 0.42
  },
  shopPromoEyebrow: {
    ...typography.label,
    color: '#ffffff',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0
  },
  shopDiscountTitle: {
    ...typography.h1,
    marginTop: 8,
    color: '#ffffff',
    lineHeight: 34,
    fontWeight: '700'
  },
  shopDiscountText: {
    ...typography.caption,
    marginTop: 4,
    color: '#8e8e8e',
    fontSize: 12,
    fontWeight: '600'
  },
  shopDiscountButton: {
    marginTop: 14,
    width: 112,
    minHeight: 24,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#ffffff',
    alignItems: 'center',
    justifyContent: 'center'
  },
  shopDiscountButtonText: {
    ...typography.caption,
    color: '#ffffff',
    fontSize: 10,
    fontWeight: '700'
  },
  shopLookCard: {
    marginTop: 18,
    marginHorizontal: 16,
    height: 184,
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: '#e2d5cc'
  },
  shopLookImage: {
    width: '100%',
    height: '100%'
  },
  shopLookShade: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0, 0, 0, 0.18)'
  },
  shopLookCopy: {
    position: 'absolute',
    left: 28,
    bottom: 28
  },
  shopLookEyebrow: {
    ...typography.label,
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0
  },
  shopLookTitle: {
    ...typography.display,
    marginTop: 4,
    color: '#ffffff',
    lineHeight: 36,
    fontWeight: '700'
  },
  shopLookAction: {
    ...typography.caption,
    marginTop: 18,
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '700',
    textDecorationLine: 'underline'
  },
  shopExploreHead: {
    paddingHorizontal: 18,
    paddingTop: 30,
    paddingBottom: 22
  },
  shopValuesBand: {
    paddingHorizontal: 26,
    paddingTop: 104,
    paddingBottom: 52,
    backgroundColor: '#f0e9e9',
    gap: 58
  },
  shopValueItem: {
    alignItems: 'center'
  },
  shopValueTitle: {
    marginTop: 22,
    color: '#2e2b29',
    textAlign: 'center',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0
  },
  shopValueText: {
    marginTop: 15,
    maxWidth: 286,
    color: '#5d5754',
    textAlign: 'center',
    fontSize: 12,
    lineHeight: 18,
    fontWeight: '600'
  },
  shopFloatingButton: {
    position: 'absolute',
    right: 18,
    bottom: Platform.OS === 'ios' ? 91 : 82,
    width: 54,
    height: 54,
    borderRadius: 27,
    backgroundColor: '#050505',
    alignItems: 'center',
    justifyContent: 'center'
  },
  wardrobeScreen: {
    flex: 1,
    backgroundColor: '#fbf7f6'
  },
  wardrobeContent: {
    paddingBottom: screenBottomInset + 72,
    backgroundColor: '#fbf7f6'
  },
  wardrobeTopBar: {
    height: 86,
    paddingHorizontal: 28,
    backgroundColor: '#fbf7f6',
    borderBottomWidth: 1,
    borderBottomColor: '#ece5e1',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between'
  },
  wardrobeBrand: {
    ...typography.display,
    color: '#111111',
    fontSize: 30,
    lineHeight: 36
  },
  wardrobeTopActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 18
  },
  wardrobeTopIcon: {
    width: 34,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center'
  },
  wardrobeAvatarButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    overflow: 'hidden',
    backgroundColor: '#f1e8e2',
    alignItems: 'center',
    justifyContent: 'center'
  },
  wardrobeAvatar: {
    width: '100%',
    height: '100%'
  },
  wardrobeHeroHead: {
    paddingHorizontal: 18,
    paddingTop: 28,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 18
  },
  wardrobeTitle: {
    ...typography.h1,
    color: '#1b1715',
    fontSize: 26,
    lineHeight: 32
  },
  wardrobeSubtitle: {
    ...typography.body,
    marginTop: 4,
    color: '#514f4e',
    fontSize: 15,
    lineHeight: 20
  },
  wardrobeAddButton: {
    minHeight: 38,
    borderRadius: 19,
    backgroundColor: '#050505',
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 9
  },
  wardrobeAddText: {
    ...typography.label,
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '700'
  },
  wardrobeCategoryTrack: {
    paddingHorizontal: 18,
    paddingTop: 24,
    paddingBottom: 32,
    gap: 16
  },
  wardrobeCategoryButton: {
    width: 64,
    alignItems: 'center'
  },
  wardrobeCategoryIcon: {
    width: 56,
    height: 56,
    borderRadius: 28,
    borderWidth: 1,
    borderColor: '#ebe6e3',
    backgroundColor: '#ffffff',
    alignItems: 'center',
    justifyContent: 'center'
  },
  wardrobeCategoryIconActive: {
    borderWidth: 3,
    borderColor: '#9b5658'
  },
  wardrobeCategoryLabel: {
    ...typography.caption,
    marginTop: 8,
    color: '#444140',
    textAlign: 'center',
    fontSize: 11,
    lineHeight: 14,
    fontWeight: '500'
  },
  wardrobeCategoryLabelActive: {
    color: '#111111',
    fontFamily: fontFamilies.bodyBold,
    fontWeight: '700'
  },
  wardrobePreviewWrap: {
    marginHorizontal: 18,
    gap: 16
  },
  wardrobePreviewCard: {
    width: '100%',
    borderRadius: 16,
    overflow: 'hidden',
    backgroundColor: '#f3f1f0',
    shadowColor: '#000',
    shadowOpacity: 0.08,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2
  },
  wardrobePreviewImage: {
    width: '100%',
    height: '100%'
  },
  wardrobeTryButton: {
    alignSelf: 'center',
    minHeight: 44,
    minWidth: 164,
    borderRadius: 22,
    backgroundColor: '#050505',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 22
  },
  wardrobeTryText: {
    ...typography.caption,
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '700'
  },
  wardrobeRecommendationsHead: {
    paddingHorizontal: 18,
    paddingTop: 28,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 14
  },
  wardrobeSectionTitle: {
    ...typography.h2,
    flex: 1,
    color: '#1b1715',
    fontSize: 22,
    lineHeight: 28,
    fontWeight: '600'
  },
  wardrobeGenerateLink: {
    minHeight: 34,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5
  },
  wardrobeGenerateText: {
    ...typography.caption,
    color: '#9b5658',
    fontSize: 13,
    lineHeight: 17,
    fontWeight: '500'
  },
  wardrobeRecommendationTrack: {
    paddingHorizontal: 18,
    paddingTop: 18,
    gap: 14,
    paddingRight: 28
  },
  wardrobeEmptyRecommendation: {
    width: 250,
    minHeight: 126,
    padding: 16,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e4d9d4',
    backgroundColor: '#fffaf7',
    justifyContent: 'center',
    gap: 8
  },
  wardrobeEmptyRecommendationTitle: {
    ...typography.productTitle,
    color: '#211c1a',
    fontSize: 14,
    fontWeight: '700'
  },
  wardrobeEmptyRecommendationText: {
    ...typography.caption,
    color: '#6e6662',
    fontSize: 12,
    lineHeight: 17,
    fontWeight: '600'
  },
  wardrobeRecommendationCard: {
    width: 250,
    minHeight: 132,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#f1ece9',
    backgroundColor: '#ffffff',
    overflow: 'hidden'
  },
  wardrobeRecommendationImages: {
    height: 78,
    paddingHorizontal: 14,
    paddingTop: 14,
    flexDirection: 'row',
    gap: 13
  },
  wardrobeRecommendationImage: {
    flex: 1,
    height: '100%',
    borderRadius: 8,
    backgroundColor: '#f2eeeb'
  },
  wardrobeRecommendationFooter: {
    minHeight: 50,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12
  },
  wardrobeRecommendationTitle: {
    ...typography.smallBody,
    flex: 1,
    color: '#504c4a',
    fontSize: 14,
    lineHeight: 18,
    fontWeight: '400'
  },
  wardrobeModeTabs: {
    paddingHorizontal: 16,
    paddingTop: 18,
    paddingBottom: 14
  },
  addStudioScreen: {
    flex: 1,
    backgroundColor: '#fbf7f6'
  },
  addStudioContent: {
    paddingBottom: 132,
    backgroundColor: '#fbf7f6'
  },
  addStudioTopBar: {
    height: 62,
    paddingHorizontal: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#e7dfdb',
    backgroundColor: '#fbf7f6',
    flexDirection: 'row',
    alignItems: 'center'
  },
  addStudioTopButton: {
    width: 34,
    height: 42,
    alignItems: 'center',
    justifyContent: 'center'
  },
  addStudioBrandLogo: {
    flex: 1,
    justifyContent: 'center'
  },
  addStudioIntro: {
    paddingHorizontal: 20,
    paddingTop: 35
  },
  addStudioTitle: {
    ...typography.h1,
    color: '#171412',
    fontSize: 27,
    lineHeight: 33,
    fontWeight: '700'
  },
  addStudioSubtitle: {
    ...typography.smallBody,
    marginTop: 9,
    color: '#55514f',
    fontSize: 14,
    lineHeight: 22,
    fontWeight: '500'
  },
  addStudioUploadBox: {
    marginTop: 44,
    marginHorizontal: 20,
    height: 424,
    borderRadius: 12,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderColor: '#b8b8b8',
    overflow: 'hidden',
    backgroundColor: '#fbf7f6',
    alignItems: 'center',
    justifyContent: 'center'
  },
  addStudioUploadImage: {
    width: '100%',
    height: '100%'
  },
  addStudioAnalyzeOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(17, 17, 17, 0.42)',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 9
  },
  addStudioAnalyzeText: {
    ...typography.caption,
    color: '#ffffff',
    fontWeight: '700'
  },
  addStudioUploadCopy: {
    alignItems: 'center',
    paddingHorizontal: 34
  },
  addStudioUploadTitle: {
    marginTop: 11,
    color: '#171412',
    fontSize: 14,
    lineHeight: 18,
    fontWeight: '700'
  },
  addStudioUploadText: {
    marginTop: 5,
    color: '#55514f',
    textAlign: 'center',
    fontSize: 14,
    lineHeight: 20,
    fontWeight: '500'
  },
  addStudioThumbRow: {
    paddingHorizontal: 20,
    paddingTop: 16,
    flexDirection: 'row',
    gap: 12
  },
  addStudioAddThumb: {
    width: 80,
    height: 96,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#d0d0d0',
    backgroundColor: '#e6e3e1',
    alignItems: 'center',
    justifyContent: 'center'
  },
  addStudioThumbWrap: {
    width: 80,
    height: 96,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#d0d0d0',
    overflow: 'hidden',
    backgroundColor: '#ece7e3'
  },
  addStudioThumbImage: {
    width: '100%',
    height: '100%'
  },
  addStudioThumbClose: {
    position: 'absolute',
    right: 4,
    top: 4,
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: 'rgba(255, 255, 255, 0.88)',
    alignItems: 'center',
    justifyContent: 'center'
  },
  itemDetectionCard: {
    marginHorizontal: 20,
    marginTop: 18,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e2d7d3',
    backgroundColor: '#fffdfb',
    padding: 14
  },
  itemDetectionCardCompact: {
    marginHorizontal: 0,
    marginTop: 12
  },
  itemDetectionCardError: {
    borderColor: '#efc7c7',
    backgroundColor: '#fff7f7'
  },
  itemDetectionHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11
  },
  itemDetectionIcon: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: '#f8efed',
    alignItems: 'center',
    justifyContent: 'center'
  },
  itemDetectionIconError: {
    backgroundColor: '#fdecec'
  },
  itemDetectionCopy: {
    flex: 1,
    minWidth: 0
  },
  itemDetectionTitle: {
    ...typography.productTitle,
    color: '#211c1a',
    fontSize: 14,
    lineHeight: 18,
    fontWeight: '700'
  },
  itemDetectionText: {
    ...typography.caption,
    marginTop: 3,
    color: '#706762',
    fontWeight: '500'
  },
  itemDetectionPills: {
    marginTop: 12,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 7
  },
  itemDetectionPill: {
    minHeight: 26,
    borderRadius: 13,
    backgroundColor: '#f4eeee',
    paddingHorizontal: 10,
    alignItems: 'center',
    justifyContent: 'center'
  },
  itemDetectionPillText: {
    ...typography.caption,
    color: '#4f4a48',
    fontSize: 11,
    fontWeight: '700'
  },
  addStudioArchiveHead: {
    paddingHorizontal: 20,
    paddingTop: 52
  },
  addStudioArchiveTitle: {
    ...typography.h2,
    color: '#171412',
    fontSize: 23,
    lineHeight: 29,
    fontWeight: '600'
  },
  addStudioArchiveLine: {
    marginTop: 11,
    width: 48,
    height: 1,
    backgroundColor: '#9b5658'
  },
  addStudioSectionLabel: {
    ...typography.label,
    marginTop: 38,
    paddingHorizontal: 20,
    color: '#4f4a48',
    fontSize: 14,
    fontWeight: '700',
    letterSpacing: 0
  },
  addStudioForm: {
    paddingHorizontal: 20,
    paddingTop: 22
  },
  addStudioFieldLabel: {
    marginBottom: 8,
    color: '#4f4a48',
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '700'
  },
  addStudioInput: {
    minHeight: 48,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#c9cdd2',
    backgroundColor: '#ffffff',
    paddingHorizontal: 16,
    color: '#171412',
    fontSize: 16,
    fontWeight: '400'
  },
  addStudioTwoCol: {
    marginTop: 20,
    flexDirection: 'row',
    gap: 14
  },
  addStudioFieldHalf: {
    flex: 1
  },
  addStudioSelectInput: {
    minHeight: 48,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#c9cdd2',
    backgroundColor: '#ffffff',
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between'
  },
  addStudioInputText: {
    color: '#171412',
    fontSize: 16,
    fontWeight: '400'
  },
  addStudioColorInput: {
    minHeight: 48,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#c9cdd2',
    backgroundColor: '#ffffff',
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11
  },
  addStudioColorDot: {
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: '#050505'
  },
  addStudioColorTextInput: {
    flex: 1,
    minHeight: 44,
    color: '#171412',
    fontSize: 16,
    fontWeight: '400'
  },
  addStudioSegmented: {
    minHeight: 38,
    borderRadius: 10,
    backgroundColor: '#e9e3e3',
    padding: 4,
    flexDirection: 'row'
  },
  addStudioSegment: {
    flex: 1,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center'
  },
  addStudioSegmentActive: {
    backgroundColor: '#1f1f1f'
  },
  addStudioSegmentText: {
    color: '#171412',
    fontSize: 12,
    fontWeight: '700'
  },
  addStudioSegmentTextActive: {
    color: '#ffffff'
  },
  addStudioTagInput: {
    minHeight: 48,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#c9cdd2',
    backgroundColor: '#ffffff',
    paddingLeft: 16,
    paddingRight: 7,
    flexDirection: 'row',
    alignItems: 'center'
  },
  addStudioTagTextInput: {
    flex: 1,
    minHeight: 44,
    color: '#171412',
    fontSize: 16,
    fontWeight: '400'
  },
  addStudioTagAdd: {
    width: 32,
    height: 32,
    borderRadius: 8,
    backgroundColor: '#eee8e8',
    alignItems: 'center',
    justifyContent: 'center'
  },
  addStudioTagRow: {
    marginTop: 8,
    flexDirection: 'row',
    gap: 8
  },
  addStudioTagPill: {
    minHeight: 24,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#d4cecb',
    backgroundColor: '#eee8e8',
    paddingHorizontal: 11,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5
  },
  addStudioTagPillText: {
    color: '#4f4a48',
    fontSize: 12,
    fontWeight: '500'
  },
  addStudioMessage: {
    marginHorizontal: 20,
    marginTop: 18
  },
  addStudioFooter: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    minHeight: 96,
    borderTopWidth: 1,
    borderTopColor: '#e1dad7',
    backgroundColor: '#fbf7f6',
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: Platform.OS === 'ios' ? 24 : 14,
    flexDirection: 'row',
    gap: 16
  },
  addStudioDiscardButton: {
    flex: 1,
    minHeight: 56,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#9b5658',
    backgroundColor: '#fbf7f6',
    alignItems: 'center',
    justifyContent: 'center'
  },
  addStudioDiscardText: {
    color: '#9b5658',
    fontSize: 14,
    fontWeight: '500',
    letterSpacing: 0
  },
  addStudioSaveButton: {
    flex: 1,
    minHeight: 56,
    borderRadius: 10,
    backgroundColor: '#050505',
    alignItems: 'center',
    justifyContent: 'center'
  },
  addStudioSaveText: {
    color: '#ffffff',
    textAlign: 'center',
    fontSize: 15,
    lineHeight: 20,
    fontWeight: '700',
    letterSpacing: 0
  },
  hero: {
    margin: 16,
    height: 240,
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: '#efe3d2'
  },
  heroCompact: {
    height: 190
  },
  heroImage: {
    width: '100%',
    height: '100%',
    objectPosition: '70% center'
  },
  heroOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(17, 24, 39, 0.18)'
  },
  heroCopy: {
    position: 'absolute',
    left: 22,
    right: 22,
    bottom: 24
  },
  kicker: {
    color: '#0f766e',
    fontWeight: '700',
    textTransform: 'uppercase',
    fontSize: 12,
    letterSpacing: 0
  },
  heroTitle: {
    marginTop: 8,
    color: '#fff',
    fontSize: 40,
    lineHeight: 43,
    fontWeight: '700',
    letterSpacing: 0
  },
  heroText: {
    marginTop: 10,
    color: '#ecfeff',
    fontSize: 15,
    lineHeight: 22,
    maxWidth: 290
  },
  heroButton: {
    marginTop: 18,
    alignSelf: 'flex-start'
  },
  button: {
    minHeight: 46,
    borderRadius: 8,
    paddingHorizontal: 16,
    backgroundColor: '#111827',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8
  },
  secondaryButton: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#d1d5db'
  },
  ghostButton: {
    backgroundColor: 'transparent'
  },
  disabledButton: {
    opacity: 0.55
  },
  buttonPressed: {
    opacity: 0.88
  },
  buttonText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 14
  },
  secondaryButtonText: {
    color: '#111827'
  },
  section: {
    paddingHorizontal: 16,
    marginTop: 10
  },
  sectionHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12
  },
  sectionTitle: {
    fontSize: 22,
    color: '#111827',
    fontWeight: '700',
    letterSpacing: 0
  },
  viewAll: {
    color: '#0f766e',
    fontWeight: '700'
  },
  horizontalList: {
    gap: 12,
    paddingRight: 16
  },
  productGrid: {
    paddingHorizontal: 16,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    alignItems: 'stretch'
  },
  productCard: {
    flexGrow: 1,
    flexBasis: '46.5%',
    maxWidth: '48%',
    backgroundColor: '#fff',
    borderRadius: 8,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#e8dfda'
  },
  productCardHomeFrame: {
    overflow: 'visible'
  },
  productCardPressed: {
    opacity: 0.94
  },
  productCardCarousel: {
    width: 148,
    flexGrow: 0,
    flexBasis: 148,
    maxWidth: 148
  },
  lockedCard: {
    opacity: 0.72
  },
  productImageWrap: {
    aspectRatio: productImageAspectRatio,
    backgroundColor: '#f0ece8',
    position: 'relative'
  },
  productImage: {
    width: '100%',
    height: '100%'
  },
  productImageFrame: {
    overflow: 'hidden',
    backgroundColor: '#f0ece8'
  },
  productImageSkeleton: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#eee7e2'
  },
  resilientImageFrame: {
    overflow: 'hidden',
    backgroundColor: '#f0ece8',
    position: 'relative'
  },
  resilientImage: {
    ...StyleSheet.absoluteFillObject,
    width: '100%',
    height: '100%'
  },
  avatarPositionedImage: {
    position: 'absolute'
  },
  resilientImageSkeleton: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#eee7e2'
  },
  resilientImageFallback: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5
  },
  resilientImageFallbackText: {
    color: '#8b817b',
    fontSize: 10,
    lineHeight: 13,
    fontWeight: '700',
    textAlign: 'center'
  },
  productImageFallback: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#f0ece8',
    gap: 6
  },
  productImageFallbackText: {
    color: '#8b817b',
    fontSize: 11,
    fontWeight: '700'
  },
  wishlistDoneButton: {
    position: 'absolute',
    top: 8,
    right: 8,
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: 'rgba(33, 28, 26, 0.08)',
    backgroundColor: 'rgba(255, 253, 251, 0.96)',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#1a1412',
    shadowOpacity: 0.12,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 5 },
    elevation: 3,
    zIndex: 8
  },
  wishlistDoneButtonCompact: {
    width: 32,
    height: 32,
    borderRadius: 16
  },
  wishlistDoneButtonSaved: {
    borderColor: '#111111',
    backgroundColor: '#111111'
  },
  lockOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(17, 24, 39, 0.45)',
    alignItems: 'center',
    justifyContent: 'center'
  },
  badge: {
    position: 'absolute',
    left: 8,
    top: 8,
    backgroundColor: '#ccfbf1',
    color: '#115e59',
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 4,
    fontSize: 11,
    fontWeight: '700',
    overflow: 'hidden'
  },
  productBody: {
    padding: 10,
    gap: 4
  },
  productTitle: {
    fontSize: 12,
    lineHeight: 16,
    color: '#111827',
    fontWeight: '700'
  },
  productBrand: {
    color: '#64748b',
    fontSize: 10,
    fontWeight: '700'
  },
  productSwatchPreviewRow: {
    minHeight: 18,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5
  },
  productSwatchPreview: {
    width: 13,
    height: 13,
    borderRadius: 7,
    borderWidth: 1,
    borderColor: '#e5ded8'
  },
  productSwatchMore: {
    color: '#817772',
    fontSize: 10,
    fontWeight: '700'
  },
  ratingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4
  },
  ratingText: {
    color: '#475569',
    fontSize: 10,
    fontWeight: '700'
  },
  priceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 6
  },
  price: {
    color: '#111827',
    fontWeight: '700',
    fontSize: 12
  },
  discount: {
    color: '#0f766e',
    fontWeight: '700',
    fontSize: 11
  },
  wasPrice: {
    color: '#94a3b8',
    textDecorationLine: 'line-through',
    fontWeight: '700'
  },
  cardButton: {
    minHeight: 34,
    marginTop: 4
  },
  errorText: {
    color: '#b91c1c',
    fontWeight: '700'
  },
  muted: {
    color: '#64748b',
    lineHeight: 20
  },
  categoryGrid: {
    marginTop: 12,
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginHorizontal: -5,
    rowGap: 10
  },
  categoryCell: {
    width: '50%',
    paddingHorizontal: 5
  },
  categoryCard: {
    width: '100%',
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e5e7eb'
  },
  categoryImage: {
    height: 88,
    width: '100%'
  },
  categoryText: {
    padding: 8,
    fontWeight: '700',
    color: '#111827',
    fontSize: 12
  },
  featureBand: {
    margin: 16,
    padding: 14,
    borderRadius: 8,
    backgroundColor: '#ecfeff',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10
  },
  featureItem: {
    width: '48%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8
  },
  featureTitle: {
    fontWeight: '700',
    color: '#134e4a'
  },
  searchScreen: {
    flex: 1,
    backgroundColor: '#ffffff'
  },
  searchTopBar: {
    minHeight: Platform.OS === 'android' ? appTopInset + 58 : 64,
    paddingTop: Platform.OS === 'android' ? appTopInset + 8 : 8,
    paddingBottom: 8,
    paddingLeft: 8,
    paddingRight: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#e3e1e7',
    backgroundColor: '#ffffff',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8
  },
  searchBackButton: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center'
  },
  searchCompactInputWrap: {
    flex: 1,
    minHeight: 46,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#d9d7df',
    backgroundColor: '#ffffff',
    paddingLeft: 12,
    paddingRight: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8
  },
  searchCompactInput: {
    ...typography.body,
    flex: 1,
    minHeight: 44,
    color: '#302b34',
    fontSize: 15
  },
  searchTopIconButton: {
    width: 32,
    height: 38,
    alignItems: 'center',
    justifyContent: 'center'
  },
  searchContent: {
    paddingTop: 0,
    paddingBottom: screenBottomInset + 72,
    backgroundColor: '#ffffff'
  },
  searchUtilitySection: {
    paddingHorizontal: 22,
    paddingTop: 26,
    paddingBottom: 18,
    backgroundColor: '#ffffff'
  },
  searchUtilityTitle: {
    ...typography.h4,
    color: '#302b34',
    fontSize: 17
  },
  recentSearchList: {
    marginTop: 20,
    gap: 28
  },
  recentSearchRow: {
    minHeight: 30,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14
  },
  recentSearchText: {
    ...typography.body,
    color: '#302b34',
    fontSize: 16,
    lineHeight: 22
  },
  recentSearchEmpty: {
    ...typography.smallBody,
    marginTop: 18,
    color: '#8d8791',
    fontWeight: '500'
  },
  searchPopularBlock: {
    marginTop: 8,
    paddingHorizontal: 22,
    paddingTop: 24,
    paddingBottom: 24,
    borderTopWidth: 8,
    borderTopColor: '#f4f3f5',
    backgroundColor: '#ffffff'
  },
  searchSuggestionGrid: {
    marginTop: 16,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10
  },
  searchSuggestionChip: {
    minHeight: 36,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#e6e4ea',
    backgroundColor: '#faf9fb',
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center'
  },
  searchSuggestionText: {
    ...typography.smallBody,
    color: '#5c5864',
    fontWeight: '500'
  },
  searchPromoBanner: {
    height: 176,
    backgroundColor: '#f2f0f7',
    overflow: 'hidden',
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: 26
  },
  searchPromoCopy: {
    width: '58%',
    zIndex: 2
  },
  searchPromoTitle: {
    ...typography.h3,
    color: '#706986',
    fontSize: 19,
    lineHeight: 25
  },
  searchPromoText: {
    ...typography.body,
    marginTop: 12,
    color: '#9a94a9',
    fontWeight: '700'
  },
  searchPromoImageCluster: {
    flex: 1,
    minHeight: '100%',
    alignItems: 'center',
    justifyContent: 'center'
  },
  searchPromoImage: {
    position: 'absolute'
  },
  searchPromoImageLarge: {
    right: -12,
    bottom: -18,
    width: 160,
    height: 160
  },
  searchPromoImageSmall: {
    right: 84,
    top: 26,
    width: 82,
    height: 82,
    opacity: 0.92
  },
  searchResultsHead: {
    paddingHorizontal: 18,
    marginTop: 22,
    marginBottom: 14,
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    gap: 14
  },
  searchResultsTitle: {
    ...typography.h3,
    flex: 1,
    color: '#211c1a'
  },
  searchResultsMeta: {
    ...typography.caption,
    color: '#8d8682',
    paddingBottom: 2
  },
  searchEmptyCard: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#eadfda',
    backgroundColor: '#fffdfb',
    paddingHorizontal: 18,
    paddingVertical: 24,
    alignItems: 'center',
    gap: 8
  },
  searchEmptyTitle: {
    ...typography.h4,
    color: '#211c1a',
    textAlign: 'center'
  },
  searchEmptyText: {
    ...typography.smallBody,
    color: '#706762',
    textAlign: 'center'
  },
  searchPanel: {
    marginHorizontal: 16,
    marginBottom: 10,
    padding: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#eaded9',
    backgroundColor: '#fffdfb',
    gap: 8,
    shadowColor: '#2a211d',
    shadowOpacity: 0.04,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 1
  },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 42,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#ded6d0',
    backgroundColor: '#fffdfb',
    paddingLeft: 11,
    paddingRight: 5,
    gap: 8,
    shadowOpacity: 0
  },
  searchInput: {
    flex: 1,
    minHeight: 40,
    paddingHorizontal: 0,
    color: '#1f1b19',
    fontSize: 13,
    fontWeight: '600'
  },
  searchButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#151824',
    alignItems: 'center',
    justifyContent: 'center'
  },
  filterRail: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'flex-start',
    gap: 8
  },
  dropdownButton: {
    minWidth: 96,
    height: 40,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#e2d8d2',
    backgroundColor: '#ffffff',
    paddingHorizontal: 12,
    paddingVertical: 4,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    alignSelf: 'flex-start',
    gap: 7
  },
  dropdownButtonActive: {
    borderColor: '#e2c9c5',
    backgroundColor: '#f6ece9'
  },
  dropdownCopy: {
    flexShrink: 1,
    minWidth: 0
  },
  dropdownLabel: {
    color: '#7b716a',
    fontSize: 8,
    lineHeight: 10,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0
  },
  dropdownValue: {
    color: '#1f1b19',
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '700',
    letterSpacing: 0
  },
  dropdownBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(24, 20, 18, 0.36)',
    justifyContent: 'flex-end'
  },
  dropdownSheet: {
    maxHeight: '72%',
    borderTopLeftRadius: 8,
    borderTopRightRadius: 8,
    backgroundColor: '#fffdfb',
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: bottomNavigationHeight + 18
  },
  dropdownHandle: {
    width: 38,
    height: 4,
    borderRadius: 2,
    alignSelf: 'center',
    backgroundColor: '#e0d7d2',
    marginBottom: 14
  },
  dropdownTitle: {
    ...typography.h3,
    color: '#1f1b19',
    fontSize: 20,
    lineHeight: 25,
    marginBottom: 12
  },
  dropdownOptions: {
    maxHeight: 420
  },
  dropdownOption: {
    minHeight: 48,
    borderRadius: 7,
    paddingHorizontal: 12,
    marginBottom: 8,
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#eee4df',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10
  },
  dropdownOptionActive: {
    backgroundColor: '#f8eded',
    borderColor: '#b66d70'
  },
  dropdownOptionText: {
    ...typography.body,
    flex: 1,
    color: '#3e3936',
    fontWeight: '700'
  },
  dropdownOptionTextActive: {
    color: '#8c4d50'
  },
  chipRow: {
    gap: 8,
    paddingRight: 12
  },
  wrappedChipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingRight: 0
  },
  chip: {
    borderRadius: 999,
    paddingHorizontal: 13,
    paddingVertical: 9,
    backgroundColor: '#f1f5f9',
    borderWidth: 1,
    borderColor: '#e2e8f0'
  },
  compactChip: {
    paddingVertical: 7
  },
  wrappedChip: {
    marginBottom: 8
  },
  activeChip: {
    backgroundColor: '#f6ece9',
    borderColor: '#d7b8b5'
  },
  chipText: {
    color: '#334155',
    fontWeight: '700'
  },
  activeChipText: {
    color: '#8c4d50'
  },
  resultsHead: {
    paddingHorizontal: 16,
    marginBottom: 12,
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between'
  },
  screenTitle: {
    ...typography.display,
    color: '#111827',
    fontSize: 30,
    lineHeight: 34
  },
  statusPanel: {
    margin: 16,
    padding: 18,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#eee3dc',
    backgroundColor: '#fffdfb',
    alignItems: 'center',
    gap: 9,
    shadowColor: '#2a211d',
    shadowOpacity: 0.06,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 7 },
    elevation: 2
  },
  loadingPanel: {
    alignItems: 'stretch'
  },
  skeletonIcon: {
    alignSelf: 'center',
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: '#efe7e1'
  },
  skeletonLineWide: {
    height: 12,
    borderRadius: 6,
    backgroundColor: '#eee6e0'
  },
  skeletonLine: {
    width: '76%',
    height: 10,
    borderRadius: 5,
    backgroundColor: '#f2ebe6',
    alignSelf: 'center'
  },
  skeletonLineShort: {
    width: '52%',
    height: 10,
    borderRadius: 5,
    backgroundColor: '#f2ebe6',
    alignSelf: 'center'
  },
  skeletonBlock: {
    borderRadius: 7,
    backgroundColor: '#eee7e2'
  },
  skeletonFill: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: 0,
    backgroundColor: '#eee7e2'
  },
  skeletonProductCard: {
    borderColor: '#efe5df',
    backgroundColor: '#fffdfb'
  },
  skeletonTextLarge: {
    width: '86%',
    height: 13,
    borderRadius: 7,
    backgroundColor: '#eee6e0'
  },
  skeletonTextMedium: {
    width: '64%',
    height: 11,
    borderRadius: 6,
    backgroundColor: '#f2ebe6'
  },
  skeletonTextSmall: {
    width: '42%',
    height: 9,
    borderRadius: 5,
    backgroundColor: '#f4eee9'
  },
  homeSkeletonLine: {
    marginTop: 8
  },
  statusIcon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center'
  },
  statusIconEmpty: {
    backgroundColor: '#edf8f4'
  },
  statusIconError: {
    backgroundColor: '#fbefef'
  },
  statusTitle: {
    color: '#111827',
    fontWeight: '700',
    fontSize: 16
  },
  statusText: {
    color: '#64748b',
    textAlign: 'center',
    lineHeight: 20
  },
  emptyStateCard: {
    width: '100%',
    flexBasis: '100%',
    alignSelf: 'stretch',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#eaded9',
    backgroundColor: '#fffdfb',
    paddingHorizontal: 20,
    paddingVertical: 24,
    alignItems: 'center',
    gap: 9,
    shadowColor: '#2a211d',
    shadowOpacity: 0.05,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
    elevation: 2
  },
  emptyStateCardCompact: {
    paddingVertical: 18
  },
  emptyStateIcon: {
    width: 50,
    height: 50,
    borderRadius: 25,
    backgroundColor: '#fff2f0',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 4
  },
  emptyStateTitle: {
    ...typography.h3,
    color: '#211c1a',
    textAlign: 'center',
    fontSize: 19,
    lineHeight: 24
  },
  emptyStateText: {
    ...typography.smallBody,
    maxWidth: 280,
    color: '#6f6864',
    textAlign: 'center',
    fontWeight: '500'
  },
  emptyStateButton: {
    marginTop: 8,
    minHeight: 42,
    borderRadius: 21,
    backgroundColor: '#050505',
    paddingHorizontal: 22,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8
  },
  emptyStateButtonText: {
    ...typography.button,
    color: '#ffffff',
    fontSize: 14,
    lineHeight: 18
  },
  initialsAvatar: {
    overflow: 'hidden',
    backgroundColor: '#fff2f0',
    borderWidth: 1,
    borderColor: '#eaded9',
    alignItems: 'center',
    justifyContent: 'center'
  },
  initialsAvatarText: {
    ...typography.label,
    color: '#9b5658',
    fontWeight: '700',
    textAlign: 'center'
  },
  aiPreviewNote: {
    marginHorizontal: 16,
    marginTop: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#eaded9',
    backgroundColor: '#fff5f3',
    paddingHorizontal: 12,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8
  },
  aiPreviewNoteText: {
    flex: 1,
    color: '#5d5754',
    fontSize: 12,
    lineHeight: 18,
    fontWeight: '700'
  },
  lockedPanel: {
    margin: 16,
    padding: 16,
    borderRadius: 8,
    backgroundColor: '#111827',
    gap: 10
  },
  lockedTitle: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 18
  },
  lockedActions: {
    flexDirection: 'row',
    gap: 10
  },
  productDetailScreen: {
    flex: 1,
    backgroundColor: '#fbf7f6'
  },
  productDetailContent: {
    paddingBottom: screenBottomInset,
    backgroundColor: '#fbf7f6'
  },
  productTopBar: {
    height: 42,
    paddingHorizontal: 14,
    backgroundColor: '#fbf7f6',
    borderBottomWidth: 1,
    borderBottomColor: '#eee7e2',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between'
  },
  productTopIcon: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center'
  },
  productTopBrand: {
    ...typography.caption,
    color: '#111111',
    fontSize: 12,
    fontWeight: '700'
  },
  productHeroMedia: {
    marginHorizontal: 14,
    borderRadius: 7,
    overflow: 'hidden',
    backgroundColor: '#f2f0ef'
  },
  productMediaTrack: {
    alignItems: 'stretch'
  },
  productMediaSlide: {
    height: '100%',
    backgroundColor: '#f2f0ef',
    position: 'relative'
  },
  productHeroImage: {
    width: '100%',
    height: '100%'
  },
  productHeroVideo: {
    width: '100%',
    height: '100%',
    backgroundColor: '#f2f0ef'
  },
  videoSurface: {
    overflow: 'hidden',
    backgroundColor: '#f2f0ef'
  },
  videoSurfacePlayer: {
    width: '100%',
    height: '100%',
    backgroundColor: '#f2f0ef'
  },
  productMediaBadge: {
    position: 'absolute',
    left: 12,
    top: 12,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    overflow: 'hidden',
    backgroundColor: 'rgba(255, 255, 255, 0.92)',
    color: '#171412',
    fontSize: 11,
    fontWeight: '700'
  },
  productMediaCount: {
    position: 'absolute',
    right: 56,
    top: 14,
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: 999,
    overflow: 'hidden',
    backgroundColor: 'rgba(5, 5, 5, 0.72)',
    color: '#ffffff',
    fontSize: 11,
    fontWeight: '700'
  },
  productFavoriteButton: {
    position: 'absolute',
    right: 13,
    top: 14,
    width: 39,
    height: 39,
    borderRadius: 20,
    backgroundColor: 'rgba(255, 255, 255, 0.88)',
    alignItems: 'center',
    justifyContent: 'center'
  },
  productSwipeHint: {
    position: 'absolute',
    left: 12,
    bottom: 12,
    minHeight: 28,
    borderRadius: 14,
    backgroundColor: 'rgba(255, 255, 255, 0.86)',
    paddingHorizontal: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5
  },
  productSwipeText: {
    color: '#171412',
    fontSize: 11,
    fontWeight: '700'
  },
  productSummary: {
    paddingHorizontal: 14,
    paddingTop: 19,
    paddingBottom: 24
  },
  productSummaryTop: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 14
  },
  productSummaryTitleBlock: {
    flex: 1
  },
  productBrandLabel: {
    color: '#9b5658',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0
  },
  productNameText: {
    marginTop: 4,
    color: '#171412',
    fontSize: 13,
    lineHeight: 17,
    fontWeight: '600'
  },
  productPriceBlock: {
    alignItems: 'flex-end'
  },
  productDetailPrice: {
    color: '#171412',
    fontSize: 12,
    fontWeight: '700'
  },
  productRatingLine: {
    marginTop: 5,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3
  },
  productRatingText: {
    color: '#5b5551',
    fontSize: 11,
    fontWeight: '700'
  },
  productTagRow: {
    marginTop: 13,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 9
  },
  productSoftTag: {
    minHeight: 22,
    borderRadius: 11,
    overflow: 'hidden',
    backgroundColor: '#eee9e7',
    color: '#7a716d',
    paddingHorizontal: 12,
    paddingTop: 5,
    fontSize: 10,
    fontWeight: '700'
  },
  productCategoryMeta: {
    alignSelf: 'flex-start',
    marginTop: 10,
    minHeight: 28,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#eadfdb',
    backgroundColor: '#fffdfb',
    paddingHorizontal: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6
  },
  productCategoryMetaLabel: {
    color: '#8c817c',
    fontSize: 10,
    fontWeight: '700'
  },
  productCategoryMetaValue: {
    color: '#4f4a48',
    fontSize: 10,
    fontWeight: '700'
  },
  productOptionLabel: {
    marginTop: 25,
    color: '#423d3a',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0
  },
  productOptionValue: {
    color: '#5c5754',
    fontWeight: '700'
  },
  productSwatchRow: {
    marginTop: 13,
    flexDirection: 'row',
    gap: 14
  },
  productColorSwatch: {
    width: 38,
    height: 38,
    borderRadius: 19,
    borderWidth: 1,
    borderColor: '#d9d2ce'
  },
  productColorSwatchActive: {
    borderWidth: 2,
    borderColor: '#050505'
  },
  productSizeHead: {
    marginTop: 21,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between'
  },
  productSizeGuide: {
    color: '#9b5658',
    fontSize: 11,
    fontWeight: '700',
    textDecorationLine: 'underline'
  },
  productSizeRow: {
    marginTop: 12,
    flexDirection: 'row',
    gap: 10
  },
  productSizeButton: {
    flex: 1,
    minHeight: 45,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#eadfdb',
    backgroundColor: '#fbf7f6',
    alignItems: 'center',
    justifyContent: 'center'
  },
  productSizeButtonActive: {
    borderWidth: 2,
    borderColor: '#171412',
    backgroundColor: '#ffffff'
  },
  productSizeText: {
    color: '#4f4a48',
    fontSize: 12,
    fontWeight: '700'
  },
  productSizeTextActive: {
    color: '#171412'
  },
  productActionRow: {
    marginTop: 24,
    flexDirection: 'row',
    gap: 8
  },
  productActionButton: {
    flex: 1,
    minHeight: 48,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#d4c8c4',
    backgroundColor: '#fbf7f6',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7
  },
  productActionButtonActive: {
    backgroundColor: '#050505',
    borderColor: '#050505'
  },
  productActionText: {
    color: '#4f4a48',
    fontSize: 12,
    fontWeight: '700'
  },
  productActionTextActive: {
    color: '#ffffff'
  },
  productAccordion: {
    paddingHorizontal: 14,
    paddingTop: 29
  },
  productAccordionRow: {
    minHeight: 42,
    borderBottomWidth: 1,
    borderBottomColor: '#e6dfdb',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between'
  },
  productAccordionText: {
    color: '#3a3532',
    fontSize: 12,
    fontWeight: '700'
  },
  productStorySection: {
    paddingHorizontal: 14,
    paddingTop: 61
  },
  productStoryTitle: {
    ...typography.h3,
    color: '#3a2424',
    fontSize: 21,
    lineHeight: 27,
    fontWeight: '600'
  },
  productStoryText: {
    ...typography.smallBody,
    marginTop: 17,
    color: '#4f4a48',
    fontSize: 13,
    lineHeight: 23,
    fontWeight: '500'
  },
  productStoryImage: {
    marginTop: 46,
    width: '100%',
    height: 388,
    borderRadius: 7,
    backgroundColor: '#eee8e3'
  },
  completeLookSection: {
    paddingHorizontal: 14,
    paddingTop: 120
  },
  completeLookHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between'
  },
  completeLookTitle: {
    color: '#3a3532',
    fontSize: 12,
    fontWeight: '500'
  },
  completeLookAll: {
    color: '#9b5658',
    fontSize: 10,
    fontWeight: '700',
    textDecorationLine: 'underline'
  },
  completeLookGrid: {
    marginTop: 21,
    flexDirection: 'row',
    gap: 13
  },
  completeLookCard: {
    flex: 1
  },
  completeLookImageWrap: {
    position: 'relative'
  },
  completeLookImage: {
    width: '100%',
    height: 174,
    borderRadius: 6,
    backgroundColor: '#eee8e3'
  },
  completeLookBrand: {
    marginTop: 12,
    color: '#9b5658',
    fontSize: 9,
    fontWeight: '700'
  },
  completeLookName: {
    marginTop: 3,
    minHeight: 34,
    color: '#171412',
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '600'
  },
  completeLookPrice: {
    marginTop: 4,
    color: '#171412',
    fontSize: 11,
    fontWeight: '700'
  },
  productAtelierFooter: {
    marginTop: 150,
    paddingHorizontal: 26,
    paddingTop: 62,
    paddingBottom: 64,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    backgroundColor: '#050505'
  },
  productAtelierTitle: {
    ...typography.h2,
    color: '#ffffff',
    textAlign: 'center',
    fontSize: 22,
    lineHeight: 28,
    fontWeight: '600'
  },
  productAtelierCopy: {
    ...typography.caption,
    marginTop: 20,
    color: '#a5a5a5',
    textAlign: 'center',
    fontSize: 13,
    lineHeight: 21,
    fontWeight: '500'
  },
  productEmailBox: {
    marginTop: 31,
    minHeight: 48,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#1d1d1d',
    backgroundColor: '#0c0c0c',
    paddingLeft: 14,
    paddingRight: 6,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8
  },
  productEmailInput: {
    flex: 1,
    minHeight: 40,
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '600'
  },
  productSubmitButton: {
    minWidth: 75,
    minHeight: 38,
    borderRadius: 8,
    backgroundColor: '#ffffff',
    alignItems: 'center',
    justifyContent: 'center'
  },
  productSubmitText: {
    color: '#050505',
    fontSize: 12,
    fontWeight: '700'
  },
  productFooterDivider: {
    marginTop: 70,
    height: 1,
    backgroundColor: '#181818'
  },
  productFooterBrand: {
    ...typography.h3,
    marginTop: 37,
    color: '#ffffff',
    textAlign: 'center',
    fontSize: 21,
    lineHeight: 27,
    fontWeight: '600'
  },
  productFooterCopy: {
    marginTop: 8,
    color: '#8b8b8b',
    textAlign: 'center',
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 0
  },
  productFooterLinks: {
    marginTop: 58,
    flexDirection: 'row',
    justifyContent: 'space-between'
  },
  productFooterHead: {
    color: '#ffffff',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0
  },
  productFooterLink: {
    marginTop: 14,
    color: '#9b9b9b',
    fontSize: 11,
    fontWeight: '600'
  },
  aiStudioScreen: {
    flex: 1,
    backgroundColor: '#fbf7f6'
  },
  aiStudioContent: {
    paddingTop: 18,
    paddingBottom: screenBottomInset + 86,
    paddingHorizontal: 16,
    backgroundColor: '#fbf7f6'
  },
  aiHeroPanel: {
    minHeight: 92,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e7dfda',
    backgroundColor: '#fffdfb',
    padding: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 13
  },
  aiHeroIcon: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: '#f5ece9',
    alignItems: 'center',
    justifyContent: 'center'
  },
  aiHeroCopy: {
    flex: 1,
    minWidth: 0
  },
  aiGreetingText: {
    ...typography.h4,
    marginTop: 5,
    color: '#252221',
    fontSize: 18,
    lineHeight: 24
  },
  aiIdeaPanel: {
    marginTop: 14
  },
  aiIdeaPanelLabel: {
    ...typography.caption,
    color: '#8d8682',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0,
    textTransform: 'uppercase'
  },
  aiIdeaRow: {
    paddingTop: 9,
    paddingBottom: 2,
    gap: 8,
    paddingRight: 18
  },
  aiIdeaChip: {
    height: 38,
    maxWidth: 166,
    borderRadius: 19,
    borderWidth: 1,
    borderColor: '#e3d9d4',
    backgroundColor: '#fffdfb',
    paddingHorizontal: 13,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7
  },
  aiIdeaChipCompact: {
    maxWidth: 142,
    paddingHorizontal: 11
  },
  aiIdeaText: {
    ...typography.caption,
    flexShrink: 1,
    color: '#252221',
    fontSize: 13,
    fontWeight: '700'
  },
  aiEmptyState: {
    marginTop: 18,
    minHeight: 118,
    padding: 18,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#ebe3df',
    backgroundColor: '#f8f1ed',
    justifyContent: 'center'
  },
  aiEmptyTitle: {
    ...typography.h4,
    marginTop: 12,
    color: '#211c1a',
    fontSize: 17,
    fontWeight: '700'
  },
  aiEmptyText: {
    ...typography.smallBody,
    marginTop: 6,
    color: '#69615d',
    fontWeight: '500'
  },
  aiStarterPanel: {
    marginTop: 18
  },
  aiStarterTitle: {
    ...typography.label,
    color: '#8d8682',
    textTransform: 'uppercase'
  },
  aiStarterGrid: {
    marginTop: 10,
    gap: 10
  },
  aiStarterCard: {
    minHeight: 76,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#ebe3df',
    backgroundColor: '#fffdfb',
    paddingHorizontal: 14,
    paddingVertical: 13,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12
  },
  aiStarterIcon: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: '#f8efed',
    alignItems: 'center',
    justifyContent: 'center'
  },
  aiStarterCopy: {
    flex: 1,
    minWidth: 0
  },
  aiStarterCardTitle: {
    ...typography.productTitle,
    color: '#211c1a',
    fontWeight: '700'
  },
  aiStarterCardText: {
    ...typography.caption,
    marginTop: 3,
    color: '#706762',
    fontWeight: '500'
  },
  aiChatThread: {
    paddingTop: 18,
    gap: 14
  },
  aiMessageBlock: {
    gap: 10
  },
  aiMessageBubble: {
    maxWidth: '88%',
    minHeight: 42,
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 11,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8
  },
  aiMessageBubbleAssistant: {
    alignSelf: 'flex-start',
    borderBottomLeftRadius: 5,
    borderWidth: 1,
    borderColor: '#e7dfda',
    backgroundColor: '#fffdfb'
  },
  aiMessageBubbleUser: {
    alignSelf: 'flex-end',
    borderBottomRightRadius: 5,
    backgroundColor: '#252221'
  },
  aiMessageBubbleError: {
    borderColor: '#efc7c7',
    backgroundColor: '#fff7f7'
  },
  aiMessageText: {
    ...typography.body,
    flexShrink: 1,
    color: '#2d2927',
    fontSize: 15,
    lineHeight: 21,
    fontWeight: '500'
  },
  aiMessageTextUser: {
    color: '#ffffff',
    fontWeight: '600'
  },
  aiMessageTextError: {
    color: '#b4232a',
    fontWeight: '700'
  },
  aiSuggestionProductsTrack: {
    gap: 12,
    paddingRight: 16
  },
  aiFollowUpRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8
  },
  aiFollowUpChip: {
    minHeight: 34,
    borderRadius: 17,
    borderWidth: 1,
    borderColor: '#e3d9d4',
    backgroundColor: '#fffdfb',
    paddingHorizontal: 12,
    alignItems: 'center',
    justifyContent: 'center'
  },
  aiFollowUpText: {
    ...typography.caption,
    color: '#9b5658',
    fontWeight: '700'
  },
  conciergeSuggestionTrack: {
    paddingTop: 18,
    gap: 12,
    paddingRight: 16
  },
  conciergeSuggestionCard: {
    width: 184,
    borderRadius: 10,
    overflow: 'hidden',
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#ebe3df'
  },
  conciergeSuggestionImageWrap: {
    height: 190,
    backgroundColor: '#eee8e3'
  },
  conciergeSuggestionImage: {
    width: '100%',
    height: '100%'
  },
  conciergeSparkButton: {
    position: 'absolute',
    right: 10,
    top: 10,
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(255, 255, 255, 0.92)',
    alignItems: 'center',
    justifyContent: 'center'
  },
  conciergeSuggestionBody: {
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 12
  },
  conciergeSuggestionBrand: {
    ...typography.caption,
    color: '#55514f',
    fontSize: 10,
    lineHeight: 13,
    fontWeight: '700'
  },
  conciergeSuggestionName: {
    ...typography.productTitle,
    marginTop: 5,
    minHeight: 34,
    color: '#171412',
    fontSize: 13,
    lineHeight: 17,
    fontWeight: '700',
    letterSpacing: 0
  },
  conciergeSuggestionPrice: {
    ...typography.price,
    marginTop: 5,
    color: '#171412',
    fontSize: 13,
    lineHeight: 17,
    fontWeight: '700'
  },
  conciergeShopButton: {
    marginTop: 9,
    alignSelf: 'flex-start',
    minHeight: 34,
    borderRadius: 8,
    backgroundColor: '#050505',
    paddingHorizontal: 12,
    alignItems: 'center',
    justifyContent: 'center'
  },
  conciergeShopText: {
    ...typography.caption,
    color: '#ffffff',
    fontSize: 11,
    fontWeight: '700'
  },
  conciergeExternalLink: {
    marginTop: 8
  },
  conciergeExternalLinkText: {
    ...typography.caption,
    color: '#9b5658',
    fontSize: 11,
    fontWeight: '700',
    textDecorationLine: 'underline'
  },
  aiThreadPanel: {
    marginTop: 18,
    gap: 12
  },
  aiUserBubble: {
    alignSelf: 'flex-end',
    maxWidth: '86%',
    borderRadius: 16,
    borderBottomRightRadius: 5,
    backgroundColor: '#252221',
    paddingHorizontal: 14,
    paddingVertical: 11
  },
  aiUserBubbleText: {
    ...typography.body,
    color: '#ffffff',
    fontSize: 15,
    lineHeight: 21,
    fontWeight: '600'
  },
  aiAssistantRow: {
    alignSelf: 'flex-start',
    maxWidth: '88%',
    minHeight: 40,
    borderRadius: 16,
    borderBottomLeftRadius: 5,
    borderWidth: 1,
    borderColor: '#e7dfda',
    backgroundColor: '#fffdfb',
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8
  },
  aiStatusText: {
    ...typography.caption,
    color: '#6f6864',
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '700'
  },
  aiRunPreviewGrid: {
    paddingTop: 16,
    flexDirection: 'row',
    gap: 10
  },
  aiRunPreviewCard: {
    width: 104,
    borderRadius: 10,
    overflow: 'hidden',
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#ebe3df'
  },
  aiRunPreviewImage: {
    width: '100%',
    height: 116,
    backgroundColor: '#eee8e3'
  },
  aiRunPreviewName: {
    ...typography.caption,
    paddingHorizontal: 8,
    paddingVertical: 7,
    color: '#34302d',
    fontSize: 11,
    fontWeight: '700'
  },
  aiComposer: {
    position: 'absolute',
    left: 14,
    right: 14,
    bottom: Platform.OS === 'ios' ? 14 : 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#e8ddd8',
    backgroundColor: '#fffdfb',
    padding: 8,
    shadowColor: '#1a1412',
    shadowOpacity: 0.08,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
    elevation: 6
  },
  aiComposerInput: {
    ...typography.body,
    flex: 1,
    minHeight: 42,
    borderRadius: 13,
    backgroundColor: '#f8f4f2',
    paddingHorizontal: 14,
    color: '#171412'
  },
  aiSendButton: {
    width: 42,
    height: 42,
    borderRadius: 13,
    backgroundColor: '#9b5658',
    alignItems: 'center',
    justifyContent: 'center'
  },
  detailMedia: {
    margin: 16,
    height: 460,
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: '#e5e7eb'
  },
  detailMediaTrack: {
    alignItems: 'stretch'
  },
  detailSlide: {
    height: '100%',
    position: 'relative',
    backgroundColor: '#fff'
  },
  detailImage: {
    width: '100%',
    height: '100%'
  },
  detailVideo: {
    width: '100%',
    height: '100%',
    backgroundColor: '#000'
  },
  detailImageBadge: {
    ...typography.caption,
    position: 'absolute',
    left: 12,
    top: 12,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    overflow: 'hidden',
    backgroundColor: 'rgba(255, 255, 255, 0.92)',
    color: '#111827',
    fontSize: 12,
    fontWeight: '700'
  },
  detailImageCount: {
    ...typography.caption,
    position: 'absolute',
    right: 12,
    top: 12,
    paddingHorizontal: 9,
    paddingVertical: 6,
    borderRadius: 999,
    overflow: 'hidden',
    backgroundColor: 'rgba(17, 24, 39, 0.82)',
    color: '#fff',
    fontSize: 12,
    fontWeight: '700'
  },
  detailSwipeHint: {
    position: 'absolute',
    left: 12,
    right: 12,
    bottom: 12,
    minHeight: 34,
    borderRadius: 999,
    backgroundColor: 'rgba(255, 255, 255, 0.88)',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6
  },
  detailSwipeText: {
    ...typography.caption,
    color: '#111827',
    fontWeight: '700'
  },
  detailBody: {
    paddingHorizontal: 16,
    gap: 10
  },
  detailTitle: {
    ...typography.display,
    lineHeight: 36,
    fontWeight: '700',
    color: '#111827'
  },
  detailPrice: {
    ...typography.price,
    fontSize: 24,
    color: '#111827'
  },
  description: {
    ...typography.body,
    color: '#475569',
    lineHeight: 22
  },
  factGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8
  },
  factItem: {
    width: '48%',
    padding: 12,
    borderRadius: 8,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e5e7eb'
  },
  factLabel: {
    ...typography.caption,
    color: '#64748b',
    fontWeight: '700'
  },
  factValue: {
    ...typography.body,
    color: '#111827',
    fontWeight: '700',
    marginTop: 4
  },
  tagWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8
  },
  tag: {
    ...typography.caption,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: '#f1f5f9',
    color: '#334155',
    fontWeight: '700'
  },
  detailActions: {
    gap: 10
  },
  authEntryScroll: {
    flex: 1,
    backgroundColor: '#111111'
  },
  authEntryContent: {
    flexGrow: 1,
    justifyContent: 'center'
  },
  authEntryBackground: {
    ...StyleSheet.absoluteFillObject,
    width: '100%',
    height: '100%'
  },
  authEntryImageWash: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(17, 17, 17, 0.18)'
  },
  authEntryShadow: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0, 0, 0, 0.38)'
  },
  authEntryMain: {
    flex: 1,
    justifyContent: 'space-between',
    alignItems: 'stretch',
    paddingTop: 8,
    paddingBottom: 22
  },
  authEntryMainCompact: {
    paddingTop: 2,
    paddingBottom: 12
  },
  authEntryBrand: {
    alignItems: 'center'
  },
  authEntryLogoMark: {
    justifyContent: 'center',
    marginBottom: 4
  },
  authEntryTagline: {
    ...typography.body,
    color: 'rgba(255, 255, 255, 0.82)',
    textAlign: 'center'
  },
  authEntryFeatureList: {},
  authEntryFeature: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.18)',
    backgroundColor: 'rgba(25, 25, 25, 0.34)',
    flexDirection: 'row',
    alignItems: 'center'
  },
  authEntryCheck: {
    backgroundColor: '#ffb5b5',
    alignItems: 'center',
    justifyContent: 'center'
  },
  authEntryFeatureText: {
    ...typography.body,
    flex: 1,
    color: '#fff',
    fontWeight: '400'
  },
  authEntryCta: {
    backgroundColor: '#fff',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingHorizontal: 24
  },
  authEntryCtaText: {
    ...typography.button,
    color: '#151515',
    fontWeight: '600'
  },
  authEntryExplore: {
    alignSelf: 'center',
    paddingHorizontal: 18,
    paddingVertical: 2
  },
  authEntryExploreText: {
    ...typography.smallBody,
    color: 'rgba(255, 255, 255, 0.76)',
    fontWeight: '400'
  },
  authEntryHomeIndicator: {
    alignSelf: 'center',
    height: 5,
    borderRadius: 999,
    backgroundColor: 'rgba(255, 255, 255, 0.28)'
  },
  signupScreen: {
    flex: 1,
    backgroundColor: '#fbf7f6'
  },
  signupContent: {
    flexGrow: 1,
    paddingTop: Platform.OS === 'android' ? 34 : 54,
    paddingBottom: 34
  },
  signupBrandLogo: {
    flex: 1
  },
  signupTitle: {
    ...typography.h1,
    marginTop: 50,
    color: '#050505',
    fontSize: 52,
    lineHeight: 60
  },
  signupSubtitle: {
    ...typography.body,
    marginTop: 22,
    color: '#4b4b4d',
    fontSize: 23,
    lineHeight: 31,
    fontWeight: '400',
    letterSpacing: 0
  },
  signupFieldStack: {
    marginTop: 55,
    gap: 27
  },
  signupInputWrap: {
    minHeight: 77,
    borderRadius: 15,
    borderWidth: 1.3,
    borderColor: '#c8cacc',
    backgroundColor: '#fbf7f6',
    paddingHorizontal: 20,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 17
  },
  signupInput: {
    ...typography.body,
    flex: 1,
    minHeight: 52,
    color: '#111111',
    fontSize: 20
  },
  signupInlineIcon: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center'
  },
  signupSuggestionRow: {
    marginTop: -14,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8
  },
  signupSuggestionChip: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#d7d8da',
    paddingHorizontal: 12,
    paddingVertical: 7,
    backgroundColor: '#ffffff'
  },
  signupSuggestionText: {
    ...typography.caption,
    color: '#555b66',
    fontWeight: '700'
  },
  signupSectionLabel: {
    ...typography.label,
    marginTop: 37,
    color: '#4b4b4d',
    fontSize: 17,
    lineHeight: 22,
    fontWeight: '700',
    letterSpacing: 0
  },
  signupGenderRow: {
    marginTop: 16,
    flexDirection: 'row',
    gap: 11
  },
  signupGenderButton: {
    flex: 1,
    minHeight: 67,
    borderRadius: 15,
    borderWidth: 1.3,
    borderColor: '#c8cacc',
    backgroundColor: '#fbf7f6',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8
  },
  signupGenderButtonActive: {
    backgroundColor: '#111111',
    borderColor: '#111111'
  },
  signupGenderText: {
    ...typography.body,
    color: '#111111',
    fontSize: 22,
    lineHeight: 27,
    fontWeight: '400',
    letterSpacing: 0
  },
  signupGenderTextActive: {
    color: '#ffffff'
  },
  signupPhotoRow: {
    marginTop: 38,
    flexDirection: 'row',
    gap: 17
  },
  signupPhotoButton: {
    flex: 1,
    minHeight: 68,
    borderRadius: 15,
    borderWidth: 1.3,
    borderColor: '#c8cacc',
    backgroundColor: '#fbf7f6',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
    gap: 10
  },
  signupPhotoButtonText: {
    ...typography.button,
    color: '#19191b',
    fontSize: 19,
    lineHeight: 24,
    fontWeight: '700',
    letterSpacing: 0
  },
  signupModeRow: {
    marginTop: 18,
    flexDirection: 'row',
    gap: 17
  },
  signupModeButton: {
    flex: 1,
    minHeight: 72,
    borderRadius: 15,
    borderWidth: 1,
    borderColor: '#d9dadd',
    backgroundColor: '#fbf7f6',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12
  },
  signupModeButtonActive: {
    borderColor: '#111111'
  },
  signupModeText: {
    ...typography.smallBody,
    color: '#4c4d50',
    fontSize: 16,
    lineHeight: 20,
    fontWeight: '700',
    textAlign: 'center',
    letterSpacing: 0
  },
  signupModeTextActive: {
    color: '#111111'
  },
  signupTermsRow: {
    marginTop: 41,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 16
  },
  signupCheckbox: {
    marginTop: 1,
    width: 27,
    height: 27,
    borderRadius: 4,
    borderWidth: 1.3,
    borderColor: '#c8cacc',
    alignItems: 'center',
    justifyContent: 'center'
  },
  signupCheckboxActive: {
    backgroundColor: '#111111',
    borderColor: '#111111'
  },
  signupTermsText: {
    ...typography.smallBody,
    flex: 1,
    color: '#3c3d40',
    fontSize: 18,
    lineHeight: 24,
    fontWeight: '400',
    letterSpacing: 0
  },
  signupTermsLink: {
    color: '#050505',
    textDecorationLine: 'underline'
  },
  signupSubmit: {
    marginTop: 40,
    minHeight: 76,
    borderRadius: 15,
    backgroundColor: '#050606',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingHorizontal: 22
  },
  signupSubmitDisabled: {
    opacity: 0.62
  },
  signupSubmitText: {
    ...typography.button,
    color: '#ffffff',
    fontSize: 20,
    lineHeight: 25,
    fontWeight: '700',
    letterSpacing: 0
  },
  signupMessage: {
    marginTop: 14,
    textAlign: 'center'
  },
  signupSwitch: {
    marginTop: 25,
    alignItems: 'center'
  },
  signupSwitchText: {
    ...typography.smallBody,
    color: '#4c4d50',
    fontSize: 18,
    lineHeight: 24,
    fontWeight: '400'
  },
  signupSwitchLink: {
    color: '#050505'
  },
  loginScreen: {
    flex: 1,
    backgroundColor: '#fbf7f6'
  },
  loginContent: {
    flexGrow: 1,
    backgroundColor: '#fbf7f6'
  },
  loginHero: {
    position: 'relative',
    overflow: 'hidden',
    backgroundColor: '#1f1f1f'
  },
  loginHeroImage: {
    width: '100%',
    height: '100%',
    transform: [{ scale: 1.06 }]
  },
  loginHeroOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0, 0, 0, 0.42)'
  },
  loginHeroCopy: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    paddingTop: 18,
    paddingBottom: 28
  },
  loginHeroTitle: {
    ...typography.display,
    color: '#ffffff',
    fontWeight: '700'
  },
  loginHeroText: {
    ...typography.h2,
    marginTop: 64,
    color: 'rgba(255, 255, 255, 0.92)',
    fontSize: 24,
    lineHeight: 36,
    fontWeight: '400',
    letterSpacing: 0
  },
  loginPanel: {
    paddingTop: 60,
    paddingBottom: 38,
    backgroundColor: '#fbf7f6'
  },
  loginTitle: {
    ...typography.h1,
    color: '#111111',
    fontWeight: '700'
  },
  loginSubtitle: {
    ...typography.body,
    marginTop: 22,
    color: '#4b4b4d',
    fontSize: 21,
    lineHeight: 28,
    fontWeight: '400',
    letterSpacing: 0
  },
  loginTabWrap: {
    marginTop: 76,
    height: 48,
    position: 'relative',
    justifyContent: 'flex-start'
  },
  loginTabText: {
    ...typography.h4,
    marginLeft: 58,
    color: '#111111',
    fontSize: 19,
    lineHeight: 24,
    fontWeight: '700',
    letterSpacing: 0
  },
  loginTabLine: {
    position: 'absolute',
    left: 0,
    bottom: 0,
    width: '34%',
    height: 3,
    backgroundColor: '#111111'
  },
  loginTabFaintLine: {
    position: 'absolute',
    left: '34%',
    right: 0,
    bottom: 0,
    height: 1,
    backgroundColor: '#e4e1e0'
  },
  loginFieldStack: {
    marginTop: 62,
    gap: 32
  },
  loginInputWrap: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#dedfde',
    backgroundColor: '#ffffff',
    paddingHorizontal: 18,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16
  },
  loginInput: {
    ...typography.body,
    flex: 1,
    minHeight: 46,
    color: '#111111',
    fontSize: 18,
    lineHeight: 24,
    fontWeight: '400'
  },
  loginOptionsRow: {
    marginTop: 34,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 16
  },
  loginRemember: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12
  },
  loginCheckbox: {
    width: 27,
    height: 27,
    borderRadius: 4,
    borderWidth: 1.3,
    borderColor: '#c8cacc',
    alignItems: 'center',
    justifyContent: 'center'
  },
  loginOptionText: {
    ...typography.smallBody,
    color: '#4b4b4d',
    fontSize: 18,
    lineHeight: 24,
    fontWeight: '400'
  },
  loginForgotText: {
    ...typography.smallBody,
    color: '#7a3a31',
    fontSize: 18,
    lineHeight: 24,
    fontWeight: '700'
  },
  loginTermsText: {
    ...typography.smallBody,
    marginTop: 30,
    color: '#96999c',
    fontSize: 16,
    lineHeight: 25,
    fontWeight: '400',
    textAlign: 'center'
  },
  loginTermsLink: {
    color: '#8c8f92',
    textDecorationLine: 'underline'
  },
  loginTermsUnderline: {
    alignSelf: 'center',
    marginTop: 0,
    width: '64%',
    height: 1,
    backgroundColor: '#b8b8b8'
  },
  loginSubmit: {
    marginTop: 28,
    minHeight: 60,
    borderRadius: 13,
    backgroundColor: '#050606',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingHorizontal: 22
  },
  loginSubmitText: {
    ...typography.button,
    color: '#ffffff',
    fontSize: 18,
    lineHeight: 23,
    fontWeight: '700',
    letterSpacing: 0
  },
  loginSwitch: {
    marginTop: 27,
    alignItems: 'center'
  },
  loginSwitchText: {
    ...typography.smallBody,
    color: '#4c4d50',
    fontSize: 19,
    lineHeight: 25,
    fontWeight: '400'
  },
  loginSwitchLink: {
    color: '#050505'
  },
  phoneAuthContent: {
    flexGrow: 1,
    justifyContent: 'flex-start',
    alignItems: 'center',
    paddingBottom: 44,
    backgroundColor: '#fbf7f6'
  },
  phoneAuthTopRow: {
    width: '100%',
    maxWidth: 520,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    marginBottom: 22
  },
  phoneAuthClose: {
    width: 42,
    height: 42,
    borderRadius: 21,
    borderWidth: 1,
    borderColor: '#eaded9',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#fffdfb'
  },
  phoneAuthCard: {
    width: '100%',
    maxWidth: 520,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#eaded9',
    backgroundColor: '#fffdfb',
    paddingHorizontal: 26,
    paddingVertical: 28,
    shadowColor: '#2a211d',
    shadowOpacity: 0.06,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 2
  },
  phoneAuthIcon: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: '#fff5f3',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20
  },
  phoneAuthSubtitle: {
    ...typography.body,
    marginTop: 12,
    color: '#5d5754',
    fontSize: 15,
    lineHeight: 22,
    fontWeight: '600'
  },
  phoneAuthFieldStack: {
    marginTop: 30,
    gap: 12
  },
  passwordVisibilityButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#f7f2f0'
  },
  signupDetailsCard: {
    width: '100%',
    maxWidth: 520,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#eaded9',
    backgroundColor: '#fffdfb',
    paddingHorizontal: 24,
    paddingVertical: 26,
    shadowColor: '#2a211d',
    shadowOpacity: 0.06,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 2
  },
  signupDetailsFieldStack: {
    marginTop: 26,
    gap: 18
  },
  signupDetailsLabel: {
    ...typography.label,
    color: '#5d5754',
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '700'
  },
  signupDetailsGenderRow: {
    marginTop: 10,
    flexDirection: 'row',
    gap: 8
  },
  signupDetailsGenderButton: {
    flex: 1,
    minHeight: 48,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2d7d2',
    backgroundColor: '#fbf7f6',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: 8
  },
  signupDetailsGenderButtonActive: {
    borderColor: '#9b5658',
    backgroundColor: '#9b5658'
  },
  signupDetailsGenderText: {
    ...typography.caption,
    color: '#5d5754',
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '700'
  },
  signupDetailsGenderTextActive: {
    color: '#ffffff'
  },
  signupDetailsUploadBox: {
    height: 250,
    borderRadius: 8,
    borderWidth: 1.4,
    borderStyle: 'dashed',
    borderColor: '#cdbbb5',
    overflow: 'hidden',
    backgroundColor: '#fbf7f6',
    alignItems: 'center',
    justifyContent: 'center'
  },
  signupDetailsUploadImage: {
    width: '100%',
    height: '100%'
  },
  signupDetailsUploadOverlay: {
    position: 'absolute',
    left: 12,
    right: 12,
    bottom: 12,
    minHeight: 38,
    borderRadius: 8,
    backgroundColor: 'rgba(17, 17, 17, 0.76)',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8
  },
  signupDetailsUploadOverlayText: {
    ...typography.caption,
    color: '#ffffff',
    fontWeight: '700'
  },
  signupDetailsUploadCopy: {
    alignItems: 'center',
    paddingHorizontal: 28
  },
  signupDetailsUploadIcon: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: '#fff5f3',
    alignItems: 'center',
    justifyContent: 'center'
  },
  signupDetailsUploadTitle: {
    ...typography.productTitle,
    marginTop: 13,
    color: '#2b2321',
    fontWeight: '700',
    textAlign: 'center'
  },
  signupDetailsUploadText: {
    ...typography.smallBody,
    marginTop: 6,
    color: '#6d625e',
    textAlign: 'center',
    fontWeight: '500'
  },
  signupDetailsLegalText: {
    ...typography.caption,
    marginTop: 14,
    color: '#8d8682',
    textAlign: 'center',
    fontWeight: '500'
  },
  signupDetailsLegalLink: {
    color: '#9b5658',
    fontWeight: '700',
    textDecorationLine: 'underline'
  },
  phoneAuthOtpBlock: {
    gap: 7
  },
  phoneAuthEditorial: {
    width: '100%',
    maxWidth: 520,
    marginTop: 14,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#eaded9',
    backgroundColor: '#fffdfb',
    padding: 10,
    shadowColor: '#2a211d',
    shadowOpacity: 0.05,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
    elevation: 2
  },
  phoneAuthEditorialImageFrame: {
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: '#e8ded9'
  },
  phoneAuthEditorialImage: {
    width: '100%',
    height: '100%'
  },
  phoneAuthEditorialShade: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(17, 17, 17, 0.14)'
  },
  phoneAuthEditorialBadge: {
    position: 'absolute',
    left: 10,
    bottom: 10,
    minHeight: 30,
    borderRadius: 15,
    backgroundColor: 'rgba(255, 255, 255, 0.9)',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10
  },
  phoneAuthEditorialBadgeText: {
    ...typography.caption,
    color: '#111111',
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '800'
  },
  phoneAuthEditorialTitle: {
    ...typography.productTitle,
    marginTop: 12,
    color: '#2b2321',
    fontSize: 15,
    lineHeight: 20,
    fontWeight: '800'
  },
  phoneAuthPerkRow: {
    marginTop: 10,
    flexDirection: 'row',
    gap: 8
  },
  phoneAuthPerk: {
    flex: 1,
    minHeight: 34,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#eee3dc',
    backgroundColor: '#fbf7f6',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    paddingHorizontal: 6
  },
  phoneAuthPerkText: {
    ...typography.caption,
    color: '#2b2321',
    fontSize: 11,
    lineHeight: 15,
    fontWeight: '800'
  },
  phoneAuthTextButton: {
    marginTop: 14,
    minHeight: 46,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2d7d2',
    backgroundColor: '#fbf7f6',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 16
  },
  phoneAuthTextButtonLabel: {
    ...typography.caption,
    color: '#2b2321',
    fontSize: 14,
    lineHeight: 19,
    fontWeight: '800'
  },
  phoneAuthMessage: {
    color: '#5d5754'
  },
  authModeSwitch: {
    marginTop: 18,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    flexWrap: 'wrap'
  },
  authModeSwitchText: {
    ...typography.caption,
    color: '#6d625e',
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '700'
  },
  authModeSwitchLink: {
    ...typography.caption,
    color: '#2b2321',
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '900',
    textDecorationLine: 'underline'
  },
  phoneAuthBrowseButton: {
    width: '100%',
    maxWidth: 520,
    marginTop: 18,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 42
  },
  phoneAuthBrowseText: {
    ...typography.caption,
    color: '#5d5754',
    fontSize: 14,
    lineHeight: 19,
    fontWeight: '700'
  },
  authCard: {
    margin: 16,
    padding: 18,
    borderRadius: 8,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e5e7eb',
    gap: 12
  },
  authTitle: {
    ...typography.h1,
    fontSize: 29,
    lineHeight: 34,
    fontWeight: '700',
    color: '#111827',
    letterSpacing: 0
  },
  input: {
    ...typography.body,
    minHeight: 48,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#d1d5db',
    paddingHorizontal: 12,
    color: '#111827',
    backgroundColor: '#fff',
    fontWeight: '500'
  },
  formGroup: {
    gap: 8
  },
  formLabel: {
    ...typography.label,
    color: '#334155',
    fontWeight: '700',
    textTransform: 'uppercase'
  },
  noteInput: {
    marginHorizontal: 16,
    minHeight: 90,
    paddingTop: 12,
    textAlignVertical: 'top'
  },
  uploadBox: {
    borderRadius: 8,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: '#0f766e',
    padding: 12,
    backgroundColor: '#f0fdfa',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12
  },
  uploadPreview: {
    width: 58,
    height: 72,
    borderRadius: 8
  },
  uploadCopy: {
    flex: 1
  },
  uploadTitle: {
    ...typography.body,
    color: '#134e4a',
    fontWeight: '700'
  },
  photoGuide: {
    marginTop: 8,
    gap: 4
  },
  photoGuideTitle: {
    ...typography.caption,
    color: '#0f766e',
    fontWeight: '700'
  },
  photoGuideText: {
    ...typography.caption,
    color: '#475569',
    lineHeight: 17,
    fontWeight: '700'
  },
  formMessage: {
    ...typography.smallBody,
    color: '#475569',
    fontWeight: '700'
  },
  switchText: {
    ...typography.smallBody,
    color: '#0f766e',
    fontWeight: '700',
    textAlign: 'center',
    marginTop: 4
  },
  toolHero: {
    margin: 16,
    padding: 18,
    borderRadius: 8,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e5e7eb',
    gap: 10
  },
  customTryOnScreen: {
    flex: 1,
    backgroundColor: '#fbf7f6'
  },
  customTryOnContent: {
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: bottomNavigationHeight + screenBottomInset + 18
  },
  customHeroPanel: {
    padding: 18,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#eaded9',
    backgroundColor: '#fffdfb',
    shadowColor: '#2a211d',
    shadowOpacity: 0.06,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 2,
    gap: 10
  },
  customHeroMetaRow: {
    minHeight: 28,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12
  },
  customTokenPill: {
    minHeight: 28,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#eaded9',
    backgroundColor: '#fbf7f6',
    paddingHorizontal: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5
  },
  customTokenText: {
    ...typography.caption,
    color: '#5d5754',
    fontSize: 11,
    lineHeight: 15,
    fontWeight: '800'
  },
  customUploadRow: {
    marginTop: 14,
    flexDirection: 'row',
    gap: 12
  },
  customProfileCard: {
    width: 116,
    height: 232,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#eaded9',
    backgroundColor: '#fffdfb',
    overflow: 'hidden'
  },
  customProfileImage: {
    width: '100%',
    height: '100%'
  },
  customProfileEmpty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
    backgroundColor: '#f2ece9'
  },
  customProfileEmptyText: {
    ...typography.caption,
    marginTop: 8,
    color: '#77716f',
    textAlign: 'center',
    fontSize: 11,
    lineHeight: 15,
    fontWeight: '700'
  },
  customProfileCaption: {
    position: 'absolute',
    left: 8,
    right: 8,
    bottom: 8,
    borderRadius: 8,
    backgroundColor: 'rgba(255, 253, 251, 0.9)',
    paddingHorizontal: 8,
    paddingVertical: 7
  },
  customProfileLabel: {
    ...typography.caption,
    color: '#2b2321',
    fontSize: 11,
    lineHeight: 15,
    fontWeight: '800'
  },
  customProfileSub: {
    ...typography.caption,
    marginTop: 2,
    color: '#77716f',
    fontSize: 9,
    lineHeight: 12,
    fontWeight: '700',
    textTransform: 'uppercase'
  },
  customGarmentDrop: {
    flex: 1,
    minWidth: 0,
    height: 232,
    borderRadius: 10,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderColor: '#cdbbb5',
    backgroundColor: '#fffdfb',
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center'
  },
  customGarmentDropReady: {
    borderStyle: 'solid',
    borderColor: '#9b5658'
  },
  customGarmentCopy: {
    alignItems: 'center',
    paddingHorizontal: 18
  },
  customGarmentIcon: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: '#fff5f3',
    alignItems: 'center',
    justifyContent: 'center'
  },
  customGarmentTitle: {
    ...typography.productTitle,
    marginTop: 13,
    color: '#2b2321',
    textAlign: 'center',
    fontWeight: '800'
  },
  customGarmentHelp: {
    ...typography.caption,
    marginTop: 6,
    color: '#6d625e',
    textAlign: 'center',
    fontSize: 11,
    lineHeight: 16,
    fontWeight: '600'
  },
  customGarmentImage: {
    width: '100%',
    height: '100%'
  },
  customGarmentOverlay: {
    position: 'absolute',
    left: 10,
    right: 10,
    bottom: 10,
    minHeight: 38,
    borderRadius: 8,
    backgroundColor: 'rgba(17, 17, 17, 0.74)',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7
  },
  customGarmentOverlayText: {
    ...typography.caption,
    color: '#ffffff',
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '800'
  },
  customResultCard: {
    marginTop: 14,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#eaded9',
    backgroundColor: '#fffdfb',
    overflow: 'hidden'
  },
  customResultHead: {
    minHeight: 62,
    paddingHorizontal: 14,
    paddingVertical: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12
  },
  customResultTitle: {
    ...typography.productTitle,
    color: '#2b2321',
    fontSize: 15,
    lineHeight: 20,
    fontWeight: '800'
  },
  customResultSub: {
    ...typography.caption,
    marginTop: 2,
    color: '#77716f',
    fontSize: 11,
    lineHeight: 15,
    fontWeight: '600'
  },
  customResultOpen: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: '#f5efec',
    alignItems: 'center',
    justifyContent: 'center'
  },
  customResultFrame: {
    minHeight: 368,
    backgroundColor: '#f2ece9',
    alignItems: 'center',
    justifyContent: 'center'
  },
  customResultImage: {
    width: '100%',
    height: 368
  },
  customResultState: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingHorizontal: 20
  },
  customResultStateOverlay: {
    backgroundColor: 'rgba(251, 247, 246, 0.72)'
  },
  customTryOnMessage: {
    marginTop: 12,
    textAlign: 'center'
  },
  customAiPreviewNote: {
    marginHorizontal: 0
  },
  tryOnPair: {
    paddingHorizontal: 16,
    flexDirection: 'row',
    gap: 12
  },
  previewBox: {
    flex: 1,
    height: 260,
    borderRadius: 8,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#e5e7eb',
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center'
  },
  previewBoxWide: {
    margin: 16,
    minHeight: 360,
    borderRadius: 8,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#e5e7eb',
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center'
  },
  previewImage: {
    width: '100%',
    height: '100%'
  },
  resultImage: {
    width: '100%',
    height: 420
  },
  previewPlaceholder: {
    color: '#64748b',
    fontWeight: '700',
    textAlign: 'center'
  },
  customGenerateButton: {
    marginTop: 16,
    width: '100%'
  },
  debugText: {
    marginHorizontal: 16,
    marginBottom: 10,
    color: '#64748b',
    fontSize: 12,
    fontWeight: '700'
  },
  chatPanel: {
    marginHorizontal: 16,
    gap: 12
  },
  chatBubbleAssistant: {
    alignSelf: 'flex-start',
    maxWidth: '96%',
    padding: 12,
    borderRadius: 8,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e5e7eb',
    gap: 10
  },
  chatBubbleUser: {
    alignSelf: 'flex-end',
    maxWidth: '86%',
    padding: 12,
    borderRadius: 8,
    backgroundColor: '#111827',
    marginBottom: 8
  },
  chatText: {
    color: '#334155',
    lineHeight: 20,
    fontWeight: '700'
  },
  chatUserText: {
    color: '#fff',
    fontWeight: '700'
  },
  composer: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: Platform.OS === 'ios' ? 80 : 106,
    padding: 10,
    backgroundColor: '#fff',
    borderTopWidth: 1,
    borderTopColor: '#e5e7eb',
    flexDirection: 'row',
    gap: 8
  },
  composerInput: {
    flex: 1,
    minHeight: 46,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#d1d5db',
    paddingHorizontal: 12,
    fontWeight: '700'
  },
  composerButton: {
    width: 48,
    borderRadius: 8,
    backgroundColor: '#111827',
    alignItems: 'center',
    justifyContent: 'center'
  },
  styleResult: {
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: '#e5e7eb',
    gap: 8
  },
  styleImages: {
    flexDirection: 'row',
    gap: 8
  },
  styleImageBox: {
    flex: 1,
    height: 190,
    borderRadius: 8,
    backgroundColor: '#f1f5f9',
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center'
  },
  styleImage: {
    width: '100%',
    height: '100%',
    borderRadius: 8
  },
  styleModelBadge: {
    alignSelf: 'flex-start',
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: 999,
    overflow: 'hidden',
    backgroundColor: '#ecfdf5',
    color: '#0f766e',
    fontSize: 11,
    fontWeight: '700'
  },
  creditsScreen: {
    flex: 1,
    backgroundColor: '#fbf8f7'
  },
  creditsContent: {
    paddingBottom: 34
  },
  creditsHero: {
    paddingHorizontal: 24,
    paddingTop: 34,
    paddingBottom: 16,
    gap: 24
  },
  creditsHeroCopy: {
    gap: 10
  },
  creditsEyebrow: {
    ...typography.label,
    color: '#a86164',
    fontSize: 12,
    lineHeight: 16,
    letterSpacing: 0,
    textTransform: 'uppercase'
  },
  creditsHeroTitle: {
    ...typography.display,
    color: '#171414',
    fontSize: 54,
    lineHeight: 58
  },
  creditsBackLink: {
    ...typography.label,
    color: '#9b5658',
    fontSize: 12,
    lineHeight: 16,
    letterSpacing: 0,
    textTransform: 'uppercase'
  },
  creditsHeroText: {
    ...typography.label,
    color: '#6f6967',
    fontSize: 13,
    lineHeight: 20,
    letterSpacing: 0,
    textTransform: 'uppercase'
  },
  creditsLoader: {
    marginTop: 8
  },
  creditChoiceGrid: {
    paddingHorizontal: 24,
    paddingTop: 20,
    gap: 14
  },
  creditMandateCard: {
    minHeight: 252,
    paddingHorizontal: 20,
    paddingVertical: 22,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#dccfcb',
    backgroundColor: '#fffdfc',
    overflow: 'hidden',
    gap: 10
  },
  creditMandateCardSelected: {
    borderColor: '#b56b6c',
    borderWidth: 1.3
  },
  creditSelectedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minHeight: 22
  },
  creditSelectedPill: {
    ...typography.caption,
    alignSelf: 'flex-start',
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 999,
    overflow: 'hidden',
    backgroundColor: '#1f1d1c',
    color: '#ffffff',
    fontSize: 9,
    lineHeight: 12,
    fontWeight: '700'
  },
  creditActivePill: {
    ...typography.caption,
    alignSelf: 'flex-start',
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 999,
    overflow: 'hidden',
    backgroundColor: '#e8f6ef',
    color: '#0f766e',
    fontSize: 9,
    lineHeight: 12,
    fontWeight: '700'
  },
  creditCardKicker: {
    ...typography.label,
    color: '#b26a6d',
    fontSize: 12,
    lineHeight: 16,
    letterSpacing: 0,
    textTransform: 'uppercase'
  },
  creditMandateTitle: {
    ...typography.display,
    color: '#1c1919',
    fontSize: 40,
    lineHeight: 44
  },
  creditMandateSub: {
    ...typography.body,
    color: '#242020',
    fontSize: 15,
    lineHeight: 21,
    fontWeight: '700'
  },
  creditMutedText: {
    ...typography.caption,
    color: '#9d9693',
    fontSize: 12,
    lineHeight: 17
  },
  creditCapsText: {
    ...typography.label,
    color: '#8f8582',
    fontSize: 11,
    lineHeight: 15,
    letterSpacing: 0,
    textTransform: 'uppercase'
  },
  creditCardDescription: {
    ...typography.smallBody,
    marginTop: 6,
    color: '#5e5956',
    fontSize: 13,
    lineHeight: 19
  },
  creditAddMoreCard: {
    minHeight: 210,
    paddingHorizontal: 20,
    paddingVertical: 24,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2d8d5',
    backgroundColor: '#fffdfc',
    gap: 10
  },
  creditAddMoreTitle: {
    ...typography.display,
    color: '#1c1919',
    fontSize: 38,
    lineHeight: 42
  },
  topUpGrid: {
    paddingHorizontal: 24,
    paddingTop: 20,
    gap: 14
  },
  topUpCreditCard: {
    minHeight: 210,
    paddingHorizontal: 20,
    paddingVertical: 24,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#ded5d2',
    backgroundColor: '#fffdfc',
    gap: 9,
    overflow: 'hidden'
  },
  topUpBestValue: {
    ...typography.caption,
    position: 'absolute',
    top: 0,
    right: 16,
    paddingHorizontal: 16,
    paddingVertical: 7,
    borderBottomLeftRadius: 18,
    borderBottomRightRadius: 18,
    overflow: 'hidden',
    backgroundColor: '#a45d5f',
    color: '#ffffff',
    fontSize: 9,
    lineHeight: 12,
    fontWeight: '700'
  },
  topUpPrice: {
    ...typography.display,
    color: '#1c1919',
    fontSize: 42,
    lineHeight: 48
  },
  creditsDivider: {
    marginHorizontal: 24,
    marginTop: 34,
    height: 1,
    backgroundColor: '#e1d8d5'
  },
  creditsSectionLabel: {
    ...typography.h2,
    marginTop: 34,
    paddingHorizontal: 24,
    color: '#1c1919',
    fontSize: 30,
    lineHeight: 37
  },
  creditTierStack: {
    marginTop: 24,
    paddingHorizontal: 24,
    gap: 14
  },
  creditTierCard: {
    minHeight: 168,
    paddingHorizontal: 22,
    paddingVertical: 24,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#c9c9c9',
    backgroundColor: '#fffdfc'
  },
  creditTierCardSelected: {
    borderColor: '#111111',
    borderWidth: 1.3
  },
  creditTierBadge: {
    ...typography.caption,
    position: 'absolute',
    top: -11,
    left: 23,
    paddingHorizontal: 11,
    paddingVertical: 4,
    borderRadius: 999,
    overflow: 'hidden',
    backgroundColor: '#060606',
    color: '#ffffff',
    fontSize: 9,
    fontWeight: '700'
  },
  creditTierTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 14
  },
  creditTierName: {
    ...typography.productTitle,
    fontSize: 14,
    color: '#1b1717'
  },
  creditTierPrice: {
    ...typography.price,
    color: '#111111',
    fontSize: 16,
    fontWeight: '500'
  },
  creditAmountRow: {
    marginTop: 20,
    flexDirection: 'row',
    alignItems: 'flex-end'
  },
  creditAmount: {
    ...typography.display,
    fontSize: 29,
    lineHeight: 34,
    color: '#9b5658'
  },
  creditAmountLabel: {
    ...typography.label,
    paddingBottom: 3,
    color: '#9b5658',
    fontSize: 15,
    letterSpacing: 0,
    fontWeight: '600'
  },
  creditTierDescription: {
    marginTop: 24,
    color: '#4d4a4a',
    fontSize: 13,
    lineHeight: 18
  },
  paymentMethodCard: {
    marginTop: 18,
    marginHorizontal: 24,
    minHeight: 64,
    paddingHorizontal: 15,
    paddingVertical: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#272323',
    backgroundColor: '#fffdfc',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between'
  },
  paymentMethodLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12
  },
  phonePeMark: {
    width: 32,
    height: 32,
    borderRadius: 8,
    backgroundColor: '#6739b7',
    alignItems: 'center',
    justifyContent: 'center'
  },
  phonePeMarkText: {
    color: '#ffffff',
    fontSize: 15,
    lineHeight: 20,
    fontWeight: '800'
  },
  appStoreMark: {
    width: 32,
    height: 32,
    borderRadius: 8,
    backgroundColor: '#1f1d1c',
    alignItems: 'center',
    justifyContent: 'center'
  },
  paymentMethodText: {
    ...typography.body,
    color: '#242020',
    fontSize: 15,
    lineHeight: 19,
    fontWeight: '700'
  },
  paymentMethodSubText: {
    ...typography.caption,
    marginTop: 2,
    color: '#7d7572',
    fontSize: 12,
    lineHeight: 16
  },
  paymentSelectedText: {
    ...typography.caption,
    color: '#a45d5f',
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '700'
  },
  addPaymentCard: {
    marginTop: 10,
    marginHorizontal: 36,
    height: 54,
    paddingHorizontal: 15,
    borderRadius: 8,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: '#c9c2c0',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11
  },
  addPaymentText: {
    color: '#55514f',
    fontSize: 15
  },
  orderSummaryCard: {
    marginTop: 34,
    marginHorizontal: 24,
    paddingHorizontal: 22,
    paddingVertical: 26,
    borderRadius: 8,
    backgroundColor: '#fffdfc',
    shadowColor: '#000000',
    shadowOpacity: 0.05,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 12 },
    elevation: 3,
    gap: 0
  },
  orderSummaryTitle: {
    ...typography.h2,
    marginBottom: 6,
    fontSize: 30,
    lineHeight: 36,
    color: '#1d1919'
  },
  orderSummaryKicker: {
    ...typography.label,
    marginBottom: 16,
    color: '#b26a6d',
    fontSize: 12,
    lineHeight: 16,
    letterSpacing: 0,
    textTransform: 'uppercase'
  },
  paymentSummaryLine: {
    minHeight: 54,
    paddingVertical: 13,
    borderBottomWidth: 1,
    borderBottomColor: '#eee5e2',
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 16
  },
  paymentSummaryLabel: {
    ...typography.body,
    color: '#8b8582',
    fontSize: 14,
    lineHeight: 20,
    flexShrink: 1
  },
  paymentSummaryValue: {
    ...typography.body,
    color: '#2e2927',
    fontSize: 14,
    lineHeight: 20,
    flex: 1,
    textAlign: 'right'
  },
  paymentSummaryValueStrong: {
    fontWeight: '700'
  },
  orderSummaryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 16
  },
  orderSummaryText: {
    ...typography.body,
    color: '#474343',
    fontSize: 15,
    lineHeight: 20,
    flexShrink: 1
  },
  orderSummaryDivider: {
    height: 1,
    backgroundColor: '#e5dcda'
  },
  orderSummaryTotalRow: {
    marginTop: 20,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12
  },
  totalAmountLabel: {
    ...typography.label,
    color: '#111111',
    fontSize: 15,
    letterSpacing: 0,
    fontWeight: '500'
  },
  totalAmountValue: {
    ...typography.h3,
    color: '#111111',
    fontSize: 32,
    lineHeight: 39,
    fontWeight: '700'
  },
  cancelMandateButton: {
    marginTop: 16,
    marginHorizontal: 24,
    height: 45,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#d7c7c4',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#fffdfc'
  },
  cancelMandateText: {
    ...typography.label,
    color: '#9b5658',
    fontSize: 12,
    lineHeight: 16,
    letterSpacing: 0
  },
  creditsMessage: {
    ...typography.caption,
    marginTop: 16,
    marginHorizontal: 24,
    color: '#55514f',
    fontSize: 13,
    lineHeight: 18
  },
  secureCheckoutButton: {
    marginTop: 28,
    marginHorizontal: 24,
    height: 52,
    borderRadius: 8,
    backgroundColor: '#050505',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000000',
    shadowOpacity: 0.2,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 7 },
    elevation: 5
  },
  secureCheckoutText: {
    color: '#ffffff',
    fontSize: 15,
    letterSpacing: 0,
    fontWeight: '600'
  },
  verifyPaymentButton: {
    marginTop: 12,
    marginHorizontal: 24,
    height: 46,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#d9c8c5',
    backgroundColor: '#fffdfc',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8
  },
  verifyPaymentText: {
    ...typography.label,
    color: '#5e3335',
    fontSize: 12,
    lineHeight: 16,
    letterSpacing: 0
  },
  appleStoreActionRow: {
    marginTop: 12,
    marginHorizontal: 24,
    flexDirection: 'row',
    gap: 10
  },
  appleStoreActionButton: {
    flex: 1,
    minHeight: 46,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#d8c7c2',
    backgroundColor: '#fffdfc',
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 8
  },
  creditsFooterLinks: {
    marginTop: 16,
    paddingHorizontal: 30,
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 10
  },
  creditsFooterLink: {
    color: '#9b9391',
    fontSize: 9,
    fontWeight: '600'
  },
  balanceCard: {
    padding: 16,
    borderRadius: 8,
    backgroundColor: '#111827',
    alignItems: 'center'
  },
  balanceNumber: {
    color: '#fff',
    fontSize: 44,
    fontWeight: '700'
  },
  balanceLabel: {
    color: '#ccfbf1',
    fontWeight: '700'
  },
  tokenPack: {
    marginHorizontal: 16,
    marginBottom: 10,
    padding: 14,
    borderRadius: 8,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e5e7eb',
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12
  },
  subscriptionPack: {
    flexDirection: 'column'
  },
  planHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10
  },
  activePill: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    overflow: 'hidden',
    backgroundColor: '#dcfce7',
    color: '#166534',
    fontSize: 12,
    fontWeight: '700'
  },
  tokenName: {
    fontSize: 18,
    fontWeight: '700',
    color: '#111827'
  },
  tokenRight: {
    alignItems: 'flex-end'
  },
  tokenAmount: {
    color: '#0f766e',
    fontWeight: '700'
  },
  generationPreviewCard: {
    marginHorizontal: 18,
    marginTop: 24,
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 16,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e5dcd9',
    backgroundColor: '#fffdfc',
    shadowColor: '#2a211d',
    shadowOpacity: 0.04,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 7 },
    elevation: 2
  },
  generationPreviewHead: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 14
  },
  generationPreviewTitleBlock: {
    flex: 1,
    minWidth: 0
  },
  generationPreviewTitle: {
    ...typography.h3,
    color: '#2b2321',
    fontSize: 22,
    lineHeight: 27,
    fontWeight: '700'
  },
  generationPreviewSubtitle: {
    ...typography.caption,
    marginTop: 4,
    color: '#7c7470',
    fontSize: 10,
    lineHeight: 14,
    fontWeight: '700',
    textTransform: 'uppercase'
  },
  generationPreviewIcon: {
    width: 32,
    height: 32,
    borderRadius: 8,
    backgroundColor: '#f5efec',
    alignItems: 'center',
    justifyContent: 'center'
  },
  generationPreviewThumbRow: {
    minHeight: 82,
    marginTop: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10
  },
  generationPreviewThumb: {
    width: 58,
    height: 76,
    borderRadius: 6,
    overflow: 'hidden',
    backgroundColor: '#efe8e4'
  },
  generationPreviewImage: {
    width: '100%',
    height: '100%'
  },
  generationPreviewEmpty: {
    flex: 1,
    minHeight: 76,
    borderRadius: 8,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: '#e2d8d2',
    backgroundColor: '#fbf7f6',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: 14
  },
  generationPreviewEmptyText: {
    ...typography.caption,
    color: '#7c7470',
    textAlign: 'center',
    fontSize: 11,
    lineHeight: 15,
    fontWeight: '700'
  },
  generationPreviewDivider: {
    marginTop: 14,
    height: 1,
    backgroundColor: '#efe4df'
  },
  generationPreviewFooter: {
    minHeight: 42,
    paddingTop: 13,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12
  },
  generationPreviewCount: {
    ...typography.caption,
    flex: 1,
    minWidth: 0,
    color: '#9b928d',
    fontSize: 10,
    lineHeight: 14,
    fontWeight: '700'
  },
  generationPreviewButton: {
    minHeight: 34,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#ded3ce',
    paddingHorizontal: 13,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: '#fffdfc'
  },
  generationPreviewButtonText: {
    ...typography.caption,
    color: '#2b2321',
    fontSize: 11,
    lineHeight: 15,
    fontWeight: '700'
  },
  generationHistoryScreen: {
    flex: 1,
    backgroundColor: '#fbf7f6'
  },
  generationHistoryContent: {
    paddingHorizontal: 18,
    paddingTop: 28,
    paddingBottom: bottomNavigationHeight + screenBottomInset
  },
  generationHistoryHeader: {
    marginBottom: 20,
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 14
  },
  generationHistoryTitle: {
    ...typography.display,
    color: '#2b2321',
    fontSize: 32,
    lineHeight: 38
  },
  generationHistorySubtitle: {
    ...typography.caption,
    marginTop: 5,
    color: '#7c7470',
    fontSize: 12,
    lineHeight: 17,
    fontWeight: '600'
  },
  generationHistoryTotal: {
    ...typography.caption,
    marginTop: 8,
    color: '#9b928d',
    fontSize: 11,
    lineHeight: 15,
    fontWeight: '700'
  },
  generationHistoryRefresh: {
    width: 42,
    height: 42,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#eaded9',
    backgroundColor: '#fffdfc',
    alignItems: 'center',
    justifyContent: 'center'
  },
  generationGridRow: {
    gap: 14
  },
  generationGridCard: {
    flex: 1,
    flexBasis: '48%',
    maxWidth: '48%',
    marginBottom: 16,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e9dfda',
    overflow: 'hidden',
    backgroundColor: '#fffdfc'
  },
  generationGridImageWrap: {
    position: 'relative',
    backgroundColor: '#efe8e4'
  },
  generationGridImage: {
    width: '100%',
    aspectRatio: 0.76
  },
  generationGridBadge: {
    position: 'absolute',
    left: 9,
    top: 9,
    maxWidth: '82%',
    minHeight: 24,
    borderRadius: 12,
    backgroundColor: 'rgba(255, 253, 252, 0.92)',
    paddingHorizontal: 9,
    alignItems: 'center',
    justifyContent: 'center'
  },
  generationGridBadgeText: {
    ...typography.caption,
    color: '#9b5658',
    fontSize: 9,
    lineHeight: 12,
    fontWeight: '800',
    textTransform: 'uppercase'
  },
  generationGridCopy: {
    paddingHorizontal: 10,
    paddingTop: 10,
    paddingBottom: 11
  },
  generationGridTitle: {
    ...typography.productTitle,
    color: '#2b2321',
    fontSize: 12,
    lineHeight: 17,
    fontWeight: '800'
  },
  generationGridMeta: {
    ...typography.caption,
    marginTop: 5,
    color: '#7c7470',
    fontSize: 10,
    lineHeight: 13,
    fontWeight: '700'
  },
  generationGridFooter: {
    marginTop: 9,
    minHeight: 24,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8
  },
  generationGridDate: {
    ...typography.caption,
    flex: 1,
    color: '#9b928d',
    fontSize: 9,
    lineHeight: 12,
    fontWeight: '700'
  },
  generationGridProductButton: {
    width: 26,
    height: 26,
    borderRadius: 13,
    borderWidth: 1,
    borderColor: '#eaded9',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#fbf7f6'
  },
  generationGridSkeleton: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 14
  },
  generationGridSkeletonLine: {
    width: '78%',
    height: 10,
    borderRadius: 5,
    marginTop: 10,
    marginHorizontal: 10
  },
  generationGridSkeletonShort: {
    width: '48%',
    height: 9,
    borderRadius: 5,
    marginTop: 8,
    marginHorizontal: 10,
    marginBottom: 12
  },
  generationHistoryFootnote: {
    ...typography.caption,
    marginTop: 4,
    color: '#7c7470',
    textAlign: 'center',
    fontSize: 11,
    fontWeight: '700'
  },
  profileScreen: {
    flex: 1,
    backgroundColor: '#fbf7f6'
  },
  profileContent: {
    paddingBottom: screenBottomInset
  },
  profileTopBar: {
    height: 58,
    paddingHorizontal: 34,
    borderBottomWidth: 1,
    borderBottomColor: '#ebe3e1',
    backgroundColor: '#fbf7f6',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between'
  },
  profileTopIcon: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center'
  },
  profileTopBrand: {
    ...typography.h2,
    position: 'absolute',
    left: 0,
    right: 0,
    textAlign: 'center',
    fontSize: 25,
    color: '#111111'
  },
  profileHero: {
    paddingTop: 26,
    paddingHorizontal: 22,
    alignItems: 'center',
    minHeight: 268
  },
  profilePhotoWrap: {
    width: 76,
    height: 76,
    borderRadius: 38,
    overflow: 'hidden',
    backgroundColor: '#efe7e4',
    borderWidth: 3,
    borderColor: '#ffffff',
    shadowColor: '#000000',
    shadowOpacity: 0.09,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 3
  },
  profilePhoto: {
    width: '100%',
    height: '100%'
  },
  profileFaceImage: {
    transform: [{ scale: 1.04 }]
  },
  profileAvatarFallback: {
    alignItems: 'center',
    justifyContent: 'center'
  },
  profileAvatarInitials: {
    fontSize: 24,
    lineHeight: 30
  },
  profilePhotoAction: {
    position: 'absolute',
    right: -1,
    bottom: 1,
    width: 21,
    height: 21,
    borderRadius: 11,
    backgroundColor: '#050505',
    borderWidth: 2,
    borderColor: '#ffffff',
    alignItems: 'center',
    justifyContent: 'center'
  },
  profileCopy: {
    flex: 1
  },
  profileName: {
    ...typography.h3,
    marginTop: 18,
    color: '#2b2321',
    textAlign: 'center'
  },
  profileRole: {
    ...typography.caption,
    marginTop: 7,
    color: '#9b5658',
    fontSize: 12,
    letterSpacing: 0,
    fontWeight: '700'
  },
  profileBio: {
    ...typography.caption,
    marginTop: 12,
    maxWidth: 320,
    color: '#5d5754',
    textAlign: 'center',
    fontSize: 12,
    lineHeight: 18,
    fontWeight: '500'
  },
  profileEditButton: {
    marginTop: 16,
    minWidth: 132,
    height: 34,
    borderRadius: 17,
    backgroundColor: '#050505',
    alignItems: 'center',
    justifyContent: 'center'
  },
  profileEditText: {
    ...typography.caption,
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '700'
  },
  profileEditOverlay: {
    flex: 1,
    justifyContent: 'flex-end'
  },
  profileEditBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(20, 16, 14, 0.42)'
  },
  profileEditSheet: {
    marginHorizontal: 10,
    marginBottom: Math.max(screenBottomInset, 12),
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#eaded9',
    backgroundColor: '#fffdfb',
    paddingHorizontal: 18,
    paddingTop: 10,
    paddingBottom: 18,
    shadowColor: '#000000',
    shadowOpacity: 0.16,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: -8 },
    elevation: 8
  },
  profileEditHandle: {
    alignSelf: 'center',
    width: 42,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#ded3ce',
    marginBottom: 14
  },
  profileEditHead: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 16
  },
  profileEditSheetTitle: {
    ...typography.h3,
    color: '#2b2321',
    fontSize: 19,
    lineHeight: 25
  },
  profileEditSheetSub: {
    ...typography.caption,
    marginTop: 5,
    maxWidth: 270,
    color: '#6f6864',
    fontSize: 12,
    lineHeight: 17,
    fontWeight: '500'
  },
  profileEditClose: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#f5efec',
    alignItems: 'center',
    justifyContent: 'center'
  },
  avatarAdjustPreviewWrap: {
    marginTop: 18,
    alignItems: 'center'
  },
  avatarAdjustPreviewFrame: {
    width: 132,
    height: 132,
    borderRadius: 66,
    overflow: 'hidden',
    borderWidth: 4,
    borderColor: '#ffffff',
    backgroundColor: '#eee9e6',
    shadowColor: '#000000',
    shadowOpacity: 0.11,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 4
  },
  avatarAdjustPreviewImage: {
    width: '100%',
    height: '100%'
  },
  avatarAdjustControls: {
    marginTop: 18,
    gap: 8,
    alignItems: 'center'
  },
  avatarAdjustRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 10
  },
  avatarAdjustIconButton: {
    width: 42,
    height: 42,
    borderRadius: 21,
    borderWidth: 1,
    borderColor: '#ded3ce',
    backgroundColor: '#fbf7f6',
    alignItems: 'center',
    justifyContent: 'center'
  },
  profileEditLabel: {
    ...typography.caption,
    marginTop: 17,
    marginBottom: 8,
    color: '#5d5754',
    fontSize: 12,
    fontWeight: '700'
  },
  profileEditInput: {
    minHeight: 48,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#ded3ce',
    backgroundColor: '#fbf7f6',
    paddingHorizontal: 13,
    color: '#211c1a',
    fontSize: 15,
    fontWeight: '700'
  },
  profileGenderGrid: {
    flexDirection: 'row',
    gap: 8
  },
  profileGenderOption: {
    flex: 1,
    minHeight: 46,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#ded3ce',
    backgroundColor: '#fbf7f6',
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 6,
    paddingHorizontal: 8
  },
  profileGenderOptionActive: {
    borderColor: '#050505',
    backgroundColor: '#050505'
  },
  profileGenderText: {
    ...typography.caption,
    color: '#5d5754',
    fontSize: 12,
    fontWeight: '700'
  },
  profileGenderTextActive: {
    color: '#ffffff'
  },
  profileEditMessage: {
    ...typography.caption,
    marginTop: 12,
    color: '#5d5754',
    fontSize: 12,
    lineHeight: 17,
    fontWeight: '700'
  },
  profileEditActions: {
    marginTop: 20,
    flexDirection: 'row',
    gap: 10
  },
  profilePasswordNotice: {
    marginTop: 18,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#eaded9',
    backgroundColor: '#fbf7f6',
    paddingHorizontal: 13,
    paddingVertical: 12,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 9
  },
  profilePasswordNoticeText: {
    ...typography.caption,
    flex: 1,
    color: '#5d5754',
    fontSize: 12,
    lineHeight: 17,
    fontWeight: '700'
  },
  profilePasswordPrimaryButton: {
    flex: 0,
    marginTop: 18,
    width: '100%'
  },
  profileEditCancelButton: {
    flex: 1,
    height: 46,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#ded3ce',
    alignItems: 'center',
    justifyContent: 'center'
  },
  profileEditCancelText: {
    ...typography.caption,
    color: '#5d5754',
    fontSize: 13,
    fontWeight: '700'
  },
  profileEditSaveButton: {
    flex: 1,
    height: 46,
    borderRadius: 8,
    backgroundColor: '#050505',
    alignItems: 'center',
    justifyContent: 'center'
  },
  profileEditSaveText: {
    ...typography.caption,
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '700'
  },
  profileCreditsCard: {
    marginHorizontal: 18,
    marginTop: 4,
    paddingHorizontal: 18,
    paddingTop: 18,
    paddingBottom: 18,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e5dcd9',
    backgroundColor: '#fbf7f6',
    shadowColor: '#000000',
    shadowOpacity: 0.03,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 8 },
    elevation: 1
  },
  profileCreditsHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between'
  },
  profileCreditsLabel: {
    ...typography.caption,
    color: '#747071',
    fontSize: 12,
    fontWeight: '700'
  },
  profileCreditsAmountRow: {
    marginTop: 14,
    flexDirection: 'row',
    alignItems: 'flex-end'
  },
  profileCreditsAmount: {
    ...typography.h3,
    color: '#2b2321',
    fontSize: 22,
    lineHeight: 28
  },
  profileCreditsTotal: {
    ...typography.caption,
    paddingBottom: 3,
    color: '#5d5754',
    fontSize: 12,
    fontWeight: '700'
  },
  profileCreditTrack: {
    marginTop: 16,
    height: 5,
    borderRadius: 3,
    overflow: 'hidden',
    backgroundColor: '#e9e3e1'
  },
  profileCreditFill: {
    height: '100%',
    borderRadius: 3,
    backgroundColor: '#9b5658'
  },
  profileBuyButton: {
    marginTop: 22,
    height: 40,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#9b5658',
    alignItems: 'center',
    justifyContent: 'center'
  },
  profileBuyText: {
    ...typography.caption,
    color: '#9b5658',
    fontSize: 14,
    letterSpacing: 0,
    fontWeight: '700'
  },
  profileCreditHistory: {
    marginTop: 22,
    paddingTop: 16,
    borderTopWidth: 1,
    borderTopColor: '#eaded9'
  },
  profileCreditHistoryHead: {
    minHeight: 24,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between'
  },
  profileCreditHeadSkeleton: {
    width: 54,
    height: 12,
    borderRadius: 6
  },
  profileCreditHistoryTitle: {
    ...typography.productTitle,
    color: '#2b2321',
    fontSize: 15,
    lineHeight: 20,
    fontWeight: '700'
  },
  profileCreditHistoryAction: {
    minHeight: 26,
    borderRadius: 13,
    borderWidth: 1,
    borderColor: '#eaded9',
    backgroundColor: '#fffdfb',
    paddingHorizontal: 10,
    alignItems: 'center',
    justifyContent: 'center'
  },
  profileCreditHistoryActionText: {
    ...typography.caption,
    color: '#9b5658',
    fontSize: 11,
    lineHeight: 14,
    fontWeight: '800'
  },
  profileCreditHistoryHeaderRow: {
    marginTop: 12,
    minHeight: 26,
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: '#efe4df'
  },
  profileCreditHistoryRow: {
    minHeight: 36,
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: '#f3e9e5'
  },
  profileCreditColumnLabel: {
    ...typography.caption,
    color: '#8a817d',
    fontSize: 10,
    lineHeight: 14,
    fontWeight: '700',
    textTransform: 'uppercase'
  },
  profileCreditCell: {
    ...typography.caption,
    color: '#5d5754',
    fontSize: 11,
    lineHeight: 15,
    fontWeight: '700',
    paddingRight: 6
  },
  profileCreditActionColumn: {
    flex: 1.05
  },
  profileCreditProductColumn: {
    flex: 1.25
  },
  profileCreditDateColumn: {
    width: 72
  },
  profileCreditTokenColumn: {
    width: 48,
    textAlign: 'right'
  },
  profileCreditTokenText: {
    color: '#9b5658',
    fontWeight: '700'
  },
  profileCreditAddedText: {
    color: '#0f766e',
    fontWeight: '700'
  },
  profileCreditSkeletonCell: {
    height: 10,
    borderRadius: 5,
    backgroundColor: '#efe6e1'
  },
  profileCreditEmptyText: {
    ...typography.caption,
    marginTop: 12,
    color: '#77716f',
    fontSize: 12,
    lineHeight: 18,
    fontWeight: '700'
  },
  profileSection: {
    marginTop: 36,
    paddingHorizontal: 18
  },
  profileSectionHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between'
  },
  profileSectionTitle: {
    ...typography.h2,
    color: '#2b2321',
    fontSize: 22,
    lineHeight: 28,
    fontWeight: '600'
  },
  profilePhotoCount: {
    ...typography.caption,
    color: '#5d5754',
    fontSize: 12,
    fontWeight: '700'
  },
  profilePortraitPanel: {
    marginTop: 18,
    flexDirection: 'row',
    gap: 12
  },
  profilePortraitFeatured: {
    width: 122,
    height: 172,
    borderRadius: 10,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#eaded9',
    backgroundColor: '#eee8e3'
  },
  profilePortraitFeaturedImage: {
    width: '100%',
    height: '100%'
  },
  profilePortraitBadge: {
    position: 'absolute',
    left: 8,
    right: 8,
    bottom: 8,
    borderRadius: 8,
    backgroundColor: 'rgba(255, 253, 251, 0.9)',
    paddingHorizontal: 8,
    paddingVertical: 6
  },
  profilePortraitBadgeText: {
    ...typography.caption,
    color: '#2b2321',
    textAlign: 'center',
    fontSize: 10,
    lineHeight: 13,
    fontWeight: '800',
    textTransform: 'uppercase'
  },
  profilePortraitEmpty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
    backgroundColor: '#f2ece9'
  },
  profilePortraitEmptyText: {
    ...typography.caption,
    marginTop: 8,
    color: '#77716f',
    textAlign: 'center',
    fontSize: 11,
    lineHeight: 15,
    fontWeight: '700'
  },
  profileUploadPortraitLarge: {
    flex: 1,
    minWidth: 0,
    height: 172,
    borderRadius: 10,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderColor: '#c6c4c2',
    backgroundColor: '#fffdfb',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 16
  },
  profileUploadPortraitIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: '#f5efec',
    alignItems: 'center',
    justifyContent: 'center'
  },
  profileUploadPortraitText: {
    ...typography.caption,
    color: '#77716f',
    textAlign: 'center',
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '800'
  },
  profileUploadPortraitHelp: {
    ...typography.caption,
    color: '#8d8682',
    textAlign: 'center',
    fontSize: 11,
    lineHeight: 16,
    fontWeight: '600'
  },
  profileSavePhotoButton: {
    marginTop: 14,
    height: 42,
    borderRadius: 8,
    backgroundColor: '#050505',
    alignItems: 'center',
    justifyContent: 'center'
  },
  profileSavePhotoText: {
    ...typography.caption,
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '700'
  },
  profileInlineMessage: {
    ...typography.caption,
    marginTop: 12,
    color: '#5d5754',
    fontSize: 12,
    lineHeight: 18
  },
  profileQuickOptions: {
    marginTop: 34,
    marginHorizontal: 18,
    gap: 12
  },
  profileQuickCard: {
    minHeight: 72,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e5dcd9',
    backgroundColor: '#fffdfc',
    paddingHorizontal: 18,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14
  },
  profileQuickIcon: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: '#f4eeee',
    alignItems: 'center',
    justifyContent: 'center'
  },
  profileQuickCopy: {
    flex: 1
  },
  profileQuickTitle: {
    ...typography.productTitle,
    color: '#2b2321',
    fontSize: 15,
    fontWeight: '700'
  },
  profileQuickSub: {
    ...typography.caption,
    marginTop: 4,
    color: '#77716f',
    fontSize: 12,
    fontWeight: '600'
  },
  profilePaymentCard: {
    marginTop: 24,
    minHeight: 82,
    borderRadius: 8,
    backgroundColor: '#f0eaea',
    paddingHorizontal: 22,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 18
  },
  profileVisaBadge: {
    width: 45,
    height: 27,
    borderRadius: 4,
    backgroundColor: '#111111',
    alignItems: 'center',
    justifyContent: 'center'
  },
  profileVisaText: {
    ...typography.caption,
    color: '#ffffff',
    fontSize: 9,
    fontWeight: '700'
  },
  profilePaymentCopy: {
    flex: 1
  },
  profilePaymentTitle: {
    ...typography.productTitle,
    color: '#2b2321',
    fontSize: 15,
    fontWeight: '700'
  },
  profilePaymentSub: {
    ...typography.caption,
    marginTop: 4,
    color: '#5d5754',
    fontSize: 12,
    fontWeight: '600'
  },
  profileSettingsList: {
    marginTop: 24
  },
  profileSettingsRow: {
    minHeight: 77,
    borderBottomWidth: 1,
    borderBottomColor: '#e9e1de',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between'
  },
  profileSettingsCopy: {
    flex: 1,
    paddingRight: 20
  },
  profileSettingsLabel: {
    ...typography.smallBody,
    color: '#5d5754',
    fontSize: 14,
    fontWeight: '700'
  },
  profileSettingsValue: {
    ...typography.smallBody,
    marginTop: 4,
    color: '#3f3937',
    fontSize: 14,
    fontWeight: '700'
  },
  profileLogoutButton: {
    marginTop: 58,
    marginHorizontal: 35,
    height: 47,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#efc8ca',
    backgroundColor: '#fff0f0',
    alignItems: 'center',
    justifyContent: 'center'
  },
  profileLogoutText: {
    ...typography.caption,
    color: '#c85664',
    fontSize: 13,
    letterSpacing: 0,
    fontWeight: '700'
  },
  profileDeleteButton: {
    marginTop: 12,
    marginHorizontal: 35,
    height: 47,
    borderRadius: 8,
    backgroundColor: '#b91c1c',
    alignItems: 'center',
    justifyContent: 'center'
  },
  profileDeleteText: {
    ...typography.caption,
    color: '#ffffff',
    fontSize: 13,
    letterSpacing: 0,
    fontWeight: '700'
  },
  wishlistScreen: {
    flex: 1,
    backgroundColor: '#fbf7f6'
  },
  wishlistContent: {
    paddingBottom: screenBottomInset
  },
  wishlistTopBar: {
    height: 58,
    paddingHorizontal: 34,
    borderBottomWidth: 1,
    borderBottomColor: '#ebe3e1',
    backgroundColor: '#fbf7f6',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between'
  },
  wishlistTopIcon: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center'
  },
  wishlistBrand: {
    ...typography.h3,
    position: 'absolute',
    left: 0,
    right: 0,
    textAlign: 'center',
    fontSize: 22,
    color: '#2b2321'
  },
  wishlistTopActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12
  },
  wishlistBody: {
    paddingHorizontal: 35,
    paddingTop: 31
  },
  wishlistTitle: {
    ...typography.h1,
    color: '#2b2321',
    fontSize: 26,
    lineHeight: 32,
    fontWeight: '700'
  },
  wishlistCount: {
    ...typography.body,
    color: '#77716f',
    fontSize: 15
  },
  wishlistActionRow: {
    marginTop: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10
  },
  wishlistCreateButton: {
    minHeight: 31,
    borderRadius: 16,
    backgroundColor: '#050505',
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6
  },
  wishlistCreateText: {
    ...typography.caption,
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '700'
  },
  wishlistShareButton: {
    minHeight: 31,
    borderRadius: 16,
    backgroundColor: '#eee9e7',
    paddingHorizontal: 15,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7
  },
  wishlistShareText: {
    ...typography.caption,
    color: '#111111',
    fontSize: 12,
    fontWeight: '700'
  },
  wishlistTabs: {
    paddingTop: 42,
    gap: 28
  },
  wishlistTab: {
    minHeight: 22,
    justifyContent: 'center'
  },
  wishlistTabText: {
    ...typography.smallBody,
    color: '#4b4644',
    fontSize: 14,
    fontWeight: '700',
    letterSpacing: 0
  },
  wishlistTabTextActive: {
    color: '#111111'
  },
  wishlistSortRow: {
    marginTop: 27,
    paddingBottom: 28,
    borderTopWidth: 1,
    borderTopColor: '#eee7e4',
    paddingTop: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between'
  },
  wishlistSortText: {
    ...typography.caption,
    color: '#77716f',
    fontSize: 12,
    fontWeight: '700'
  },
  wishlistSortStrong: {
    color: '#3f3937'
  },
  wishlistViewToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12
  },
  wishlistGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    rowGap: 30
  },
  wishlistProductCard: {
    width: '47%'
  },
  wishlistProductImageWrap: {
    width: '100%',
    aspectRatio: productImageAspectRatio,
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: '#eee8e3'
  },
  wishlistProductImage: {
    width: '100%',
    height: '100%'
  },
  wishlistHeartButton: {
    position: 'absolute',
    top: 10,
    right: 10,
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: '#ffffff',
    alignItems: 'center',
    justifyContent: 'center'
  },
  wishlistProductBrand: {
    ...typography.caption,
    marginTop: 12,
    color: '#4b4644',
    fontSize: 12,
    letterSpacing: 0,
    fontWeight: '700'
  },
  wishlistProductName: {
    ...typography.smallBody,
    marginTop: 4,
    minHeight: 35,
    color: '#1e1a19',
    fontSize: 14,
    lineHeight: 17,
    fontWeight: '500'
  },
  wishlistProductPrice: {
    ...typography.price,
    marginTop: 4,
    color: '#050505',
    fontSize: 15,
    fontWeight: '700'
  },
  wishlistSizeRow: {
    marginTop: 10,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 7
  },
  wishlistSizeChip: {
    ...typography.caption,
    minWidth: 24,
    height: 22,
    borderRadius: 6,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#d9d2ce',
    color: '#4b4644',
    textAlign: 'center',
    paddingTop: 4,
    fontSize: 10,
    fontWeight: '700'
  },
  wishlistSizeChipActive: {
    backgroundColor: '#050505',
    borderColor: '#050505',
    color: '#ffffff'
  },
  wishlistMoveButton: {
    marginTop: 12,
    height: 31,
    borderRadius: 7,
    backgroundColor: '#050505',
    alignItems: 'center',
    justifyContent: 'center'
  },
  wishlistMoveText: {
    ...typography.caption,
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '700'
  },
  wishlistProCard: {
    marginTop: 60,
    paddingHorizontal: 23,
    paddingTop: 25,
    paddingBottom: 22,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#ff9d9d',
    backgroundColor: '#ffe1e1'
  },
  wishlistProBadge: {
    ...typography.caption,
    alignSelf: 'flex-start',
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: 3,
    overflow: 'hidden',
    backgroundColor: '#9b5658',
    color: '#ffffff',
    fontSize: 9,
    letterSpacing: 0,
    fontWeight: '700'
  },
  wishlistProTitle: {
    ...typography.h2,
    marginTop: 20,
    color: '#9b5658',
    fontSize: 22,
    lineHeight: 28,
    fontWeight: '600'
  },
  wishlistProText: {
    ...typography.smallBody,
    marginTop: 12,
    maxWidth: 270,
    color: '#9b5658',
    fontSize: 14,
    lineHeight: 20,
    fontWeight: '500'
  },
  wishlistUpgradeButton: {
    marginTop: 20,
    alignSelf: 'flex-start',
    height: 38,
    borderRadius: 19,
    backgroundColor: '#9b5658',
    paddingHorizontal: 24,
    alignItems: 'center',
    justifyContent: 'center'
  },
  wishlistUpgradeText: {
    ...typography.caption,
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '700'
  },
  wishlistSectionTitle: {
    ...typography.h2,
    marginTop: 66,
    color: '#2b2321',
    fontSize: 22,
    lineHeight: 28,
    fontWeight: '600'
  },
  wishlistRecommendedTrack: {
    paddingTop: 25,
    gap: 16,
    paddingRight: 34
  },
  wishlistRecommendedCard: {
    width: 150
  },
  wishlistRecommendedImage: {
    width: '100%',
    aspectRatio: productImageAspectRatio,
    borderRadius: 8,
    backgroundColor: '#eee8e3'
  },
  wishlistRecommendedSkeletonLine: {
    marginTop: 10
  },
  wishlistRecommendedBrand: {
    marginTop: 12,
    color: '#4b4644',
    fontSize: 11,
    letterSpacing: 0,
    fontWeight: '700'
  },
  wishlistRecommendedPrice: {
    marginTop: 3,
    color: '#050505',
    fontSize: 14,
    fontWeight: '700'
  },
  ordersScreen: {
    flex: 1,
    backgroundColor: '#fbf7f6'
  },
  ordersContent: {
    paddingBottom: screenBottomInset
  },
  ordersBody: {
    paddingHorizontal: 35,
    paddingTop: 32,
    gap: 16
  },
  ordersEmptyCard: {
    marginTop: 8,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e5dcd9',
    backgroundColor: '#fffdfc',
    paddingHorizontal: 22,
    paddingVertical: 26,
    alignItems: 'center',
    shadowColor: '#2a211d',
    shadowOpacity: 0.05,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
    elevation: 2
  },
  ordersEmptyIcon: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: '#f8eeee',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 14
  },
  ordersEmptyTitle: {
    ...typography.h3,
    color: '#211c1a',
    textAlign: 'center'
  },
  ordersEmptyText: {
    ...typography.body,
    marginTop: 8,
    color: '#6f6864',
    textAlign: 'center'
  },
  ordersStartButton: {
    marginTop: 20,
    minHeight: 42,
    borderRadius: 21,
    backgroundColor: '#050505',
    paddingHorizontal: 24,
    alignItems: 'center',
    justifyContent: 'center'
  },
  ordersStartText: {
    ...typography.button,
    color: '#ffffff'
  },
  ordersPopularSection: {
    marginTop: 30
  },
  ordersPopularTitle: {
    ...typography.h3,
    color: '#211c1a',
    marginBottom: 16
  },
  ordersPopularGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    rowGap: 22
  },
  ordersPopularCard: {
    width: '47%'
  },
  ordersPopularImage: {
    width: '100%',
    aspectRatio: productImageAspectRatio,
    borderRadius: 9,
    overflow: 'hidden',
    backgroundColor: '#eee8e3'
  },
  ordersPopularBrand: {
    ...typography.caption,
    marginTop: 10,
    color: '#8d8682',
    fontWeight: '700'
  },
  ordersPopularName: {
    ...typography.smallBody,
    marginTop: 4,
    color: '#211c1a',
    fontWeight: '600'
  },
  ordersPopularPrice: {
    ...typography.price,
    marginTop: 6,
    color: '#111111',
    fontSize: 15,
    lineHeight: 20
  },
  ordersPopularSkeletonLine: {
    marginTop: 10,
    width: '86%',
    height: 12,
    borderRadius: 6
  },
  ordersPopularSkeletonShort: {
    marginTop: 8,
    width: '54%',
    height: 12,
    borderRadius: 6
  },
  ordersPopularEmpty: {
    ...typography.caption,
    color: '#77716f'
  },
  orderCard: {
    minHeight: 86,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e5dcd9',
    backgroundColor: '#fffdfc',
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14
  },
  orderIconBox: {
    width: 45,
    height: 45,
    borderRadius: 8,
    backgroundColor: '#f4eeee',
    alignItems: 'center',
    justifyContent: 'center'
  },
  orderCopy: {
    flex: 1
  },
  orderName: {
    color: '#2b2321',
    fontSize: 15,
    fontWeight: '700'
  },
  orderMeta: {
    marginTop: 5,
    color: '#77716f',
    fontSize: 12,
    fontWeight: '600'
  },
  orderPrice: {
    color: '#111111',
    fontSize: 13,
    fontWeight: '700'
  },
  fullBodyPreviewCard: {
    marginHorizontal: 16,
    marginTop: 14,
    padding: 16,
    borderRadius: 8,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e5e7eb',
    gap: 12
  },
  fullBodyPreviewTitle: {
    marginTop: 4,
    color: '#111827',
    fontSize: 22,
    lineHeight: 26,
    fontWeight: '700',
    letterSpacing: 0
  },
  previewIconButton: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e5e7eb',
    alignItems: 'center',
    justifyContent: 'center'
  },
  fullBodyPreviewFrame: {
    height: 360,
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: '#f5efe7',
    borderWidth: 1,
    borderColor: '#e7d7c6',
    alignItems: 'center',
    justifyContent: 'center'
  },
  fullBodyPreviewImage: {
    width: '100%',
    height: '100%'
  },
  profileActions: {
    margin: 16,
    gap: 10
  },
  profileDetailsInline: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8
  },
  statPill: {
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 999,
    overflow: 'hidden',
    backgroundColor: '#ecfdf5',
    color: '#0f766e',
    fontSize: 12,
    fontWeight: '700'
  },
  latestOutfitCard: {
    marginHorizontal: 16,
    marginBottom: 12,
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e5e7eb'
  },
  latestOutfitImage: {
    width: '100%',
    height: 320
  },
  latestOutfitCopy: {
    padding: 14,
    gap: 5
  },
  latestOutfitTitle: {
    color: '#111827',
    fontSize: 21,
    lineHeight: 25,
    fontWeight: '700'
  },
  closetPanel: {
    marginHorizontal: 16,
    marginBottom: 12,
    padding: 14,
    borderRadius: 8,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e5e7eb',
    gap: 10
  },
  closetEmptyWrap: {
    marginHorizontal: 16,
    marginBottom: 14
  },
  panelHeaderRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12
  },
  smallOutlineButton: {
    minHeight: 38,
    paddingHorizontal: 12,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#d1d5db',
    backgroundColor: '#fff',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6
  },
  smallOutlineText: {
    color: '#0f766e',
    fontSize: 12,
    fontWeight: '700'
  },
  stylistBoard: {
    gap: 12
  },
  wardrobeRail: {
    gap: 10,
    paddingRight: 12
  },
  wardrobeRailItem: {
    width: 112,
    padding: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    backgroundColor: '#f8fafc',
    alignItems: 'center',
    gap: 6
  },
  wardrobeRailItemActive: {
    borderColor: '#0f766e',
    backgroundColor: '#ecfdf5'
  },
  wardrobeRailItemSelected: {
    borderColor: '#14b8a6'
  },
  railThumb: {
    width: 58,
    height: 58,
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e5e7eb',
    alignItems: 'center',
    justifyContent: 'center'
  },
  railThumbImage: {
    width: '100%',
    height: '100%'
  },
  railThumbText: {
    color: '#64748b',
    fontSize: 13,
    fontWeight: '700'
  },
  railLabel: {
    color: '#111827',
    fontSize: 12,
    fontWeight: '700'
  },
  railMeta: {
    maxWidth: 92,
    color: '#64748b',
    fontSize: 10,
    fontWeight: '700',
    textAlign: 'center'
  },
  stylistPreviewFrame: {
    height: 360,
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: '#f1f5f9',
    borderWidth: 1,
    borderColor: '#e5e7eb'
  },
  stylistPreviewImage: {
    width: '100%',
    height: '100%'
  },
  previewGenerating: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    backgroundColor: 'rgba(17, 24, 39, 0.45)',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8
  },
  previewGeneratingText: {
    color: '#fff',
    fontWeight: '700'
  },
  lookbookRail: {
    gap: 8
  },
  lookbookCard: {
    width: 112,
    height: 140,
    borderRadius: 8,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#e5e7eb',
    backgroundColor: '#f8fafc',
    alignItems: 'center',
    justifyContent: 'center'
  },
  lookbookImage: {
    width: '100%',
    height: '100%'
  },
  lookbookEmpty: {
    color: '#64748b',
    fontSize: 12,
    fontWeight: '700'
  },
  lookbookThumbs: {
    position: 'absolute',
    left: 6,
    right: 6,
    bottom: 6,
    flexDirection: 'row',
    gap: 4
  },
  lookbookThumb: {
    width: 20,
    height: 20,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: '#fff'
  },
  emptyActionBox: {
    minHeight: 92,
    borderRadius: 8,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: '#cbd5e1',
    backgroundColor: '#f8fafc',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6
  },
  emptyActionText: {
    color: '#0f766e',
    fontWeight: '700'
  },
  stylistConsoleActions: {
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: '#e5e7eb',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10
  },
  actionMetric: {
    color: '#111827',
    fontSize: 22,
    fontWeight: '700'
  },
  actionMetricLabel: {
    color: '#64748b',
    fontSize: 10,
    fontWeight: '700'
  },
  generateMiniButton: {
    minHeight: 44,
    paddingHorizontal: 14,
    borderRadius: 999,
    backgroundColor: '#0f766e',
    alignItems: 'center',
    justifyContent: 'center'
  },
  generateMiniText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '700'
  },
  actionCardList: {
    gap: 10
  },
  closetActionCard: {
    padding: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderTopWidth: 4,
    borderColor: '#e5e7eb',
    backgroundColor: '#fff',
    gap: 9
  },
  closetActionTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center'
  },
  actionStep: {
    width: 34,
    height: 34,
    borderRadius: 17,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#e5e7eb',
    color: '#0f5132',
    fontSize: 12,
    fontWeight: '700',
    textAlign: 'center',
    lineHeight: 32
  },
  actionMeta: {
    color: '#64748b',
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase'
  },
  actionPreview: {
    height: 116,
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: '#f3f4f6',
    borderWidth: 1,
    borderColor: '#e5e7eb',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center'
  },
  actionPreviewImage: {
    flex: 1,
    height: '100%'
  },
  actionLink: {
    fontWeight: '700'
  },
  occasionChip: {
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#d1d5db',
    backgroundColor: '#fff'
  },
  occasionChipText: {
    color: '#0f5132',
    fontSize: 12,
    fontWeight: '700'
  },
  twoColumnInputs: {
    flexDirection: 'row',
    gap: 8
  },
  halfInput: {
    flex: 1,
    marginBottom: 0
  },
  comboSlotGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8
  },
  comboSlot: {
    width: '48%',
    minHeight: 72,
    padding: 10,
    borderRadius: 8,
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    justifyContent: 'center'
  },
  comboSlotActive: {
    borderColor: '#0f766e',
    backgroundColor: '#ecfdf5'
  },
  comboSlotLabel: {
    color: '#64748b',
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase'
  },
  comboSlotValue: {
    marginTop: 5,
    color: '#111827',
    fontSize: 13,
    lineHeight: 17,
    fontWeight: '700'
  },
  slotOptions: {
    gap: 10
  },
  slotOptionCard: {
    width: 118,
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e5e7eb'
  },
  slotOptionActive: {
    borderColor: '#0f766e',
    backgroundColor: '#ecfdf5'
  },
  slotOptionImage: {
    width: '100%',
    height: 112,
    backgroundColor: '#e5e7eb'
  },
  slotOptionName: {
    padding: 8,
    minHeight: 48,
    color: '#111827',
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '700'
  },
  selectedComboStrip: {
    gap: 8
  },
  selectedChipCard: {
    minHeight: 56,
    padding: 8,
    borderRadius: 8,
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8
  },
  selectedChipImage: {
    width: 40,
    height: 40,
    borderRadius: 6,
    backgroundColor: '#e5e7eb'
  },
  selectedChipName: {
    flex: 1,
    color: '#111827',
    fontSize: 12,
    fontWeight: '700'
  },
  selectedChipAction: {
    color: '#0f766e',
    fontSize: 11,
    fontWeight: '700'
  },
  comboSuggestionList: {
    gap: 8
  },
  comboSuggestionCard: {
    padding: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    backgroundColor: '#f8fafc',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10
  },
  comboSuggestionActive: {
    borderColor: '#0f766e',
    backgroundColor: '#ecfdf5'
  },
  comboNumber: {
    width: 34,
    height: 34,
    borderRadius: 17,
    overflow: 'hidden',
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e5e7eb',
    color: '#0f5132',
    fontSize: 12,
    fontWeight: '700',
    textAlign: 'center',
    lineHeight: 32
  },
  comboThumbs: {
    width: 72,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 3
  },
  comboThumb: {
    width: 33,
    height: 33,
    borderRadius: 6,
    backgroundColor: '#e5e7eb'
  },
  comboSuggestionCopy: {
    flex: 1
  },
  suggestionRow: {
    gap: 10,
    paddingRight: 12
  },
  suggestionCard: {
    width: 220,
    padding: 12,
    borderRadius: 8,
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    gap: 5
  },
  suggestionTitle: {
    color: '#111827',
    fontWeight: '700'
  },
  suggestionCopy: {
    color: '#64748b',
    fontSize: 12,
    lineHeight: 17,
    fontWeight: '700'
  },
  chatTranscript: {
    maxHeight: 220,
    padding: 10,
    borderRadius: 8,
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e5e7eb',
    gap: 8
  },
  chatBubble: {
    maxWidth: '88%',
    alignSelf: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e5e7eb'
  },
  chatBubbleUser: {
    alignSelf: 'flex-end',
    backgroundColor: '#111827',
    borderColor: '#111827'
  },
  chatBubbleText: {
    color: '#334155',
    fontSize: 12,
    lineHeight: 17,
    fontWeight: '700'
  },
  chatBubbleUserText: {
    color: '#fff'
  },
  closetGrid: {
    paddingHorizontal: 16,
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    rowGap: 14
  },
  closetItemCard: {
    width: '47.5%',
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e5e7eb'
  },
  closetItemSelected: {
    borderColor: '#0f766e',
    backgroundColor: '#ecfdf5'
  },
  closetItemImage: {
    width: '100%',
    aspectRatio: productImageAspectRatio,
    backgroundColor: '#f0ece8'
  },
  closetItemBody: {
    padding: 10,
    gap: 5
  },
  closetItemActions: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8
  },
  selectText: {
    color: '#64748b',
    fontSize: 11,
    fontWeight: '700'
  },
  selectTextActive: {
    color: '#0f766e'
  },
  closetMessage: {
    marginHorizontal: 16,
    marginTop: 10
  },
  looksList: {
    marginBottom: 12
  },
  infoGrid: {
    paddingHorizontal: 16,
    gap: 10
  },
  infoCard: {
    padding: 14,
    borderRadius: 8,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e5e7eb'
  },
  infoTitle: {
    color: '#111827',
    fontSize: 17,
    fontWeight: '700',
    marginBottom: 4
  },
  policyGrid: {
    paddingHorizontal: 16,
    gap: 10
  },
  policyCard: {
    padding: 16,
    borderRadius: 8,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e5e7eb'
  },
  policyUpdated: {
    ...typography.caption,
    color: '#8f4f52',
    fontSize: 12,
    fontWeight: '700'
  },
  policySectionTitle: {
    ...typography.h4,
    marginBottom: 8,
    color: '#111827',
    fontSize: 17,
    lineHeight: 23
  },
  policyText: {
    ...typography.smallBody,
    color: '#4b5563',
    fontSize: 14,
    lineHeight: 22,
    marginTop: 6
  },
  policyEmail: {
    color: '#8f4f52',
    fontWeight: '700',
    textDecorationLine: 'underline'
  },
  policyRelated: {
    padding: 16,
    borderRadius: 8,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e5e7eb'
  },
  policyRelatedTitle: {
    ...typography.label,
    color: '#8f4f52',
    textTransform: 'uppercase',
    marginBottom: 8
  },
  policyRelatedRow: {
    minHeight: 44,
    borderTopWidth: 1,
    borderTopColor: '#f1ece9',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12
  },
  policyRelatedText: {
    ...typography.smallBody,
    flex: 1,
    color: '#2b2321',
    fontSize: 14,
    fontWeight: '700'
  },
  stepCard: {
    marginHorizontal: 16,
    marginBottom: 10,
    padding: 16,
    borderRadius: 8,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e5e7eb'
  },
  stepNumber: {
    color: '#0f766e',
    fontSize: 26,
    fontWeight: '700'
  },
  stepTitle: {
    color: '#111827',
    fontWeight: '700',
    fontSize: 19,
    marginTop: 4,
    marginBottom: 6
  },
  pageHero: {
    margin: 16,
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e5e7eb'
  },
  pageImage: {
    width: '100%',
    height: 250
  },
  pageCopy: {
    padding: 16,
    gap: 10
  },
  notFoundContent: {
    flexGrow: 1,
    paddingHorizontal: 24,
    paddingTop: 92,
    paddingBottom: screenBottomInset + 100,
    backgroundColor: '#fbf7f6',
    alignItems: 'center'
  },
  notFoundMark: {
    width: '100%',
    minHeight: 162,
    alignItems: 'center',
    justifyContent: 'center'
  },
  notFoundCode: {
    ...typography.display,
    color: '#eadfdb',
    fontSize: 94,
    lineHeight: 104
  },
  notFoundIcon: {
    position: 'absolute',
    width: 62,
    height: 62,
    borderRadius: 31,
    borderWidth: 1,
    borderColor: '#e4d6d1',
    backgroundColor: '#fffdfb',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#2a211d',
    shadowOpacity: 0.08,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
    elevation: 2
  },
  notFoundTitle: {
    ...typography.h1,
    marginTop: 10,
    color: '#211c1a',
    textAlign: 'center'
  },
  notFoundText: {
    ...typography.body,
    marginTop: 10,
    maxWidth: 320,
    color: '#706762',
    textAlign: 'center',
    fontWeight: '500'
  },
  notFoundActions: {
    width: '100%',
    marginTop: 28,
    gap: 12
  },
  notFoundButton: {
    width: '100%'
  },
  notFoundShopLink: {
    marginTop: 22,
    minHeight: 42,
    paddingHorizontal: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8
  },
  notFoundShopText: {
    ...typography.button,
    color: '#9b5658',
    fontSize: 14
  },
  tryOnLoading: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(17, 24, 39, 0.72)',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingHorizontal: 22
  },
  tryOnLoadingLarge: {
    position: 'absolute'
  },
  tryOnLoadingPill: {
    minHeight: 34,
    maxWidth: '84%',
    borderRadius: 17,
    borderWidth: 1,
    borderColor: '#eaded9',
    backgroundColor: 'rgba(255, 253, 251, 0.94)',
    paddingHorizontal: 12,
    paddingVertical: 7,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    shadowColor: '#2a211d',
    shadowOpacity: 0.1,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 3
  },
  tryOnLoadingPillLarge: {
    minHeight: 38,
    borderRadius: 19,
    paddingHorizontal: 15
  },
  tryOnLoadingText: {
    color: '#fff',
    fontWeight: '700',
    textAlign: 'center'
  },
  tryOnProgressMark: {
    flexDirection: 'row',
    gap: 6
  },
  tryOnProgressDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: '#ffffff'
  },
  tryOnProgressDotMuted: {
    opacity: 0.48
  },
  tryOnProgressTrack: {
    width: '58%',
    maxWidth: 120,
    height: 4,
    borderRadius: 2,
    overflow: 'hidden',
    backgroundColor: 'rgba(255, 255, 255, 0.28)'
  },
  tryOnProgressFill: {
    width: '62%',
    height: '100%',
    borderRadius: 2,
    backgroundColor: '#ffffff'
  },
  tourOverlay: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
    paddingVertical: 24
  },
  tourBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(17, 17, 17, 0.56)'
  },
  tourDimPiece: {
    position: 'absolute',
    backgroundColor: 'rgba(17, 17, 17, 0.62)'
  },
  tourSpotlight: {
    position: 'absolute',
    borderRadius: 12,
    borderWidth: 2,
    borderColor: '#fffdfb',
    backgroundColor: 'rgba(255, 253, 251, 0.08)',
    shadowColor: '#ffffff',
    shadowOpacity: 0.32,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 0 },
    elevation: 9
  },
  tourCard: {
    width: '100%',
    maxWidth: 344,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#eaded9',
    backgroundColor: '#fffdfb',
    paddingHorizontal: 18,
    paddingTop: 18,
    paddingBottom: 14,
    shadowColor: '#111111',
    shadowOpacity: 0.18,
    shadowRadius: 26,
    shadowOffset: { width: 0, height: 14 },
    elevation: 8
  },
  tourCardAnchored: {
    position: 'absolute',
    alignSelf: 'center'
  },
  tourIntroCard: {
    alignItems: 'center'
  },
  tourCloseButton: {
    position: 'absolute',
    top: 12,
    right: 12,
    zIndex: 2,
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#eaded9',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#fffdfb'
  },
  tourIcon: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: '#fff5f3',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 10
  },
  tourEyebrow: {
    ...typography.label,
    color: '#9b5658',
    fontSize: 11,
    lineHeight: 15,
    fontWeight: '700'
  },
  tourTitle: {
    ...typography.h3,
    marginTop: 6,
    color: '#2b2321',
    textAlign: 'center'
  },
  tourText: {
    ...typography.smallBody,
    marginTop: 7,
    color: '#5d5754',
    textAlign: 'center',
    fontWeight: '500'
  },
  tourHintRow: {
    marginTop: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#eaded9',
    backgroundColor: '#fbf7f6',
    paddingHorizontal: 12,
    paddingVertical: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8
  },
  tourHintText: {
    ...typography.caption,
    flex: 1,
    color: '#6d625e',
    fontWeight: '600'
  },
  tourDots: {
    marginTop: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7
  },
  tourDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: '#eaded9'
  },
  tourDotActive: {
    width: 18,
    backgroundColor: '#9b5658'
  },
  tourActions: {
    marginTop: 14,
    flexDirection: 'row',
    gap: 10
  },
  tourPrimaryButton: {
    flex: 1,
    minHeight: 44,
    borderRadius: 8,
    backgroundColor: '#111111',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 14
  },
  tourPrimaryButtonFull: {
    flex: 0,
    alignSelf: 'stretch'
  },
  tourPrimaryText: {
    ...typography.button,
    color: '#ffffff'
  },
  tourSecondaryButton: {
    minWidth: 96,
    minHeight: 44,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#d8c7c2',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#fffdfb',
    paddingHorizontal: 14
  },
  tourSecondaryText: {
    ...typography.button,
    color: '#5d5754'
  },
  tourSkipButton: {
    marginTop: 8,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 32
  },
  tourSkipText: {
    ...typography.caption,
    color: '#77716f',
    fontWeight: '700'
  },
  authPromptBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(17, 17, 17, 0.46)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20
  },
  authPromptSheet: {
    width: '100%',
    maxWidth: 372,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#eaded9',
    backgroundColor: '#fffdfb',
    paddingHorizontal: 18,
    paddingTop: 18,
    paddingBottom: 17,
    alignItems: 'center',
    shadowColor: '#111111',
    shadowOpacity: 0.22,
    shadowRadius: 30,
    shadowOffset: { width: 0, height: 18 },
    elevation: 10
  },
  authPromptBrand: {
    alignSelf: 'flex-start',
    marginBottom: 16
  },
  authPromptBrandSymbol: {
    width: 26,
    height: 26
  },
  authPromptBrandDivider: {
    height: 22,
    backgroundColor: '#d4cbc5'
  },
  authPromptBrandText: {
    fontSize: 22,
    lineHeight: 27
  },
  authPromptIcon: {
    width: 54,
    height: 54,
    borderRadius: 27,
    backgroundColor: '#fff5f3',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 13
  },
  authPromptTitle: {
    color: '#2b2321',
    fontSize: 21,
    lineHeight: 27,
    fontWeight: '800'
  },
  authPromptText: {
    marginTop: 7,
    color: '#5d5754',
    textAlign: 'center',
    fontSize: 14,
    lineHeight: 21,
    fontWeight: '700',
    paddingHorizontal: 5
  },
  authPromptChipRow: {
    marginTop: 15,
    flexDirection: 'row',
    gap: 8
  },
  authPromptChip: {
    minHeight: 32,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#eee3dc',
    backgroundColor: '#fbf7f6',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10
  },
  authPromptChipText: {
    ...typography.caption,
    color: '#2b2321',
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '800'
  },
  authPromptPrimary: {
    marginTop: 18,
    minHeight: 50,
    alignSelf: 'stretch',
    borderRadius: 8,
    backgroundColor: '#050606',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8
  },
  authPromptPrimaryText: {
    color: '#ffffff',
    fontSize: 15,
    lineHeight: 20,
    fontWeight: '800'
  },
  authPromptSecondary: {
    marginTop: 9,
    minHeight: 36,
    alignItems: 'center',
    justifyContent: 'center'
  },
  authPromptSecondaryText: {
    color: '#5d5754',
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '800'
  },
  lightbox: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.92)',
    alignItems: 'center',
    justifyContent: 'center'
  },
  lightboxImage: {
    width: '94%',
    height: '84%'
  },
  closeButton: {
    position: 'absolute',
    top: 54,
    right: 18,
    zIndex: 2,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(255, 255, 255, 0.18)',
    alignItems: 'center',
    justifyContent: 'center'
  },
});
