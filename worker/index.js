const LATEST_QUOTES_PATH = "/api/market-data/latest";
const LATEST_QUOTES_KEY = "market-data/latest/quotes/all.json.gz";
const HISTORY_PATH_PREFIX = "/api/market-data/history/";
const HISTORY_KEY_PREFIX = "market-data/history";
const CACHE_FORMAT_VERSION = "decoded-json-v1";
const RESEARCH_MANIFEST_PATH = "/api/etf-research/manifest";
const RESEARCH_VERSION_PREFIX = "/api/etf-research/versions/";
const MARKET_REPORT_INDEX_PATH = "/api/market-reports";
const MARKET_REPORT_VERSION_PREFIX = "/api/market-reports/";

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

function assetHeaders(object, contentType) {
  const headers = new Headers({
    "content-type": contentType,
    "cache-control": "public, max-age=31536000, immutable",
    "x-content-type-options": "nosniff",
  });
  if (object?.httpEtag) headers.set("etag", object.httpEtag);
  if (object?.uploaded instanceof Date) {
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

export async function handleEtfResearch(
  request,
  env,
  context,
  objectKey,
  staticPath,
  compressed,
  immutable = false,
  cache = globalThis.caches?.default,
) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, {
      status: 405,
      headers: { allow: "GET, HEAD", "cache-control": "no-store" },
    });
  }
  const cacheUrl = new URL(request.url);
  cacheUrl.searchParams.set("__cache_format", CACHE_FORMAT_VERSION);
  const cacheKey = new Request(cacheUrl, { method: "GET" });
  if (request.method === "GET" && cache) {
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
  }

  let object = null;
  if (env.MARKET_DATA) {
    try {
      object =
        request.method === "HEAD"
          ? await env.MARKET_DATA.head(objectKey)
          : await env.MARKET_DATA.get(objectKey);
    } catch {
      object = null;
    }
  }
  if (!object) {
    const fallbackUrl = new URL(staticPath, request.url);
    return env.ASSETS.fetch(new Request(fallbackUrl, request));
  }

  const headers = quoteHeaders(object);
  headers.set(
    "cache-control",
    immutable
      ? "public, max-age=31536000, immutable"
      : "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400",
  );
  const response = new Response(
    request.method === "HEAD"
      ? null
      : compressed
        ? decompressedBody(object.body)
        : object.body,
    { status: 200, headers },
  );
  if (request.method === "GET" && cache && context?.waitUntil) {
    context.waitUntil(cache.put(cacheKey, response.clone()));
  }
  return response;
}

export async function handleMarketReportAsset(
  request,
  env,
  objectKey,
  staticPath,
  contentType,
) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, {
      status: 405,
      headers: { allow: "GET, HEAD", "cache-control": "no-store" },
    });
  }

  let object = null;
  if (env.MARKET_DATA) {
    try {
      object = request.method === "HEAD"
        ? await env.MARKET_DATA.head(objectKey)
        : await env.MARKET_DATA.get(objectKey);
    } catch {
      object = null;
    }
  }
  if (!object) {
    const fallbackUrl = new URL(staticPath, request.url);
    return env.ASSETS.fetch(new Request(fallbackUrl, request));
  }

  return new Response(request.method === "HEAD" ? null : object.body, {
    status: 200,
    headers: assetHeaders(object, contentType),
  });
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
    if (url.pathname === RESEARCH_MANIFEST_PATH) {
      return handleEtfResearch(
        request,
        env,
        context,
        "etf-research/latest/manifest.json",
        "/data/etf-research-manifest.json",
        false,
      );
    }
    if (url.pathname.startsWith(RESEARCH_VERSION_PREFIX)) {
      const rest = url.pathname.slice(RESEARCH_VERSION_PREFIX.length);
      const match = /^([A-Za-z0-9._-]{1,80})\/(analysis|returns)$/.exec(rest);
      if (!match) return jsonError("Invalid ETF research path.", 400);
      const [, version, bundle] = match;
      return handleEtfResearch(
        request,
        env,
        context,
        `etf-research/versions/${version}/${bundle}.json.gz`,
        `/data/etf-research-${bundle}.json`,
        true,
        true,
      );
    }
    if (url.pathname === MARKET_REPORT_INDEX_PATH) {
      return handleEtfResearch(
        request,
        env,
        context,
        "market-reports/index.json",
        "/data/market-reports/index.json",
        false,
      );
    }
    if (url.pathname.startsWith(MARKET_REPORT_VERSION_PREFIX)) {
      const reportPath = url.pathname.slice(MARKET_REPORT_VERSION_PREFIX.length);
      const dashboardMatch = /^(\d{4}-\d{2}-\d{2})\/dashboard$/.exec(reportPath);
      if (dashboardMatch) {
        const displayDate = dashboardMatch[1];
        return handleMarketReportAsset(
          request,
          env,
          `market-reports/${displayDate}.png`,
          `/data/market-reports/${displayDate}.png`,
          "image/png",
        );
      }
      const displayDate = reportPath;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(displayDate)) {
        return jsonError("Invalid market-report date.", 400);
      }
      return handleEtfResearch(
        request,
        env,
        context,
        `market-reports/${displayDate}.json`,
        `/data/market-reports/${displayDate}.json`,
        false,
      );
    }
    if (url.pathname.startsWith("/api/")) {
      return jsonError("API route not found.", 404);
    }
    return env.ASSETS.fetch(request);
  },
};
