"use strict";

/**
 * TomaSafe's TextBee SMS transport (Node 18+).
 * This module does not send anything until sendTextBeeBatch/sendSMS is called.
 * The Express endpoint, admin authentication and preview/test/live policy
 * will be connected separately; never call this from untrusted client code.
 *
 * A successful API response means queued, not delivered.
 */
const TEXTBEE_URL = "https://api.textbee.dev/api/v1/gateway/send-sms";

/** Convert Philippine mobile numbers into +639XXXXXXXXX (E.164). */
function normalizePHNumber(value) {
  if (typeof value !== "string") return null;
  const number = value.replace(/[\s()\-]/g, "");
  if (/^09\d{9}$/.test(number)) return `+63${number.slice(1)}`;
  if (/^639\d{9}$/.test(number)) return `+${number}`;
  if (/^\+639\d{9}$/.test(number)) return number;
  return null;
}

/** Remove invalid numbers and duplicates before charging SMS credits. */
function uniquePhones(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map(normalizePHNumber).filter(Boolean))];
}

async function sendTextBeeBatch({
  recipients,
  message,
  apiKey = process.env.TEXTBEE_API_KEY,
  deviceId = process.env.TEXTBEE_DEVICE_ID,
  fetchImpl = globalThis.fetch,
}) {
  const phones = uniquePhones(recipients);
  if (!phones.length) throw new Error("No valid Philippine mobile recipients.");
  if (typeof message !== "string" || !message.trim()) {
    throw new Error("SMS message must be a nonempty string.");
  }
  if (!apiKey) throw new Error("TEXTBEE_API_KEY is not configured on the server.");
  if (typeof fetchImpl !== "function") {
    throw new Error("Fetch is not available. Use Node.js 18 or newer.");
  }

  const payload = { recipients: phones, message: message.trim() };
  if (deviceId) payload.deviceId = deviceId;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  let response;
  try {
    response = await fetchImpl(TEXTBEE_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch {
    // A timed-out request might still have been accepted by TextBee.
    // Do not automatically retry or risk duplicate emergency messages.
    throw new Error("TextBee request result is unknown. Check TextBee history before retrying.");
  } finally {
    clearTimeout(timer);
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.data?.success === false) {
    // Do not print secrets, message bodies or recipient phone numbers.
    throw new Error(`TextBee refused the request (HTTP ${response.status}). Check your device, key and plan.`);
  }
  const info = data?.data;
  if (info?.success !== true && !Number.isFinite(info?.successCount)) {
    throw new Error("TextBee response is unclear. Check TextBee history before retrying.");
  }
  // Prefer successful accepts over total recipients when TextBee reports both.
  const acceptedCount = Number(info.successCount ?? info.recipientCount ?? phones.length);
  const queued = Math.max(0, Math.min(phones.length, acceptedCount));
  return {
    status: "queued_not_delivered",
    queued,
    batchId: info.smsBatchId ?? null,
  };
}

/**
 * Helper for later bulk alert integration; sends in small batches.
 * If one batch is uncertain or rejected, stop immediately.
 */
async function sendSMS({
  recipients,
  message,
  apiKey,
  deviceId,
  fetchImpl = globalThis.fetch,
  batchSize = 10,
}) {
  const phones = uniquePhones(recipients);
  if (!phones.length) {
    return { targeted: 0, queued: 0, failed: 0, status: "no_recipients", batchIds: [], errors: [] };
  }
  const size = Math.max(1, Math.min(20, Number(batchSize) || 10));
  let queued = 0;
  const batchIds = [];
  const errors = [];

  for (let i = 0; i < phones.length; i += size) {
    const chunk = phones.slice(i, i + size);
    try {
      const result = await sendTextBeeBatch({
        recipients: chunk, message, apiKey, deviceId, fetchImpl,
      });
      queued += result.queued;  
      if (result.batchId) batchIds.push(result.batchId);
    } catch (error) {
      errors.push(error.message);
      break; // Don't retry uncertain submissions automatically.
    }
  }
  return {
    targeted: phones.length,
    queued,
    failed: phones.length - queued, // Includes not attempted or unknown submissions.
    status: errors.length ? (queued ? "partial_or_unknown" : "failed_or_unknown") : "queued_not_delivered",
    batchIds,
    errors,
  };
}

module.exports = {
  TEXTBEE_URL,
  normalizePHNumber,
  uniquePhones,
  sendTextBeeBatch,
  sendSMS,
};
