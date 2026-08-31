# Devora21 Authentication — Saved Context

> **Status:** Backend code is built. Deployment (PostgreSQL + server start + OAuth/SMTP) deferred for later implementation.  
> **Saved:** June 2026  
> **Project path:** `C:\Users\Administrator\Music\devora21_backend`

---

## Architecture

| Component | URL / Location |
|-----------|----------------|
| Frontend | `https://devora21-dev.netlify.app` (Next.js, auth UI complete) |
| Backend API | `http://31.44.7.64:5000` (VPS Windows Server) |
| Future API (recommended) | `https://api.devora21.com` (HTTPS for cross-origin cookies) |

Frontend must use `credentials: "include"` on all API requests.

---

## What's Already Built (Backend)

Full auth backend code exists and compiles. Stack:

- Node.js + Express + TypeScript
- PostgreSQL + Prisma
- bcrypt (password hashing)
- JWT access + refresh tokens in HTTP-only cookies
- Passport.js (Google + Microsoft OAuth)
- Zod validation
- CORS locked to Netlify frontend

### Routes (all under `/auth`)

| Method | Route | Description |
|--------|-------|-------------|
| POST | `/auth/register` | Email/password signup |
| POST | `/auth/login` | Email/password login |
| POST | `/auth/logout` | Revoke refresh token, clear cookies |
| POST | `/auth/refresh` | Rotate tokens via refresh cookie |
| GET | `/auth/me` | Current user (requires access cookie) |
| GET | `/auth/google` | Start Google OAuth |
| GET | `/auth/google/callback` | Google callback → redirect dashboard |
| GET | `/auth/microsoft` | Start Microsoft OAuth |
| GET | `/auth/microsoft/callback` | Microsoft callback → redirect dashboard |
| POST | `/auth/forgot-password` | Send reset email |
| POST | `/auth/reset-password` | Reset with token |
| POST | `/auth/verify-email` | Verify with token |
| GET | `/health` | Health check |

OAuth success redirect: `https://devora21-dev.netlify.app/dashboard`  
OAuth failure redirect: `https://devora21-dev.netlify.app/login?error=...`

### Project structure

```
devora21_backend/
├── src/
│   ├── app.ts              # Express + CORS + middleware
│   ├── server.ts           # Entry (binds 0.0.0.0:5000)
│   ├── config/env.ts       # Zod-validated env
│   ├── config/passport.ts  # Google + Microsoft strategies
│   ├── controllers/auth.controller.ts
│   ├── routes/auth.routes.ts
│   ├── services/auth.service.ts
│   ├── services/email.service.ts
│   ├── middleware/auth.ts, validate.ts, errorHandler.ts
│   ├── validators/auth.validator.ts
│   ├── lib/jwt.ts, prisma.ts
│   └── utils/cookies.ts
├── prisma/schema.prisma
├── API_SPEC.md             # Full request/response shapes for frontend
├── README.md
├── .env.example
└── AUTH_CONTEXT.md         # This file
```

---

## Environment & Tools Needed

### Required

| Tool | Notes |
|------|-------|
| Node.js 18+ (22 recommended) | Runtime |
| npm | Package manager |
| PostgreSQL 14+ | Local VPS or managed (Neon, Supabase, Railway) |

### Required `.env` (minimum)

```env
NODE_ENV=production
PORT=5000
DATABASE_URL=postgresql://devora21:devora21@localhost:5432/devora21
JWT_ACCESS_SECRET=<64-char random hex>
JWT_REFRESH_SECRET=<64-char random hex>
FRONTEND_URL=https://devora21-dev.netlify.app
API_BASE_URL=http://31.44.7.64:5000
```

Generate secrets:
```powershell
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

### Production VPS extras

- Firewall: open port **5000**
- **PM2** (recommended): keep server running in background
- **HTTPS + domain** (recommended): for cross-origin cookies from Netlify

### Optional (implement later — all have free tiers)

| Feature | Env vars | Free? |
|---------|----------|-------|
| Google OAuth | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Yes |
| Microsoft OAuth | `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_TENANT_ID=common` | Yes |
| SMTP email | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | Yes (SendGrid, Resend, Brevo free tiers) |

Without OAuth env vars: Google/Microsoft routes return `503`.  
Without SMTP: verification and reset emails log to console only.

---

## Manual Deployment Steps (when ready)

### 1. PostgreSQL

**Option A — Local (VPS):**
- Install from https://www.postgresql.org/download/windows/
- Service: `postgresql-x64-16` (was partially installed on VPS)
- Superuser password from installer: `devora21admin` (if using that install)

Create DB:
```sql
CREATE USER devora21 WITH PASSWORD 'devora21';
CREATE DATABASE devora21 OWNER devora21;
GRANT ALL PRIVILEGES ON DATABASE devora21 TO devora21;
```

**Option B — Managed (fastest):**
- Neon / Supabase / Railway → paste connection string as `DATABASE_URL`

### 2. Firewall

```powershell
New-NetFirewallRule -DisplayName "Devora21 API" -Direction Inbound -Protocol TCP -LocalPort 5000 -Action Allow
```

### 3. Configure & run

```powershell
cd C:\Users\Administrator\Music\devora21_backend
copy .env.example .env
# Edit .env with real values

