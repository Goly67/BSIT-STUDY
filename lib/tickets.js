"use strict";

const {createHash, randomBytes} = require("node:crypto");
const {cert, getApps, initializeApp} = require("firebase-admin/app");
const {getDatabase} = require("firebase-admin/database");

const DATABASE_URL = "https://bsit-study-default-rtdb.firebaseio.com";
const BSIT_STUDY_ORIGIN = process.env.BSIT_STUDY_ORIGIN || "https://bsit-study.vercel.app";
const STUDY_SITE_ORIGIN = "https://kokeck4-oss.github.io";
const STUDY_MATERIAL_ORIGINS = new Map([
  ["-P3pYh_459UiKb2JeiaQ", STUDY_SITE_ORIGIN],
  ["-P3pgBNjkJ19AIxvlBNe", STUDY_SITE_ORIGIN],
  ["-P3pgBNjkJ19AIxvlBNf", STUDY_SITE_ORIGIN]
]);
const STUDY_MATERIAL_URL_ORIGINS = new Map([
  ["https://tinyurl.com/GE-LIT-ERA", STUDY_SITE_ORIGIN],
  ["https://tinyurl.com/2rnjb2du", STUDY_SITE_ORIGIN],
  ["https://tinyurl.com/mr45m7ht", STUDY_SITE_ORIGIN]
]);
const TICKET_TTL_MS = 60 * 1000;
const MATERIAL_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const TICKET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

class ApiError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

function getServices() {
  const encodedAccount = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!encodedAccount) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is not configured.");
  }

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(encodedAccount);
  } catch {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON.");
  }
  if (serviceAccount.project_id !== "bsit-study") {
    throw new Error("The configured Firebase service account is not for bsit-study.");
  }

  const app = getApps()[0] || initializeApp({
    credential: cert(serviceAccount),
    databaseURL: DATABASE_URL
  });
  return {database: getDatabase(app)};
}

function setCors(req, res, allowedOrigin) {
  res.setHeader("Cache-Control", "no-store");
  const origin = req.headers.origin;
  if (origin === allowedOrigin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  }
}

function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      throw new ApiError(400, "Request body must be valid JSON.");
    }
  }
  throw new ApiError(400, "Request body must be valid JSON.");
}

function hashTicket(ticket) {
  return createHash("sha256").update(ticket).digest("hex");
}

function getTargetOrigin(materialId, materialUrl) {
  if (STUDY_MATERIAL_ORIGINS.has(materialId)) return STUDY_MATERIAL_ORIGINS.get(materialId);
  let target;
  try {
    target = new URL(materialUrl);
  } catch {
    throw new ApiError(400, "This material does not have a valid website URL.");
  }
  if (!["http:", "https:"].includes(target.protocol)) {
    throw new ApiError(400, "This material does not have a valid website URL.");
  }
  if (target.hostname === "tinyurl.com") return STUDY_SITE_ORIGIN;
  const configuredOrigin = STUDY_MATERIAL_URL_ORIGINS.get(target.origin + target.pathname);
  if (configuredOrigin) return configuredOrigin;
  return target.origin;
}

function isAllowedTicketOrigin(materialId, materialUrl, ticketOrigin, requestOrigin) {
  return ticketOrigin === requestOrigin ||
      getTargetOrigin(materialId, materialUrl) === requestOrigin;
}

function handleMethod(req, res, allowedOrigin) {
  setCors(req, res, allowedOrigin);
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return false;
  }
  if (req.method !== "POST") {
    res.status(405).json({error: "Method not allowed."});
    return false;
  }
  if (req.headers.origin !== allowedOrigin) {
    res.status(403).json({error: "This website is not allowed to request tickets."});
    return false;
  }
  return true;
}

async function createViewerTicket(req, res) {
  if (!handleMethod(req, res, BSIT_STUDY_ORIGIN)) return;

  try {
    const {materialId} = readBody(req);
    if (typeof materialId !== "string" || !MATERIAL_ID_PATTERN.test(materialId)) {
      throw new ApiError(400, "A valid material ID is required.");
    }

    const {database} = getServices();
    const materialSnapshot = await database.ref(`materials/${materialId}`).get();
    const material = materialSnapshot.val();
    if (!material || typeof material.url !== "string") {
      throw new ApiError(404, "The requested study material was not found.");
    }

    const targetOrigin = getTargetOrigin(materialId, material.url);
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

    res.status(200).json({ticket, expiresAt: now + TICKET_TTL_MS});
  } catch (error) {
    if (error instanceof ApiError) {
      res.status(error.statusCode).json({error: error.message});
      return;
    }
    console.error("Failed to create viewer ticket.", error);
    res.status(500).json({error: "Unable to create a viewing ticket right now."});
  }
}

async function redeemViewerTicket(req, res) {
  if (!handleMethod(req, res, STUDY_SITE_ORIGIN)) return;

  try {
    const {ticket, materialId} = readBody(req);
    if (typeof ticket !== "string" || !TICKET_PATTERN.test(ticket) ||
        typeof materialId !== "string" || !MATERIAL_ID_PATTERN.test(materialId)) {
      throw new ApiError(400, "A valid viewing ticket and material ID are required.");
    }

    const {database} = getServices();
    const now = Date.now();
    const materialSnapshot = await database.ref(`materials/${materialId}`).get();
    const material = materialSnapshot.val();
    if (!material || typeof material.url !== "string") {
      throw new ApiError(404, "The requested study material was not found.");
    }
    const ticketRef = database.ref(`viewerTickets/${hashTicket(ticket)}`);
    let rejectionReason;
    const result = await ticketRef.transaction(current => {
      if (!current) {
        rejectionReason = "not_found";
        return;
      }
      if (current.consumed) {
        rejectionReason = "already_used";
        return;
      }
      if (typeof current.expiresAt !== "number" || current.expiresAt <= now) {
        rejectionReason = "expired_or_invalid_expiry";
        return;
      }
      if (current.materialId !== materialId) {
        rejectionReason = "material_mismatch";
        return;
      }
      if (!isAllowedTicketOrigin(
          materialId, material.url, current.targetOrigin, req.headers.origin)) {
        rejectionReason = "origin_mismatch";
        return;
      }
      return {...current, consumed: true, consumedAt: now};
    });

    if (!result.committed) {
      console.warn("Viewer ticket redemption rejected.", {
        reason: rejectionReason || "transaction_not_committed"
      });
      throw new ApiError(403, "The ticket is invalid, expired, already used, or for another website.");
    }
    res.status(200).json({valid: true, materialId});
  } catch (error) {
    if (error instanceof ApiError) {
      res.status(error.statusCode).json({error: error.message});
      return;
    }
    console.error("Failed to redeem viewer ticket.", error);
    res.status(500).json({error: "Unable to verify this viewing ticket right now."});
  }
}

module.exports = {createViewerTicket, redeemViewerTicket};
