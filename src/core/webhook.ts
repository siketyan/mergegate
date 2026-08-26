import type { AppContext } from "./ports.ts";
import { handleDelivery } from "./handlers/index.ts";

const encoder = new TextEncoder();

function fromHex(hex: string): Uint8Array<ArrayBuffer> | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) {
    return null;
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/**
 * WebCrypto compares the tag itself, in constant time, so nothing here has to
 * hand-roll that comparison.
 */
export async function verifySignature(
  secret: string,
  payload: string,
  signature: string | null,
): Promise<boolean> {
  if (signature === null || !signature.startsWith("sha256=")) {
    return false;
  }
  const mac = fromHex(signature.slice("sha256=".length));
  if (mac === null) {
    return false;
  }
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify("HMAC", key, mac, encoder.encode(payload));
}

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * The whole app as a web standard handler: verify, answer 202 straight away and
 * do the work through the `Deferrer` port, so GitHub's 10 second webhook
 * timeout is never in play.
 */
export function createWebhookHandler(context: AppContext): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return json(200, { status: "ok" });
    }
    if (request.method !== "POST" || url.pathname !== "/webhooks/github") {
      return json(404, { error: "not found" });
    }

    const event = request.headers.get("x-github-event");
    const delivery = request.headers.get("x-github-delivery");
    if (event === null || delivery === null) {
      return json(400, { error: "missing GitHub webhook headers" });
    }

    const body = await request.text();
    const verified = await verifySignature(
      context.env.webhookSecret,
      body,
      request.headers.get("x-hub-signature-256"),
    );
    if (!verified) {
      // Never processed, never logged in detail: an unsigned delivery is noise.
      return json(401, { error: "invalid signature" });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      return json(400, { error: "body is not valid JSON" });
    }

    const logger = context.logger.with({ delivery, event });
    context.deferrer.defer(async () => {
      try {
        await handleDelivery({ ...context, logger }, event, payload);
      } catch (error) {
        logger.error("delivery failed", {
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    });

    return json(202, { accepted: true });
  };
}
