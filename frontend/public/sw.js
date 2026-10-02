// Bussola's service worker.
//
// It exists for one thing: to show a notification when the server says an item
// is waiting in the inbox (Web Push), and to open the app when it is tapped.
//
// What it deliberately does NOT do: it has no "fetch" handler and keeps
// nothing in any cache of its own. Bussola is a finance application behind a
// session, and a service worker that stored pages or API answers could show
// one person's figures to the next person at the same browser, or after
// signing out. Every request therefore goes straight to the network, exactly
// as if this file were not here. Do not add offline support to it.
//
// The message is { title, body, url, tag }. url is a path on this origin and
// is checked again below; tag makes a new message replace the previous one.
// Nothing sensitive travels in it: the server only says that something is
// waiting (amount and merchant only if the administrator turned that on).

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// Only a same-origin path is ever opened; anything else becomes the start page.
const safeUrl = (value) => {
  try {
    const url = new URL(typeof value === "string" ? value : "/", self.location.origin);
    return url.origin === self.location.origin ? url.pathname + url.search + url.hash : "/";
  } catch {
    return "/";
  }
};

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const title = typeof data.title === "string" && data.title ? data.title.slice(0, 80) : "Bussola";
  const options = {
    body: typeof data.body === "string" ? data.body.slice(0, 300) : "",
    tag: typeof data.tag === "string" ? data.tag.slice(0, 64) : "bussola",
    // A repeat with the same tag replaces the earlier one: say it buzzes again.
    renotify: true,
    icon: "/icon-192.png",
    data: { url: safeUrl(data.url) },
  };
  // A push must always show something: browsers may revoke the permission of
  // a site that receives one and stays silent.
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = safeUrl(event.notification.data && event.notification.data.url);
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of windows) {
        if (new URL(client.url).origin !== self.location.origin) continue;
        // Reuse an open window: navigate it to the target, then bring it up.
        try {
          if ("navigate" in client && new URL(client.url).pathname !== target) await client.navigate(target);
        } catch {
          /* a window that cannot navigate is still focused below */
        }
        if ("focus" in client) return client.focus();
      }
      return self.clients.openWindow(target);
    })(),
  );
});
