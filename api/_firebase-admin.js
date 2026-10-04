import { applicationDefault, cert, getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

function serviceAccountCredential() {
  const rawJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '';
  if (rawJson) return cert(JSON.parse(rawJson));

  const projectId = process.env.FIREBASE_PROJECT_ID || process.env.VITE_FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');
  if (projectId && clientEmail && privateKey) return cert({ projectId, clientEmail, privateKey });
  return applicationDefault();
}

const adminApp = getApps()[0] || initializeApp({
  credential: serviceAccountCredential(),
  projectId: process.env.FIREBASE_PROJECT_ID || process.env.VITE_FIREBASE_PROJECT_ID,
});

export const adminDb = getFirestore(adminApp);
