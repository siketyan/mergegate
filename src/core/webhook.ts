import type { AppContext } from "./ports.ts";
import { handleDelivery } from "./handlers/index.ts";

const encoder = new TextEncoder();

function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

/** Comparison that does not short-circuit on the first differing byte. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return difference === 0;
}

export async function verifySignature(
  secret: string,
  payload: string,
  signature: string | null,
): Promise<boolean> {
  if (signature === null || !signature.startsWith("sha256=")) {
    return false;
  }
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return timingSafeEqual(`sha256=${toHex(new Uint8Array(mac))}`, signature);
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
