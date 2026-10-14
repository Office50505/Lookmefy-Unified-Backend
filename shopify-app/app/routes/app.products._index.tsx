import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, Link, redirect, useLoaderData } from "react-router";
import type { CSSProperties } from "react";
import { boundary } from "@shopify/shopify-app-react-router/server";

import {
  bulkSetProductEligibility,
  parseProductIds,
  setProductEligibility,
} from "../models/product-eligibility.server";
import { authenticate } from "../shopify.server";
import { listProducts, productExists, type ProductSummary } from "../services/shopify-products.server";

type BadgeTone = "info" | "success" | "warning" | "neutral" | "auto" | "caution" | "critical";

const FILTERS = [
  ["all", "All products"],
  ["enabled", "Enabled"],
  ["disabled", "Disabled"],
];

const STATUSES = [
  ["", "Any status"],
  ["active", "Active"],
  ["draft", "Draft"],
  ["archived", "Archived"],
  ["unlisted", "Unlisted"],
];

const buttonStyle: CSSProperties = {
  border: "1px solid #c9cccf",
  borderRadius: 6,
  background: "#ffffff",
  padding: "0.45rem 0.7rem",
  cursor: "pointer",
};

const primaryButtonStyle: CSSProperties = {
  ...buttonStyle,
  borderColor: "#008060",
  background: "#008060",
  color: "#ffffff",
};

const inputStyle: CSSProperties = {
  minHeight: 36,
  border: "1px solid #c9cccf",
  borderRadius: 6,
  padding: "0.35rem 0.5rem",
};

function statusTone(status: string): BadgeTone {
  if (status === "ACTIVE") return "success";
  if (status === "DRAFT") return "warning";
  if (status === "ARCHIVED") return "neutral";
  return "info";
}

function returnToFromRequest(request: Request) {
  const url = new URL(request.url);
  return `${url.pathname}${url.search}`;
}

function safeReturnTo(value: FormDataEntryValue | null) {
  const returnTo = typeof value === "string" ? value : "/app/products";
  return returnTo.startsWith("/app/products") ? returnTo : "/app/products";
}

