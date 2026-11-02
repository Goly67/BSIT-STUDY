"use strict";
// Link-preview image: returns a random photo from /images on every request
const fs = require("fs");
const path = require("path");

const TYPES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" };

module.exports = (req, res) => {
  const dir = path.join(process.cwd(), "images");
  const files = fs.readdirSync(dir).filter(f => /\.(png|jpe?g|webp)$/i.test(f));
  const pick = files[Math.floor(Math.random() * files.length)];

  res.setHeader("Content-Type", TYPES[path.extname(pick).slice(1).toLowerCase()]);
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  res.setHeader("CDN-Cache-Control", "no-store");
  res.setHeader("Vercel-CDN-Cache-Control", "no-store");
  res.end(fs.readFileSync(path.join(dir, pick)));
};
