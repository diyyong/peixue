import assert from "node:assert/strict";
import test from "node:test";

import { JSDOM } from "jsdom";

import { sanitizeSvg } from "../src/sanitizeSvg.js";

const { window } = new JSDOM("");

test("sanitizeSvg removes script and event handlers, including on the root", () => {
  const cleaned = sanitizeSvg(
    '<svg onload="alert(1)" viewBox="0 0 10 10"><script>alert(2)</script><rect onclick="alert(3)" width="5" height="5"/></svg>',
    window,
  );

  assert.ok(cleaned);
  assert.doesNotMatch(cleaned, /onload|onclick|script|alert/i);
  assert.match(cleaned, /<rect[^>]*width="5"[^>]*height="5"/);
});

test("sanitizeSvg permits local references and rejects external or data URLs", () => {
  const cleaned = sanitizeSvg(
    '<svg><defs><linearGradient id="safe"><stop offset="0"/></linearGradient></defs><rect fill="url(#safe)"/><rect fill="url(https://attacker.example/a.svg#x)"/><use href="#safe"/><use href="data:image/svg+xml,bad"/></svg>',
    window,
  );

  assert.ok(cleaned);
  assert.match(cleaned, /fill="url\(#safe\)"/);
  assert.match(cleaned, /href="#safe"/);
  assert.doesNotMatch(cleaned, /attacker|data:image/);
});

test("sanitizeSvg normalizes dimensions into a responsive viewBox", () => {
  const cleaned = sanitizeSvg(
    '<svg width="320" height="200" style="background:red"><text x="10" y="20">虚构题目</text></svg>',
    window,
  );

  assert.ok(cleaned);
  assert.match(cleaned, /viewBox="0 0 320 200"/);
  assert.doesNotMatch(cleaned, /\s(?:width|height|style)=/);
  assert.match(cleaned, />虚构题目<\/text>/);
});

test("sanitizeSvg rejects non-SVG, malformed, and oversized input", () => {
  assert.equal(sanitizeSvg('<div onload="x">bad</div>', window), null);
  assert.equal(sanitizeSvg("<svg><g></svg>", window), null);
  assert.equal(sanitizeSvg(`<svg>${"x".repeat(80_001)}</svg>`, window), null);
});
