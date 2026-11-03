/**
 * Pulse Cloudflare Worker — subscription and reminder preferences API.
 *
 * Deploy to the existing "pulse-notifications" Worker.
 * REQUIRED binding: KV namespace named PULSE_REMINDERS.
 *
 * This stage stores real browser push subscriptions and chosen reminder times.
 * It does NOT yet deliver notifications. Delivery requires VAPID encryption,
 * a configured sender key pair, and a scheduled trigger.
 *
 * Privacy: no account or email is collected. Push endpoint and encryption keys
 * are device-specific identifiers and must be handled as personal data.
 */
const APP_ORIGIN = "https://gbms5p27kk-eng.github.io";
const HEADERS = {
  "Access-Control-Allow-Origin": APP_ORIGIN,
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Vary": "Origin",
  "Cache-Control": "no-store"
};
function json(body, status=200) {
  return new Response(JSON.stringify(body), { status, headers: { ...HEADERS, "Content-Type": "application/json; charset=utf-8" } });
}
function isValidSubscription(s) {
  return !!(s && typeof s.endpoint === "string" && /^https:\/\//.test(s.endpoint) &&
    s.endpoint.length < 2048 && s.keys &&
    typeof s.keys.p256dh === "string" && typeof s.keys.auth === "string" &&
    s.keys.p256dh.length < 300 && s.keys.auth.length < 300);
}
function validatePreferences(input) {
  if (!input || typeof input !== "object") return null;
  const result = {};
  for (const part of ["morning", "afternoon", "evening"]) {
    const value = input[part];
    if (!value || typeof value.enabled !== "boolean" || typeof value.time !== "string" ||
        !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value.time)) return null;
    result[part] = { time: value.time, enabled: value.enabled };
  }
  return result;
}
async function subscriptionKey(endpoint) {
  const bytes = new TextEncoder().encode(endpoint);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return "sub:" + Array.from(new Uint8Array(hash), x => x.toString(16).padStart(2, "0")).join("");
}
export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin");
    if (origin && origin !== APP_ORIGIN) return json({ error: "Origin not allowed" }, 403);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: HEADERS });
    const path = new URL(request.url).pathname;
    if (path === "/health" && request.method === "GET") {
      return json({ service: "pulse-notifications", status: "ready", notificationsActive: false,
        storageConfigured: !!env.PULSE_REMINDERS });
    }
    if (path === "/config" && request.method === "GET") {
      return json({ notificationsActive: false, publicKey: env.VAPID_PUBLIC_KEY || null });
    }
    if (!env.PULSE_REMINDERS) return json({ error: "Storage not configured" }, 503);
    if ((path === "/subscribe" && request.method === "POST") ||
        (path === "/unsubscribe" && request.method === "DELETE")) {
      let data;
      try { data = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
      if (!isValidSubscription(data.subscription)) return json({ error: "Invalid subscription" }, 400);
      const key = await subscriptionKey(data.subscription.endpoint);
      if (request.method === "DELETE") {
        // Subscription ownership must be proven before enabling this endpoint publicly.
        return json({ error: "Unsubscribe is not enabled yet" }, 501);
      }
      const preferences = validatePreferences(data.preferences);
      if (!preferences) return json({ error: "Invalid reminder preferences" }, 400);
      if (typeof data.timezone !== "string" || data.timezone.length > 80) return json({ error: "Unsupported timezone" }, 400);
      try { new Intl.DateTimeFormat("en-GB", { timeZone: data.timezone }); }
      catch { return json({ error: "Unsupported timezone" }, 400); }
      const previous=await env.PULSE_REMINDERS.get(key,"json");
      await env.PULSE_REMINDERS.put(key, JSON.stringify({
        subscription: data.subscription, preferences, timezone: data.timezone,
        progress: previous?.progress || null,
        updatedAt: new Date().toISOString()
      }));
      return json({ saved: true, notificationsActive: false });
    }
    if (path === "/progress" && request.method === "POST") {
      let input;
      try { input=await request.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
      if (!isValidSubscription(input.subscription)) return json({ error: "Invalid subscription" }, 400);
      if (typeof input.date !== "string" || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(input.date))
        return json({ error: "Invalid date" }, 400);
      const completed=input.completed;
      if (!completed || ["morning","afternoon","evening"].some(p=>typeof completed[p]!=="boolean"))
        return json({ error: "Invalid progress" }, 400);
      const key=await subscriptionKey(input.subscription.endpoint);
      const record=await env.PULSE_REMINDERS.get(key,"json");
      if (!record || record.subscription?.keys?.auth!==input.subscription.keys.auth ||
          record.subscription?.keys?.p256dh!==input.subscription.keys.p256dh)
        return json({ error: "Save reminder settings first" }, 404);
      // Progress can only be added, never cleared by a stale tab.
      const prior=record.progress?.date===input.date?record.progress.completed:{};
      const merged={};
      for (const p of ["morning","afternoon","evening"])merged[p]=completed[p] || prior?.[p]===true;
      record.progress={date:input.date,completed:merged};
      await env.PULSE_REMINDERS.put(key,JSON.stringify(record));
      return json({ saved:true, completed:merged });
    }
    return json({ error: "Not found" }, 404);
  }
};
