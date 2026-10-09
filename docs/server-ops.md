# Backend server ops (keep the API up)

This Windows box serves `api.devora21.com`. Downtime is almost always from **force-killing** the Node process, not from request errors.

## Rules

1. Run **one** API process only (pm2 name: `devora21-api`).
2. Do **not** restart unless you changed runtime code that needs a reload, or Prisma schema/client.
3. Do **not** “stop all terminals” unless you intentionally want the API offline.
4. Do **not** restart for CORS / Anthropic / AI-JSON errors — those are handled and leave the process running.
5. Prefer `tsx watch` (`npm run pm2:dev`) only while actively iterating; use production start (`npm run pm2:start`) for the public API.

## Everyday commands

```bash
npm run pm2:start      # build + start under pm2 (production)
npm run pm2:dev        # start tsx watch under pm2 (dev only)
npm run pm2:restart    # restart the named process
npm run pm2:stop       # stop (API goes down)
npm run pm2:status     # list pm2 processes
npm run pm2:logs       # follow logs
```

Or via pm2 directly:

```bash
npx pm2 status
npx pm2 restart devora21-api
npx pm2 logs devora21-api
```

Persist the process list after changes:

```bash
npx pm2 save
```

**Windows note:** `pm2 startup` is not supported (no systemd/init). After a reboot, resurrect with:

```bash
npx pm2 resurrect
```

Optional: add a Task Scheduler entry at logon that runs `npx pm2 resurrect` from this repo directory so the API comes back after reboot.

## Prisma / schema regenerate (Windows)

`prisma generate` fails with **EPERM** while Node holds `query_engine-windows.dll.node`. Always stop first:

```bash
npm run pm2:stop
npx prisma generate
npx prisma db push          # if schema changed
npm run build               # if using production start
npm run pm2:start           # or: npm run pm2:restart after start
npx pm2 save
```

Never run `prisma generate` against a live API process on Windows.

## Streaming AI (`POST /ai/chat/completions/stream`)

The handler writes **plain text chunks** (not SSE) and sets `X-Accel-Buffering: no`.
If a reverse proxy sits in front of Node, disable response buffering for this path
or browsers will show an empty body until the full reply finishes (FE stuck on
“Claude · generating…”).

- **nginx:** `proxy_buffering off;` (or honor `X-Accel-Buffering: no`)
- **Caddy:** `flush_interval -1` on the reverse_proxy for `/ai/*`

## What not to do

- Multiple leftover `npm run dev` Cursor terminals competing for port 5000
- Killing whatever is on port 5000 as a habit
- Treating FE/API request failures as a reason to restart the whole server
