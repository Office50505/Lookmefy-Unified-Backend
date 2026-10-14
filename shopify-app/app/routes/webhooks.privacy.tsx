import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { markShopRedacted, recordWebhookDelivery } from "../models/shop.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload, shop, topic, webhookId } = await authenticate.webhook(request);

  console.log(`Received ${topic} privacy webhook for ${shop}`);

  const delivery = await recordWebhookDelivery({
    webhookId,
    topic,
    shop,
    action: "privacy_request_received",
  });

  if (!delivery.duplicate && topic === "shop/redact") {
    const shopDomain = String(payload.shop_domain || shop);
    await markShopRedacted(shopDomain);
  }

  return new Response(null, { status: 200 });
};