npm install
npm run db:generate
npm run db:push
npm run build
npm start
```

### 4. Verify

```powershell
Invoke-RestMethod http://31.44.7.64:5000/health
```

### 5. Keep running (PM2)

```powershell
npm install -g pm2
pm2 start dist/server.js --name devora21-api
pm2 save
pm2 startup
```

---

## OAuth Setup (when ready — free)

### Google

1. [Google Cloud Console](https://console.cloud.google.com/) → OAuth 2.0 Client (Web)
2. Redirect URI: `http://31.44.7.64:5000/auth/google/callback`
   - Later: `https://api.devora21.com/auth/google/callback`
3. Add `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` to `.env`

### Microsoft

1. [Azure Portal](https://portal.azure.com/) → App registrations
2. Redirect URI: `http://31.44.7.64:5000/auth/microsoft/callback`
3. Permissions: `openid`, `profile`, `email`, `User.Read`
4. Add `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_TENANT_ID=common`

---

## SMTP Setup (when ready — free tiers)

Example SendGrid:
```env
SMTP_HOST=smtp.sendgrid.net
SMTP_PORT=587
SMTP_USER=apikey
SMTP_PASS=<sendgrid-api-key>
SMTP_FROM=noreply@devora21.com
```

Email links point to frontend:
- Verify: `https://devora21-dev.netlify.app/verify-email?token=...`
- Reset: `https://devora21-dev.netlify.app/reset-password?token=...`

---

## Cookies & CORS

### CORS
- Origin: `https://devora21-dev.netlify.app` only
- `credentials: true`

### Cookies
| Cookie | Lifetime | Purpose |
|--------|----------|---------|
| `access_token` | 15 min | JWT access |
| `refresh_token` | 7 days | JWT refresh |

When `API_BASE_URL` is HTTPS:
- `httpOnly: true`, `secure: true`, `sameSite: "none"`

When HTTP (current IP setup):
- `secure: false`, `sameSite: "lax"` — **cross-origin cookies from Netlify will NOT work**

**Fix for production cookies:** Put API on HTTPS (`https://api.devora21.com`) or use Netlify proxy to backend.

Optional: `COOKIE_DOMAIN=.devora21.com` when frontend and API share parent domain.

---

## API Quick Reference (for frontend)

See **`API_SPEC.md`** for full shapes. Summary:

```typescript
const API = "http://31.44.7.64:5000";

// All requests
fetch(`${API}/auth/me`, { credentials: "include" });

// Register / login
fetch(`${API}/auth/register`, {
  method: "POST",
  credentials: "include",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email, password, firstName, lastName }),
});

// OAuth (browser redirect, not fetch)
window.location.href = `${API}/auth/google`;
window.location.href = `${API}/auth/microsoft`;
```

### User object returned by API

```typescript
interface User {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  avatarUrl: string | null;
  provider: "LOCAL" | "GOOGLE" | "MICROSOFT";
  emailVerified: boolean;
  createdAt: string;
}
```

---

## VPS State (as of last session)

| Item | Status |
|------|--------|
| Backend code | Built, `npm run build` succeeds |
| PostgreSQL service | `postgresql-x64-16` Running (installer completed) |
| `devora21` database | **Not created yet** — run SQL from Step 1 |
| API server (port 5000) | **Not started** |
| Google/Microsoft OAuth | Not configured in `.env` |
| SMTP | Not configured |

---

## Implementation Order (suggested for later)

1. PostgreSQL — create `devora21` DB + user
2. `.env` — JWT secrets + `DATABASE_URL`
3. `npm run db:push` → `npm run build` → `npm start`
4. Firewall port 5000
5. Test `/health`, `/auth/register`, `/auth/login`, `/auth/me` with frontend
6. HTTPS domain (when ready) — update `API_BASE_URL`, OAuth callbacks
7. Google OAuth credentials
8. Microsoft OAuth credentials
9. SMTP for verify/reset emails
10. PM2 for production process management

---

## Related files in this repo

| File | Purpose |
|------|---------|
| `API_SPEC.md` | Full API contract for frontend alignment |
| `README.md` | Setup docs and examples |
| `.env.example` | All environment variable templates |
| `prisma/schema.prisma` | User, RefreshToken, PasswordReset, EmailVerification models |

---

## Notes

- Frontend auth UI is complete on Netlify; backend activation unblocks end-to-end auth.
- Do **not** commit `.env` (contains secrets).
- Minimum to go live: Node + PostgreSQL + JWT secrets only. OAuth and SMTP are additive.
- Interrupted PostgreSQL installs on VPS left partial files in `%TEMP%`; final install via GUI or silent installer succeeded with service running.
