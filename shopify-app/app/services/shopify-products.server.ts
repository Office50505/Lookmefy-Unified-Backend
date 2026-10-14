import {
  countEnabledProducts,
  getEligibilityMap,
  listEnabledProductIds,
} from "../models/product-eligibility.server";

export const PAGE_SIZE = 20;
const MAX_DISABLED_FETCH_PAGES = 5;
const PRODUCT_STATUS_VALUES = new Set(["active", "draft", "archived", "unlisted"]);
const MAX_ENABLED_LOOKUP = 250;
const MIN_DEV_PAGE_SIZE = 1;
const MAX_DEV_PAGE_SIZE = PAGE_SIZE;

type AdminGraphql = {
  graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response>;
};

type ProductNode = {
  id: string;
  title: string;
  handle: string;
  status: string;
  productType?: string | null;
  vendor?: string | null;
  tags?: string[];
  createdAt?: string;
  updatedAt?: string;
  featuredMedia?: {
    id: string;
    alt?: string | null;
    preview?: { image?: ProductImage | null } | null;
  } | null;
  priceRangeV2?: {
    minVariantPrice: Money;
    maxVariantPrice: Money;
  };
  variants?: {
    nodes: ProductVariant[];
  };
  media?: {
    nodes: ProductMedia[];
  };
};

export type ProductImage = {
  id?: string | null;
  url?: string | null;
  altText?: string | null;
  width?: number | null;
  height?: number | null;
};

export type ProductVariant = {
  id: string;
  title: string;
  image?: ProductImage | null;
  price?: string | null;
};

export type ProductMedia = {
  id: string;
  mediaContentType: string;
  alt?: string | null;
  preview?: { image?: ProductImage | null } | null;
};

export type Money = {
  amount: string;
  currencyCode: string;
};

export type ProductSummary = {
  id: string;
  title: string;
  handle: string;
  status: string;
  productType: string;
  vendor: string;
  tags: string[];
  image: ProductImage | null;
  priceLabel: string;
  minPrice: Money | null;
  maxPrice: Money | null;
  variantCount: number;
  variants: ProductVariant[];
  media: ProductMedia[];
  hasUsableImage: boolean;
  eligibilityEnabled: boolean;
};

type PageInfo = {
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  startCursor?: string | null;
  endCursor?: string | null;
};

export type ProductListResult = {
  products: ProductSummary[];
  pageInfo: PageInfo;
  counts: {
    total: number | null;
    totalPrecision: string | null;
    enabled: number;
    disabled: number | null;
  };
  query: string;
  filter: string;
  search: string;
  status: string;
  productType: string;
  direction: "next" | "previous";
  pageSize: number;
  error: string | null;
};

export function escapeSearchValue(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').trim();
}

export function buildProductSearchQuery({
  search,
  status,
  productType,
}: {
  search?: string | null;
  status?: string | null;
  productType?: string | null;
}) {
  const terms: string[] = [];
  const safeSearch = (search || "").trim().slice(0, 120);
  if (safeSearch) terms.push(`title:*${escapeSearchValue(safeSearch)}*`);

  const normalizedStatus = (status || "").toLowerCase();
  if (PRODUCT_STATUS_VALUES.has(normalizedStatus)) terms.push(`status:${normalizedStatus}`);

  const safeType = (productType || "").trim().slice(0, 80);
  if (safeType) terms.push(`product_type:"${escapeSearchValue(safeType)}"`);

  return terms.join(" ");
}

function getPageSize() {
  if (process.env.NODE_ENV === "production") return PAGE_SIZE;

  const raw = process.env.LOOKMEFY_PRODUCT_PAGE_SIZE;
  if (!raw) return PAGE_SIZE;

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return PAGE_SIZE;
  return Math.min(Math.max(parsed, MIN_DEV_PAGE_SIZE), MAX_DEV_PAGE_SIZE);
}

function formatPrice(minPrice?: Money | null, maxPrice?: Money | null) {
  if (!minPrice) return "Unavailable";
  const format = (money: Money) => `${money.currencyCode} ${Number(money.amount).toFixed(2)}`;
  if (!maxPrice || minPrice.amount === maxPrice.amount) return format(minPrice);
  return `${format(minPrice)} - ${format(maxPrice)}`;
}

function productImage(product: ProductNode) {
  const featured = product.featuredMedia?.preview?.image;
  if (featured?.url) return { ...featured, id: featured.id || product.featuredMedia?.id };
  const variantImage = product.variants?.nodes.find((variant) => variant.image?.url)?.image;
  if (variantImage?.url) return variantImage;
  const mediaImage = product.media?.nodes.find((media) => media.preview?.image?.url)?.preview?.image;
  return mediaImage?.url ? { ...mediaImage, id: mediaImage.id || undefined } : null;
}

