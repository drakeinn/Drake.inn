// Draké store API as a Netlify Function (v2).
// Routes: POST /api/orders | /api/orders/:id/verify | /api/track | /api/cashfree/webhook
// Secrets come from Netlify environment variables and never reach the browser.
import crypto from 'node:crypto';
import { getStore } from '@netlify/blobs';

export const config = { path: '/api/*' };

const env = process.env;
const CF_MODE = env.CASHFREE_ENV === 'production' ? 'production' : 'sandbox';
const CF_BASE = CF_MODE === 'production' ? 'https://api.cashfree.com/pg' : 'https://sandbox.cashfree.com/pg';
const store = () => getStore('orders');   // one JSON blob per order, key = order ID

// ---------- helpers ----------
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 symbols, no I/O/0/1
function genOrderId() {
  let s = '';
  for (const b of crypto.randomBytes(8)) s += ALPHABET[b % 32];
  return 'DRAKE-' + s;
}
const clean = (v, max) => String(v ?? '').trim().slice(0, max);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const inr = n => '₹' + Number(n).toLocaleString('en-IN');
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' } });

// Best-effort rate limit (per warm function instance). Order IDs are random and tracking also needs the email.
const hits = new Map();
function allow(key, max, windowMs) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter(t => now - t < windowMs);
  if (arr.length >= max) { hits.set(key, arr); return false; }
  arr.push(now); hits.set(key, arr);
  if (hits.size > 5000) hits.clear();
  return true;
}

function validateCustomer(c = {}) {
  const out = {
    name: clean(c.name, 80),
    phone: clean(c.phone, 16).replace(/\s/g, ''),
    email: clean(c.email, 120).toLowerCase(),
    house: clean(c.house, 120),
    street: clean(c.street, 160),
    city: clean(c.city, 80),
    state: clean(c.state, 80),
    pincode: clean(c.pincode, 6),
    country: clean(c.country, 56) || 'India'
  };
  if (out.name.length < 2) return { error: 'Please enter your full name' };
  if (!/^\+91[6-9]\d{9}$/.test(out.phone)) return { error: 'Enter a valid 10-digit Indian mobile number' };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(out.email)) return { error: 'Enter a valid email address' };
  if (!out.house) return { error: 'Please enter your house / building' };
  if (!out.street) return { error: 'Please enter your street / locality' };
  if (!out.city) return { error: 'Please enter your city' };
  if (!out.state) return { error: 'Please select your state' };
  if (!/^[1-9]\d{5}$/.test(out.pincode)) return { error: 'Enter a valid 6-digit PIN code' };
  return { value: out };
}

function validateItems(items) {
  if (!Array.isArray(items) || items.length === 0 || items.length > 20) return { error: 'Your cart is empty or too large' };
  const out = [];
  for (const i of items) {
    const qty = Number(i.qty), price = Number(i.price);
    if (!Number.isInteger(qty) || qty < 1 || qty > 10 || !Number.isFinite(price) || price <= 0 || price > 500000) return { error: 'Invalid cart item' };
    out.push({ id: clean(i.id, 60), brand: clean(i.brand, 60), model: clean(i.model, 80), size: clean(i.size, 10), qty, price });
  }
  const total = Math.round(out.reduce((s, i) => s + i.price * i.qty, 0) * 100) / 100;
  if (total < 1 || total > 1000000) return { error: 'Order total is out of range' };
  return { value: out, total };
}

