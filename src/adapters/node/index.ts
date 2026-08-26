import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AppContext } from "../../core/ports.ts";
import { createWebhookHandler } from "../../core/webhook.ts";
import { createGitHubApiFactory } from "../github/octokit.ts";
import { readEnv } from "../shared/env.ts";
import { createLogger } from "../shared/logger.ts";
import { createMemoryCache } from "../shared/memory-cache.ts";

async function readBody(message: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of message) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function toRequest(message: IncomingMessage, body: string): Request {
  const host = message.headers.host ?? "localhost";
  const url = new URL(message.url ?? "/", `http://${host}`);
  const headers = new Headers();
  for (const [name, value] of Object.entries(message.headers)) {
    if (typeof value === "string") {
      headers.set(name, value);
    }
  }
  const method = message.method ?? "GET";
  return new Request(url, {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? undefined : body,
  });
}

async function writeResponse(response: Response, target: ServerResponse): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name] = value;
  });
  target.writeHead(response.status, headers);
  target.end(await response.text());
}

/** The same core, behind `node:http`, for self-hosting and local verification. */
export function createNodeServer(source: NodeJS.ProcessEnv = process.env) {
  const env = readEnv(source);
  const logger = createLogger(env.logLevel);

  const context: AppContext = {
    github: createGitHubApiFactory(env, logger),
    logger,
    clock: { now: () => new Date() },
    // Nothing to hand the work to here, so it simply runs after the response.
    deferrer: {
      defer: (work) => {
        void work().catch((error: unknown) => {
          logger.error("deferred work failed", { reason: String(error) });
        });
      },
    },
    env,
    cache: createMemoryCache(),
    appId: env.appId,
  };

  const handle = createWebhookHandler(context);

  return createServer((message, target) => {
    void (async () => {
      try {
        const body = await readBody(message);
        await writeResponse(await handle(toRequest(message, body)), target);
      } catch (error) {
        logger.error("request failed", { reason: String(error) });
        target.writeHead(500, { "content-type": "application/json" });
        target.end(JSON.stringify({ error: "internal error" }));
      }
    })();
  });
}

if (process.argv[1]?.endsWith("adapters/node/index.ts") === true) {
  const port = Number(process.env.PORT ?? "8787");
  createNodeServer().listen(port, () => {
    console.log(JSON.stringify({ level: "info", message: "listening", port }));
  });
}
