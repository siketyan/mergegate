import { expect, test } from "vite-plus/test";
import { createFakeGitHub, createTestContext, pullRequest } from "../test/fake-github.ts";
import { createWebhookHandler, verifySignature } from "./webhook.ts";

// The example from GitHub's own webhook documentation.
const SECRET = "It's a Secret to Everybody";
const PAYLOAD = "Hello, World!";
const SIGNATURE = "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";

test("a known vector verifies", async () => {
  expect(await verifySignature(SECRET, PAYLOAD, SIGNATURE)).toBe(true);
});

test("anything else does not", async () => {
  const cases = [
    null,
    "",
    "sha256=",
    SIGNATURE.replace("757107", "757108"),
    SIGNATURE.slice(0, -1),
    SIGNATURE.replace("sha256=", "sha1="),
    "757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17",
  ];
  for (const signature of cases) {
    expect(await verifySignature(SECRET, PAYLOAD, signature)).toBe(false);
  }
  expect(await verifySignature("another secret", PAYLOAD, SIGNATURE)).toBe(false);
  expect(await verifySignature(SECRET, "another payload", SIGNATURE)).toBe(false);
});

async function sign(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const hex = [...new Uint8Array(mac)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `sha256=${hex}`;
}

function deliveryRequest(body: string, signature: string, event = "pull_request"): Request {
  return new Request("https://mergegate.example/webhooks/github", {
    method: "POST",
    headers: {
      "x-github-event": event,
      "x-github-delivery": "00000000-0000-0000-0000-000000000000",
      "x-hub-signature-256": signature,
      "content-type": "application/json",
    },
    body,
  });
}

function delivery(): string {
  return JSON.stringify({
    action: "opened",
    installation: { id: 42 },
    repository: { name: "mergegate", owner: { login: "siketyan" } },
    pull_request: { number: 12 },
  });
}

test("an unsigned delivery is never processed", async () => {
  const pull = pullRequest();
  const { api, state } = createFakeGitHub({
    configSource: "version: 1\n",
    pullRequests: new Map([[pull.number, pull]]),
  });
  const { context, flush } = createTestContext(api);

  const body = delivery();
  const response = await createWebhookHandler(context)(deliveryRequest(body, "sha256=deadbeef"));

  expect(response.status).toBe(401);
  await flush();
  expect(state.checkRuns).toHaveLength(0);
});

test("a signed delivery is accepted immediately and handled afterwards", async () => {
  const pull = pullRequest();
  const { api, state } = createFakeGitHub({
    configSource: "version: 1\n",
    pullRequests: new Map([[pull.number, pull]]),
  });
  const { context, flush } = createTestContext(api);

  const body = delivery();
  const response = await createWebhookHandler(context)(
    deliveryRequest(body, await sign(context.env.webhookSecret, body)),
  );

  expect(response.status).toBe(202);
  // Nothing has run yet: the work is deferred so GitHub gets its answer fast.
  expect(state.checkRuns).toHaveLength(0);

  await flush();
  expect(state.checkRuns).toHaveLength(1);
});

test("health checks and unknown routes do not need a signature", async () => {
  const { api } = createFakeGitHub();
  const { context } = createTestContext(api);
  const handle = createWebhookHandler(context);

  expect((await handle(new Request("https://mergegate.example/health"))).status).toBe(200);
  expect((await handle(new Request("https://mergegate.example/"))).status).toBe(404);
});
