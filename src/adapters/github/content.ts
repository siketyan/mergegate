/**
 * Reading a file out of the contents API.
 *
 * With `mediaType: { format: "raw" }` GitHub sends the file itself and Octokit
 * hands back a string. The endpoint types still describe the JSON envelope, so
 * the response is narrowed here rather than cast.
 */

/**
 * Anything that is not the file's text is an error, so that an unreadable
 * configuration fails the check run instead of looking like a repository
 * without one. A missing file is a 404 and never reaches this.
 */
export function decodeContent(path: string, data: unknown): string {
  if (typeof data === "string") {
    return data;
  }
  throw new Error(
    `could not read ${path} from the contents API: expected the raw file, got ${typeof data}`,
  );
}
