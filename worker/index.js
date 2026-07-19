const LATEST_QUOTES_PATH = "/api/market-data/latest";
const LATEST_QUOTES_KEY = "market-data/latest/quotes/all.json.gz";

function jsonError(message, status) {
  return new Response(
    JSON.stringify({
      error: message,
      status,
    }),
    {
      status,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    },
  );
}

function quoteHeaders(object) {
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "content-encoding": "gzip",
    "cache-control":
      "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'",
  });
  if (object.httpEtag) {
    headers.set("etag", object.httpEtag);
  }
  if (object.uploaded instanceof Date) {
    headers.set("last-modified", object.uploaded.toUTCString());
  }
  return headers;
}

export async function handleLatestQuotes(
  request,
  env,
  context,
  cache = globalThis.caches?.default,
) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, {
      status: 405,
      headers: {
        allow: "GET, HEAD",
        "cache-control": "no-store",
      },
    });
  }

  const cacheKey = new Request(request.url, { method: "GET" });
  if (request.method === "GET" && cache) {
    const cached = await cache.match(cacheKey);
    if (cached) {
      return cached;
    }
  }

  if (!env.MARKET_DATA) {
    return jsonError("R2 market-data binding is not configured.", 503);
  }

  let object;
  try {
    object =
      request.method === "HEAD"
        ? await env.MARKET_DATA.head(LATEST_QUOTES_KEY)
        : await env.MARKET_DATA.get(LATEST_QUOTES_KEY);
  } catch {
    return jsonError("R2 market data is temporarily unavailable.", 502);
  }
  if (!object) {
    return jsonError(
      "Latest quotes are not ready. Run the collection workflow first.",
      503,
    );
  }

  const response = new Response(
    request.method === "HEAD" ? null : object.body,
    {
      status: 200,
      headers: quoteHeaders(object),
    },
  );
  if (request.method === "GET" && cache && context?.waitUntil) {
    context.waitUntil(cache.put(cacheKey, response.clone()));
  }
  return response;
}

export default {
  async fetch(request, env, context) {
    const url = new URL(request.url);
    if (url.pathname === LATEST_QUOTES_PATH) {
      return handleLatestQuotes(request, env, context);
    }
    if (url.pathname.startsWith("/api/")) {
      return jsonError("API route not found.", 404);
    }
    return env.ASSETS.fetch(request);
  },
};
