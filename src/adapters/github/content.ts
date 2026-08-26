/**
 * Reading a file out of the contents API.
 *
 * With `mediaType: { format: "raw" }` GitHub sends the file itself and Octokit
 * hands back a string. The endpoint types still describe the JSON envelope, so
 * the response is narrowed here rather than cast, and the base64 envelope is
 * still handled in case a proxy or a future Octokit collapses the media type.
 */

export class ContentDecodeError extends Error {
  constructor(path: string, reason: string) {
    super(`could not read ${path} from the contents API: ${reason}`);
    this.name = "ContentDecodeError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Base64 as GitHub sends it: wrapped every 60 characters. */
export function decodeBase64(path: string, content: string): string {
  const compact = content.replaceAll(/\s/g, "");
  let binary: string;
  try {
    binary = atob(compact);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ContentDecodeError(path, `the base64 payload could not be decoded (${reason})`);
  }
  return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
}

/**
 * `null` means "no such file"; anything else that cannot be turned into text is
 * an error, so that an unreadable configuration fails the check run instead of
 * looking like a repository without one.
 */
export function decodeContent(path: string, data: unknown): string | null {
  if (typeof data === "string") {
    return data;
  }
  if (Array.isArray(data)) {
    // A directory, not a file.
    return null;
  }
  if (!isRecord(data)) {
    throw new ContentDecodeError(path, `unexpected response of type ${typeof data}`);
  }
  if (data.type !== "file") {
    return null;
  }
  if (data.encoding === "base64" && typeof data.content === "string") {
    return decodeBase64(path, data.content);
  }
  // `encoding: "none"` means the file was too large to inline. Refusing beats
  // guessing: the caller fails the check rather than treating the repository as
  // unconfigured.
  throw new ContentDecodeError(
    path,
    `the file was returned with encoding ${String(data.encoding)}`,
  );
}
