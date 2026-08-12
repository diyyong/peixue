#!/usr/bin/env node

import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const frontendRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(frontendRoot, "dist");

function requireNonEmpty(relativePath) {
  const path = join(dist, relativePath);
  assert.ok(existsSync(path), `missing build output: ${relativePath}`);
  assert.ok(statSync(path).size > 0, `empty build output: ${relativePath}`);
  return path;
}

const html = readFileSync(requireNonEmpty("index.html"), "utf8");
assert.match(html, /<title>陪学笔记<\/title>/);
assert.match(html, /Content-Security-Policy/);
assert.doesNotMatch(html, /\/src\/main\.jsx/);

const referencedFiles = new Set();
for (const match of html.matchAll(/(?:src|href)="([^"?#]+)[^"?]*"/g)) {
  const reference = match[1];
  if (!reference || /^(?:https?:|data:|#)/.test(reference)) continue;
  referencedFiles.add(reference.replace(/^\//, ""));
}
assert.ok(referencedFiles.size >= 3, "built HTML should reference static assets");
for (const reference of referencedFiles) requireNonEmpty(reference);

const manifest = JSON.parse(
  readFileSync(requireNonEmpty("manifest.json"), "utf8"),
);
assert.equal(manifest.name, "陪学笔记");
for (const icon of manifest.icons || []) {
  requireNonEmpty(String(icon.src || "").replace(/^\//, ""));
}

const notices = readFileSync(
  requireNonEmpty("THIRD_PARTY_NOTICES.txt"),
  "utf8",
);
assert.match(notices, /DOMPurify 3\.4\.13/);
assert.match(notices, /React, React DOM, and Scheduler/);
requireNonEmpty("licenses/DOMPurify-Apache-2.0.txt");

console.log(
  `Verified frontend build: ${referencedFiles.size} referenced assets and dependency notices.`,
);
