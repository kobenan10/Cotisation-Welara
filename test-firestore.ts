import { initializeApp } from 'firebase/app';
import { initializeFirestore } from 'firebase/firestore';

const app = initializeApp({});
const db = initializeFirestore(app, { experimentalForceLongPolling: true }, "db-id");
