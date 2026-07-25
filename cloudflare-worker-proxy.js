/**
 * Cloudflare Worker — stolen-serial proxy + sliding-window rate limit
 *
 * Secrets (wrangler secret put):
 *   STOLEN_API_URL
 *   STOLEN_API_KEY
 *
 * Deploy:
 *   npx wrangler deploy cloudflare-worker-proxy.js
 *
 * Then set STOLEN_CHECK_API.proxyUrl in app.js to your worker URL + /stolen-check
 */

const LOCAL_STOLEN = new Set(['SN12345678', 'STOLEN999', 'HOTCAM001']);

/** Sliding window: 10 requests / 60 seconds per IP */
const RATE_LIMIT = 10;
const WINDOW_MS = 60_000;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname.endsWith('/stolen-check')) {
      const ip =
        request.headers.get('CF-Connecting-IP') ||
        request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ||
        'unknown';

      const limited = await checkRateLimit(ip, env);
      if (!limited.allowed) {
        return json(
          { error: 'rate_limited', retryAfter: limited.retryAfter },
          429,
          { 'Retry-After': String(limited.retryAfter) }
        );
      }

      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: 'invalid json' }, 400);
      }

      const serial = String(body.serial || '')
        .trim()
        .toUpperCase()
        .replace(/\s+/g, '');
      if (!serial) return json({ error: 'serial required' }, 400);

      // Upstream commercial / official API
      if (env.STOLEN_API_URL) {
        try {
          const r = await fetch(env.STOLEN_API_URL, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(env.STOLEN_API_KEY
                ? { Authorization: `Bearer ${env.STOLEN_API_KEY}` }
                : {}),
            },
            body: JSON.stringify({ serial }),
          });
          if (r.ok) {
            const data = await r.json();
            return json({ stolen: !!data.stolen, source: 'upstream', ...data });
          }
        } catch (e) {
          // fall through to local
        }
      }

      return json({
        stolen: LOCAL_STOLEN.has(serial),
        source: 'local-mock',
        serial,
      });
    }

    return json({ ok: true, service: 'camera-trade-stolen-proxy' });
  },
};

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders,
      ...extraHeaders,
    },
  });
}

/**
 * Sliding-window rate limiter using Cache API.
 * Stores JSON array of request timestamps per IP.
 */
async function checkRateLimit(ip, env) {
  const key = new Request(
    `https://rate-limit.internal/stolen-check/${encodeURIComponent(ip)}`
  );
  const cache = caches.default;
  const now = Date.now();

  let timestamps = [];
  const cached = await cache.match(key);
  if (cached) {
    try {
      timestamps = await cached.json();
    } catch {
      timestamps = [];
    }
  }

  // Prune outside window
  timestamps = timestamps.filter((t) => now - t < WINDOW_MS);

  if (timestamps.length >= RATE_LIMIT) {
    const oldest = Math.min(...timestamps);
    const retryAfter = Math.ceil((WINDOW_MS - (now - oldest)) / 1000);
    // re-store pruned list
    ctxWaitUntilPut(cache, key, timestamps);
    return { allowed: false, retryAfter: Math.max(1, retryAfter) };
  }

  timestamps.push(now);
  await cache.put(
    key,
    new Response(JSON.stringify(timestamps), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': `max-age=${Math.ceil(WINDOW_MS / 1000)}`,
      },
    })
  );

  return { allowed: true, remaining: RATE_LIMIT - timestamps.length };
}

function ctxWaitUntilPut(cache, key, timestamps) {
  // fire-and-forget put for 429 path
  cache.put(
    key,
    new Response(JSON.stringify(timestamps), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': `max-age=${Math.ceil(WINDOW_MS / 1000)}`,
      },
    })
  );
}

// Also export pure rate-limit helper for unit tests (Node)
export function slidingWindowAllow(timestamps, now = Date.now(), limit = RATE_LIMIT, windowMs = WINDOW_MS) {
  const pruned = timestamps.filter((t) => now - t < windowMs);
  if (pruned.length >= limit) {
    const oldest = Math.min(...pruned);
    return {
      allowed: false,
      retryAfter: Math.ceil((windowMs - (now - oldest)) / 1000),
      timestamps: pruned,
    };
  }
  pruned.push(now);
  return { allowed: true, timestamps: pruned };
}
