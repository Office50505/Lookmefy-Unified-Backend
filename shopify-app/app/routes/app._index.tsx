import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { recordShopAuthenticated } from "../models/shop.server";

type ShopInfo = {
  name: string;
  myshopifyDomain: string;
  url: string;
  planName: string;
  partnerDevelopment: boolean;
};

type BadgeTone = "info" | "success" | "warning" | "neutral" | "auto" | "caution" | "critical";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  let shopInfo: ShopInfo = {
    name: session.shop,
    myshopifyDomain: session.shop,
    url: `https://${session.shop}`,
    planName: "Unavailable",
    partnerDevelopment: false,
  };

  try {
    const response = await admin.graphql(`#graphql
      query LookmefyShopStatus {
        shop {
          name
          myshopifyDomain
          url
          plan {
            displayName
            partnerDevelopment
          }
        }
      }
    `);
    const json = await response.json();
    const shop = json.data?.shop;
    if (shop) {
      shopInfo = {
        name: shop.name || session.shop,
        myshopifyDomain: shop.myshopifyDomain || session.shop,
        url: shop.url || `https://${session.shop}`,
        planName: shop.plan?.displayName || "Unavailable",
        partnerDevelopment: Boolean(shop.plan?.partnerDevelopment),
      };
    }
  } catch (error) {
    console.warn("Could not load Shopify shop profile", error);
  }

  const installation = await recordShopAuthenticated({
    shop: session.shop,
    name: shopInfo.name,
    myshopifyDomain: shopInfo.myshopifyDomain,
    scope: session.scope,
  });

  return {
    shop: session.shop,
    scopes: session.scope || "",
    shopInfo,
    installationStatus: installation.installationStatus,
    installedAt: installation.installedAt.toISOString(),
    lastAuthenticatedAt: installation.lastAuthenticatedAt.toISOString(),
    upcomingScopes:
      "read_products is used only for Phase 3 product catalog loading. Write, order, customer, theme, AI, and billing scopes remain disabled.",
  };
};

export default function Index() {
  const data = useLoaderData<typeof loader>();
  const checklist: Array<{ label: string; status: string; tone: BadgeTone }> = [
    {
      label: "Connect Shopify store",
      status: data.installationStatus === "installed" ? "Connected" : "Needs attention",
      tone: data.installationStatus === "installed" ? "success" : "warning",
    },
    { label: "Configure products", status: "Available", tone: "success" },
    { label: "Enable Virtual Try-On", status: "Coming in Phase 4", tone: "neutral" },
    { label: "Configure merchant billing", status: "Coming in Phase 6", tone: "neutral" },
  ];

  const features = [
    {
      title: "Product Integration",
      body: "Select which real Shopify products will offer AI virtual try-on.",
      status: "Available",
    },
    {
      title: "AI Virtual Try-On",
      body: "Allow shoppers to visualize products on themselves.",
      status: "Coming in Phase 4",
    },
    {
      title: "Usage Analytics",
      body: "Monitor AI generations and merchant engagement.",
      status: "Coming in Phase 5",
    },
    {
      title: "Plans & Billing",
      body: "Manage merchant subscription plans and generation quotas.",
      status: "Coming in Phase 6",
    },
  ];

  return (
    <s-page heading="Lookmefy AI Virtual Try-On">
      <s-section>
        <s-stack gap="base">
          <s-heading>Bring AI-powered virtual fitting rooms to your fashion store.</s-heading>
          <s-paragraph>
            Your Shopify store is authenticated with Lookmefy. Phase 3 adds real Shopify product catalog loading and
            merchant-controlled try-on eligibility settings.
          </s-paragraph>
        </s-stack>
      </s-section>

      <s-section heading="Product setup">
        <s-box padding="base" borderWidth="base" borderRadius="base">
          <s-stack gap="small">
            <s-heading>Configure try-on eligible products</s-heading>
            <s-paragraph>
              Open the Shopify product catalog to search products, review media and variants, and enable Lookmefy
              eligibility for selected products.
            </s-paragraph>
            <s-link href="/app/products">Manage products</s-link>
          </s-stack>
        </s-box>
      </s-section>

      <s-section heading="Connection status">
        <s-box padding="base" borderWidth="base" borderRadius="base">
          <s-stack gap="small">
            <s-heading>{data.shopInfo.name}</s-heading>
            <s-paragraph>
              Authenticated shop domain: <s-text>{data.shopInfo.myshopifyDomain}</s-text>
            </s-paragraph>
            <s-paragraph>
              Installation status: <s-badge tone="success">{data.installationStatus}</s-badge>
            </s-paragraph>
            <s-paragraph>Connection confirmed through Shopify Admin authentication.</s-paragraph>
          </s-stack>
        </s-box>
      </s-section>

      <s-section heading="Getting started">
        <s-stack gap="small">
          {checklist.map((item) => (
            <s-box key={item.label} padding="small" borderWidth="base" borderRadius="base">
              <s-stack direction="inline" justifyContent="space-between" alignItems="center">
                <s-text>{item.label}</s-text>
                <s-badge tone={item.tone}>{item.status}</s-badge>
              </s-stack>
            </s-box>
          ))}
        </s-stack>
      </s-section>

      <s-section heading="Feature overview">
        <s-grid gridTemplateColumns="repeat(auto-fit, minmax(220px, 1fr))" gap="base">
          {features.map((feature) => (
            <s-box key={feature.title} padding="base" borderWidth="base" borderRadius="base">
              <s-stack gap="small">
                <s-heading>{feature.title}</s-heading>
                <s-paragraph>{feature.body}</s-paragraph>
                <s-badge>{feature.status}</s-badge>
              </s-stack>
            </s-box>
          ))}
        </s-grid>
      </s-section>

      <s-section heading="Store information">
        <s-stack gap="small">
          <s-paragraph>Store name: {data.shopInfo.name}</s-paragraph>
          <s-paragraph>Shop domain: {data.shopInfo.myshopifyDomain}</s-paragraph>
          <s-paragraph>Admin session shop: {data.shop}</s-paragraph>
          <s-paragraph>Plan: {data.shopInfo.planName}</s-paragraph>
          <s-paragraph>
            Development store: {data.shopInfo.partnerDevelopment ? "Yes" : "Not reported by Shopify"}
          </s-paragraph>
          <s-paragraph>
            Authenticated scopes: {data.scopes || "No additional Admin API scopes requested for Phase 2"}
          </s-paragraph>
        </s-stack>
      </s-section>

      <s-section heading="Help and documentation">
        <s-stack gap="small">
          <s-paragraph>
            Storefront app blocks, customer uploads, AI generation, and merchant billing are intentionally disabled until
            their approved phases.
          </s-paragraph>
          <s-paragraph>{data.upcomingScopes}</s-paragraph>
          <s-link href="https://shopify.dev/docs/apps/build" target="_blank">
            Shopify app development docs
          </s-link>
          <s-link href="https://shopify.dev/docs/api/shopify-app-react-router" target="_blank">
            Shopify React Router package docs
          </s-link>
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
