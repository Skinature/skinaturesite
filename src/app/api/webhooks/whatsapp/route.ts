import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { whatsappEnabled, sendAutoReply } from "@/lib/whatsapp";

export const runtime = "nodejs";

/**
 * WhatsApp Cloud API webhook (Meta app -> WhatsApp -> Configuration).
 *
 * GET:  Meta's one-time subscription check. Echoes `hub.challenge` when
 *       `hub.verify_token` matches WHATSAPP_WEBHOOK_VERIFY_TOKEN.
 * POST: incoming events, signed with the Meta app secret
 *       (X-Hub-Signature-256 = "sha256=" + HMAC-SHA256 of the raw body).
 *       - a customer message gets the auto-reply (src/lib/whatsapp.ts), at most
 *         once per number per AUTO_REPLY_GAP_MS so "ok", "thanks" do not each
 *         trigger another copy;
 *       - a failed delivery of one of our messages is logged, so a missing order
 *         message shows up in the Vercel logs.
 *
 * Gated on WHATSAPP_APP_SECRET + the WhatsApp send config: unset means a 200
 * no-op. Valid events always get a 200 quickly, or Meta keeps retrying them.
 */

const AUTO_REPLY_GAP_MS = 12 * 60 * 60 * 1000;
/**
 * Best effort only: lives in this server instance, so a cold start can send one
 * extra auto-reply. Acceptable for a courtesy message; no database needed.
 */
const lastReplyAt = new Map<string, number>();

type WebhookBody = {
  entry?: {
    changes?: {
      field?: string;
      value?: {
        metadata?: { phone_number_id?: string };
        messages?: { from?: string; type?: string }[];
        statuses?: {
          status?: string;
          recipient_id?: string;
          errors?: { code?: number; title?: string }[];
        }[];
      };
    }[];
  }[];
};

/** Logs keep only the last 4 digits of a customer's number. */
function mask(phone: string | undefined): string {
  return phone ? `***${phone.slice(-4)}` : "unknown";
}

function timingSafeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const verifyToken = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
  if (
    verifyToken &&
    params.get("hub.mode") === "subscribe" &&
    params.get("hub.verify_token") === verifyToken
  ) {
    return new Response(params.get("hub.challenge") ?? "", { status: 200 });
  }
  return NextResponse.json({ error: "Forbidden." }, { status: 403 });
}

export async function POST(request: Request) {
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!secret || !whatsappEnabled()) {
    return NextResponse.json({ received: false, reason: "webhook not configured" });
  }

  const raw = await request.text();
  const header = request.headers.get("x-hub-signature-256") ?? "";
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(raw).digest("hex");
  if (!header || !timingSafeEqualHex(expected, header)) {
    return NextResponse.json({ error: "Invalid signature." }, { status: 401 });
  }

  let body: WebhookBody;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Invalid payload." }, { status: 400 });
  }

  const ourNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      // Only events for our own sending number.
      if (!value || change.field !== "messages" || value.metadata?.phone_number_id !== ourNumberId) {
        continue;
      }

      for (const status of value.statuses ?? []) {
        if (status.status === "failed") {
          const error = status.errors?.[0];
          console.error(
            "[whatsapp] delivery failed to",
            mask(status.recipient_id),
            error?.code,
            error?.title
          );
        }
      }

      for (const message of value.messages ?? []) {
        // Reactions and system notices are not someone asking for help.
        if (!message.from || message.type === "reaction" || message.type === "system") continue;
        const now = Date.now();
        const last = lastReplyAt.get(message.from);
        if (last && now - last < AUTO_REPLY_GAP_MS) continue;

        const res = await sendAutoReply(message.from);
        // Only a reply that went out starts the quiet period; a failed one is retried
        // on the customer's next message.
        if (res.sent) lastReplyAt.set(message.from, now);
        else console.error("[whatsapp] auto-reply not sent to", mask(message.from), res.reason);
      }
    }
  }

  return NextResponse.json({ received: true });
}
