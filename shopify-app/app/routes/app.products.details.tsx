import type { CSSProperties } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, Link, redirect, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { assertProductGid, parseProductIds, setProductEligibility } from "../models/product-eligibility.server";
import { authenticate } from "../shopify.server";
import { getProductDetail, productExists } from "../services/shopify-products.server";

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

function productIdFromUrl(request: Request) {
  const productId = new URL(request.url).searchParams.get("productId");
  if (!productId) throw new Response("Missing product id", { status: 400 });
  assertProductGid(productId);
  return productId;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const productId = productIdFromUrl(request);
  const product = await getProductDetail(admin, session.shop, productId);

  return {
    product,
    shop: session.shop,
    returnTo: `/app/products/details?productId=${encodeURIComponent(product.id)}`,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const actionName = String(formData.get("_action") || "");
  if (actionName !== "enable" && actionName !== "disable") {
    throw new Response("Unsupported product action", { status: 400 });
  }

  const [productId] = parseProductIds(formData);
  if (!(await productExists(admin, productId))) {
    throw new Response("Product is not available in this Shopify store", { status: 404 });
  }

  await setProductEligibility({ shop: session.shop, productId, enabled: actionName === "enable" });
  return redirect(`/app/products/details?productId=${encodeURIComponent(productId)}`);
};

export default function ProductDetails() {
  const { product, returnTo } = useLoaderData<typeof loader>();

  return (
    <s-page heading={product.title}>
      <s-section>
        <s-stack gap="small">
          <s-link href="/app/products">Back to products</s-link>
          <s-paragraph>
            This product detail is loaded from Shopify Admin API and paired with merchant-scoped Lookmefy eligibility
            settings stored in the app database.
          </s-paragraph>
        </s-stack>
      </s-section>

      <s-section heading="Try-on eligibility">
        <s-box padding="base" borderWidth="base" borderRadius="base">
          <s-stack gap="small">
            <s-badge tone={product.eligibilityEnabled ? "success" : "neutral"}>
              {product.eligibilityEnabled ? "Try-on enabled" : "Try-on disabled"}
            </s-badge>
            <Form method="post">
              <input name="returnTo" type="hidden" value={returnTo} />
              <input name="productId" type="hidden" value={product.id} />
              <button
                name="_action"
                style={product.eligibilityEnabled ? buttonStyle : primaryButtonStyle}
                type="submit"
                value={product.eligibilityEnabled ? "disable" : "enable"}
              >
                {product.eligibilityEnabled ? "Disable try-on" : "Enable try-on"}
              </button>
            </Form>
          </s-stack>
        </s-box>
      </s-section>

      <s-section heading="Product media">
        <s-grid gridTemplateColumns="minmax(180px, 260px) minmax(0, 1fr)" gap="base">
          <s-box padding="base" borderWidth="base" borderRadius="base">
            {product.image?.url ? (
              <img
                alt={product.image.altText || product.title}
                src={product.image.url}
                style={{ width: "100%", aspectRatio: "1 / 1", objectFit: "cover", borderRadius: 6 }}
              />
            ) : (
              <div
                style={{
                  aspectRatio: "1 / 1",
                  display: "grid",
                  placeItems: "center",
                  border: "1px solid #dde0e4",
                  borderRadius: 6,
                  color: "#6d7175",
                }}
              >
                No usable image
              </div>
            )}
          </s-box>
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-stack gap="small">
              <s-paragraph>Status: {product.status}</s-paragraph>
              <s-paragraph>Vendor: {product.vendor || "No vendor"}</s-paragraph>
              <s-paragraph>Product type: {product.productType}</s-paragraph>
              <s-paragraph>Price range: {product.priceLabel}</s-paragraph>
              <s-paragraph>Handle: {product.handle}</s-paragraph>
              <s-paragraph>Tags: {product.tags.length ? product.tags.join(", ") : "No tags"}</s-paragraph>
            </s-stack>
          </s-box>
        </s-grid>
      </s-section>

      <s-section heading="Variant previews">
        <s-grid gridTemplateColumns="repeat(auto-fit, minmax(180px, 1fr))" gap="base">
          {product.variants.length === 0 ? (
            <s-box padding="base" borderWidth="base" borderRadius="base">
              <s-paragraph>No variant previews were returned by Shopify.</s-paragraph>
            </s-box>
          ) : null}
          {product.variants.map((variant) => (
            <s-box key={variant.id} padding="base" borderWidth="base" borderRadius="base">
              <s-stack gap="small">
                {variant.image?.url ? (
                  <img
                    alt={variant.image.altText || variant.title}
                    src={variant.image.url}
                    style={{ width: "100%", aspectRatio: "1 / 1", objectFit: "cover", borderRadius: 6 }}
                  />
                ) : null}
                <s-heading>{variant.title}</s-heading>
                <s-paragraph>{variant.price ? `Variant price: ${variant.price}` : "Variant price unavailable"}</s-paragraph>
              </s-stack>
            </s-box>
          ))}
        </s-grid>
      </s-section>

      <s-section heading="Shopify identifiers">
        <s-box padding="base" borderWidth="base" borderRadius="base">
          <s-stack gap="small">
            <s-paragraph>Product ID: {product.id}</s-paragraph>
            <s-paragraph>Primary image ID: {product.image?.id || "No image selected"}</s-paragraph>
            <Link to="/app/products" style={buttonStyle}>
              Return to catalog
            </Link>
          </s-stack>
        </s-box>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
