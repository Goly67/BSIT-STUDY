"use strict";

const {createHash, randomBytes} = require("node:crypto");
const {initializeApp} = require("firebase-admin/app");
const {getDatabase} = require("firebase-admin/database");
const {HttpsError, onCall} = require("firebase-functions/v2/https");

initializeApp({
  databaseURL: "https://bsit-study-default-rtdb.firebaseio.com"
});

const database = getDatabase();
const TICKET_TTL_MS = 60 * 1000;
const materialIdPattern = /^[A-Za-z0-9_-]{1,128}$/;
const hashTicket = ticket => createHash("sha256").update(ticket).digest("hex");

exports.createViewerTicket = onCall({region: "us-central1"}, async request => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Sign in anonymously before requesting a viewing ticket.");
  }

  const {materialId} = request.data || {};
  if (typeof materialId !== "string" || !materialIdPattern.test(materialId)) {
    throw new HttpsError("invalid-argument", "A valid material ID is required.");
  }

  const materialSnapshot = await database.ref(`materials/${materialId}`).get();
  const material = materialSnapshot.val();
  if (!material || typeof material.url !== "string") {
    throw new HttpsError("not-found", "The requested study material was not found.");
  }

  let targetOrigin;
  try {
    const target = new URL(material.url);
    if (!["http:", "https:"].includes(target.protocol)) throw new Error("Unsupported protocol");
    targetOrigin = target.origin;
  } catch {
    throw new HttpsError("failed-precondition", "This material does not have a valid website URL.");
  }

  const ticket = randomBytes(32).toString("base64url");
  const now = Date.now();
  const expiredTickets = await database.ref("viewerTickets")
      .orderByChild("expiresAt")
      .endAt(now)
      .limitToFirst(100)
      .get();
  if (expiredTickets.exists()) {
    const deletions = {};
    expiredTickets.forEach(snapshot => {
      deletions[`viewerTickets/${snapshot.key}`] = null;
    });
    await database.ref().update(deletions);
  }

  await database.ref(`viewerTickets/${hashTicket(ticket)}`).set({
    materialId,
    targetOrigin,
    createdAt: now,
    expiresAt: now + TICKET_TTL_MS,
    consumed: false
  });

  return {ticket, expiresAt: now + TICKET_TTL_MS};
});

exports.redeemViewerTicket = onCall({region: "us-central1"}, async request => {
  const {ticket, materialId} = request.data || {};
  if (typeof ticket !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(ticket) ||
      typeof materialId !== "string" || !materialIdPattern.test(materialId)) {
    throw new HttpsError("invalid-argument", "A valid viewing ticket and material ID are required.");
  }

  const origin = request.rawRequest.get("origin");
  if (typeof origin !== "string" || origin === "null") {
    throw new HttpsError("permission-denied", "Viewing tickets must be redeemed by a website.");
  }

  const now = Date.now();
  const ticketRef = database.ref(`viewerTickets/${hashTicket(ticket)}`);
  const result = await ticketRef.transaction(current => {
    if (!current || current.consumed || current.expiresAt <= now ||
        current.materialId !== materialId || current.targetOrigin !== origin) {
      return;
    }
    return {...current, consumed: true, consumedAt: now};
  });

  if (!result.committed) {
    throw new HttpsError("permission-denied", "The ticket is invalid, expired, already used, or for another website.");
  }
  return {valid: true, materialId};
});
