/**
 * Pulse Cloudflare Worker — subscription and reminder preferences API.
 *
 * Deploy to the existing "pulse-notifications" Worker.
 * REQUIRED binding: KV namespace named PULSE_REMINDERS.
 *
 * Reminder delivery uses OneSignal's API and a Cloudflare cron trigger.
 * Required secret: ONESIGNAL_REST_API_KEY. No key is exposed to browsers.
 *
 * Privacy: no account or email is collected. Push endpoint and encryption keys
 * are device-specific identifiers and must be handled as personal data.
 */
const APP_ORIGIN = "https://gbms5p27kk-eng.github.io";
const ONESIGNAL_APP_ID = "b5b28f65-852f-4a95-a39a-90a187650a50";
const PERIODS = ["morning","afternoon","evening"];
function localParts(date, timezone) {
 const parts=new Intl.DateTimeFormat("en-CA",{timeZone:timezone,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(date);
 const fields=Object.fromEntries(parts.map(p=>[p.type,p.value]));
 return {date:fields.year+"-"+fields.month+"-"+fields.day,time:fields.hour+":"+fields.minute};
}
async function deliverReminders(env,now) {
 if(!env.PULSE_REMINDERS||!env.ONESIGNAL_REST_API_KEY)return;
 let cursor;
 do {
  const page=await env.PULSE_REMINDERS.list({prefix:"sub:",limit:500,...(cursor?{cursor}:{})});
  for(const item of page.keys){
   const record=await env.PULSE_REMINDERS.get(item.name,"json");
   if(!record?.oneSignalSubscriptionId||!record.preferences||!record.timezone)continue;
   let local;
   try{local=localParts(now,record.timezone);}catch{continue;}
   for(const period of PERIODS){
    const preference=record.preferences[period];
    if(!preference?.enabled)continue;
    // The cron runs every five minutes. Cover the preceding five local clock
    // minutes so user-selected times do not need to land on a cron boundary.
    // Compare real instants before formatting to handle DST transitions safely.
    let due=false;
    for(let offset=0;offset<5;offset++){
     const candidate=localParts(new Date(now.getTime()-offset*60000),record.timezone);
     if(candidate.date===local.date&&candidate.time===preference.time){due=true;break;}
    }
    if(!due)continue;
    if(record.progress?.date===local.date&&record.progress.completed?.[period]===true)continue;
    const marker="sent:"+item.name+":"+local.date+":"+period;
    if(await env.PULSE_REMINDERS.get(marker))continue;
    // Reserve before sending to reduce duplicates if a cron invocation overlaps.
    // KV is eventually consistent, so this is best-effort, not exactly-once.
    await env.PULSE_REMINDERS.put(marker,"reserved",{expirationTtl:172800});
    try{
     const response=await fetch("https://api.onesignal.com/notifications",{
      method:"POST",
      headers:{"Content-Type":"application/json","Authorization":"Key "+env.ONESIGNAL_REST_API_KEY},
      body:JSON.stringify({
       app_id:ONESIGNAL_APP_ID,
       target_channel:"push",
       include_subscription_ids:[record.oneSignalSubscriptionId],
       headings:{en:"A little moment for you ♡"},
       contents:{en:"Time for your "+period+" pelvic floor session ♡"},
       url:"https://gbms5p27kk-eng.github.io/pulse-app/"
      })
     });
     if(!response.ok)throw Error("OneSignal HTTP "+response.status);
    }catch(error){
     console.error("Pulse reminder delivery failed",period,String(error));
     await env.PULSE_REMINDERS.delete(marker);
    }
   }
  }
  cursor=page.list_complete?null:page.cursor;
 }while(cursor);
}

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
  async scheduled(event, env, ctx) {
    ctx.waitUntil(deliverReminders(env,new Date(event.scheduledTime)));
  },
  async fetch(request, env) {
    const origin = request.headers.get("Origin");
    if (origin && origin !== APP_ORIGIN) return json({ error: "Origin not allowed" }, 403);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: HEADERS });
    const path = new URL(request.url).pathname;
    if (path === "/health" && request.method === "GET") {
      return json({ service: "pulse-notifications", status: "ready", notificationsActive: !!env.ONESIGNAL_REST_API_KEY,
        storageConfigured: !!env.PULSE_REMINDERS });
    }
    if (path === "/config" && request.method === "GET") {
      return json({ notificationsActive: !!env.ONESIGNAL_REST_API_KEY });
    }
    if (!env.PULSE_REMINDERS) return json({ error: "Storage not configured" }, 503);
    if ((path === "/subscribe" && request.method === "POST") ||
        (path === "/unsubscribe" && request.method === "DELETE")) {
      let data;
      try { data = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
      if (!isValidSubscription(data.subscription)) return json({ error: "Invalid subscription" }, 400);
      const key = await subscriptionKey(data.subscription.endpoint);
      if (request.method === "DELETE") {
        // Match the device's push encryption keys before removing its record.
        // Do not accept an endpoint alone as proof of subscription ownership.
        const record = await env.PULSE_REMINDERS.get(key, "json");
        if (!record) return json({ deleted: true });
        if (record.subscription?.keys?.auth !== data.subscription.keys.auth ||
            record.subscription?.keys?.p256dh !== data.subscription.keys.p256dh)
          return json({ error: "Subscription does not match this device" }, 403);
        await env.PULSE_REMINDERS.delete(key);
        return json({ deleted: true });
      }
      const preferences = validatePreferences(data.preferences);
      if (!preferences) return json({ error: "Invalid reminder preferences" }, 400);
      if (typeof data.timezone !== "string" || data.timezone.length > 80) return json({ error: "Unsupported timezone" }, 400);
      try { new Intl.DateTimeFormat("en-GB", { timeZone: data.timezone }); }
      catch { return json({ error: "Unsupported timezone" }, 400); }
      const previous=await env.PULSE_REMINDERS.get(key,"json");
      const oneSignalSubscriptionId = typeof data.oneSignalSubscriptionId==="string" &&
        /^[a-f0-9-]{36}$/i.test(data.oneSignalSubscriptionId) ? data.oneSignalSubscriptionId : previous?.oneSignalSubscriptionId || null;
      await env.PULSE_REMINDERS.put(key, JSON.stringify({
        subscription: data.subscription, oneSignalSubscriptionId, preferences, timezone: data.timezone,
        progress: previous?.progress || null,
        updatedAt: new Date().toISOString()
      }));
      return json({ saved: true, notificationsActive: !!env.ONESIGNAL_REST_API_KEY, pushTargetSaved:!!oneSignalSubscriptionId });
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
