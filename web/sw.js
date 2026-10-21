// Service worker for Trabajo Yebuchee: push notifications, and the offline answer Chrome
// requires before it will call the app installable.
//
// Deliberately caches NOTHING. This app is API-driven and behind auth, so a caching
// worker would serve stale job lists and, worse, hand a cached authenticated page to
// whoever opens the browser next. The fetch handler below is pure passthrough with a
// message for the offline case.

// The app icon: a PNG, because Chrome does not render SVG notification icons.
var ICON = '/icon-192.png';

var OFFLINE = '<!doctype html><html lang="ru"><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>Нет сети</title>'
    + '<body style="background:#0f0f0f;color:#f0f0f0;font-family:-apple-system,'
    + 'BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;display:flex;height:100vh;margin:0;'
    + 'align-items:center;justify-content:center;text-align:center">'
    + '<div><div style="font-size:48px">📡</div>'
    + '<p style="color:#888">Нет соединения. Данные живут на сервере — '
    + 'открой снова, когда сеть вернётся.</p></div>';

self.addEventListener('install', function() { self.skipWaiting(); });
self.addEventListener('activate', function(e) { e.waitUntil(self.clients.claim()); });

self.addEventListener('fetch', function(event) {
    // Only page loads get a fallback; a failed API call must stay a failed API call so
    // the app's own error handling sees it.
    if (event.request.mode !== 'navigate') return;
    event.respondWith(fetch(event.request).catch(function() {
        return new Response(OFFLINE, {
            status: 503,
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
    }));
});

self.addEventListener('push', function(event) {
    var payload = {};
    try {
        payload = event.data ? event.data.json() : {};
    } catch (err) {
        payload = { body: event.data ? event.data.text() : '' };
    }
    var title = payload.title || 'Trabajo Yebuchee';
    event.waitUntil(self.registration.showNotification(title, {
        body: payload.body || '',
        icon: ICON,
        badge: ICON,
        // Same tag replaces the previous notification instead of stacking: two auto-runs
        // three hours apart should leave one current message, not a pile.
        tag: payload.tag || 'pt',
        renotify: true,
        data: { url: payload.url || './' }
    }));
});

self.addEventListener('notificationclick', function(event) {
    event.notification.close();
    // Resolved against the worker's scope, so the app URL is never hardcoded here.
    var target = new URL((event.notification.data && event.notification.data.url) || './',
                         self.registration.scope).href;
    event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true })
        .then(function(clients) {
            for (var i = 0; i < clients.length; i++) {
                // Already open somewhere: focus that tab rather than opening a second.
                if (clients[i].url.indexOf(self.registration.scope) === 0 && clients[i].focus) {
                    clients[i].navigate(target);
                    return clients[i].focus();
                }
            }
            return self.clients.openWindow(target);
        }));
});
