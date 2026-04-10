"use strict";

/**
 * User-Agent Client Hints parser.
 *
 * Reads the `Sec-CH-UA-*` request headers sent by Chromium-based browsers
 * and returns a flat object of derived features. No parsing of the raw
 * `user-agent` string — these headers are structured and reliable.
 *
 * Low-entropy hints (always sent cross-origin, no opt-in needed):
 *   - Sec-CH-UA              — brand list: `"Chromium";v="120", "Google Chrome";v="120"`
 *   - Sec-CH-UA-Mobile       — boolean: `?0` or `?1`
 *   - Sec-CH-UA-Platform     — OS name: `"Windows"`, `"Android"`, `"macOS"`, ...
 *
 * High-entropy hints (require Accept-CH opt-in from us AND Permission-Policy
 * from the client site — only some will arrive in practice):
 *   - Sec-CH-UA-Platform-Version
 *   - Sec-CH-UA-Arch
 *   - Sec-CH-UA-Bitness
 *   - Sec-CH-UA-Model
 *   - Sec-CH-UA-Full-Version-List
 *
 * All returned fields are nullable — Firefox, Safari, and older Chromium
 * versions don't send these headers at all. CatBoost handles NaN natively.
 */

/**
 * Parse a Structured Field Values "sh-boolean" header value.
 * The browser sends `?0` (false) or `?1` (true).
 */
function parseBoolean(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (s === "?1") return true;
  if (s === "?0") return false;
  return null;
}

/**
 * Parse a Structured Field Values "sh-string" header value.
 * Browsers wrap strings in double quotes: `"Windows"`, `"Android"`.
 */
function parseString(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    const inner = s.slice(1, -1);
    return inner.length > 0 ? inner : null;
  }
  return s.length > 0 ? s : null;
}

/**
 * Parse the Sec-CH-UA list header into a list of {brand, version} pairs
 * and identify the primary brand (skipping the GREASE "Not A;Brand"
 * placeholder that Chromium includes as an anti-sniffing measure).
 *
 * Example input:
 *   `"Chromium";v="120", "Google Chrome";v="120", "Not A;Brand";v="99"`
 *
 * Returns: { brand: "Google Chrome", version: "120" }
 *   — picks the last non-GREASE entry as the "real" brand because
 *     Chromium convention puts the generic "Chromium" entry first and
 *     the specific product (Chrome, Edge, Opera, etc.) last.
 */
function parseBrandList(v) {
  if (v == null) return { brand: null, version: null };
  const s = String(v);
  // Match "name";v="version" pairs
  const entries = [];
  const re = /"([^"]+)";v="([^"]+)"/g;
  let match;
  while ((match = re.exec(s)) !== null) {
    const name = match[1];
    const version = match[2];
    // Skip GREASE placeholders (random brands inserted by Chromium
    // to discourage UA sniffing — they contain `Not`, `?`, or similar)
    if (/not.*brand/i.test(name)) continue;
    entries.push({ brand: name, version });
  }
  if (entries.length === 0) return { brand: null, version: null };
  // Prefer the last entry (specific product name) over generic "Chromium"
  const last = entries[entries.length - 1];
  return { brand: last.brand, version: last.version };
}

/**
 * Read all Sec-CH-UA-* headers from a Fastify/Node request.headers object
 * (keys are lowercased by Node) and return the flat features object.
 *
 * @param {object} headers - request.headers
 * @returns {{
 *   uah_brand: string|null,
 *   uah_brand_version: string|null,
 *   uah_mobile: boolean|null,
 *   uah_platform: string|null,
 *   uah_platform_version: string|null,
 *   uah_model: string|null,
 *   uah_arch: string|null,
 *   uah_bitness: string|null,
 * }}
 */
function parseUaClientHints(headers) {
  const empty = {
    uah_brand: null,
    uah_brand_version: null,
    uah_mobile: null,
    uah_platform: null,
    uah_platform_version: null,
    uah_model: null,
    uah_arch: null,
    uah_bitness: null,
  };
  if (!headers || typeof headers !== "object") return empty;

  const { brand, version } = parseBrandList(headers["sec-ch-ua"]);

  return {
    uah_brand: brand,
    uah_brand_version: version,
    uah_mobile: parseBoolean(headers["sec-ch-ua-mobile"]),
    uah_platform: parseString(headers["sec-ch-ua-platform"]),
    uah_platform_version: parseString(headers["sec-ch-ua-platform-version"]),
    uah_model: parseString(headers["sec-ch-ua-model"]),
    uah_arch: parseString(headers["sec-ch-ua-arch"]),
    uah_bitness: parseString(headers["sec-ch-ua-bitness"]),
  };
}

module.exports = {
  parseUaClientHints,
  // Exported for tests
  _parseBoolean: parseBoolean,
  _parseString: parseString,
  _parseBrandList: parseBrandList,
};
