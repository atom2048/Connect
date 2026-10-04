// Provider sending moved to the authenticated GCP push-delivery worker.
// Keep this compatibility export so an old deployment cannot accidentally
// become a second sender after the cutover.
export async function sendPushForNotification() {
  throw new Error('Legacy Vercel Push provider is disabled; use the GCP push-delivery worker');
}
