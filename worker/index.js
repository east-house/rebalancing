const LATEST_QUOTES_PATH = "/api/market-data/latest";
const LATEST_QUOTES_KEY = "market-data/latest/quotes/all.json.gz";
const HISTORY_PATH_PREFIX = "/api/market-data/history/";
const HISTORY_KEY_PREFIX = "market-data/history";
const CACHE_FORMAT_VERSION = "decoded-json-v2";
const RESEARCH_MANIFEST_PATH = "/api/etf-research/manifest";
const RESEARCH_VERSION_PREFIX = "/api/etf-research/versions/";

function reportRoute(path) {
  const match = /^\/api\/(market-reports|portfolio-reports|trading-test-reports)(?:\/(.*))?$/.exec(path);
  if (!match) return null;
  const [, group, suffix = ""] = match;
  const product = group === "trading-test-reports" ? "trading" : group === "portfolio-reports" ? "portfolio" : "morning";
  if (suffix === "status") return { product, status: true };
  if (!suffix || suffix === "latest" && group !== "market-reports") {
    const filename = suffix ? "latest.json" : "index.json";
    return { product, logical: `${group}/${filename}`, fallback: `/data/${group}/${filename}`, type: "application/json" };
  }
  const date = /^(\d{4}-\d{2}-\d{2})(\/dashboard)?$/.exec(suffix);
  if (!date || date[2] && group !== "market-reports") return { invalid: true };
  const instant = new Date(`${date[1]}T00:00:00Z`);
  if (!Number.isFinite(instant.getTime()) || instant.toISOString().slice(0, 10) !== date[1]) return { invalid: true };
  const ext = date[2] ? "png" : "json";
  return { product, logical: `${group}/${group === "trading-test-reports" ? "reports/" : ""}${date[1]}.${ext}`,
    fallback: `/data/${group}/${date[1]}.${ext}`, type: date[2] ? "image/png" : "application/json" };
}

export async function handlePublishedReport(request, env) {
  const url = new URL(request.url);
  const route = reportRoute(url.pathname);
  if (!route) return null;
  if (route.invalid) return jsonError("Invalid report date.", 400);
  if (!["GET", "HEAD"].includes(request.method)) return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
  if (!env.MARKET_DATA) {
    if (route.status) return jsonError("Report store is not configured.", 503);
    const response = await env.ASSETS.fetch(new Request(new URL(route.fallback, url), { method: request.method, headers: request.headers }));
    const headers = new Headers(response.headers);
    headers.set("x-report-source", "static-preview");
    return new Response(response.body, { status: response.status, headers });
  }
  try {
    let pointer = await env.MARKET_DATA.get(`report-publications/${route.product}/current.json`);
    // Before the independent archive is initialized, preserve access to its old releases.
    if (!pointer && route.product === "portfolio") pointer = await env.MARKET_DATA.get("report-publications/morning/current.json");
    const manifest = pointer ? await new Response(pointer.body).json() : null;
    if (manifest && (!manifest.releaseId || !manifest.objects)) return jsonError("Invalid publication manifest.", 502);
    if (route.status) {
      return new Response(JSON.stringify({ releaseId: manifest?.releaseId ?? null, codeSha: manifest?.codeSha ?? null,
        publishedAt: manifest?.publishedAt ?? null, jobs: manifest?.jobs ?? {},
        dailyStartDate: manifest?.dailyStartDate ?? null, recoveryDates: manifest?.recoveryDates ?? [],
        schedule: route.product === "portfolio" ? { timezone: "Asia/Seoul", time: "19:00", startDate: "2026-09-14", weekdays: [1, 2, 3, 4, 5] } : undefined,
        serverTime: new Date().toISOString() }),
      { headers: { "content-type": "application/json", "cache-control": "no-store" } });
    }
    const expectedRelease = url.searchParams.get("release");
    if (expectedRelease && expectedRelease !== manifest?.releaseId) return jsonError("Publication changed; refresh the report index.", 409);
    const entry = manifest?.objects[route.logical];
    const object = await env.MARKET_DATA.get(entry?.key ?? route.logical);
    if (!object) return jsonError("Report is not available.", entry ? 502 : 404);
    const headers = new Headers({ "content-type": entry?.contentType ?? route.type,
      "cache-control": "public, max-age=0, s-maxage=60, must-revalidate", "x-content-type-options": "nosniff",
      "x-report-source": manifest ? "published" : "legacy", "x-report-release": manifest?.releaseId ?? "",
      "x-report-published-at": manifest?.publishedAt ?? "" });
    if (object.httpEtag) headers.set("etag", object.httpEtag);
    return new Response(request.method === "HEAD" ? null : object.body, { headers });
  } catch {
    return jsonError("Report storage is unavailable; the last publication has not been replaced.", 502);
  }
}

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

export async function handleEtfResearch(
  request,
  env,
  context,
  objectKey,
  staticPath,
  compressed,
  immutable = false,
  cache = globalThis.caches?.default,
  cacheControlOverride = null,
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
    return env.ASSETS.fetch(new Request(fallbackUrl, { method: request.method, headers: request.headers }));
  }

  const headers = quoteHeaders(object);
  headers.set(
    "cache-control",
    cacheControlOverride ?? (immutable
      ? "public, max-age=31536000, immutable"
      : "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400"),
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


export default {
  async fetch(request, env, context) {
    const published = await handlePublishedReport(request, env);
    if (published) return published;
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
    if (url.pathname.startsWith("/api/")) {
      return jsonError("API route not found.", 404);
    }
    return env.ASSETS.fetch(request);
  },
};
