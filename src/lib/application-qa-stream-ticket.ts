import { randomBytes } from "crypto";

/**
 * Short-lived tickets so Super Admin EventSource can auth without Authorization
 * headers (EventSource cannot set them). Prefer fetch()+Bearer when possible.
 */

type TicketRecord = {
  userId: string;
  email: string;
  exp: number;
};

const tickets = new Map<string, TicketRecord>();
const TTL_MS = 2 * 60 * 1000; // 2 minutes to open the stream

function sweep(): void {
  const now = Date.now();
  for (const [k, v] of tickets) {
    if (v.exp <= now) tickets.delete(k);
  }
}

export function issueApplicationQaStreamTicket(user: {
  id: string;
  email: string;
}): { ticket: string; expiresIn: number } {
  sweep();
  const ticket = randomBytes(24).toString("hex");
  tickets.set(ticket, {
    userId: user.id,
    email: user.email,
    exp: Date.now() + TTL_MS,
  });
  return { ticket, expiresIn: Math.floor(TTL_MS / 1000) };
}

export function consumeApplicationQaStreamTicket(
  ticket: string
): TicketRecord | null {
  sweep();
  const key = String(ticket || "").trim();
  if (!key) return null;
  const rec = tickets.get(key);
  if (!rec) return null;
  // One-time use after successful stream open is optional; keep until expiry
  // so EventSource auto-reconnect within TTL still works.
  if (rec.exp <= Date.now()) {
    tickets.delete(key);
    return null;
  }
  return rec;
}
