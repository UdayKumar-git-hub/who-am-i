# TAIT Presents : WHO AM I? — Local Server Setup

Why this exists: the previous version relied on `window.storage`, an API that
only works inside Claude.ai's own preview. Opened as a plain `.html` file, or
served from any real computer, that API doesn't exist — so admin actions never
saved anywhere, and every screen silently reset. This folder adds a tiny real
server so all devices (admin laptop, TV, team phones) share one live game
state over your local Wi-Fi, with **no internet required**.

## 1. Setup (once, on the laptop that will run the event)

```bash
cd brain-buzz-server
npm install
npm start
```

You'll see something like:

```
BRAIN BUZZ SERVER STARTED

Local:   http://localhost:3000/
Network: http://192.168.1.10:3000/

Open the network URL above on the admin laptop, the TV, and every team phone.
All devices must be on the same Wi-Fi / router. No internet required.
```

## 2. Connect every device

1. Connect the laptop to your local Wi-Fi router (internet not required).
2. Connect every team phone and the TV/projector's browser to the **same**
   router.
3. On each device, open the **Network** URL shown in the terminal
   (e.g. `http://192.168.1.10:3000/`) — not `localhost`, since that only
   works on the laptop itself.
4. Pick the correct role on each device (Admin / TV Display / Team) and log in.

## 3. How it stays in sync

Every device polls the server roughly twice a second and the server keeps one
shared JSON state file (`data/state.json`, created automatically). When the
admin clicks a button, it's saved to the server immediately, and every other
connected screen picks up the change on its next poll (well under a second).

If the server restarts mid-event, the state file survives on disk, so nothing
is lost.

## 4. Troubleshooting

- **Buttons doing nothing / other screens not updating:** make sure every
  device opened the `http://<network-ip>:3000/` address, not a file opened
  directly from disk, and that they're all on the same router.
- **Team phone can't reach the server:** some routers isolate wireless clients
  from each other ("AP/client isolation") — check your router settings and
  disable that if present.
- **Firewall prompt on the laptop:** allow Node.js / this app to accept
  incoming connections on your local network when prompted.
