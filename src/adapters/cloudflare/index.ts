import type { AppContext, Cache } from "../../core/ports.ts";
import { createWebhookHandler } from "../../core/webhook.ts";
import { createGitHubApiFactory } from "../github/octokit.ts";
import { readEnv } from "../shared/env.ts";
import { createLogger } from "../shared/logger.ts";

/**
 * Minimal shapes of the two Workers types this adapter touches, declared here so
 * that no Cloudflare type ever reaches `core`. Swap in `@cloudflare/workers-types`
 * if you want the full definitions.
 */
interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

interface KVNamespaceLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface WorkerEnv {
  readonly GITHUB_APP_ID: string;
  readonly GITHUB_APP_PRIVATE_KEY: string;
  readonly GITHUB_WEBHOOK_SECRET: string;
  readonly LOG_LEVEL?: string;
  readonly CONFIG_CACHE_TTL?: string;
  /** Optional: the app owns no state, so running without it is fine. */
  readonly CACHE?: KVNamespaceLike;
}

function toCache(namespace: KVNamespaceLike | undefined): Cache | undefined {
  if (namespace === undefined) {
    return undefined;
  }
  return {
    get: (key) => namespace.get(key),
    put: (key, value, ttlSeconds) => namespace.put(key, value, { expirationTtl: ttlSeconds }),
    delete: (key) => namespace.delete(key),
  };
}

export default {
  async fetch(
    request: Request,
    workerEnv: WorkerEnv,
    executionContext: ExecutionContextLike,
  ): Promise<Response> {
    let env;
    try {
      env = readEnv({
        GITHUB_APP_ID: workerEnv.GITHUB_APP_ID,
        GITHUB_APP_PRIVATE_KEY: workerEnv.GITHUB_APP_PRIVATE_KEY,
        GITHUB_WEBHOOK_SECRET: workerEnv.GITHUB_WEBHOOK_SECRET,
        LOG_LEVEL: workerEnv.LOG_LEVEL,
        CONFIG_CACHE_TTL: workerEnv.CONFIG_CACHE_TTL,
      });
    } catch (error) {
      // A misconfigured Worker should say so rather than throw a stack trace at
      // GitHub. None of these messages carry key material.
      const message = error instanceof Error ? error.message : String(error);
      console.log(
        JSON.stringify({ level: "error", message: "configuration rejected", reason: message }),
      );
      return new Response(JSON.stringify({ error: message }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }

    const logger = createLogger(env.logLevel);

    const context: AppContext = {
      github: createGitHubApiFactory(env, logger),
      logger,
      // The 202 goes out first; the work continues here.
      deferrer: { defer: (work) => executionContext.waitUntil(work()) },
      env,
      cache: toCache(workerEnv.CACHE),
    };

    return createWebhookHandler(context)(request);
  },
};
