# Tactical FPS Arena 3D — 10v10 update

## Included changes
- Replaces public 1v1 matchmaking with **10v10 Team Battle** (20 players per public match).
- Tracks and renders every other player in the match.
- Assigns the first 10 players to Alpha and the next 10 to Bravo.
- Uses team score and a 50-elimination team limit by default (`TEAM_KILL_LIMIT` can override it).
- Blocks damage to teammates on the server.
- Keeps solo mode and private 1v1 rooms.
- Requires every player in the 20-player match to press Ready before the countdown begins.

## Important notes
- This project was syntax-checked with `node --check server.js` and `node --check multiplayer.js`.
- A full browser playtest with 20 live clients was not available here. Test on a staging deployment before using it publicly.
- Damage hit detection is still client-side, as in the original project; this is a prototype multiplayer implementation, not an anti-cheat-secure competitive server.
- Public 10v10 matchmaking waits until 20 players are queued. It does not start a smaller match.

## Run locally
Requires Node.js 20 or newer.

```bash
npm install
npm start
```

Open `http://localhost:80` (or the port configured by `PORT`). For local use without permission to bind port 80, set `PORT=3000` and open `http://localhost:3000`.

## Deploying updated code
Uploading these files to GitHub does not by itself update an already-published Edgegap image/version unless your build pipeline is configured to build and publish on each commit. Publish a new build/image using your configured Edgegap workflow, select its new tag in the application version, then create a new deployment. Keep the previous version until the new one has been tested.
