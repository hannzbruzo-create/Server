/**
 * TomaSafe one-time maintenance: remove ALL registered FCM device tokens.
 * Run from the server directory with the Express server stopped:
 *   node clear-fcm-devices.js
 * Requires the backend's existing better-sqlite3 dependency.
 */
const path = require('node:path');
const fs = require('node:fs');
const readline = require('node:readline/promises');
const { stdin, stdout } = require('node:process');
const Database = require('better-sqlite3');

async function main() {
  const databasePath = path.join(__dirname, 'evacuation.db');
  if (!fs.existsSync(databasePath)) {
    throw new Error(`Database not found: ${databasePath}. Place this script in your server folder.`);
  }

  const db = new Database(databasePath, { fileMustExist: true, timeout: 5000 });
  try {
    const exists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='devices'").get();
    if (!exists) throw new Error('The devices table was not found; nothing was deleted.');

    const before = db.prepare('SELECT COUNT(*) AS count FROM devices').get().count;
    console.log(`Registered FCM devices: ${before}`);
    if (before === 0) {
      console.log('Nothing to delete.');
      return;
    }

    const prompt = readline.createInterface({ input: stdin, output: stdout });
    let confirmation;
    try {
      confirmation = await prompt.question('Type DELETE ALL to back up the database and clear all FCM devices: ');
    } finally {
      prompt.close();
    }
    if (confirmation.trim() !== 'DELETE ALL') {
      console.log('Cancelled. No records were changed.');
      return;
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(__dirname, `evacuation.before-fcm-clear-${stamp}.db`);
    await db.backup(backupPath);
    console.log(`Backup created: ${backupPath}`);

    const deleted = db.transaction(() => db.prepare('DELETE FROM devices').run().changes)();
    const remaining = db.prepare('SELECT COUNT(*) AS count FROM devices').get().count;
    console.log(`Deleted FCM device registrations: ${deleted}`);
    console.log(`Remaining FCM devices: ${remaining}`);
    console.log('Admins, SMS recipients, and alert history were not modified.');
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error('Cleanup failed:', error.message);
  process.exitCode = 1;
});
