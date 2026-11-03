'use strict';

// TomaSafe: manual, single-recipient live SMS connectivity test.
// Run locally from the Express server folder: node test-textbee.js
// This does not use or change /api/emergency, FCM, or the recipients table.

require('dotenv').config();
const readline = require('node:readline/promises');
const fs = require('node:fs');
const path = require('node:path');
const { stdin: input, stdout: output } = require('node:process');
const { normalizePHNumber, sendTextBeeBatch } = require('./services/textbee');

const TEST_MESSAGE =
  '[TomaSafe TEST] This is an SMS connection test, NOT an emergency. No action is required.';

async function main() {
  const rl = readline.createInterface({ input, output });
  try {
    if (!process.env.TEXTBEE_API_KEY) {
      console.error('Missing TEXTBEE_API_KEY in server/.env');
      process.exitCode = 1;
      return;
    }

    console.log('\nTomaSafe / TextBee — single-phone live test');
    console.log('No emergency alert will be sent to your recipients database.\n');

    const entered = await rl.question('Enter YOUR test recipient number (09XXXXXXXXX): ');
    const recipient = normalizePHNumber(entered.trim());
    if (!recipient) {
      console.error('Invalid Philippine mobile number. Use 09XXXXXXXXX or +639XXXXXXXXX.');
      process.exitCode = 1;
      return;
    }

    console.log('\nSMS message:\n' + TEST_MESSAGE + '\n');
    const confirmed = await rl.question('Send ONE real test SMS now? Type SEND to confirm: ');
    if (confirmed.trim() !== 'SEND') {
      console.log('Cancelled. No SMS request was submitted.');
      return;
    }

    // Persist an on-disk send lock BEFORE contacting TextBee.
    // This prevents accidentally submitting another batch by running the
    // same test script repeatedly. Never auto-retry an uncertain response.
    const lockPath = path.join(__dirname, '.textbee-test-send-lock.json');
    try {
      fs.writeFileSync(lockPath, JSON.stringify({
        createdAt: new Date().toISOString(),
        phoneLast4: recipient.slice(-4),
        note: 'A TextBee test request may already be queued. Inspect dashboard before removing lock.'
      }, null, 2), { flag: 'wx', mode: 0o600 });
    } catch (err) {
      if (err.code === 'EEXIST') {
        console.error('A previous test already submitted an SMS.');
        console.error('Check TextBee batches and the receiving phone BEFORE another test.');
        console.error('Only after checking, manually delete .textbee-test-send-lock.json to retest.');
        return;
      }
      throw err;
    }

    const result = await sendTextBeeBatch({
      recipients: [recipient],
      message: TEST_MESSAGE,
    });

    console.log('\nTextBee submission result:', result.status);
    console.log('Messages accepted for processing:', result.queued);
    if (result.batchId) console.log('Batch ID:', result.batchId);
    console.log('Check the TextBee dashboard and recipient Messages app to confirm delivery.');
    console.log('Accepted/queued does NOT mean delivered.');
  } catch (error) {
    console.error('\nSMS test unsuccessful or outcome uncertain:', error.message);
    console.error('Before retrying, check TextBee message history to avoid a duplicate SMS.');
    process.exitCode = 1;
  } finally {
    rl.close();
  }
}

main();
