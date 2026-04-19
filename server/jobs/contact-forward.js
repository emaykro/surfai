"use strict";

/**
 * Contact bot forwarder — polls @Surfaiask_bot (the landing-page contact
 * endpoint) for incoming messages, auto-replies to the sender, and
 * forwards the message to the admin chat through @SurfaiOps_bot.
 *
 * Runs every 60s via surfai-contact-forward.timer. Maintains a state
 * file with the last-processed update_id so messages are never sent twice.
 *
 * Env vars:
 *   CONTACT_BOT_TOKEN          required — @Surfaiask_bot token (reads + auto-reply)
 *   TELEGRAM_BOT_TOKEN         required — @SurfaiOps_bot token (sends forwards to admin)
 *   TELEGRAM_ALERT_CHAT_ID     required — admin chat id (same one health-alert uses)
 *   CONTACT_STATE_FILE         default /var/lib/surfai-contact/state.json
 *   CONTACT_AUTOREPLY_TEXT     default — the standard "we got your message" text
 */

require("dotenv").config({ path: require("path").resolve(__dirname, "../../.env") });
const fs = require("fs");
const path = require("path");

const CONTACT_TOKEN = process.env.CONTACT_BOT_TOKEN;
const ADMIN_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.TELEGRAM_ALERT_CHAT_ID;
const STATE_FILE = process.env.CONTACT_STATE_FILE || "/var/lib/surfai-contact/state.json";

const DEFAULT_AUTOREPLY =
  "Спасибо, получили ваше сообщение. Ответим в течение дня.\n\n" +
  "— Команда SURFAI";
const AUTOREPLY_TEXT = process.env.CONTACT_AUTOREPLY_TEXT || DEFAULT_AUTOREPLY;

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { last_update_id: 0, replied_chats: [] };
  }
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function tg(token, method, params) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  const json = await res.json();
  if (!json.ok) {
    throw new Error(`${method} failed: ${json.description || res.status}`);
  }
  return json.result;
}

function formatSender(msg) {
  const from = msg.from || {};
  const parts = [from.first_name, from.last_name].filter(Boolean).join(" ") || "Unknown";
  const username = from.username ? ` (@${from.username})` : "";
  return `${parts}${username}`;
}

function formatAdminNotification(msg) {
  const chatId = msg.chat?.id ?? msg.from?.id ?? "?";
  const sender = formatSender(msg);
  const ts = new Date(msg.date * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC";
  const body = msg.text || (msg.caption ? `[${msg.caption}]` : "[нетекстовое сообщение]");

  // HTML mode — safer for arbitrary user content. Escape <>&.
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  return (
    `📩 <b>Новое обращение</b> в @Surfaiask_bot\n\n` +
    `<b>От:</b> ${esc(sender)}\n` +
    `<b>Chat ID:</b> <code>${esc(chatId)}</code>\n` +
    `<b>Time:</b> ${esc(ts)}\n\n` +
    `<i>${esc(body)}</i>`
  );
}

async function main() {
  for (const [name, val] of Object.entries({ CONTACT_BOT_TOKEN: CONTACT_TOKEN, TELEGRAM_BOT_TOKEN: ADMIN_TOKEN, TELEGRAM_ALERT_CHAT_ID: ADMIN_CHAT_ID })) {
    if (!val) {
      console.error(`${name} is not set`);
      process.exit(1);
    }
  }

  const state = loadState();
  const repliedSet = new Set(state.replied_chats || []);

  // Fetch new updates starting after last processed id.
  const offset = (state.last_update_id || 0) + 1;
  let updates;
  try {
    updates = await tg(CONTACT_TOKEN, "getUpdates", {
      offset: String(offset),
      timeout: "0",
      allowed_updates: JSON.stringify(["message"]),
    });
  } catch (err) {
    console.error("getUpdates failed:", err.message);
    process.exit(2);
  }

  if (!updates.length) {
    console.log(`no new updates (offset=${offset})`);
    return;
  }

  let processed = 0;
  let maxUpdateId = state.last_update_id || 0;

  for (const upd of updates) {
    maxUpdateId = Math.max(maxUpdateId, upd.update_id);
    const msg = upd.message;
    if (!msg || msg.from?.is_bot) continue;

    const chatId = msg.chat?.id;

    // 1) Auto-reply to the sender (once per chat — no spam on every message).
    if (chatId && !repliedSet.has(chatId)) {
      try {
        await tg(CONTACT_TOKEN, "sendMessage", {
          chat_id: String(chatId),
          text: AUTOREPLY_TEXT,
          parse_mode: "Markdown",
        });
        repliedSet.add(chatId);
      } catch (err) {
        console.error(`auto-reply to ${chatId} failed:`, err.message);
        // Keep going — admin notification is more important than the ack.
      }
    }

    // 2) Forward to admin chat via the ops bot.
    //
    // We used to add an inline button "Открыть чат с автором" pointing at
    // tg://user?id=<chat_id>, but Telegram rejects this with
    // BUTTON_USER_INVALID — bots can't create buttons to arbitrary users
    // by numeric id. If the sender has a username, fall back to a public
    // https://t.me/<username> button; otherwise the admin can still tap
    // the @username in the notification body (Telegram auto-linkifies it).
    try {
      const adminText = formatAdminNotification(msg);
      const params = {
        chat_id: String(ADMIN_CHAT_ID),
        text: adminText,
        parse_mode: "HTML",
        disable_web_page_preview: "true",
      };
      const username = msg.from?.username;
      if (username) {
        params.reply_markup = JSON.stringify({
          inline_keyboard: [[{ text: `Открыть @${username}`, url: `https://t.me/${username}` }]],
        });
      }

      await tg(ADMIN_TOKEN, "sendMessage", params);
      processed++;
    } catch (err) {
      console.error(`admin forward failed for update_id=${upd.update_id}:`, err.message);
      // Don't advance past this update on forwarding failure — we'd lose the message.
      // Save what we've done so far, exit non-zero so systemd logs a failure.
      saveState({
        last_update_id: Math.max(0, upd.update_id - 1),
        replied_chats: Array.from(repliedSet),
      });
      process.exit(3);
    }
  }

  saveState({ last_update_id: maxUpdateId, replied_chats: Array.from(repliedSet) });
  console.log(`processed ${processed} message(s), new offset: ${maxUpdateId + 1}`);
}

main().catch((err) => {
  console.error("contact-forward failed:", err);
  process.exit(1);
});
