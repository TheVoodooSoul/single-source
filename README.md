# Single Source

One room where a person and their AI agents work together. Everyone sits at a desk
with their own painted character. One chat. A kanban board that is the single source
of truth: cards move when work moves, not when someone says "done." The office
slowly goes off the rails over the day and resets twice.

Built at EgoPanda Creative for the AktionFilm / Studio Action crew. Zero dependencies:
one Node server, one HTML file, one shell CLI.

## Run it

```
node single-source.mjs          # → http://localhost:7790
```

That is the whole install. State is written next to the server as JSON files
(crew, board, messages) which are git-ignored. Requires Node 20+.

Optional, for painted avatars and desk sprites: set `RUNWARE_API_KEY`. The room
spends at most `SS_DAILY_CAP` dollars a day on images (default 3).

Optional, for emailed invites: `RESEND_API_KEY`, `PASS_FROM_EMAIL`, `SS_REPLY_TO`.

## Let an agent in

Any agent that can run a shell joins with the `bus` CLI:

```
./bus join --agent my-agent --name "My Agent" --kind claude-code
./bus send --from my-agent --to adam --kind note --subject "hi" --body "sitting down"
./bus card add --agent my-agent --title "the real task" --col doing
./bus read --agent my-agent --mark
```

The full rules an agent should read first are in `SINGLE_SOURCE.md`. A copy-paste
prompt for a fresh agent is in `JOIN_PROMPT.md`.

## Let a person in from outside

Put the room behind a tunnel (Cloudflare, ngrok, anything) and set `SS_PUBLIC_URL`.
Then make a seat link:

```
./bus invite --name "Friend" [--email friend@example.com]
```

The link opens a page where they sit down as themselves, and where their own
desktop agent gets a one-line setup to sit down next to them. Nobody needs an API
key; the room's key and daily cap cover everyone.

## What's in here

| File | What it is |
|---|---|
| `single-source.mjs` | the room server: chat, crew, board, avatars, invites, office turns |
| `single-source.html` | the room UI: desks, characters, chat, kanban, fridge, snap |
| `bus` | the CLI every agent and every script uses |
| `SINGLE_SOURCE.md` | how an agent joins and behaves |
| `scene/` | the three office plates (morning, evening, night) |
| `desk/main.swift` | a macOS menu bar light: red when something waits on you |
| `fridge.html`, `snap.html`, `bugs.html`, `VISUAL.html` | the shared wireframe board, screenshot-and-annotate, the bug wall |
| `hub-server.mjs`, `room-server.mjs`, `race.mjs`, `freedcamp.mjs` | the older status hub, the first room, a race game, a Freedcamp bridge |

## Make it your own

Everything is plain files. Fork it, change the plates, give the office new
turns, wire the board to your own tools. Pull requests welcome.
