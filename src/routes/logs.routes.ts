import { Response, NextFunction, Request } from "express";
import { Router } from "express";
import {
  AuthenticatedRequest,
  requireAuth,
  requireResumeBuilder,
} from "../middleware/auth";
import { AppError } from "../middleware/errorHandler";
import {
  getRecentLogs,
  logsFilePathToday,
  subscribeLogs,
  type LogEntry,
} from "../lib/logger";

/**
 * EventSource cannot set Authorization headers. Allow ?access_token= / ?token=
 * (JWT or dv21_ key) for the live log viewer/stream only.
 */
function acceptQueryAccessToken(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  if (!req.headers.authorization) {
    const q = req.query.access_token || req.query.token;
    if (typeof q === "string" && q.trim()) {
      req.headers.authorization = `Bearer ${q.trim()}`;
    }
  }
  next();
}

function entryToSse(entry: LogEntry): string {
  return `data: ${JSON.stringify(entry)}\n\n`;
}

export async function recentLogsHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.authUser?.id) {
      throw new AppError(401, "Authentication required");
    }

    const limitRaw = req.query.limit;
    const limit =
      typeof limitRaw === "string" && /^\d+$/.test(limitRaw)
        ? Number(limitRaw)
        : 200;
    const scope =
      typeof req.query.scope === "string" && req.query.scope.trim()
        ? req.query.scope.trim()
        : undefined;

    res.status(200).json({
      file: logsFilePathToday(),
      count: getRecentLogs(limit, scope).length,
      logs: getRecentLogs(limit, scope),
    });
  } catch (err) {
    next(err);
  }
}

export async function streamLogsHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.authUser?.id) {
      throw new AppError(401, "Authentication required");
    }

    const scope =
      typeof req.query.scope === "string" && req.query.scope.trim()
        ? req.query.scope.trim()
        : undefined;

    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    const send = (entry: LogEntry) => {
      if (scope && entry.scope !== scope && !entry.scope.startsWith(`${scope}.`)) {
        return;
      }
      res.write(entryToSse(entry));
    };

    // Replay recent buffer first so the viewer isn't empty.
    for (const entry of getRecentLogs(100, scope)) {
      send(entry);
    }
    res.write(`event: ready\ndata: ${JSON.stringify({ ok: true })}\n\n`);

    const unsubscribe = subscribeLogs(send);
    const heartbeat = setInterval(() => {
      res.write(`: ping ${new Date().toISOString()}\n\n`);
    }, 15000);

    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  } catch (err) {
    next(err);
  }
}

/** Minimal live log viewer (open in browser while logged in). */
export async function logsViewerHandler(
  _req: AuthenticatedRequest,
  res: Response
): Promise<void> {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.status(200).send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Devora21 live logs</title>
  <style>
    :root { color-scheme: dark; }
    body { margin: 0; font: 13px/1.45 ui-monospace, Consolas, monospace; background: #0b1020; color: #d7e0ff; }
    header { position: sticky; top: 0; display: flex; gap: 12px; align-items: center; padding: 10px 14px; background: #141a2e; border-bottom: 1px solid #243056; }
    header strong { font-size: 14px; }
    header span { opacity: .7; }
    #status { margin-left: auto; }
    #status.ok { color: #6dffa8; }
    #status.bad { color: #ff7b7b; }
    #log { padding: 12px 14px; white-space: pre-wrap; word-break: break-word; }
    .error { color: #ff8e8e; }
    .warn { color: #ffd27a; }
    .info { color: #c9d4ff; }
    .debug { color: #8fa0c8; }
    .meta { color: #7f8db3; }
  </style>
</head>
<body>
  <header>
    <strong>Devora21 live logs</strong>
    <span>SSE /logs/stream</span>
    <label>scope <input id="scope" placeholder="resume / http / remote" style="width:140px" /></label>
    <button id="reconnect" type="button">Reconnect</button>
    <button id="clear" type="button">Clear</button>
    <span id="status">connecting…</span>
  </header>
  <div id="log"></div>
  <script>
    const el = document.getElementById('log');
    const status = document.getElementById('status');
    const scopeInput = document.getElementById('scope');
    const params = new URLSearchParams(location.search);
    const token = params.get('access_token') || params.get('token') || '';
    let es;

    function lineClass(level) {
      if (level === 'error') return 'error';
      if (level === 'warn') return 'warn';
      if (level === 'debug') return 'debug';
      return 'info';
    }

    function append(entry) {
      const div = document.createElement('div');
      div.className = lineClass(entry.level);
      div.textContent = entry.ts + ' [' + entry.level.toUpperCase() + '] [' + entry.scope + '] ' + entry.message;
      if (entry.meta) {
        const m = document.createElement('span');
        m.className = 'meta';
        m.textContent = ' ' + JSON.stringify(entry.meta);
        div.appendChild(m);
      }
      el.appendChild(div);
      if (el.childNodes.length > 1500) el.removeChild(el.firstChild);
      window.scrollTo(0, document.body.scrollHeight);
    }

    function connect() {
      if (es) es.close();
      const scope = scopeInput.value.trim();
      const q = new URLSearchParams();
      if (scope) q.set('scope', scope);
      if (token) q.set('access_token', token);
      const url = '/logs/stream' + (q.toString() ? ('?' + q.toString()) : '');
      status.textContent = 'connecting…';
      status.className = '';
      es = new EventSource(url, { withCredentials: true });
      es.onopen = () => { status.textContent = 'live'; status.className = 'ok'; };
      es.onerror = () => { status.textContent = 'disconnected (login or ?access_token= required)'; status.className = 'bad'; };
      es.onmessage = (ev) => {
        try { append(JSON.parse(ev.data)); } catch (_) {}
      };
    }

    document.getElementById('reconnect').onclick = connect;
    document.getElementById('clear').onclick = () => { el.textContent = ''; };
    scopeInput.addEventListener('change', connect);
    connect();
  </script>
</body>
</html>`);
}

const router = Router();

router.use(acceptQueryAccessToken);
router.get("/viewer", requireAuth, requireResumeBuilder, logsViewerHandler);
router.get("/recent", requireAuth, requireResumeBuilder, recentLogsHandler);
router.get("/stream", requireAuth, requireResumeBuilder, streamLogsHandler);

export default router;
