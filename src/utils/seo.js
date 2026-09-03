const SITE_NAME = 'Lookmefy';
const DEFAULT_DESCRIPTION = 'AI-powered fashion shopping with virtual try-on, curated products, wardrobe tools, and style recommendations.';

const routeMeta = {
  '/': ['Lookmefy - AI Fashion Try-On', 'Upload your photo, try outfits virtually, and shop with more confidence.'],
  '/home': ['Lookmefy Home - AI-Powered Fashion', 'Discover curated new arrivals, categories, and AI try-on tools.'],
  '/about': ['About Lookmefy | AI Fashion, Virtual Try-On & Personal Styling', 'Learn about Lookmefy, an AI-powered fashion platform bringing fashion discovery, virtual try-on, digital wardrobe tools and AI styling into one experience.'],
  '/categories': ['Fashion Categories - Lookmefy', 'Explore live catalog categories and discover styles by department.'],
  '/search': ['Shop Fashion - Lookmefy', 'Search products, filter the live catalog, and try selected looks with AI.'],
  '/custom-try-on': ['Custom AI Try-On - Lookmefy', 'Upload a clothing photo and generate a custom AI try-on preview.'],
  '/try-on': ['AI Try-On - Lookmefy', 'Create virtual try-on previews with your Lookmefy profile.'],
  '/closet': ['My Wardrobe - Lookmefy', 'Build outfits from your saved wardrobe and AI-generated looks.'],
  '/wishlist': ['Wishlist - Lookmefy', 'Review saved products and create your personal style shortlist.'],
  '/tokens': ['Lookmefy Credits', 'Buy secure credits for AI try-on generation.'],
  '/profile': ['My Profile - Lookmefy', 'Manage your profile photo, credits, privacy, and account preferences.'],
  '/cart': ['Cart - Lookmefy', 'Review selected products before checkout.'],
  '/privacy': ['Privacy Policy - Lookmefy', 'How Lookmefy handles profile photos, try-on results, and account data.'],
  '/terms': ['Terms and Conditions - Lookmefy', 'Lookmefy shopping, credits, AI try-on, and platform terms.'],
  '/copyright': ['Copyright Policy - Lookmefy', 'Copyright ownership, permitted use, user uploads, AI-generated media, and takedown support for Lookmefy.'],
  '/support': ['Support - Lookmefy', 'Get help with orders, payments, AI try-on, and account questions.'],
  '/contact': ['Contact Lookmefy', 'Contact Lookmefy support for shopping, payment, or AI try-on help.'],
  '/download': ['Download the Lookmefy App', 'Download Lookmefy for AI Try-On, personal styling, wardrobe management and fashion discovery on mobile.']
};

function upsertMeta(selector, attributes) {
  let node = document.head.querySelector(selector);
  if (!node) {
    node = document.createElement('meta');
    Object.entries(attributes.identity).forEach(([key, value]) => node.setAttribute(key, value));
    document.head.appendChild(node);
  }
  Object.entries(attributes.values).forEach(([key, value]) => node.setAttribute(key, value));
}

function upsertLink(rel, href) {
  let node = document.head.querySelector(`link[rel="${rel}"]`);
  if (!node) {
    node = document.createElement('link');
    node.setAttribute('rel', rel);
    document.head.appendChild(node);
  }
  node.setAttribute('href', href);
}

export function updateRouteSeo(path, search = '') {
  if (typeof document === 'undefined') return;
  const normalizedPath = path || '/';
  const [title, description] = routeMeta[normalizedPath] || routeMeta['/'];
  const canonical = `${window.location.origin}${normalizedPath}${search && normalizedPath === '/search' ? search : ''}`;
  document.title = title;
  upsertMeta('meta[name="description"]', { identity: { name: 'description' }, values: { content: description || DEFAULT_DESCRIPTION } });
  upsertMeta('meta[property="og:title"]', { identity: { property: 'og:title' }, values: { content: title } });
  upsertMeta('meta[property="og:description"]', { identity: { property: 'og:description' }, values: { content: description || DEFAULT_DESCRIPTION } });
  upsertMeta('meta[property="og:site_name"]', { identity: { property: 'og:site_name' }, values: { content: SITE_NAME } });
  upsertMeta('meta[property="og:type"]', { identity: { property: 'og:type' }, values: { content: 'website' } });
  upsertMeta('meta[name="twitter:card"]', { identity: { name: 'twitter:card' }, values: { content: 'summary_large_image' } });
  upsertLink('canonical', canonical);
}

export function updateProductSeo(product) {
  if (typeof document === 'undefined' || !product) return;
  const title = `${product.name} - Lookmefy`;
  const description = product.description || `${product.name} by ${product.brand || 'Lookmefy catalog'}. Preview supported items with AI try-on.`;
  document.title = title;
  upsertMeta('meta[name="description"]', { identity: { name: 'description' }, values: { content: description.slice(0, 160) } });
  upsertMeta('meta[property="og:title"]', { identity: { property: 'og:title' }, values: { content: title } });
  upsertMeta('meta[property="og:description"]', { identity: { property: 'og:description' }, values: { content: description.slice(0, 200) } });
  if (product.imageUrl) upsertMeta('meta[property="og:image"]', { identity: { property: 'og:image' }, values: { content: product.imageUrl } });
  upsertLink('canonical', `${window.location.origin}/product/${encodeURIComponent(product.id)}`);
}
