/**
 * Parse a typed keyword that looks like money ("45,000.00", "USD 45000").
 * Returns a finite number or null when the keyword is not an amount.
 */
export function parseSearchAmount(keyword) {
  const raw = String(keyword || "").trim();
  if (!raw) return null;

  const stripped = raw
    .replace(/[A-Za-z]/g, "")
    .replace(/,/g, "")
    .replace(/\s/g, "");

  if (!/^-?\d+(\.\d+)?$/.test(stripped)) return null;
  const amount = Number(stripped);
  return Number.isFinite(amount) ? amount : null;
}

/** Comma-free form of a keyword for CAST/LIKE amount matching. */
export function compactSearchAmount(keyword) {
  return String(keyword || "")
    .trim()
    .replace(/[A-Za-z]/g, "")
    .replace(/,/g, "")
    .replace(/\s/g, "");
}

/**
 * Match formatted amounts (45,000.00) against numeric money columns.
 * Adds OR clauses to the existing keyword search.
 */
export function pushAmountKeywordClauses(parts, values, columns, keyword, escapeLike) {
  const amount = parseSearchAmount(keyword);
  const compact = compactSearchAmount(keyword);
  if (amount != null) {
    for (const column of columns) {
      parts.push(`${column} = ?`);
      values.push(amount);
    }
  }
  if (!compact) return;
  const like = `%${escapeLike(compact)}%`;
  for (const column of columns) {
    parts.push(`CAST(${column} AS CHAR) LIKE ? ESCAPE '\\\\'`);
    values.push(like);
  }
}
