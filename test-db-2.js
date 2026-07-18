import { initializeApp } from "firebase/app";
import { getFirestore, collection, getDocs } from "firebase/firestore";
import fs from "fs";

const config = JSON.parse(fs.readFileSync("./firebase-applet-config.json"));
const app = initializeApp(config);
const db = getFirestore(app, config.firestoreDatabaseId);

async function run() {
  const expenses = await getDocs(collection(db, "expenses"));
  console.log("Expenses:");
  expenses.forEach(doc => console.log(doc.id, doc.data()));
  
  const revenues = await getDocs(collection(db, "revenues"));
  console.log("Revenues:");
  revenues.forEach(doc => console.log(doc.id, doc.data()));
  
  process.exit(0);
}
run().catch(console.error);
