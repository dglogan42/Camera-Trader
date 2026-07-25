/**
 * Example Express server:
 *  - Stripe webhook handlers (signature verification)
 *  - Stolen serial proxy (/api/stolen-check)
 *  - ExifTool shutter count (/api/exif-shutter)
 *  - Static file hosting for the MVP
 *  - Idempotency-Key support on cash transfers
 *
 * Usage:
 *   npm install
 *   STRIPE_WEBHOOK_SECRET=whsec_xxx STRIPE_SECRET_KEY=sk_test_xxx node server-webhooks.example.js
 *
 * Without Stripe keys, webhooks/transfers run in simulation mode.
 */

import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import { createHmac, timingSafeEqual, randomUUID } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8787;

const STOLEN_API_URL = process.env.STOLEN_API_URL || null;
const STOLEN_API_KEY = process.env.STOLEN_API_KEY || null;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || null;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || null;

const LOCAL_STOLEN = new Set(['SN12345678', 'STOLEN999', 'HOTCAM001']);
const idempotencyStore = new Map(); // key -> { body, status, createdAt }

const app = express();
app.use(cors({ origin: true }));

// Stripe needs raw body for signature verification
app.post(
  '/webhooks/stripe',
  express.raw({ type: 'application/json' }),
  (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
      if (STRIPE_WEBHOOK_SECRET && sig) {
        event = verifyStripeSignature(req.body, sig, STRIPE_WEBHOOK_SECRET);
      } else {
        event = JSON.parse(req.body.toString('utf8'));
        console.warn('[webhook] No STRIPE_WEBHOOK_SECRET — skipped verify');
      }
    } catch (err) {
      console.error('Webhook signature failed', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    handleStripeEvent(event)
      .then(() => res.json({ received: true }))
      .catch((e) => {
        console.error(e);
        res.status(500).json({ error: e.message });
      });
  }
);

app.use(express.json());

// ---- Stolen check proxy ----
app.post('/api/stolen-check', async (req, res) => {
  const serial = String(req.body?.serial || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '');
  if (!serial) return res.status(400).json({ error: 'serial required' });

  if (STOLEN_API_URL) {
    try {
      const r = await fetch(STOLEN_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(STOLEN_API_KEY ? { Authorization: `Bearer ${STOLEN_API_KEY}` } : {}),
        },
        body: JSON.stringify({ serial }),
      });
      if (r.ok) {
        const data = await r.json();
        return res.json({ stolen: !!data.stolen, source: 'upstream', ...data });
      }
    } catch (e) {
      console.warn('Upstream stolen API failed', e.message);
    }
  }

  const stolen = LOCAL_STOLEN.has(serial);
  res.json({
    stolen,
    source: 'local-mock',
    serial,
    // NZ Police: no public camera serial API — reporting links only
    police: {
      note:
        'NZ Police do not offer a public camera serial lookup. Use 105 Online to report. Commercial options (e.g. SeriSafe) may offer dealer checks — contact providers for API terms.',
      faqLostStolenFound:
        'https://www.police.govt.nz/faq/questions-by-category/lost-stolen-found-property',
      reportStolen: 'https://www.police.govt.nz/use-105/stolen-property',
      reportStolenForm: 'https://webforms.police.govt.nz/en/form/stolen-property',
      serialNumbers:
        'https://www.police.govt.nz/faq/it-worth-keeping-serial-numbers-case-property-lost-or-stolen',
      secondhandDealers:
        'https://www.police.govt.nz/advice-services/businesses-and-organisations/secondhand-dealers-and-pawnbrokers/secondhand-dealers',
      ecoStolenGoods:
        'https://ecotechnologies.nz/resources/knowledge-base/stolen-goods/',
      seriSafe: 'https://serisafe.com/',
      stoleMe: 'http://www.stoleme.co.nz/',
      tcfStolenPhones:
        'https://www.tcf.org.nz/consumers/mobile/lost-stolen-phones/check-your-handsets-status/',
      snapDecommissioned:
        'https://www.police.govt.nz/about-site-and-nz-police-app/other-sites/snap-decommissioning',
      snapNote:
        'SNAP (snap.org.nz / Serial Number Action Partnership) was decommissioned by NZ Police on 15 December 2021. Do not use as a live serial check.',
    },
  });
});

