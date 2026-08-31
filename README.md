# Devora21 Backend — Authentication API

Node.js + Express + TypeScript authentication backend with email/password, Google, and Microsoft sign-in.

## Stack

- **Runtime:** Node.js, Express, TypeScript
- **Database:** PostgreSQL + Prisma
- **Auth:** bcrypt, JWT (access + refresh), HTTP-only cookies
- **OAuth:** Passport.js (Google OAuth 2.0, Microsoft OAuth 2.0)
- **Validation:** Zod
- **CORS:** credentials enabled for the Netlify frontend

## Quick start

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` with your database URL, JWT secrets, and OAuth credentials.

Generate JWT secrets:

```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

### 3. Set up the database

```bash
npm run db:generate
npm run db:push
```

For production migrations:

```bash
npm run db:migrate
```

### 4. Run

Development:

```bash
npm run dev
```

Production:

```bash
npm run build
npm start
```

Server listens on port **5000** by default.

## API endpoints

| Method | Route | Description |
|--------|-------|-------------|
| `POST` | `/auth/register` | Email/password signup |
| `POST` | `/auth/login` | Email/password login |
| `POST` | `/auth/logout` | Logout (revokes refresh token, clears cookies) |
| `POST` | `/auth/refresh` | Refresh access token using refresh cookie |
| `GET` | `/auth/me` | Get current authenticated user |
| `GET` | `/auth/google` | Start Google OAuth flow |
| `GET` | `/auth/google/callback` | Google OAuth callback |
| `GET` | `/auth/microsoft` | Start Microsoft OAuth flow |
| `GET` | `/auth/microsoft/callback` | Microsoft OAuth callback |
| `POST` | `/auth/forgot-password` | Request password reset email |
| `POST` | `/auth/reset-password` | Reset password with token |
| `POST` | `/auth/verify-email` | Verify email with token |
| `GET` | `/health` | Health check |

## Request / response examples

### Register

```http
POST /auth/register
Content-Type: application/json

{
  "email": "user@example.com",
  "password": "securepassword",
  "firstName": "Jane",
  "lastName": "Doe"
}
```

Response `201`:

```json
{
  "user": {
    "id": "...",
    "email": "user@example.com",
    "firstName": "Jane",
    "lastName": "Doe",
    "avatarUrl": null,
    "provider": "LOCAL",
    "emailVerified": false,
    "createdAt": "..."
  }
}
```

Sets `access_token` and `refresh_token` HTTP-only cookies.

### Login

```http
POST /auth/login
Content-Type: application/json

{
  "email": "user@example.com",
  "password": "securepassword"
}
```

### Get current user

```http
GET /auth/me
Cookie: access_token=...
```

### Refresh token

```http
POST /auth/refresh
Cookie: refresh_token=...
```

### Forgot password

```http
POST /auth/forgot-password
Content-Type: application/json

{ "email": "user@example.com" }
```

### Reset password

```http
POST /auth/reset-password
Content-Type: application/json

{
  "token": "uuid-from-email",
  "password": "newsecurepassword"
}
```

### Verify email

```http
POST /auth/verify-email
Content-Type: application/json

{ "token": "uuid-from-email" }
```

## Frontend integration

The frontend at `https://devora21-dev.netlify.app` must send requests with credentials:

```javascript
fetch("http://31.44.7.64:5000/auth/me", {
  credentials: "include",
});
```

### OAuth flows

- Google: redirect user to `GET /auth/google`
- Microsoft: redirect user to `GET /auth/microsoft`

After successful OAuth, the user is redirected to:

```
https://devora21-dev.netlify.app/dashboard
```

Auth cookies are set on the redirect response.

## CORS

Only `https://devora21-dev.netlify.app` is allowed, with `credentials: true`.

Configure via `FRONTEND_URL` in `.env`.

## Cookies

| Cookie | Purpose | Lifetime |
|--------|---------|----------|
| `access_token` | JWT access token | 15 minutes |
| `refresh_token` | JWT refresh token | 7 days |

Production settings:

- `httpOnly: true`
- `secure: true`
- `sameSite: "none"`

Development uses `secure: false` and `sameSite: "lax"`.

### Cross-origin cookies (Netlify HTTPS → VPS IP)

Because the frontend is HTTPS on Netlify and the backend is HTTP on a raw IP, browsers may block third-party cookies in production mode.

**Recommended fix:** put the API behind HTTPS on a domain, e.g. `https://api.devora21.com`:

1. Set `API_BASE_URL=https://api.devora21.com`
2. Optionally set `COOKIE_DOMAIN=.devora21.com` if frontend moves to `*.devora21.com`
3. Update OAuth callback URLs in Google Cloud Console and Azure Portal

## OAuth setup

### Google

1. Create a project in [Google Cloud Console](https://console.cloud.google.com/)
2. Enable Google+ API / People API
3. Create OAuth 2.0 credentials (Web application)
4. Authorized redirect URI:
   ```
   http://31.44.7.64:5000/auth/google/callback
   ```
   (or `https://api.devora21.com/auth/google/callback` when using HTTPS domain)
5. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in `.env`

### Microsoft

1. Register an app in [Azure Portal](https://portal.azure.com/) → App registrations
2. Add redirect URI (Web):
   ```
   http://31.44.7.64:5000/auth/microsoft/callback
   ```
3. Create a client secret
4. API permissions: `openid`, `profile`, `email`, `User.Read`
5. Set `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, and optionally `MICROSOFT_TENANT_ID` in `.env`

## Email

Configure SMTP in `.env` for verification and password-reset emails. When SMTP is not configured, email content is logged to the console (useful for development).

## Project structure

```
src/
├── app.ts                 # Express app setup
├── server.ts              # Entry point
├── config/
│   ├── env.ts             # Environment validation (Zod)
│   └── passport.ts        # OAuth strategies
├── controllers/
│   └── auth.controller.ts
├── lib/
│   ├── jwt.ts
│   └── prisma.ts
├── middleware/
│   ├── auth.ts
│   ├── errorHandler.ts
│   └── validate.ts
├── routes/
│   └── auth.routes.ts
├── services/
│   ├── auth.service.ts
│   └── email.service.ts
├── utils/
│   └── cookies.ts
└── validators/
    └── auth.validator.ts
prisma/
└── schema.prisma
```

## Resume archive

`POST /resume/archive` — accepts `multipart/form-data` from the Next.js frontend proxy.

| Field | Required |
|-------|----------|
| `jobTitle` | yes |
| `companyName` | yes |
| `jobDescription` | no |
| `datetime` | yes (ISO 8601 UTC) |
| `resume` | yes (`.docx`, max 10 MB) |

**Success `200`:**
```json
{
  "resumeName": "Franco-tailored.docx",
  "pdfFileName": "Franco-tailored.pdf",
  "pdfBase64": "..."
}
```

Saves DOCX under `storage/resumes/{YYYY}/{MM}/{DD}/`, appends `storage/resume_log.csv`, converts to PDF via **LibreOffice headless**.

Install LibreOffice on the server. Optional env: `LIBREOFFICE_PATH`, `STORAGE_DIR`.

See `Documents/RESUME_ARCHIVE_BACKEND.md` (frontend spec) for full details.

## Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Start dev server with hot reload |
| `npm run build` | Compile TypeScript |
| `npm start` | Run compiled production build |
| `npm run db:generate` | Generate Prisma client |
| `npm run db:push` | Push schema to database |
| `npm run db:migrate` | Run migrations |
| `npm run db:studio` | Open Prisma Studio |
