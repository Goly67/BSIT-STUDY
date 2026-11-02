"use strict";
// /s/<anything> → the normal site, but with a random class photo as the link preview.
// Each different /s/ link gets its own preview, so Messenger/Discord/etc. show a new photo.
const fs = require("fs");
const path = require("path");

const ORIGIN = "https://bsit-study.vercel.app";

module.exports = (req, res) => {
  const root = process.cwd();
  const imgs = fs.readdirSync(path.join(root, "images")).filter(f => /\.(png|jpe?g|webp)$/i.test(f));
  const pick = imgs[Math.floor(Math.random() * imgs.length)];
  const img = `${ORIGIN}/images/${encodeURIComponent(pick)}`;
  const id = String(req.query.id || "").replace(/[^\w-]/g, "").slice(0, 32);

  let html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  html = html
    .replace(/(<meta (?:property="og:image"|name="twitter:image") content=")[^"]*"/g, `$1${img}"`)
    .replace('<meta charset="utf-8">',
      `<meta charset="utf-8">\n<base href="/">\n<meta property="og:url" content="${ORIGIN}/s/${id}">`);

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.end(html);
};
