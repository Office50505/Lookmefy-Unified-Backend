const CART_KEY = 'fitlook_cart_items';

function normalizedItem(item = {}) {
  const id = String(item.id || item.productId || '').trim();
  if (!id) return null;
  const quantity = Math.min(10, Math.max(1, Number.parseInt(item.quantity, 10) || 1));
  return {
    id,
    productId: id,
    name: String(item.name || 'Product'),
    brand: String(item.brand || 'Marketplace brand'),
    imageUrl: item.imageUrl || '',
    price: Number(item.price) || 0,
    compareAtPrice: Number(item.compareAtPrice) || 0,
    currency: item.currency || 'INR',
    variant: item.variant || 'Standard',
    quantity,
    addedAt: item.addedAt || new Date().toISOString()
  };
}

export function readCartItems() {
  if (typeof localStorage === 'undefined') return [];
  try {
    const parsed = JSON.parse(localStorage.getItem(CART_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.map(normalizedItem).filter(Boolean) : [];
  } catch {
    return [];
  }
}

export function saveCartItems(items) {
  const normalized = items.map(normalizedItem).filter(Boolean);
  localStorage.setItem(CART_KEY, JSON.stringify(normalized));
  window.dispatchEvent(new CustomEvent('fitlook:cart-change', { detail: { items: normalized } }));
  return normalized;
}

export function addCartProduct(product, options = {}) {
  const productId = String(product?.id || '').trim();
  if (!productId) return readCartItems();
  const current = readCartItems();
  const index = current.findIndex((item) => item.productId === productId && item.variant === (options.variant || 'Standard'));
  if (index >= 0) {
    current[index] = normalizedItem({ ...current[index], quantity: current[index].quantity + 1 });
    return saveCartItems(current);
  }
  return saveCartItems([
    ...current,
    {
      id: productId,
      name: product.name,
      brand: product.brand,
      imageUrl: product.imageUrl,
      price: product.price,
      compareAtPrice: product.compareAtPrice,
      currency: product.currency || 'INR',
      variant: options.variant || 'Standard',
      quantity: 1
    }
  ]);
}

export function updateCartQuantity(productId, quantity, variant = 'Standard') {
  const next = readCartItems()
    .map((item) => item.productId === String(productId) && item.variant === variant ? normalizedItem({ ...item, quantity }) : item)
    .filter((item) => item && item.quantity > 0);
  return saveCartItems(next);
}

export function removeCartItem(productId, variant = 'Standard') {
  return saveCartItems(readCartItems().filter((item) => !(item.productId === String(productId) && item.variant === variant)));
}

export function cartItemCount(items = readCartItems()) {
  return items.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
}

export function cartSubtotal(items = readCartItems()) {
  return items.reduce((sum, item) => sum + (Number(item.price) || 0) * (Number(item.quantity) || 0), 0);
}