function normalizeProduct(product: ProductNode, eligibilityEnabled: boolean): ProductSummary {
  const minPrice = product.priceRangeV2?.minVariantPrice || null;
  const maxPrice = product.priceRangeV2?.maxVariantPrice || null;
  const image = productImage(product);
  const variants = product.variants?.nodes || [];
  const media = product.media?.nodes || [];

  return {
    id: product.id,
    title: product.title,
    handle: product.handle,
    status: product.status,
    productType: product.productType || "Uncategorized",
    vendor: product.vendor || "",
    tags: product.tags || [],
    image,
    priceLabel: formatPrice(minPrice, maxPrice),
    minPrice,
    maxPrice,
    variantCount: variants.length,
    variants,
    media,
    hasUsableImage: Boolean(image?.url),
    eligibilityEnabled,
  };
}

function productMatchesFilters(product: ProductNode, { search, status, productType }: { search: string; status: string; productType: string }) {
  const safeSearch = search.trim().toLowerCase();
  const safeStatus = status.trim().toUpperCase();
  const safeProductType = productType.trim().toLowerCase();

  if (safeSearch && !product.title.toLowerCase().includes(safeSearch)) return false;
  if (safeStatus && product.status !== safeStatus) return false;
  if (safeProductType && (product.productType || "").toLowerCase() !== safeProductType) return false;
  return true;
}

async function graphqlJson(admin: AdminGraphql, query: string, variables: Record<string, unknown>) {
  const response = await admin.graphql(query, { variables });
  const json = await response.json();
  if (json.errors?.length) {
    const message = json.errors.map((error: { message?: string }) => error.message).filter(Boolean).join("; ");
    throw new Error(message || "Shopify GraphQL request failed");
  }
  return json.data;
}

const PRODUCT_FIELDS = `#graphql
  fragment LookmefyProductFields on Product {
    id
    title
    handle
    status
    productType
    vendor
    tags
    createdAt
    updatedAt
    featuredMedia {
      id
      alt
      preview {
        image {
          id
          url
          altText
          width
          height
        }
      }
    }
    priceRangeV2 {
      minVariantPrice {
        amount
        currencyCode
      }
      maxVariantPrice {
        amount
        currencyCode
      }
    }
    variants(first: 8) {
      nodes {
        id
        title
        price
        image {
          id
          url
          altText
          width
          height
        }
      }
    }
    media(first: 6) {
      nodes {
        id
        mediaContentType
        alt
        preview {
          image {
            id
            url
            altText
            width
            height
          }
        }
      }
    }
  }
`;

export async function productExists(admin: AdminGraphql, productId: string) {
  const data = await graphqlJson(
    admin,
    `#graphql
      query LookmefyProductExists($id: ID!) {
        product(id: $id) {
          id
        }
      }
    `,
    { id: productId },
  );
  return Boolean(data.product?.id);
}

export async function getProductDetail(admin: AdminGraphql, shop: string, productId: string) {
  const data = await graphqlJson(
    admin,
    `${PRODUCT_FIELDS}
    query LookmefyProductDetail($id: ID!) {
      product(id: $id) {
        ...LookmefyProductFields
      }
    }`,
    { id: productId },
  );

  if (!data.product) throw new Response("Product not found or not accessible", { status: 404 });
  const eligibility = await getEligibilityMap(shop, [productId]);
  return normalizeProduct(data.product, eligibility.get(productId)?.enabled || false);
}

async function fetchProductPage({
  admin,
  first,
  last,
  after,
  before,
  query,
}: {
  admin: AdminGraphql;
  first?: number;
  last?: number;
  after?: string | null;
  before?: string | null;
  query: string;
}) {
  return graphqlJson(
    admin,
    `${PRODUCT_FIELDS}
    query LookmefyProducts($first: Int, $last: Int, $after: String, $before: String, $query: String) {
      products(first: $first, last: $last, after: $after, before: $before, query: $query, sortKey: UPDATED_AT, reverse: true) {
        nodes {
          ...LookmefyProductFields
        }
        pageInfo {
          hasNextPage
          hasPreviousPage
          startCursor
          endCursor
        }
      }
      productsCount(query: $query) {
        count
        precision
      }
    }`,
    { first, last, after, before, query: query || null },
  );
}