async function assertProductsBelongToShop(admin: Parameters<typeof productExists>[0], productIds: string[]) {
  const checks = await Promise.all(productIds.map((productId) => productExists(admin, productId)));
  const missingIndex = checks.findIndex((exists) => !exists);
  if (missingIndex >= 0) {
    throw new Response(`Product is not available in this Shopify store: ${productIds[missingIndex]}`, { status: 404 });
  }
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const result = await listProducts({ admin, shop: session.shop, url });

  return {
    shop: session.shop,
    result,
    returnTo: returnToFromRequest(request),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const actionName = String(formData.get("_action") || "");
  const enabled = actionName === "enable" || actionName === "bulk-enable";
  const returnTo = safeReturnTo(formData.get("returnTo"));

  if (actionName === "enable" || actionName === "disable") {
    const productIds = parseProductIds(formData);
    const [productId] = productIds;
    await assertProductsBelongToShop(admin, [productId]);
    await setProductEligibility({ shop: session.shop, productId, enabled });
    return redirect(returnTo);
  }

  if (actionName === "bulk-enable" || actionName === "bulk-disable") {
    const productIds = parseProductIds(formData);
    await assertProductsBelongToShop(admin, productIds);
    await bulkSetProductEligibility({ shop: session.shop, productIds, enabled });
    return redirect(returnTo);
  }

  throw new Response("Unsupported product action", { status: 400 });
};

function pageLink(searchParams: URLSearchParams, cursor: string | null | undefined, direction: "next" | "previous") {
  const params = new URLSearchParams(searchParams);
  params.delete("cursor");
  params.delete("direction");
  if (cursor) params.set("cursor", cursor);
  params.set("direction", direction);
  return `/app/products?${params.toString()}`;
}

function ProductImage({ product }: { product: ProductSummary }) {
  if (!product.image?.url) {
    return (
      <div
        style={{
          width: 64,
          height: 64,
          border: "1px solid #dde0e4",
          borderRadius: 6,
          display: "grid",
          placeItems: "center",
          color: "#6d7175",
          fontSize: 12,
          textAlign: "center",
        }}
      >
        No image
      </div>
    );
  }

  return (
    <img
      alt={product.image.altText || product.title}
      src={product.image.url}
      style={{ width: 64, height: 64, borderRadius: 6, objectFit: "cover", border: "1px solid #dde0e4" }}
    />
  );
}

export default function Products() {
  const { result, returnTo } = useLoaderData<typeof loader>();
  const currentParams = new URLSearchParams();
  if (result.search) currentParams.set("q", result.search);
  if (result.filter && result.filter !== "all") currentParams.set("filter", result.filter);
  if (result.status) currentParams.set("status", result.status);
  if (result.productType) currentParams.set("productType", result.productType);

  return (
    <s-page heading="Products">
      <s-section>
        <s-stack gap="small">
          <s-paragraph>
            Select the real Shopify products that should be eligible for Lookmefy AI Virtual Try-On. Product data is
            loaded server-side through the authenticated Shopify Admin API.
          </s-paragraph>
          <s-link href="/app">Back to dashboard</s-link>
        </s-stack>
      </s-section>

      <s-section heading="Catalog filters">
        <Form method="get">
          <div style={{ display: "grid", gridTemplateColumns: "minmax(180px, 1.5fr) repeat(3, minmax(140px, 1fr)) auto", gap: 12 }}>
            <input aria-label="Search product titles" defaultValue={result.search} name="q" placeholder="Search title" style={inputStyle} />
            <select aria-label="Eligibility filter" defaultValue={result.filter} name="filter" style={inputStyle}>
              {FILTERS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <select aria-label="Product status filter" defaultValue={result.status} name="status" style={inputStyle}>
              {STATUSES.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <input
              aria-label="Product type filter"
              defaultValue={result.productType}
              name="productType"
              placeholder="Product type"
              style={inputStyle}
            />
            <button style={primaryButtonStyle} type="submit">
              Apply
            </button>
          </div>
        </Form>
      </s-section>

      <s-section heading="Catalog summary">
        <s-grid gridTemplateColumns="repeat(auto-fit, minmax(160px, 1fr))" gap="base">
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-stack gap="small">
              <s-text>Total matching</s-text>
              <s-heading>{result.counts.total === null ? "Unavailable" : result.counts.total}</s-heading>
            </s-stack>
          </s-box>
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-stack gap="small">
              <s-text>Try-on enabled</s-text>
              <s-heading>{result.counts.enabled}</s-heading>
            </s-stack>
          </s-box>
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-stack gap="small">
              <s-text>Not enabled</s-text>
              <s-heading>{result.counts.disabled === null ? "Unavailable" : result.counts.disabled}</s-heading>
            </s-stack>
          </s-box>
        </s-grid>
        {result.pageSize < 20 ? (
          <s-paragraph>Development page size override: {result.pageSize} products per page.</s-paragraph>
        ) : null}
      </s-section>

      {result.error ? (
        <s-section heading="Catalog notice">
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-paragraph>{result.error}</s-paragraph>
          </s-box>
        </s-section>
      ) : null}

      <s-section heading="Product eligibility">
        <Form id="bulk-products-form" method="post">
          <input name="returnTo" type="hidden" value={returnTo} />
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
            <button name="_action" style={primaryButtonStyle} type="submit" value="bulk-enable">
              Enable selected
            </button>
            <button name="_action" style={buttonStyle} type="submit" value="bulk-disable">
              Disable selected
            </button>
          </div>
        </Form>

        <div style={{ display: "grid", gap: 10 }}>
          {result.products.length === 0 ? (
            <s-box padding="base" borderWidth="base" borderRadius="base">
              <s-paragraph>No Shopify products matched these filters.</s-paragraph>
            </s-box>
          ) : null}

          {result.products.map((product) => (
            <s-box key={product.id} padding="base" borderWidth="base" borderRadius="base">
              <div style={{ display: "grid", gridTemplateColumns: "auto 64px minmax(0, 1fr) auto", gap: 14, alignItems: "center" }}>
                <input
                  aria-label={`Select ${product.title}`}
                  form="bulk-products-form"
                  name="productId"
                  type="checkbox"
                  value={product.id}
                />
                <ProductImage product={product} />
                <div style={{ minWidth: 0 }}>
                  <s-stack gap="small">
                    <s-heading>{product.title}</s-heading>
                    <s-stack direction="inline" gap="small">
                      <s-badge tone={statusTone(product.status)}>{product.status}</s-badge>
                      <s-badge tone={product.eligibilityEnabled ? "success" : "neutral"}>
                        {product.eligibilityEnabled ? "Try-on enabled" : "Try-on disabled"}
                      </s-badge>
                    </s-stack>
                    <s-paragraph>
                      {product.vendor || "No vendor"} · {product.productType} · {product.priceLabel}
                    </s-paragraph>
                    <s-paragraph>
                      {product.variantCount} variant previews · {product.tags.length ? product.tags.join(", ") : "No tags"}
                    </s-paragraph>
                  </s-stack>
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
                  <Link to={`/app/products/details?productId=${encodeURIComponent(product.id)}`} style={buttonStyle}>
                    Details
                  </Link>
                  <Form method="post">
                    <input name="returnTo" type="hidden" value={returnTo} />
                    <input name="productId" type="hidden" value={product.id} />
                    <button
                      name="_action"
                      style={product.eligibilityEnabled ? buttonStyle : primaryButtonStyle}
                      type="submit"
                      value={product.eligibilityEnabled ? "disable" : "enable"}
                    >
                      {product.eligibilityEnabled ? "Disable" : "Enable"}
                    </button>
                  </Form>
                </div>
              </div>
            </s-box>
          ))}
        </div>

        <div style={{ display: "flex", gap: 8, justifyContent: "space-between", marginTop: 16 }}>
          {result.pageInfo.hasPreviousPage ? (
            <Link to={pageLink(currentParams, result.pageInfo.startCursor, "previous")} style={buttonStyle}>
              Previous
            </Link>
          ) : (
            <span />
          )}
          {result.pageInfo.hasNextPage ? (
            <Link to={pageLink(currentParams, result.pageInfo.endCursor, "next")} style={buttonStyle}>
              Next
            </Link>
          ) : null}
        </div>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
