# Devora21 Auth API Spec

Base URL: `http://31.44.7.64:5000`

All auth routes are prefixed with `/auth`. The frontend must send **`credentials: "include"`** on every request so HTTP-only cookies are sent.

## CORS

| Setting | Value |
|---------|-------|
| Allowed origin | `https://devora21-dev.netlify.app` |
| Credentials | `true` |
| Methods | GET, POST, PUT, PATCH, DELETE, OPTIONS |
| Headers | Content-Type, Authorization |

## Cookies (set by backend, not readable by JS)

| Cookie | Purpose | Lifetime |
|--------|---------|----------|
| `access_token` | JWT access token | 15 min |
| `refresh_token` | JWT refresh token | 7 days |

Cookie flags when API is HTTPS: `httpOnly`, `secure`, `sameSite: "none"`.

---

## Types

### User (safe, returned in responses)

```typescript
interface User {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  avatarUrl: string | null;
  provider: "LOCAL" | "GOOGLE" | "MICROSOFT";
  emailVerified: boolean;
  createdAt: string; // ISO 8601
}
```

### Error response

```typescript
interface ErrorResponse {
  error: string;
  details?: Record<string, string[]>; // validation errors only
}
```

---

## Endpoints

### POST `/auth/register`

Create account with email/password.

**Request body:**
```json
{
  "email": "user@example.com",
  "password": "minimum8chars",
  "firstName": "Jane",
  "lastName": "Doe"
}
```

`firstName` and `lastName` are optional.

**Success `201`:**
```json
{
  "user": { /* User */ }
}
```

Sets `access_token` + `refresh_token` cookies. Sends verification email.

**Errors:** `400` validation, `409` email already registered

---

### POST `/auth/login`

**Request body:**
```json
{
  "email": "user@example.com",
  "password": "yourpassword"
}
```

**Success `200`:**
```json
{
  "user": { /* User */ }
}
```

Sets auth cookies.

**Errors:** `400` validation, `401` invalid credentials

---

### POST `/auth/logout`

No body required. Sends refresh cookie.

**Success `200`:**
```json
{
  "message": "Logged out successfully"
}
```

Clears auth cookies and revokes refresh token.

---

### POST `/auth/refresh`

No body required. Sends `refresh_token` cookie.

**Success `200`:**
```json
{
  "message": "Token refreshed"
}
```

Rotates refresh token and sets new auth cookies.

**Errors:** `401` missing/invalid/expired refresh token

---

### GET `/auth/me`

Requires `access_token` cookie.

**Success `200`:**
```json
{
  "user": { /* User */ }
}
```

**Errors:** `401` not authenticated

---

### GET `/auth/google`

Browser redirect — no fetch. Starts Google OAuth.

On success → redirect to `https://devora21-dev.netlify.app/dashboard` with cookies set.

On failure → redirect to `https://devora21-dev.netlify.app/login?error=google_auth_failed`

**Errors:** `503` if Google OAuth not configured in `.env`

---

### GET `/auth/microsoft`

Browser redirect — no fetch. Starts Microsoft OAuth.

Same redirect behavior as Google (`dashboard` or `login?error=microsoft_auth_failed`).

---

### POST `/auth/forgot-password`

**Request body:**
```json
{
  "email": "user@example.com"
}
```

**Success `200` (always, to prevent email enumeration):**
```json
{
  "message": "If an account with that email exists, a reset link has been sent"
}
```

Email contains link: `https://devora21-dev.netlify.app/reset-password?token=<uuid>`

---

### POST `/auth/reset-password`

**Request body:**
```json
{
  "token": "uuid-from-email",
  "password": "newpassword8+"
}
```

**Success `200`:**
```json
{
  "message": "Password reset successfully"
}
```

**Errors:** `400` invalid/expired token

---

### POST `/auth/verify-email`

**Request body:**
```json
{
  "token": "uuid-from-email"
}
```

**Success `200`:**
```json
{
  "message": "Email verified successfully",
  "user": { /* User with emailVerified: true */ }
}
```

**Errors:** `400` invalid/expired token

---

### GET `/health`

**Success `200`:**
```json
{
  "status": "ok",
  "timestamp": "2026-06-13T12:00:00.000Z"
}
```

---

## Frontend client example

```typescript
const API_BASE = "http://31.44.7.64:5000";

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "Request failed");
  return data;
}

// Register
await api("/auth/register", {
  method: "POST",
  body: JSON.stringify({ email, password, firstName, lastName }),
});

// Login
await api("/auth/login", {
  method: "POST",
  body: JSON.stringify({ email, password }),
});

// Current user
const { user } = await api<{ user: User }>("/auth/me");

// Refresh (call when /auth/me returns 401)
await api("/auth/refresh", { method: "POST" });

// Logout
await api("/auth/logout", { method: "POST" });

// OAuth — use window.location, not fetch
window.location.href = `${API_BASE}/auth/google`;
window.location.href = `${API_BASE}/auth/microsoft`;
```

## OAuth callback URLs (register in provider consoles)

| Provider | Callback URL |
|----------|--------------|
| Google | `http://31.44.7.64:5000/auth/google/callback` |
| Microsoft | `http://31.44.7.64:5000/auth/microsoft/callback` |

When HTTPS domain is ready, update to `https://api.devora21.com/auth/.../callback`.

## Cross-origin cookie note

Netlify (HTTPS) → VPS IP (HTTP) cannot use `SameSite=None; Secure` cookies until the API is on HTTPS. Move to `https://api.devora21.com` or add a Netlify proxy for full cookie support.
