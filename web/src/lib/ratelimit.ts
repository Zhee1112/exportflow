/**
 * Abuse controls for the demo API routes (OWASP A04/A07): per-IP request budgets.
 *
 * The counter lives in this process only — correct for one dev/demo server, and honest
 * about its limit (a multi-instance deployment would need a shared store, e.g. Redis).
 */

const hits = new Map<string, number[]>();

/**
 * The caller's IP. Clients can write any X-Forwarded-For they like, so never trust its
 * first entry. Set TRUSTED_IP_HEADER to the header your host sets itself (Vercel:
 * x-vercel-forwarded-for, Cloudflare: cf-connecting-ip). Otherwise this takes the entry
 * your own proxy appended last.
 */
export function clientIp(req: Request): string {
  const trusted = process.env.TRUSTED_IP_HEADER?.trim().toLowerCase();
  if (trusted) return req.headers.get(trusted)?.split(",")[0]?.trim() || "unknown";
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",").at(-1)?.trim() || "unknown";
  return req.headers.get("x-real-ip")?.trim() || "unknown";
}

/** Record one hit for `bucket`; true when the bucket went over `max` within `windowMs`. */
export function overLimit(bucket: string, max: number, windowMs = 60_000): boolean {
  const now = Date.now();
  const recent = (hits.get(bucket) ?? []).filter((t) => now - t < windowMs);
  recent.push(now);
  hits.set(bucket, recent);
  // Bound the map so a flood of distinct buckets can't grow it forever.
  if (hits.size > 10_000) {
    for (const [k, times] of hits) if (times.every((t) => now - t >= windowMs)) hits.delete(k);
  }
  return recent.length > max;
}
