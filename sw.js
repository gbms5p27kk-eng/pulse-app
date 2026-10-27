
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", event => {
  let message = {
    title: "A little moment for you ♡",
    body: "Time for your gentle pelvic floor exercises."
  };

  if (event.data) {
    try {
      message = { ...message, ...event.data.json() };
    } catch (error) {
      // Use the default reminder message.
    }
  }

  event.waitUntil(
    self.registration.showNotification(message.title, {
      body: message.body,
      icon: "./Pulse%20logo.PNG",
      badge: "./Pulse%20logo.PNG",
      tag: "pulse-reminder"
    })
  );
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  event.waitUntil(
    self.clients.openWindow("./")
  );
});
