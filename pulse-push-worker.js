/* Pulse — independent Web Push service worker.
   This worker is intentionally not registered until the new push backend is ready.
   Scope: /pulse-app/
*/
self.addEventListener("push", event => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; }
  catch { payload = { body: event.data ? event.data.text() : "" }; }
  const title = typeof payload.title === "string" ? payload.title : "A little moment for you ♡";
  const options = {
    body: typeof payload.body === "string" ? payload.body : "Time for your gentle pelvic floor exercises.",
    icon: "/pulse-app/Pulse%20logo.PNG",
    badge: "/pulse-app/Pulse%20logo.PNG",
    tag: typeof payload.tag === "string" ? payload.tag : "pulse-reminder",
    data: { url: "/pulse-app/" }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});
self.addEventListener("notificationclick", event => {
  event.notification.close();
  event.waitUntil((async () => {
    const url = new URL("/pulse-app/", self.location.origin).href;
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of clients) {
      if (client.url.startsWith(url) && "focus" in client) return client.focus();
    }
    if (self.clients.openWindow) return self.clients.openWindow(url);
  })());
});
