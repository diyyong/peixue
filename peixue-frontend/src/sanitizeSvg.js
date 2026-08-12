import createDOMPurify from "dompurify";

const MAX_SVG_LENGTH = 80_000;
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

const ALLOWED_TAGS = [
  "svg",
  "g",
  "defs",
  "title",
  "desc",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "path",
  "text",
  "tspan",
  "linearGradient",
  "radialGradient",
  "stop",
  "clipPath",
  "mask",
  "marker",
  "use",
  "symbol",
];

const ALLOWED_ATTRIBUTES = [
  "xmlns",
  "viewBox",
  "preserveAspectRatio",
  "id",
  "x",
  "y",
  "x1",
  "y1",
  "x2",
  "y2",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "width",
  "height",
  "points",
  "d",
  "transform",
  "fill",
  "fill-opacity",
  "fill-rule",
  "stroke",
  "stroke-width",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-opacity",
  "opacity",
  "font-size",
  "font-family",
  "font-weight",
  "text-anchor",
  "dominant-baseline",
  "offset",
  "stop-color",
  "stop-opacity",
  "gradientUnits",
  "gradientTransform",
  "clip-path",
  "mask",
  "marker-start",
  "marker-mid",
  "marker-end",
  "href",
  "xlink:href",
  "vector-effect",
];

const PURIFY_CONFIG = {
  NAMESPACE: SVG_NAMESPACE,
  ALLOWED_TAGS,
  ALLOWED_ATTR: ALLOWED_ATTRIBUTES,
  ALLOW_ARIA_ATTR: false,
  ALLOW_DATA_ATTR: false,
  FORBID_ATTR: ["style"],
};

const purifiers = new WeakMap();
const localReference = /^#[A-Za-z_][\w:.-]*$/;
const safeUrlValue = /^\s*url\(\s*#[A-Za-z_][\w:.-]*\s*\)\s*$/i;

function getPurifier(windowObject) {
  if (!windowObject || typeof windowObject !== "object") return null;
  if (purifiers.has(windowObject)) return purifiers.get(windowObject);

  const purifier = createDOMPurify(windowObject);
  if (!purifier.isSupported) return null;

  purifier.addHook("uponSanitizeAttribute", (_node, data) => {
    const name = data.attrName.toLowerCase();
    const value = String(data.attrValue || "").trim();

    if (name === "href" || name === "xlink:href") {
      data.keepAttr = localReference.test(value);
      return;
    }

    if (/url\s*\(/i.test(value) && !safeUrlValue.test(value)) {
      data.keepAttr = false;
    }
  });

  purifiers.set(windowObject, purifier);
  return purifier;
}

function parseDimension(value) {
  const match = String(value || "")
    .trim()
    .match(/^(\d+(?:\.\d+)?)(?:px)?$/i);
  if (!match) return null;
  const number = Number(match[1]);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function hasValidViewBox(value) {
  const parts = String(value || "")
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  return (
    parts.length === 4 &&
    parts.every(Number.isFinite) &&
    parts[2] > 0 &&
    parts[3] > 0
  );
}

export function sanitizeSvg(rawSvg, windowObject = globalThis.window) {
  if (!rawSvg || typeof rawSvg !== "string") return null;
  const trimmed = rawSvg.trim();
  if (!/^<svg[\s>]/i.test(trimmed) || trimmed.length > MAX_SVG_LENGTH) {
    return null;
  }

  const purifier = getPurifier(windowObject);
  if (!purifier) return null;

  const cleaned = purifier.sanitize(trimmed, PURIFY_CONFIG);
  const document = new windowObject.DOMParser().parseFromString(
    cleaned,
    "image/svg+xml",
  );
  if (document.querySelector("parsererror")) return null;

  const root = document.documentElement;
  if (!root || root.nodeName.toLowerCase() !== "svg") return null;

  if (!hasValidViewBox(root.getAttribute("viewBox"))) {
    const width = parseDimension(root.getAttribute("width")) || 400;
    const height = parseDimension(root.getAttribute("height")) || 300;
    root.setAttribute("viewBox", `0 0 ${width} ${height}`);
  }

  root.removeAttribute("width");
  root.removeAttribute("height");
  root.setAttribute("xmlns", SVG_NAMESPACE);

  const serialized = new windowObject.XMLSerializer().serializeToString(root);
  const finalSvg = purifier.sanitize(serialized, PURIFY_CONFIG).trim();
  return /^<svg[\s>]/i.test(finalSvg) ? finalSvg : null;
}
