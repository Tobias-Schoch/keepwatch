# Keepwatch dashboard (web UI)

React + TypeScript + Vite + Tailwind, design system "Obsidian" (`src/design/`).
The Python backend in `../server` serves the built files from `dist/` and the API under `/api`
(see `../API.md`).

```sh
npm ci
npm run build      # type-check + production build into dist/
```

## Mock mode (no server needed)

```sh
npm run mock       # opens http://localhost:5173/?mock
```

Everything runs against an in-browser mock backend (`src/mock*.ts`): a made-up server
`keep` (203.0.113.10) with a few apps (`shop`, `blog`, `web`, `wiki`, `photos`) behind the
reverse proxy. Writes (backups, redeploys, unbans, settings, …) are simulated in memory.
`VITE_MOCK=1 npm run dev` does the same without the query parameter.

### Simulating disabled modules

By default every module is on. Pass a module list in the address:

| Address | Result |
| --- | --- |
| `/?mock&modules=-proxy,-portainer` | everything except the reverse proxy and Portainer |
| `/?mock&modules=docker,backup` | only these modules (plus `base` and `dashboard`) |
| `/?mock&modules=-docker` | no Docker – and so no proxy, Portainer, image scan, log archive |
| `/?mock&modules=-passkey` | no passkey confirmation for dangerous actions |

Or set it at startup: `VITE_MOCK_MODULES=-proxy,-portainer npm run mock`.
Dependencies follow the modules' `REQUIRES` (e.g. `ban-history` needs `fail2ban`).

Other mock switches: `&fresh` (fresh install: Tailscale not logged in, no Portainer token,
no off-site backup), `&ts` (request comes via Tailscale, so port 22 may be closed),
`&closed` (port 22 closed two hours ago).

## Against a real server

The dashboard listens on `127.0.0.1:9004` on the server only. Open a tunnel and start the dev server:

```sh
./keepwatch tunnel                              # from the repository root, or: ssh -L 9004:127.0.0.1:9004 root@<server>
npm run dev                                     # proxies /api to 127.0.0.1:9004
DASH_API=http://localhost:19004 npm run dev     # backend on another local port
```

## How modules are handled

At startup the UI loads `GET /api/config` (`src/config.tsx`): installed modules, the user's
timezone (`KW_LOCAL_TZ` – all times are shown in it), ports and whether passkeys are on. Pages,
dock entries, cards, settings, ⌘K commands and polling of disabled modules are hidden; an old
link to a hidden page lands on the overview. If `/api/config` fails (older backend), every module
counts as enabled.

Use `has("<module>")` (or `useHas`) from `src/config.tsx` to gate new UI.