export async function listProducts({
  admin,
  shop,
  url,
}: {
  admin: AdminGraphql;
  shop: string;
  url: URL;
}): Promise<ProductListResult> {
  const filter = url.searchParams.get("filter") || "all";
  const search = url.searchParams.get("q") || "";
  const status = url.searchParams.get("status") || "";
  const productType = url.searchParams.get("productType") || "";
  const cursor = url.searchParams.get("cursor");
  const direction = url.searchParams.get("direction") === "previous" ? "previous" : "next";
  const query = buildProductSearchQuery({ search, status, productType });
  const enabledCount = await countEnabledProducts(shop);
  const pageSize = getPageSize();

  try {
    if (filter === "enabled") {
      const ids = await listEnabledProductIds(shop);
      if (ids.length === 0) {
        return {
          products: [],
          pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
          counts: { total: null, totalPrecision: null, enabled: enabledCount, disabled: null },
          query,
          filter,
          search,
          status,
          productType,
          direction,
          pageSize,
          error: null,
        };
      }

      const data = await graphqlJson(
        admin,
        `${PRODUCT_FIELDS}
        query LookmefyEnabledProducts($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on Product {
              ...LookmefyProductFields
            }
          }
        }`,
        { ids: ids.slice(0, MAX_ENABLED_LOOKUP) },
      );
      const nodes = (data.nodes || []).filter(Boolean) as ProductNode[];
      const filteredNodes = nodes.filter((node) => productMatchesFilters(node, { search, status, productType }));
      return {
        products: filteredNodes.slice(0, pageSize).map((node) => normalizeProduct(node, true)),
        pageInfo: {
          hasNextPage: filteredNodes.length > pageSize || ids.length > MAX_ENABLED_LOOKUP,
          hasPreviousPage: false,
          startCursor: null,
          endCursor: null,
        },
        counts: { total: filteredNodes.length, totalPrecision: "EXACT", enabled: filteredNodes.length, disabled: 0 },
        query,
        filter,
        search,
        status,
        productType,
        direction,
        pageSize,
        error:
          ids.length > MAX_ENABLED_LOOKUP
            ? `Enabled filter checked the first ${MAX_ENABLED_LOOKUP} configured products in this phase.`
            : null,
      };
    }

    const products: ProductSummary[] = [];
    let pageInfo: PageInfo = { hasNextPage: false, hasPreviousPage: false };
    let total: number | null = null;
    let totalPrecision: string | null = null;
    let nextCursor: string | null | undefined = cursor;

    for (let page = 0; page < (filter === "disabled" ? MAX_DISABLED_FETCH_PAGES : 1) && products.length < pageSize; page += 1) {
      const data = await fetchProductPage({
        admin,
        first: direction === "next" ? pageSize : undefined,
        last: direction === "previous" ? pageSize : undefined,
        after: direction === "next" ? nextCursor : null,
        before: direction === "previous" ? cursor : null,
        query,
      });
      pageInfo = data.products.pageInfo;
      total = data.productsCount?.count ?? null;
      totalPrecision = data.productsCount?.precision ?? null;

      const productIds = data.products.nodes.map((product: ProductNode) => product.id);
      const eligibility = await getEligibilityMap(shop, productIds);
      const normalized = data.products.nodes.map((product: ProductNode) =>
        normalizeProduct(product, eligibility.get(product.id)?.enabled || false),
      );
      products.push(...(filter === "disabled" ? normalized.filter((product: ProductSummary) => !product.eligibilityEnabled) : normalized));
      if (!pageInfo.hasNextPage || filter !== "disabled") break;
      nextCursor = pageInfo.endCursor;
    }

    return {
      products: products.slice(0, pageSize),
      pageInfo,
      counts: {
        total,
        totalPrecision,
        enabled: enabledCount,
        disabled: total === null ? null : Math.max(total - enabledCount, 0),
      },
      query,
      filter,
      search,
      status,
      productType,
      direction,
      pageSize,
      error:
        filter === "disabled" && products.length < PAGE_SIZE && pageInfo.hasNextPage
          ? "Disabled filtering checked several Shopify pages. Continue paging if more products exist."
          : null,
    };
  } catch (error) {
    return {
      products: [],
      pageInfo: { hasNextPage: false, hasPreviousPage: false },
      counts: { total: null, totalPrecision: null, enabled: enabledCount, disabled: null },
      query,
      filter,
      search,
      status,
      productType,
      direction,
      pageSize,
      error: error instanceof Error ? error.message : "Could not load Shopify products.",
    };
  }
}
