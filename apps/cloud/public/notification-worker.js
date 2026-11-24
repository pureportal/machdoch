self.addEventListener("push", (event) => {
  const message = event.data.json();
  event.waitUntil(
    self.registration.showNotification(message.title, {
      body: message.body,
      data: { url: message.url },
      tag: message.url,
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(self.clients.openWindow(event.notification.data.url));
});
