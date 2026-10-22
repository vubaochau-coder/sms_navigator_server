/**
 * Read-only report of devices that look uninstalled (BACKLOG §1):
 *   npm run report:stale-devices -- [days=60]
 * Uses the same Firebase credentials as the server (FIREBASE_SERVICE_ACCOUNT_JSON
 * or _PATH). Prints JSON; never writes to Firestore.
 */
import { initFirebase } from '../config/firebase.js';
import { staleDeviceService } from '../services/stale-device.service.js';

async function main(): Promise<void> {
  const days = Number(process.argv[2] ?? 60);
  if (!Number.isFinite(days) || days <= 0) {
    throw new Error(`days must be a positive number, got "${process.argv[2]}"`);
  }
  initFirebase();
  const reports = await staleDeviceService.findStaleDevices(days);
  process.stdout.write(`${JSON.stringify({ days, count: reports.length, devices: reports }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${String(error)}\n`);
  process.exit(1);
});
