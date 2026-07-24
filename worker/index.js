const LATEST_QUOTES_PATH = "/api/market-data/latest";
const LATEST_QUOTES_KEY = "market-data/latest/quotes/all.json.gz";
const HISTORY_PATH_PREFIX = "/api/market-data/history/";
const HISTORY_KEY_PREFIX = "market-data/history";
const CACHE_FORMAT_VERSION = "decoded-json-v1";

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

function decompressedBody(body) {
  const stream =
    body instanceof ReadableStream
      ? body
      : new ReadableStream({
          start(controller) {
            controller.enqueue(body);
            controller.close();
          },
        });
  return stream.pipeThrough(new DecompressionStream("gzip"));
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

  const cacheUrl = new URL(request.url);
  cacheUrl.searchParams.set("__cache_format", CACHE_FORMAT_VERSION);
  const cacheKey = new Request(cacheUrl, { method: "GET" });
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
    request.method === "HEAD" ? null : decompressedBody(object.body),
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

export async function handleHistory(
  request,
  env,
  context,
  country,
  ticker,
  cache = globalThis.caches?.default,
) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, {
      status: 405,
      headers: { allow: "GET, HEAD", "cache-control": "no-store" },
    });
  }
  if (
    (country !== "KR" && country !== "US") ||
    !/^[A-Z0-9][A-Z0-9.-]{0,31}$/.test(ticker)
  ) {
    return jsonError("Invalid market-history path.", 400);
  }
  if (!env.MARKET_DATA) {
    return jsonError("R2 market-data binding is not configured.", 503);
  }

  const cacheUrl = new URL(request.url);
  cacheUrl.searchParams.set("__cache_format", CACHE_FORMAT_VERSION);
  const cacheKey = new Request(cacheUrl, { method: "GET" });
  if (request.method === "GET" && cache) {
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
  }

  const objectKey = `${HISTORY_KEY_PREFIX}/${country}/${ticker}.json.gz`;
  let object;
  try {
    object =
      request.method === "HEAD"
        ? await env.MARKET_DATA.head(objectKey)
        : await env.MARKET_DATA.get(objectKey);
  } catch {
    return jsonError("R2 market history is temporarily unavailable.", 502);
  }
  if (!object) {
    return jsonError("Closing-price history is not available for this ticker.", 404);
  }

  const response = new Response(
    request.method === "HEAD" ? null : decompressedBody(object.body),
    { status: 200, headers: quoteHeaders(object) },
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
    if (url.pathname.startsWith(HISTORY_PATH_PREFIX)) {
      const segments = url.pathname.slice(HISTORY_PATH_PREFIX.length).split("/");
      if (segments.length !== 2) {
        return jsonError("Invalid market-history path.", 400);
      }
      let ticker;
      try {
        ticker = decodeURIComponent(segments[1]).trim().toUpperCase();
      } catch {
        return jsonError("Invalid market-history path.", 400);
      }
      return handleHistory(
        request,
        env,
        context,
        segments[0].toUpperCase(),
        ticker,
      );
    }
    if (url.pathname.startsWith("/api/")) {
      return jsonError("API route not found.", 404);
    }
    return env.ASSETS.fetch(request);
  },
};