// ---- ExifTool shutter extraction ----
const upload = multer({
  dest: path.join(__dirname, '.tmp-uploads'),
  limits: { fileSize: 40 * 1024 * 1024 },
});
fs.mkdirSync(path.join(__dirname, '.tmp-uploads'), { recursive: true });

app.post('/api/exif-shutter', upload.single('photo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'photo required' });
  const filePath = req.file.path;
  try {
    const { stdout } = await execFileAsync(
      'exiftool',
      [
        '-j',
        '-n',
        '-ShutterCount',
        '-ImageCount',
        '-ShotNumber',
        '-Model',
        '-Make',
        '-SerialNumber',
        '-BodySerialNumber',
        filePath,
      ],
      { timeout: 15000 }
    );
    const meta = JSON.parse(stdout)[0] || {};
    const shutterCount =
      meta.ShutterCount ?? meta.ImageCount ?? meta.ShotNumber ?? null;
    res.json({
      shutterCount,
      model: meta.Model || null,
      make: meta.Make || null,
      serial: meta.SerialNumber || meta.BodySerialNumber || null,
      raw: meta,
    });
  } catch (e) {
    res.status(500).json({
      error: e.message,
      hint: 'Install ExifTool and ensure it is on PATH (exiftool -ver)',
    });
  } finally {
    fs.unlink(filePath, () => {});
  }
});

// ---- Simulated Connect transfer with Idempotency-Key ----
app.post('/api/connect/transfer', (req, res) => {
  const key = req.headers['idempotency-key'];
  if (!key) {
    return res.status(400).json({ error: 'Idempotency-Key header required' });
  }
  if (idempotencyStore.has(key)) {
    const prev = idempotencyStore.get(key);
    res.set('Idempotent-Replayed', 'true');
    return res.status(prev.status).json(prev.body);
  }

  const { amount, accountId, tradeId } = req.body || {};
  if (amount == null || !accountId) {
    return res.status(400).json({ error: 'amount and accountId required' });
  }

  const fee = Math.round((Number(amount) * 0.05 + 0.5) * 100) / 100;
  const net = Math.round((Number(amount) - fee) * 100) / 100;
  const body = {
    id: `tr_${randomUUID().slice(0, 12)}`,
    object: 'transfer',
    amount: net,
    fee,
    currency: 'nzd',
    destination: accountId,
    tradeId: tradeId || null,
    idempotencyKey: key,
    status: 'paid',
    simulated: !STRIPE_SECRET_KEY,
  };

  idempotencyStore.set(key, {
    status: 200,
    body,
    createdAt: new Date().toISOString(),
  });
  res.status(200).json(body);
});

// Health
app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    stripe: !!STRIPE_SECRET_KEY,
    webhookSecret: !!STRIPE_WEBHOOK_SECRET,
    stolenUpstream: !!STOLEN_API_URL,
    exiftool: true,
  });
});

// Static MVP
app.use(express.static(__dirname));

function verifyStripeSignature(rawBody, header, secret) {
  // Minimal Stripe-compatible check (t=timestamp,v1=sig)
  const parts = Object.fromEntries(
    String(header).split(',').map((p) => {
      const [k, v] = p.split('=');
      return [k.trim(), v];
    })
  );
  const timestamp = parts.t;
  const signature = parts.v1;
  if (!timestamp || !signature) throw new Error('Invalid signature header');

  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (age > 300) throw new Error('Timestamp outside tolerance');

  const payload = `${timestamp}.${rawBody.toString('utf8')}`;
  const expected = createHmac('sha256', secret).update(payload).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Error('Signature mismatch');
  }
  return JSON.parse(rawBody.toString('utf8'));
}

async function handleStripeEvent(event) {
  console.log('[stripe event]', event.type, event.id || '');
  switch (event.type) {
    case 'account.updated':
      // sync charges_enabled / payouts_enabled for the connected store
      break;
    case 'transfer.created':
    case 'transfer.updated':
    case 'transfer.paid':
    case 'transfer.failed':
      // update transfer status in your DB
      break;
    case 'payout.paid':
    case 'payout.failed':
      break;
    case 'charge.succeeded':
      break;
    default:
      console.log('Unhandled event type', event.type);
  }
}

app.listen(PORT, () => {
  console.log(`Camera Trade server http://localhost:${PORT}`);
  console.log(`Open http://localhost:${PORT}/index.html`);
});
