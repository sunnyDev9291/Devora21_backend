# Devora21 Remote Agent (Phase 2)

Background program for the **remote PC**. It polls the backend queue and saves resume PDF/DOCX to disk with **no click** on this machine.

Requires Phase 1 APIs (`/resume/remote-devices`, `/resume/remote-queue`, `/resume/archives/:id/deliver`).

## Requirements

- Windows PC (or any OS with Node)
- **Node.js 18+**
- Device secret from the web/API (`dvrd_…`)

## One-time setup on remote PC (B)

### 1. Register the device (from laptop A or API)

```http
POST /resume/remote-devices
Authorization: Bearer <user session or dv21_ key>
Content-Type: application/json

{ "name": "Office-B", "setDefault": true }
```

Response includes **`rawSecret`** once — copy it. Example: `dvrd_abc123...`

### 2. Install agent files

Copy the `remote-agent` folder to PC B, or clone this repo and open `remote-agent/`.

```bat
cd remote-agent
copy .env.example .env
notepad .env
```

Edit `.env`:

```env
API_BASE_URL=https://api.devora21.com
DEVICE_SECRET=dvrd_paste_your_secret_here
SAVE_DIR=C:\Users\YourName\Downloads\Devora21
POLL_INTERVAL_MS=5000
OVERWRITE=true
```

### 3. Start the agent

```bat
npm start
```

Leave this window open (or use Task Scheduler below).

Single poll (test):

```bat
npm run once
```

## How delivery works

1. On PC A: create/archive a resume, then:

```http
POST /resume/archives/{archiveId}/deliver
{ "mode": "remote" }
```

2. Agent on B polls `GET /resume/remote-queue`
3. Downloads PDF/DOCX into `SAVE_DIR`
4. Acks `POST /resume/remote-queue/{id}/ack` with `"delivered"`

No browser action on B after the agent is running.

## Auto-start on Windows (optional)

**Task Scheduler**

1. Open Task Scheduler → Create Basic Task
2. Trigger: **When I log on**
3. Action: Start a program
   - Program: `C:\Program Files\nodejs\node.exe`
   - Arguments: `C:\path\to\remote-agent\src\index.js`
   - Start in: `C:\path\to\remote-agent`
4. Finish → enable “Run whether user is logged on or not” if you want (needs password)

Or use [NSSM](https://nssm.cc/) to install as a Windows service pointing at `node src/index.js`.

## Troubleshooting

| Symptom | Check |
|---------|--------|
| `Invalid remote device credentials` | Wrong/revoked `DEVICE_SECRET` |
| Empty queue always | Deliver with `mode: "remote"` and correct default device |
| Download HTTP errors | Signed URL expired — deliver again; agent should pull soon after queue |
| Files missing | Check `SAVE_DIR` permissions; read agent console logs |

## Security

- Treat `DEVICE_SECRET` like a password; do not commit `.env`
- Revoke a lost device: `DELETE /resume/remote-devices/{id}` then register a new one
