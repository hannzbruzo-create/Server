'use strict';

/**
 * Read-only TextBee outgoing SMS diagnostic.
 * One GET /gateway/messages call; NEVER calls send-sms.
 * Run: node check-textbee-history.js
 */
require('dotenv').config();
const crypto = require('node:crypto');

const key = process.env.TEXTBEE_API_KEY;
if (!key) {
  console.error('Missing TEXTBEE_API_KEY in the server .env file.');
  process.exit(1);
}

function mask(number) {
  const n = String(number || '');
  return n ? `${'*'.repeat(Math.min(7, Math.max(0, n.length - 4)))}${n.slice(-4)}` : 'unknown';
}
function batchId(entry) {
  const value = entry.smsBatch ?? entry.smsBatchId;
  return typeof value === 'string' ? value : (value?._id ?? 'unknown');
}
function classify(message) {
  const m = String(message || '').toUpperCase();
  return m.includes('TOMASAFE TEST') ? 'TEST' :
    m.includes('TOMASAFE FIRE') ? 'FIRE' :
    m.includes('EARTHQUAKE') ? 'EARTHQUAKE' : 'OTHER';
}
function signature(message) {
  return crypto.createHash('sha256').update(String(message || '')).digest('hex').slice(0, 10);
}
async function main() {
  const url = new URL('https://api.textbee.dev/api/v1/gateway/messages');
  url.searchParams.set('direction', 'sent');
  url.searchParams.set('limit', '100');
  url.searchParams.set('order', 'desc');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  let response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: { 'x-api-key': key },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    console.error(`TextBee history request failed: HTTP ${response.status}`);
    process.exitCode = 1;
    return;
  }
  const result = await response.json();
  if (!Array.isArray(result.data)) {
    console.error('Unexpected TextBee history response format.');
    process.exitCode = 1;
    return;
  }

  const entries = result.data;
  const groups = new Map();
  const batches = new Map();
  for (const e of entries) {
    const batch = batchId(e);
    const recipient = String(e.recipient || '');
    const sig = signature(e.message);
    const label = classify(e.message);
    const key = `${recipient}|${sig}`;
    const group = groups.get(key) || { recipient: mask(recipient), type: label, textId: sig, count: 0, batches: new Set(), oldest: '', newest: '' };
    group.count++;
    group.batches.add(batch);
    const date = String(e.createdAt || e.requestedAt || '');
    if (date && (!group.oldest || date < group.oldest)) group.oldest = date;
    if (date && (!group.newest || date > group.newest)) group.newest = date;
    groups.set(key, group);

    const b = batches.get(batch) || { batch, total: 0, recipients: new Set(), types: new Set(), statuses: new Map() };
    b.total++;
    b.recipients.add(recipient);
    b.types.add(label);
    b.statuses.set(String(e.status || 'unknown'), (b.statuses.get(String(e.status || 'unknown')) || 0) + 1);
    batches.set(batch, b);
  }
  console.log('\nTextBee outgoing SMS history (READ ONLY; latest 100 messages)');
  console.log(`History records checked: ${entries.length}`);
  if (result.meta?.hasMore) console.log('More records exist. This is only the latest page.');
  console.log('\nBatches (different IDs indicate distinct provider submissions):');
  console.table([...batches.values()].map(b => ({
    batchId: b.batch,
    records: b.total,
    uniqueRecipients: b.recipients.size,
    types: [...b.types].join(', '),
    statuses: [...b.statuses].map(([status, n]) => `${status}:${n}`).join(' '),
  })));
  console.log('\nRepeated message text to the same recipient:');
  console.table([...groups.values()].filter(g => g.count > 1).map(g => ({
    phone: g.recipient,
    type: g.type,
    count: g.count,
    distinctBatches: g.batches.size,
    textHash: g.textId,
    first: g.oldest,
    last: g.newest,
  })));
  console.log('\nExplanation: multiple batch IDs suggest multiple queued submissions.');
  console.log('One batch ID with repeated identical records needs investigation in TextBee.');
  console.log('Multipart segments can also appear as separate bubbles on some phones.');
  console.log('This tool does not read the sending phone SMS app, and cannot prove carrier delivery.');
  console.log('SMS text, full phone numbers and API keys are never printed.');
}

main().catch(e => {
  console.error('Could not read history:', e.name === 'AbortError' ? 'Request timed out' : e.message);
  process.exitCode = 1;
});
