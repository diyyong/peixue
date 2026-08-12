#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];
const warnings = [];

function has(path) {
  return existsSync(join(root, path));
}

function requirePath(path) {
  if (!has(path)) errors.push(`缺少必要文件 / missing: ${path}`);
}

for (const path of [
  "README.md",
  "README.en.md",
  "LICENSE",
  "CONTRIBUTING.md",
  "CHANGELOG.md",
  "CODE_OF_CONDUCT.md",
  "SECURITY.md",
  "SUPPORT.md",
  "docs/AI_PROVIDER_GUIDE.md",
  "docs/KNOWN_LIMITATIONS.md",
  "docs/STARTER_ISSUES.md",
  ".env.example",
  ".nvmrc",
  ".gitignore",
  "compose.yaml",
  "examples/demo-backup.json",
  "peixue-server/package.json",
  "peixue-server/package-lock.json",
  "peixue-server/Dockerfile",
  "peixue-frontend/package.json",
  "peixue-frontend/package-lock.json",
  "peixue-frontend/Dockerfile",
  "peixue-frontend/README.md",
  "peixue-frontend/nginx.conf",
  "peixue-frontend/index.html",
  "peixue-frontend/vite.config.js",
  "peixue-frontend/tailwind.config.js",
  "peixue-frontend/postcss.config.js",
  "peixue-frontend/eslint.config.js",
  "peixue-frontend/src/App.jsx",
  "peixue-frontend/src/main.jsx",
  "peixue-frontend/src/index.css",
  "peixue-frontend/src/review.js",
  "peixue-frontend/src/sanitizeSvg.js",
  "peixue-frontend/test/review.test.js",
  "peixue-frontend/test/sanitize-svg.test.js",
  "peixue-frontend/scripts/verify-build.mjs",
  "peixue-frontend/public/manifest.json",
  "peixue-frontend/public/favicon.svg",
  "peixue-frontend/public/seed.png",
  "peixue-frontend/public/THIRD_PARTY_NOTICES.txt",
  "peixue-frontend/public/licenses/DOMPurify-Apache-2.0.txt",
]) {
  requirePath(path);
}

const frontendRoot = join(root, "peixue-frontend");
if (has("peixue-frontend/index.html")) {
  const html = readFileSync(join(frontendRoot, "index.html"), "utf8");
  for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const ref = match[1].split(/[?#]/, 1)[0];
    if (!ref || /^(?:https?:|data:|#)/.test(ref)) continue;
    const local = ref.startsWith("/") ? ref.slice(1) : ref;
    if (
      !existsSync(join(frontendRoot, local)) &&
      !existsSync(join(frontendRoot, "public", local))
    ) {
      errors.push(`index.html 引用了不存在的文件 / missing asset: ${ref}`);
    }
  }
}

if (has("peixue-frontend/public/manifest.json")) {
  try {
    const manifest = JSON.parse(
      readFileSync(join(frontendRoot, "public", "manifest.json"), "utf8")
    );
    for (const icon of manifest.icons || []) {
      const local = String(icon.src || "").replace(/^\//, "");
      if (!local || !existsSync(join(frontendRoot, "public", local))) {
        errors.push(
          `manifest.json 图标不存在 / missing manifest icon: ${icon.src || "(empty)"}`
        );
      }
    }
  } catch (error) {
    errors.push(`manifest.json 无效 / invalid JSON: ${error.message}`);
  }
}

if (has("peixue-frontend/package.json")) {
  try {
    const pkg = JSON.parse(
      readFileSync(join(frontendRoot, "package.json"), "utf8")
    );
    for (const script of ["dev", "lint", "test", "build", "check"]) {
      if (!pkg.scripts?.[script]) {
        errors.push(`前端缺少 npm 脚本 / missing frontend script: ${script}`);
      }
    }
    for (const dependency of [
      "dompurify",
      "react",
      "react-dom",
      "lucide-react",
    ]) {
      if (!pkg.dependencies?.[dependency]) {
        errors.push(
          `前端缺少运行依赖 / missing frontend dependency: ${dependency}`
        );
      }
    }
  } catch (error) {
    errors.push(`前端 package.json 无效 / invalid JSON: ${error.message}`);
  }
}

if (has("peixue-frontend/package-lock.json")) {
  const lock = readFileSync(
    join(frontendRoot, "package-lock.json"),
    "utf8"
  );
  if (lock.includes("registry.npmmirror.com")) {
    errors.push(
      "前端锁文件仍绑定第三方镜像 / frontend lockfile uses a mirror registry"
    );
  }
}

let publishCandidates = [];
try {
  const tracked = execFileSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  })
    .split("\0")
    .filter(Boolean);

  for (const path of tracked) {
    if (/(?:^|\/)\.env(?:\.|$)/.test(path) && !path.endsWith(".env.example")) {
      errors.push(`敏感配置被 Git 跟踪 / tracked secret file: ${path}`);
    }
    if (path.includes(":Zone.Identifier")) {
      errors.push(`Windows 下载元数据被 Git 跟踪 / tracked metadata: ${path}`);
    }
    if (path.startsWith("qianduan/") || path.startsWith("yuanma/")) {
      errors.push(`本地恢复目录被 Git 跟踪 / tracked recovery folder: ${path}`);
    }
    if (
      path.startsWith("peixue-frontend/dist/") ||
      path.startsWith("peixue-frontend/assets/")
    ) {
      errors.push(`前端构建产物被 Git 跟踪 / tracked frontend build: ${path}`);
    }
  }

  publishCandidates = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }
  )
    .split("\0")
    .filter(Boolean);
} catch {
  warnings.push("尚未初始化 Git；跳过 tracked-file 检查 / Git not initialized");
}