async function cf(method, p, body) {
  const res = await fetch(CF_BASE + p, {
    method,
    headers: {
      'x-client-id': env.CASHFREE_APP_ID,
      'x-client-secret': env.CASHFREE_SECRET_KEY,
      'x-api-version': '2023-08-01',
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error('Cashfree error', res.status, JSON.stringify(data).slice(0, 300));
    throw new Error(data.message || 'Payment provider error');
  }
  return data;
}

// ---------- Mailjet ----------
async function sendConfirmationEmail(o, baseUrl) {
  if (!env.MAILJET_API_KEY || !env.MAILJET_SECRET_KEY || !env.MAILJET_FROM_EMAIL) throw new Error('Mailjet is not configured');
  const c = o.customer;
  const addr = [c.house, c.street, c.city, `${c.state} - ${c.pincode}`, c.country].join(', ');
  const itemsText = o.items.map(i => `- ${i.brand} ${i.model} (Size ${i.size}) x ${i.qty}: ${inr(i.price * i.qty)}`).join('\n');
  const itemsHtml = o.items.map(i => `<tr><td style="padding:6px 0">${esc(i.brand)} ${esc(i.model)} (Size ${esc(i.size)}) × ${i.qty}</td><td style="padding:6px 0;text-align:right">${inr(i.price * i.qty)}</td></tr>`).join('');

  const text = `Hi ${c.name},\n\nThank you for your order! Your payment was received.\n\nTRACKING CODE: ${o.orderId}\n\n${itemsText}\n\nTotal paid: ${inr(o.total)}\nShipping to: ${addr}\n\nTo track your order, open ${baseUrl}, choose "Track Order" and enter this code together with this email address (${c.email}).\n\nDraké`;
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:auto;color:#111">
    <h2 style="font-family:Georgia,serif;font-style:italic;margin-bottom:4px">Draké</h2>
    <p>Hi ${esc(c.name)}, thank you for your order! Your payment was received.</p>
    <div style="background:#FFD60A;color:#000;padding:14px;text-align:center;border-radius:8px;margin:18px 0">
      <div style="font-size:11px;letter-spacing:2px">YOUR TRACKING CODE</div>
      <div style="font-size:22px;font-weight:bold;letter-spacing:2px;font-family:monospace">${esc(o.orderId)}</div>
    </div>
    <table style="width:100%;border-collapse:collapse;font-size:14px">${itemsHtml}
      <tr><td style="padding-top:10px;border-top:1px solid #ddd"><b>Total paid</b></td><td style="padding-top:10px;border-top:1px solid #ddd;text-align:right"><b>${inr(o.total)}</b></td></tr>
    </table>
    <p style="font-size:13px"><b>Shipping to:</b><br>${esc(addr)}</p>
    <p style="font-size:13px;color:#555">To track your order, visit <a href="${esc(baseUrl)}">${esc(baseUrl)}</a>, choose <b>Track Order</b> and enter this code with the email address <b>${esc(c.email)}</b>.</p>
  </div>`;

  const msg = {
    From: { Email: env.MAILJET_FROM_EMAIL, Name: env.MAILJET_FROM_NAME || 'Draké' },
    To: [{ Email: c.email, Name: c.name }],
    Subject: `Your Draké order ${o.orderId} is confirmed`,
    TextPart: text,
    HTMLPart: html,
    CustomID: o.orderId
  };
  if (env.OWNER_EMAIL) msg.Bcc = [{ Email: env.OWNER_EMAIL }];

  const auth = Buffer.from(`${env.MAILJET_API_KEY}:${env.MAILJET_SECRET_KEY}`).toString('base64');
  const res = await fetch('https://api.mailjet.com/v3.1/send', {
    method: 'POST',
    headers: { Authorization: 'Basic ' + auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ Messages: [msg] })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.Messages?.[0]?.Status !== 'success') throw new Error('Mailjet rejected the message: ' + JSON.stringify(data).slice(0, 300));
}

// ---------- payment confirmation (shared by browser verify + webhook) ----------
// Re-checks with Cashfree every time, never trusts the browser or the webhook body.
// If the browser and the webhook land at the same instant, a rare duplicate email is possible.
async function fulfill(orderId, baseUrl) {
  const s = store();
  let o = await s.get(orderId, { type: 'json' });
  if (!o) return { paid: false };
  if (o.status !== 'PAID') {
    const cfo = await cf('GET', '/orders/' + encodeURIComponent(orderId));
    if (cfo.order_status !== 'PAID') return { paid: false, orderId, status: cfo.order_status };
    if (Math.abs(Number(cfo.order_amount) - o.total) > 0.001) {
      console.error('Amount mismatch for', orderId, cfo.order_amount, o.total);
      return { paid: false, orderId };
    }
    o = { ...o, status: 'PAID', paidAt: new Date().toISOString(), trackingStatus: 'Payment Verified & Processing' };
    await s.setJSON(orderId, o);
  }
  if (!o.emailSent) {
    const fresh = await s.get(orderId, { type: 'json' });   // another request may have just sent it
    if (fresh?.emailSent) return { paid: true, orderId, emailSent: true, total: o.total };
    try {
      await sendConfirmationEmail(o, baseUrl);
      o = { ...o, emailSent: true };
      await s.setJSON(orderId, o);
    } catch (e) { console.error('Email failed for', orderId, '-', e.message); }
  }
  return { paid: true, orderId, emailSent: !!o.emailSent, total: o.total };
}

// ---------- routes ----------
export default async (req, context) => {
  const url = new URL(req.url);
  const baseUrl = (env.PUBLIC_BASE_URL || url.origin).replace(/\/$/, '');
  const route = url.pathname.replace(/\/+$/, '');
  const ip = context?.ip || req.headers.get('x-nf-client-connection-ip') || 'unknown';

  if (req.method !== 'POST') return json({ error: 'Not found' }, 404);

  // Cashfree webhook (raw body needed for the signature)
  if (route === '/api/cashfree/webhook') {
    const raw = await req.text();
    const sig = req.headers.get('x-webhook-signature'), ts = req.headers.get('x-webhook-timestamp');
    if (!sig || !ts || !env.CASHFREE_SECRET_KEY) return new Response(null, { status: 400 });
    const expected = crypto.createHmac('sha256', env.CASHFREE_SECRET_KEY).update(ts + raw).digest('base64');
    const a = Buffer.from(sig), b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return new Response(null, { status: 401 });
    let payload; try { payload = JSON.parse(raw); } catch (e) { return new Response(null, { status: 400 }); }
    const id = payload?.data?.order?.order_id;
    if (id) { try { await fulfill(id, baseUrl); } catch (e) { console.error('Webhook fulfil failed', e.message); return new Response(null, { status: 500 }); } }
    return new Response(null, { status: 200 });
  }

  let body = {};
  try { body = await req.json(); } catch (e) { /* empty body is fine for /verify */ }

  if (route === '/api/orders') {
    if (!allow('create:' + ip, 10, 10 * 60 * 1000)) return json({ error: 'Too many attempts. Please try again in a few minutes.' }, 429);
    if (!env.CASHFREE_APP_ID || !env.CASHFREE_SECRET_KEY) return json({ error: 'Payments are not configured yet' }, 503);
    const c = validateCustomer(body?.customer); if (c.error) return json({ error: c.error }, 400);
    const it = validateItems(body?.items); if (it.error) return json({ error: it.error }, 400);

    const orderId = genOrderId();
    try {
      const meta = { return_url: `${baseUrl}/?order_id={order_id}` };
      if (baseUrl.startsWith('https://')) meta.notify_url = `${baseUrl}/api/cashfree/webhook`;
      const cfo = await cf('POST', '/orders', {
        order_id: orderId,
        order_amount: it.total,
        order_currency: 'INR',
        customer_details: {
          customer_id: 'c_' + crypto.createHash('sha256').update(c.value.email).digest('hex').slice(0, 24),
          customer_name: c.value.name,
          customer_email: c.value.email,
          customer_phone: c.value.phone.slice(-10)
        },
        order_meta: meta
      });
      await store().setJSON(orderId, { orderId, status: 'PENDING', createdAt: new Date().toISOString(), customer: c.value, items: it.value, total: it.total, emailSent: false });
      return json({ orderId, paymentSessionId: cfo.payment_session_id, mode: CF_MODE });
    } catch (e) {
      return json({ error: 'Could not start the payment. Please try again.' }, 502);
    }
  }

  const m = route.match(/^\/api\/orders\/([^/]+)\/verify$/);
  if (m) {
    if (!allow('verify:' + ip, 40, 10 * 60 * 1000)) return json({ error: 'Too many requests' }, 429);
    const id = clean(decodeURIComponent(m[1]), 30).toUpperCase();
    try {
      const r = await fulfill(id, baseUrl);
      if (r.paid === false && !r.orderId && !r.status) return json({ error: 'Order not found' }, 404);
      return json(r);
    } catch (e) { return json({ error: 'Could not confirm the payment right now' }, 502); }
  }

  // Tracking: BOTH the email and the order ID must match. Same error either way.
  if (route === '/api/track') {
    if (!allow('track:' + ip, 15, 10 * 60 * 1000)) return json({ error: 'Too many attempts. Please try again later.' }, 429);
    const id = clean(body?.orderId, 30).toUpperCase();
    const email = clean(body?.email, 120).toLowerCase();
    const o = /^DRAKE-[A-Z0-9]{8}$/.test(id) ? await store().get(id, { type: 'json' }) : null;
    if (!o || o.status !== 'PAID' || o.customer.email !== email) return json({ error: 'No order found for this email and tracking code.' }, 404);
    const c = o.customer;
    return json({
      orderId: o.orderId,
      status: o.trackingStatus || 'Processing',
      paidAt: o.paidAt,
      items: o.items.map(({ brand, model, size, qty }) => ({ brand, model, size, qty })),
      total: o.total,
      shipTo: { name: c.name, phone: '+91 ******' + c.phone.slice(-4), house: c.house, street: c.street, city: c.city, state: c.state, pincode: c.pincode, country: c.country }
    });
  }

  return json({ error: 'Not found' }, 404);
};
