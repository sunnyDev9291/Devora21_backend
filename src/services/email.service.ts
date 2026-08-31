import nodemailer from "nodemailer";
import { env, emailEnabled } from "../config/env";

const transporter = emailEnabled
  ? nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_PORT === 465,
      auth: {
        user: env.SMTP_USER,
        pass: env.SMTP_PASS,
      },
    })
  : null;

async function sendMail(to: string, subject: string, html: string): Promise<void> {
  if (!transporter) {
    console.warn(`[email] SMTP not configured. Would send to ${to}: ${subject}`);
    console.warn(`[email] Body: ${html}`);
    return;
  }

  await transporter.sendMail({
    from: env.SMTP_FROM,
    to,
    subject,
    html,
  });
}

/** Sends email without failing the auth request if SMTP rejects the message. */
async function sendMailSafe(to: string, subject: string, html: string): Promise<void> {
  try {
    await sendMail(to, subject, html);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[email] Failed to send to ${to}: ${subject}`);
    console.error(`[email] ${message}`);
  }
}

export async function verifyEmailTransport(): Promise<boolean> {
  if (!transporter) {
    return false;
  }

  await transporter.verify();
  return true;
}

export async function sendVerificationEmail(email: string, token: string): Promise<void> {
  const verifyUrl = `${env.FRONTEND_URL}/verify-email?token=${token}`;
  await sendMailSafe(
    email,
    "Verify your Devora21 account",
    `<p>Click the link below to verify your email:</p>
     <p><a href="${verifyUrl}">${verifyUrl}</a></p>
     <p>Or use this token: <code>${token}</code></p>`
  );
}

export async function sendPasswordResetEmail(email: string, token: string): Promise<void> {
  const resetUrl = `${env.FRONTEND_URL}/reset-password?token=${token}`;
  await sendMailSafe(
    email,
    "Reset your Devora21 password",
    `<p>Click the link below to reset your password:</p>
     <p><a href="${resetUrl}">${resetUrl}</a></p>
     <p>Or use this token: <code>${token}</code></p>
     <p>This link expires in 1 hour.</p>`
  );
}
