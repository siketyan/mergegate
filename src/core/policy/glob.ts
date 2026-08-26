/**
 * Branch name patterns.
 *
 * `*` matches any run of characters except `/`, `**` matches any run including
 * `/`, and `?` matches a single character except `/`. Everything else is
 * literal.
 */

const REGEXP_METACHARACTERS = /[.+^${}()|[\]\\]/g;

export function compilePattern(pattern: string): RegExp {
  const source = pattern
    .split(/(\*\*+|\*|\?)/)
    .map((token) => {
      if (token === "?") {
        return "[^/]";
      }
      if (token === "*") {
        return "[^/]*";
      }
      return token.startsWith("**") ? ".*" : token.replace(REGEXP_METACHARACTERS, "\\$&");
    })
    .join("");

  return new RegExp(`^${source}$`);
}

export function matchesPattern(pattern: string, branch: string): boolean {
  return compilePattern(pattern).test(branch);
}

/** A pattern with no wildcards names exactly one branch. */
export function isLiteral(pattern: string): boolean {
  return !/[*?]/.test(pattern);
}
