import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { recordWebhookDelivery, updateShopScopes } from "../models/shop.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload, topic, shop, webhookId } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);

  const delivery = await recordWebhookDelivery({
    webhookId,
    topic,
    shop,
    action: "app_scopes_update",
  });
  const current = Array.isArray(payload.current) ? payload.current.join(",") : "";
  if (!delivery.duplicate) await updateShopScopes(shop, current);

  return new Response();
};