const textCandidates = new Map();
for (const path of publishCandidates) {
  try {
    const content = readFileSync(join(root, path), "utf8");
    if (!content.includes("\0")) textCandidates.set(path, content);
  } catch {
    // Binary or unreadable files are checked manually before publishing.
  }
}

const highConfidenceSecrets = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,
  /data:image\/[A-Za-z0-9.+-]+;base64,[A-Za-z0-9+/=]{128,}/,
];
for (const [path, content] of textCandidates) {
  if (highConfidenceSecrets.some((pattern) => pattern.test(content))) {
    errors.push(`疑似密钥出现在待发布文件中 / possible secret: ${path}`);
  }

  if (path.endsWith(".md")) {
    for (const match of content.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const link = match[1];
      if (/^(?:https?:|mailto:|#)/.test(link)) continue;
      const target = decodeURIComponent(link.split("#", 1)[0]);
      if (!target) continue;
      const resolved = target.startsWith("/")
        ? join(root, target.slice(1))
        : resolve(root, dirname(path), target);
      if (!existsSync(resolved)) {
        errors.push(`Markdown 链接不存在 / broken link: ${path} -> ${link}`);
      }
    }
  }
}

// If a local .env exists, make sure its sensitive values were not copied into
// a file that Git could publish. Values are never printed.
for (const envPath of [".env", "peixue-server/.env", "yuanma/.env"]) {
  if (!has(envPath)) continue;
  const envText = readFileSync(join(root, envPath), "utf8");
  for (const line of envText.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || !/(?:KEY|PASSWORD|SECRET|TOKEN)$/i.test(match[1])) continue;
    const value = match[2].replace(/^(?:"(.*)"|'(.*)')$/, "$1$2").trim();
    if (!value || value.length < 8 || /^(?:change|replace|example|your-)/i.test(value)) {
      continue;
    }
    for (const [path, content] of textCandidates) {
      if (content.includes(value)) {
        errors.push(`本地凭据值出现在待发布文件中 / copied local secret: ${path}`);
      }
    }
  }
}

for (const warning of warnings) console.warn(`WARN: ${warning}`);

if (errors.length > 0) {
  for (const error of errors) console.error(`ERROR: ${error}`);
  console.error(`\n仓库检查失败，共 ${errors.length} 项。`);
  process.exit(1);
}

console.log(
  `仓库基础检查通过 (${relative(process.cwd(), root) || "."})，警告 ${warnings.length} 项。`
);
