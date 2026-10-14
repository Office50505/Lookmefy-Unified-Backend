import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { markShopUninstalled, recordWebhookDelivery } from "../models/shop.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, webhookId } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  const delivery = await recordWebhookDelivery({
    webhookId,
    topic,
    shop,
    action: "app_uninstalled",
  });
  if (!delivery.duplicate) await markShopUninstalled(shop);

  return new Response();
};
