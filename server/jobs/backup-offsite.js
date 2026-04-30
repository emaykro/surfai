"use strict";

/**
 * Off-site backup job: uploads the most recent local pg_dump to an
 * S3-compatible object store (Yandex Object Storage, Selectel, Backblaze
 * B2, Cloudflare R2, MinIO, vanilla AWS S3 — anything that speaks the
 * S3 API). Provider is selected by setting BACKUP_S3_ENDPOINT.
 *
 * Usage:
 *   node server/jobs/backup-offsite.js                   # upload latest daily-*.sql.gz, prune >30d
 *   node server/jobs/backup-offsite.js --dry-run         # report what would happen
 *   node server/jobs/backup-offsite.js --keep-days=60    # custom retention
 *
 * Required env vars:
 *   BACKUP_S3_ENDPOINT       e.g. https://storage.yandexcloud.net
 *   BACKUP_S3_REGION         e.g. ru-central1 (Yandex), auto (R2), us-east-005 (B2)
 *   BACKUP_S3_BUCKET         bucket name
 *   BACKUP_S3_ACCESS_KEY     access key id
 *   BACKUP_S3_SECRET_KEY     secret access key
 *   BACKUP_S3_PREFIX         optional path prefix inside the bucket, e.g. surfai/
 *
 * Telegram alerter posts result to @SurfaiOps_bot when TELEGRAM_BOT_TOKEN
 * + TELEGRAM_ALERT_CHAT_ID are present.
 *
 * Exit codes:
 *   0 success (or dry-run successful)
 *   1 config error (missing env, no local dump, etc.)
 *   2 upload failed
 */

const fs = require("node:fs");
const path = require("node:path");

require("dotenv").config({ path: path.resolve(__dirname, "../../.env") });

const { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } =
  require("@aws-sdk/client-s3");

const BACKUP_DIR = process.env.BACKUP_DIR || "/opt/surfai/backups";
const REQUIRED = ["BACKUP_S3_ENDPOINT", "BACKUP_S3_REGION", "BACKUP_S3_BUCKET", "BACKUP_S3_ACCESS_KEY", "BACKUP_S3_SECRET_KEY"];

function parseArgs(argv) {
  const args = { dryRun: false, keepDays: 30 };
  for (const a of argv.slice(2)) {
    if (a === "--dry-run") args.dryRun = true;
    else if (a.startsWith("--keep-days=")) args.keepDays = parseInt(a.slice(12), 10);
    else if (a === "--help" || a === "-h") args.help = true;
  }
  return args;
}

function findLatestDump() {
  const files = fs
    .readdirSync(BACKUP_DIR)
    .filter((f) => /^daily-\d{4}-\d{2}-\d{2}\.sql\.gz$/.test(f))
    .sort();
  if (!files.length) return null;
  const name = files[files.length - 1];
  const full = path.join(BACKUP_DIR, name);
  const stat = fs.statSync(full);
  return { name, full, size: stat.size, mtime: stat.mtime };
}

async function postTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_ALERT_CHAT_ID;
  if (!token || !chat) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text, parse_mode: "Markdown" }),
    });
  } catch (_) { /* best effort */ }
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log("Usage: node server/jobs/backup-offsite.js [--dry-run] [--keep-days=N]");
    process.exit(0);
  }

  const missing = REQUIRED.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`Missing env vars: ${missing.join(", ")}. Off-site backup not configured — exiting cleanly.`);
    process.exit(1);
  }

  const latest = findLatestDump();
  if (!latest) {
    const msg = `No local dump found in ${BACKUP_DIR}.`;
    console.error(msg);
    await postTelegram(`🔴 backup-offsite: ${msg}`);
    process.exit(1);
  }

  const sizeMb = (latest.size / 1048576).toFixed(1);
  const prefix = (process.env.BACKUP_S3_PREFIX || "").replace(/^\/+|\/+$/g, "");
  const key = (prefix ? `${prefix}/` : "") + latest.name;
  const bucket = process.env.BACKUP_S3_BUCKET;

  console.log(`Latest dump: ${latest.name} (${sizeMb} MB, mtime ${latest.mtime.toISOString()})`);
  console.log(`Target: s3://${bucket}/${key} via ${process.env.BACKUP_S3_ENDPOINT}`);

  if (args.dryRun) {
    console.log("Dry-run: skipping upload and prune.");
    process.exit(0);
  }

  const client = new S3Client({
    endpoint: process.env.BACKUP_S3_ENDPOINT,
    region: process.env.BACKUP_S3_REGION,
    credentials: {
      accessKeyId: process.env.BACKUP_S3_ACCESS_KEY,
      secretAccessKey: process.env.BACKUP_S3_SECRET_KEY,
    },
    forcePathStyle: true,
  });

  // Upload
  try {
    const body = fs.readFileSync(latest.full);
    await client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: "application/gzip",
      ContentLength: body.length,
    }));
    console.log(`Uploaded ${sizeMb} MB → s3://${bucket}/${key}`);
  } catch (err) {
    const msg = `Upload failed: ${err.name} ${err.message}`;
    console.error(msg);
    await postTelegram(`🔴 backup-offsite: ${msg}`);
    process.exit(2);
  }

  // Prune remote
  try {
    const cutoffMs = Date.now() - args.keepDays * 86400 * 1000;
    let pruned = 0;
    let token;
    do {
      const list = await client.send(new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix ? `${prefix}/daily-` : "daily-",
        ContinuationToken: token,
      }));
      const stale = (list.Contents || []).filter(
        (o) => o.Key && /daily-\d{4}-\d{2}-\d{2}\.sql\.gz$/.test(o.Key) && o.LastModified && o.LastModified.getTime() < cutoffMs
      );
      if (stale.length) {
        await client.send(new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: stale.map((o) => ({ Key: o.Key })), Quiet: true },
        }));
        pruned += stale.length;
      }
      token = list.IsTruncated ? list.NextContinuationToken : undefined;
    } while (token);
    console.log(`Pruned ${pruned} remote dumps older than ${args.keepDays} days.`);
    await postTelegram(`🟢 backup-offsite: uploaded ${latest.name} (${sizeMb} MB), pruned ${pruned} stale remote dumps.`);
  } catch (err) {
    // Upload succeeded; prune failure is not critical.
    console.warn(`Prune step failed: ${err.message}`);
    await postTelegram(`🟡 backup-offsite: uploaded ${latest.name} (${sizeMb} MB), prune step failed: ${err.message}`);
  }

  process.exit(0);
}

main().catch(async (err) => {
  console.error(err);
  await postTelegram(`🔴 backup-offsite unexpected error: ${err.message}`);
  process.exit(2);
});
