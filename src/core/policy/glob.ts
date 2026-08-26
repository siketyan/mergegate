/**
 * Branch name patterns.
 *
 * `*` matches any run of characters except `/`, `**` matches any run including
 * `/`, and `?` matches a single character except `/`. Everything else is
 * literal.
 */

export class InvalidPatternError extends Error {
  readonly pattern: string;

  constructor(pattern: string, reason: string) {
    super(`invalid branch pattern ${JSON.stringify(pattern)}: ${reason}`);
    this.name = "InvalidPatternError";
    this.pattern = pattern;
  }
}

const REGEXP_METACHARACTERS = /[.+^${}()|[\]\\]/;

function escapeLiteral(character: string): string {
  return REGEXP_METACHARACTERS.test(character) ? `\\${character}` : character;
}

export function compilePattern(pattern: string): RegExp {
  if (pattern.length === 0) {
    throw new InvalidPatternError(pattern, "must not be empty");
  }

  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*") {
      // A run of two or more stars crosses `/`; a single star does not.
      let stars = 1;
      while (pattern[index + stars] === "*") {
        stars += 1;
      }
      source += stars === 1 ? "[^/]*" : ".*";
      index += stars - 1;
      continue;
    }
    source += character === "?" ? "[^/]" : escapeLiteral(character);
  }

  return new RegExp(`^${source}$`);
}

export function isValidPattern(pattern: string): boolean {
  try {
    compilePattern(pattern);
    return true;
  } catch {
    return false;
  }
}

export function matchesPattern(pattern: string, branch: string): boolean {
  return compilePattern(pattern).test(branch);
}
