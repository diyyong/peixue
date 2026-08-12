// ============================================================
// 陪学笔记本 · 后端服务 v4.4（流式全覆盖 + 模型按接口拆分）
//
// 相对 v4.3 的变化：
//   · /api/review-quiz 也改为 SSE 流式
//   · 新增 resolveModel(endpoint)，模型按接口可配：
//       AI_MODEL              全局默认（必填）
//       AI_MODEL_ANALYZE      错题分析模型，留空继承全局
//       AI_MODEL_QUIZ         出题模型，留空继承全局（推荐用更快的，如 glm-4-flash）
//       AI_VISION_MODEL       视觉模型（语义不同，独立变量）
//   · 启动日志 / /api/health 都展示三个模型分别是什么
//
// 历史变化（v4.2 → v4.3）：
//   · 思考模式（thinking）从硬编码改为环境变量控制（resolveThinking）
//   · /api/analyze 改为 SSE 流式输出
//
// SSE 协议：start / reasoning / content / done / error 五种事件
// 心跳：每 15s 一行 ": heartbeat\n\n"
// 客户端断开：自动 abort 上游、退还配额、写审计
//
// 准确性策略（不变）：
//   1. 默认开 thinking（env 可关）
//   2. /api/review-quiz temperature 0.2
//   3. review-quiz prompt 要求先分步推理（知识点→答案→自验证）
//
// 稳定性策略（不变）：
//   · AbortController 控 5 分钟总超时
//   · trust proxy: 1
//   · 模型能力缓存（response_format 不支持自动降级）
//   · 超时 / 客户端断开 不扣配额
// ============================================================

import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { jsonrepair } from "jsonrepair";
import { readFileSync } from "node:fs";
import "dotenv/config";
import * as db from "./db.mjs";

const app = express();
const APP_VERSION = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8")
).version;
const PORT = process.env.PORT || 3001;
const HOST = process.env.HOST || "127.0.0.1";

// ============================================================
// AI 调用超时（v4.1.5）
// 之前用 undici.Agent 精细控制超时，但 node_modules 里可能装了
// 和 Node 内置版本不同的 undici（例如 7.x），导致 handler 接口
// 不兼容（UND_ERR_INVALID_ARG: invalid onRequestStart method）。
// 改用 Node 内置的 AbortController，无外部依赖，鲁棒。
// 代价：只有总超时，不分 headersTimeout / bodyTimeout。对本应用够用。
// ============================================================
const AI_TOTAL_TIMEOUT_MS = 300_000; // 5 分钟总超时（thinking 场景下够用）

// ============================================================
// 反向代理信任（v4.1.1）
// 宝塔/nginx 反代会把真实 IP 放在 X-Forwarded-For 头里。
// 默认 Express 不信任这个头，会导致 express-rate-limit 把所有
// 请求识别成同一个 IP（nginx 的回环 IP），限流失效。
// trust proxy: 1 表示"信任最近一层代理"——如果你前面只有一层
// nginx，这就够了；如果用了 Cloudflare 等多层 CDN，可能要改成
// 2 或更精细的 IP 白名单。
// 注意：千万不要设成 true（信任所有代理），会被伪造 IP 刷限流。
// ============================================================
app.set("trust proxy", 1);

// ============================================================
// 中间件
// ============================================================
// body limit 提高到 64mb（v4.6）
// · 单个看图题录入 ~300KB base64
// · 备份导入：100 道带图题 ≈ 30MB
// · 8mb 太紧，64mb 给足余量；nginx 那边也得相应调 client_max_body_size
app.use(express.json({ limit: "64mb" }));

// 默认按同源部署，不发送跨域响应头。确实需要把前后端放在不同域名时，
// 用 CORS_ORIGIN 配置一个或多个明确来源（逗号分隔）；"*" 只建议本地调试。
const allowedCorsOrigins = (process.env.CORS_ORIGIN || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
app.use(
  cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (allowedCorsOrigins.includes("*") || allowedCorsOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(null, false);
    },
  })
);

// 限流：每个 IP 每 15 分钟最多 300 次（加入数据接口后调用数变多）
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  message: { error: "请求太频繁，请稍后再试" },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use("/api/", limiter);

// ============================================================
// 访问密码校验：查数据库对每个家庭的 bcrypt hash 做比对
// 校验成功后把 familyId 挂在 req 上供下游使用
// ============================================================
async function requireAccessPassword(req, res, next) {
  const pw = req.headers["x-access-password"];
  if (!pw) {
    return res.status(401).json({ error: "缺少访问密码", code: "no_password" });
  }
  try {
    const auth = await db.authenticateByPassword(pw);
    if (!auth.ok) {
      if (auth.reason === "expired") {
        return res.status(403).json({
          error: `家庭账号「${auth.familyName}」已过期。请联系管理员续期。`,
          code: "family_expired",
        });
      }
      if (auth.reason === "wrong_password") {
        return res.status(401).json({ error: "访问密码错误", code: "wrong_password" });
      }
      if (auth.reason === "no_family") {
        return res.status(503).json({
          error: "系统尚未初始化任何家庭。请联系管理员。",
          code: "no_family",
        });
      }
      return res.status(401).json({ error: "认证失败", code: auth.reason });
    }
    req.familyId = auth.familyId;
    req.familyName = auth.familyName;
    req.familyQuota = auth.dailyQuota;
    next();
  } catch (err) {
    console.error("认证中出错:", err);
    res.status(500).json({ error: "认证失败" });
  }
}

// ============================================================
// 配额检查中间件：只挂到 AI 接口
// 请求结束后把调用计入 daily_usage + 写审计日志
// ============================================================
function requireAIQuota(endpointName) {
  return async (req, res, next) => {
    try {
      const result = await db.incrementDailyUsage(req.familyId, req.familyQuota);
      if (!result.ok) {
        // 配额用完了，直接拒绝 + 写审计
        db.writeAuditLog({
          familyId: req.familyId,
          endpoint: endpointName,
          success: false,
          errorMsg: `quota_exceeded ${result.current}/${result.quota}`,
          ip: req.ip,
          latencyMs: 0,
        });
        return res.status(429).json({
          error: `今日额度已用完（${result.quota} 次/天）。明天 0 点后自动重置。`,
          code: "quota_exceeded",
          current: result.current,
          quota: result.quota,
        });
      }
      // 配额已 +1，把信息传给下游
      req.quotaUsed = result.current;
      req.quotaTotal = result.quota;
      req.aiEndpointName = endpointName;
      req.aiStartTime = Date.now();
      next();
    } catch (err) {
      console.error("配额检查失败:", err);
      res.status(500).json({ error: "配额服务异常" });
    }
  };
}

// 简易按家庭的速率限制：每分钟最多 20 次 AI 调用（配额是每天 N 次；限流是保护性质的）
const familyRateBuckets = new Map(); // familyId -> { count, windowStart }
function requireFamilyRateLimit(req, res, next) {
  const now = Date.now();
  const bucket = familyRateBuckets.get(req.familyId) || { count: 0, windowStart: now };
  if (now - bucket.windowStart > 60 * 1000) {
    // 新窗口
    bucket.count = 0;
    bucket.windowStart = now;
  }
  bucket.count++;
  familyRateBuckets.set(req.familyId, bucket);
  if (bucket.count > 20) {
    return res.status(429).json({
      error: "请求太快。稍等 1 分钟再试。",
      code: "rate_limited",
    });
  }
  next();
}

// 清理过期的速率限制桶（避免内存泄漏）
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of familyRateBuckets.entries()) {
    if (now - v.windowStart > 2 * 60 * 1000) familyRateBuckets.delete(k);
  }
}, 5 * 60 * 1000);

// ============================================================
// 工具：思考模式解析（v4.3）
// 优先级：AI_THINKING_<ENDPOINT> > AI_THINKING > "enabled"
// 接受的写法非常宽松，避免运维改 env 时拼错：
//   关：disabled / off / false / no / 0
//   自动：auto
//   开：其他一切（包括空字符串）
// ============================================================
function resolveThinking(endpoint) {
  const perEp = process.env[`AI_THINKING_${endpoint.toUpperCase()}`];
  const global = process.env.AI_THINKING;
  const raw = (perEp || global || "enabled").toLowerCase().trim();
  if (["disabled", "off", "false", "no", "0"].includes(raw)) return "disabled";
  if (raw === "auto") return "auto";
  return "enabled";
}

// ============================================================
// 工具：模型按接口选型（v4.4）
// 优先级：AI_MODEL_<ENDPOINT> > AI_MODEL > 报错
// 视觉接口不走这个函数，仍用 AI_VISION_MODEL（语义不同，分开管更清楚）。
// 典型用法：
//   AI_MODEL=glm-5.1            （主力，分析用）
//   AI_MODEL_QUIZ=glm-4-flash   （出题降级，更快）
//   AI_MODEL_ANALYZE=           （留空 = 继承 AI_MODEL）
// ============================================================
function resolveModel(endpoint) {
  const perEp = process.env[`AI_MODEL_${endpoint.toUpperCase()}`];
  const fallback = process.env.AI_MODEL;
  const m = (perEp || fallback || "").trim();
  if (!m) {
    throw new Error(
      `未配置模型：请在 .env 设置 AI_MODEL 或 AI_MODEL_${endpoint.toUpperCase()}`
    );
  }
  return m;
}

// ============================================================
// 工具：调用 GLM 兼容接口（非流式）
// ============================================================

// v4.1.1: 记住哪些模型不支持 response_format（json_object）。
// 比如智谱当前线上 GLM-5.1 不支持，豆包支持。一次失败后记住，
// 下次同模型直接跳过 JSON 模式，不再打扰上游也不再刷日志。
const unsupportedJsonFormatModels = new Set();

async function callGLM({
  model,
  messages,
  temperature = 0.3,
  max_tokens = 8000,
  useJsonFormat = true,
  thinkingMode = "enabled", // v4.3: enabled / disabled / auto
}) {
  // 之前已学到此模型不支持，直接关闭 JSON 模式
  if (useJsonFormat && unsupportedJsonFormatModels.has(model)) {
    useJsonFormat = false;
  }
  // 构建 payload 的内部函数，jsonFormat 参数化方便降级重试
  const buildPayload = (jsonFormat) => {
    const payload = {
      model,
      messages,
      temperature,
      max_tokens,
    };

    // v4.3: 思考模式三态控制
    //   - disabled: 显式关闭，发 thinking:{type:"disabled"}
    //   - auto: 让上游自己决定（仅部分模型支持，比如豆包 seed-1.6 系列）
    //   - enabled: 不发 thinking 字段，按上游默认行为（GLM-5 默认就是开的，
    //              豆包 thinking 模型默认也是开的）。这样跨厂商最安全。
    if (thinkingMode === "disabled") {
      payload.thinking = { type: "disabled" };
    } else if (thinkingMode === "auto") {
      payload.thinking = { type: "auto" };
    }
    // enabled 不加字段，按上游默认

    if (jsonFormat) {
      payload.response_format = { type: "json_object" };
    }

    return payload;
  };

  const doRequest = async (payload) => {
    let upstream;
    // v4.1.5: AbortController 做总超时，不再依赖 undici Agent
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort(new Error("AI_TIMEOUT"));
    }, AI_TOTAL_TIMEOUT_MS);

    try {
      upstream = await fetch(process.env.AI_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.AI_API_KEY}`,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (networkErr) {
      // 超时：controller.abort 触发的 AbortError
      if (
        networkErr?.name === "AbortError" ||
        networkErr?.cause?.message === "AI_TIMEOUT"
      ) {
        const e = new Error(
          `AI 思考超过 ${Math.round(
            AI_TOTAL_TIMEOUT_MS / 1000
          )} 秒未返回。可能是上游临时拥堵，请稍后重试（不会重复扣配额）。`
        );
        e.status = 504;
        e.isTimeout = true;
        throw e;
      }

      // v4.1.4: 把完整 cause 打出来。"fetch failed" 这层壳没有信息量。
      console.error("[callGLM] fetch 失败，完整诊断信息：");
      console.error("  endpoint:", process.env.AI_ENDPOINT);
      console.error("  outer.message:", networkErr?.message);
      console.error("  outer.code:", networkErr?.code);
      if (networkErr?.cause) {
        console.error("  cause.code:", networkErr.cause.code);
        console.error("  cause.errno:", networkErr.cause.errno);
        console.error("  cause.syscall:", networkErr.cause.syscall);
        console.error("  cause.message:", networkErr.cause.message);
        console.error(
          "  cause.stack:",
          String(networkErr.cause.stack || "").split("\n").slice(0, 5).join("\n")
        );
      } else {
        console.error("  （无 cause，打印整个对象）:", networkErr);
      }

      const code = networkErr?.cause?.code || networkErr?.code || "";
      if (
        code === "ENOTFOUND" ||
        code === "ECONNREFUSED" ||
        code === "UND_ERR_CONNECT_TIMEOUT"
      ) {
        const e = new Error(
          `无法连接 AI 端点（${code}）。检查 AI_ENDPOINT 和网络/防火墙。`
        );
        e.status = 502;
        throw e;
      }

      // 其他未知网络错 —— 把 cause 信息也带到错误 message 里
      const causeInfo = networkErr?.cause?.code
        ? ` (cause: ${networkErr.cause.code}${
            networkErr.cause.message ? ` - ${networkErr.cause.message}` : ""
          })`
        : networkErr?.cause?.message
        ? ` (cause: ${networkErr.cause.message})`
        : "";
      const e = new Error(`AI 网络错误：${networkErr.message}${causeInfo}`);
      e.status = 502;
      throw e;
    } finally {
      clearTimeout(timeoutId);
    }

    if (!upstream.ok) {
      const errText = await upstream.text();
      const err = new Error(
        `AI 服务返回 ${upstream.status}: ${errText.slice(0, 400)}`
      );
      err.status = upstream.status;
      err.upstreamText = errText;
      throw err;
    }
    return await upstream.json();
  };

  // —— 主请求 ——
  let data;
  try {
    data = await doRequest(buildPayload(useJsonFormat));
  } catch (err) {
    // 如果是带 response_format 时的 4xx 错误，且 upstream 文本里明确
    // 指向 response_format 或 json_object，则自动降级关掉 JSON 模式重试一次
    const upstreamText = (err.upstreamText || "").toLowerCase();
    const looksLikeFormatError =
      useJsonFormat &&
      err.status >= 400 && err.status < 500 &&
      (upstreamText.includes("response_format") ||
        upstreamText.includes("json_object") ||
        upstreamText.includes("json mode"));

    if (looksLikeFormatError) {
      console.warn(
        `⚠️  上游拒绝 response_format，自动关闭 JSON 模式重试。原始错误：${err.upstreamText.slice(
          0,
          300
        )}`
      );
      // v4.1.1: 记住此模型不支持，下次直接跳过 JSON 模式
      unsupportedJsonFormatModels.add(model);
      console.log(
        `📝 已记住模型 ${model} 不支持 response_format，后续请求自动跳过 JSON 模式`
      );
      data = await doRequest(buildPayload(false));
    } else {
      // 其他错误原样抛出，打印上游真实响应方便排查
      console.error(
        `AI 服务错误 ${err.status}:`,
        (err.upstreamText || err.message).slice(0, 500)
      );
      throw err;
    }
  }

  let content = data.choices?.[0]?.message?.content || "";
  const reasoning = data.choices?.[0]?.message?.reasoning || "";

  // 兜底：如果 content 为空但 reasoning 有 JSON
  if (!content && reasoning) {
    const m = reasoning.match(/\{[\s\S]*\}/);
    if (m) content = m[0];
  }

  if (!content) {
    console.error(
      "⚠️  AI 返回空 content，完整响应:",
      JSON.stringify(data).slice(0, 1000)
    );
    throw new Error(
      `AI 返回为空。可能是模型名错误、token 超限、或思考模式没关住。`
    );
  }

  return content;
}

// ============================================================
// 工具：调用 GLM 兼容接口（流式 / SSE 版，v4.3）
// ============================================================
// 设计要点：
//   · 上游用 stream:true，逐 chunk 解析 SSE
//   · GLM-5 / 豆包 thinking 模型在流式下：
//       - delta.reasoning_content 是思考过程
//       - delta.content 是最终答案
//     有些上游字段名是 reasoning，做了双兼容
//   · 流式时不强制 response_format=json_object（部分上游对组合支持不稳，
//     且不会因为关 JSON 模式更慢——靠 prompt 自己保证 JSON 形态即可）
//   · 总超时仍然 5 分钟，由内部 AbortController 控制
//   · 外部可以传 abortSignal（客户端断开），一并触发 abort
//   · 返回累积的 fullReasoning 和 fullContent，调用方按需用
// ============================================================
async function callGLMStream({
  model,
  messages,
  temperature = 0.3,
  max_tokens = 8000,
  thinkingMode = "enabled",
  onReasoningChunk,
  onContentChunk,
  abortSignal,
}) {
  const payload = {
    model,
    messages,
    temperature,
    max_tokens,
    stream: true,
  };

  if (thinkingMode === "disabled") {
    payload.thinking = { type: "disabled" };
  } else if (thinkingMode === "auto") {
    payload.thinking = { type: "auto" };
  }

  // 总超时 + 客户端断开 合并到一个 AbortController
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(new Error("AI_TIMEOUT")),
    AI_TOTAL_TIMEOUT_MS
  );

  if (abortSignal) {
    if (abortSignal.aborted) {
      controller.abort(new Error("CLIENT_ABORT"));
    } else {
      abortSignal.addEventListener(
        "abort",
        () => controller.abort(new Error("CLIENT_ABORT")),
        { once: true }
      );
    }
  }

  let upstream;
  try {
    upstream = await fetch(process.env.AI_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.AI_API_KEY}`,
        Accept: "text/event-stream",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (networkErr) {
    clearTimeout(timeoutId);
    const causeMsg = networkErr?.cause?.message;
    if (causeMsg === "AI_TIMEOUT" || networkErr?.name === "AbortError") {
      const e = new Error(
        `AI 思考超过 ${Math.round(
          AI_TOTAL_TIMEOUT_MS / 1000
        )} 秒未返回。可能是上游临时拥堵，请稍后重试（不会重复扣配额）。`
      );
      e.status = 504;
      e.isTimeout = true;
      throw e;
    }
    if (causeMsg === "CLIENT_ABORT") {
      const e = new Error("客户端已断开连接");
      e.isClientAbort = true;
      throw e;
    }
    const code = networkErr?.cause?.code || networkErr?.code || "";
    if (
      code === "ENOTFOUND" ||
      code === "ECONNREFUSED" ||
      code === "UND_ERR_CONNECT_TIMEOUT"
    ) {
      const e = new Error(`无法连接 AI 端点（${code}）。检查 AI_ENDPOINT。`);
      e.status = 502;
      throw e;
    }
    const e = new Error(`AI 网络错误：${networkErr.message}`);
    e.status = 502;
    throw e;
  }

  if (!upstream.ok) {
    clearTimeout(timeoutId);
    const errText = await upstream.text();
    const err = new Error(
      `AI 服务返回 ${upstream.status}: ${errText.slice(0, 400)}`
    );
    err.status = upstream.status;
    err.upstreamText = errText;
    throw err;
  }

  // —— 解析 SSE ——
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let fullReasoning = "";
  let fullContent = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE 事件以 \n\n 分隔
      const events = buffer.split("\n\n");
      buffer = events.pop(); // 最后一段可能不完整，留到下轮

      for (const ev of events) {
        // 一个事件可能有多行 data:，按 SSE 规范要拼起来
        const lines = ev.split("\n");
        let dataConcat = "";
        for (const line of lines) {
          if (line.startsWith("data:")) {
            dataConcat += line.slice(5).replace(/^ /, "");
          }
          // event: / id: / retry: / 注释行（: 开头）这里都不需要
        }
        if (!dataConcat) continue;
        if (dataConcat === "[DONE]") continue;

        let obj;
        try {
          obj = JSON.parse(dataConcat);
        } catch {
          continue; // 半个 chunk，跳过
        }

        const delta = obj.choices?.[0]?.delta || {};
        // GLM / 豆包 / DeepSeek 都用 reasoning_content；少数老接口叫 reasoning
        const reasoningChunk = delta.reasoning_content || delta.reasoning || "";
        const contentChunk = delta.content || "";

        if (reasoningChunk) {
          fullReasoning += reasoningChunk;
          try {
            onReasoningChunk?.(reasoningChunk);
          } catch (_) {}
        }
        if (contentChunk) {
          fullContent += contentChunk;
          try {
            onContentChunk?.(contentChunk);
          } catch (_) {}
        }
      }
    }
  } catch (err) {
    if (controller.signal.aborted) {
      const reason = controller.signal.reason;
      if (reason?.message === "AI_TIMEOUT") {
        const e = new Error("AI 思考超时");
        e.isTimeout = true;
        e.status = 504;
        throw e;
      }
      if (reason?.message === "CLIENT_ABORT") {
        const e = new Error("客户端已断开");
        e.isClientAbort = true;
        throw e;
      }
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!fullContent && !fullReasoning) {
    throw new Error("AI 流式返回为空。模型名错？token 超限？");
  }

  return { fullReasoning, fullContent };
}

// ============================================================
// 工具：稳健的 JSON 解析（三层降级）
// ============================================================
function parseJsonSafe(rawText) {
  if (!rawText) return null;

  // 去掉可能的 markdown 代码块壳
  let text = rawText
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  // 第一层：直接解析
  try {
    return JSON.parse(text);
  } catch (e) {
    // 继续
  }

  // 第二层：切到最外层 {} 再试
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) {
    const sliced = text.slice(first, last + 1);
    try {
      return JSON.parse(sliced);
    } catch (e) {
      // 继续
    }
    // 第三层：用 jsonrepair 修复常见错误（未转义引号、尾逗号、截断等）
    try {
      const repaired = jsonrepair(sliced);
      return JSON.parse(repaired);
    } catch (e) {
      // 继续
    }
  }

  // 第四层：对全文用 jsonrepair
  try {
    const repaired = jsonrepair(text);
    return JSON.parse(repaired);
  } catch (e) {
    return null;
  }
}

// ============================================================
// 接口 1: /api/analyze  — 文本错题分析（v4.3 SSE 流式）
// ============================================================
// 请求格式不变（仍是 POST JSON）。
// 响应：text/event-stream。事件类型：
//   event: start      data: { quota:{used,total} }      —— 开始处理
//   event: reasoning  data: { text: "..." }             —— 思考过程增量
//   event: content    data: { text: "..." }             —— 答案 JSON 增量
//   event: done       data: { data:{...}, quota:{...} } —— 解析完成的最终结果
//   event: error      data: { error:"...", code, status} —— 出错
//
// 注意：认证 / 限流 / 配额这些中间件错误仍会返回普通 JSON
// （因为发生在 flushHeaders 之前），前端按 Content-Type 判断。
// ============================================================
app.post(
  "/api/analyze",
  requireAccessPassword,
  requireFamilyRateLimit,
  requireAIQuota("analyze"),
  async (req, res) => {
    const { system, user, temperature = 0.3, max_tokens = 8000 } = req.body;

    if (!system || !user) {
      return res.status(400).json({ error: "缺少 system 或 user 参数" });
    }

    // v4.1: 出题/分析场景，温度不允许超过 0.4
    const safeTemperature = Math.min(Number(temperature) || 0.3, 0.4);
    const startedAt = req.aiStartTime || Date.now();
    const modelName = resolveModel("analyze");

    // —— 切到 SSE 模式 ——
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    // 关键：告诉 nginx / 宝塔反代不要缓冲
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const send = (event, payload) => {
      if (res.writableEnded) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    };

    // 心跳：每 15 秒发一次 SSE 注释行
    // 防止 nginx / Cloudflare / 客户端反代在长 thinking 期间把连接切了
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(`: heartbeat\n\n`);
    }, 15000);

    // 客户端断开（用户切页 / 关浏览器）时：
    //   1. 中断上游 fetch（abortSignal）
    //   2. 退还配额（提前取消不算用户用了一次）
    //   3. 写审计日志
    let clientAborted = false;
    const clientAbortController = new AbortController();
    const onClientClose = () => {
      if (clientAborted || res.writableEnded) return;
      clientAborted = true;
      clientAbortController.abort();
      clearInterval(heartbeat);
      db.decrementDailyUsage?.(req.familyId).catch(() => {});
      db.writeAuditLog({
        familyId: req.familyId,
        endpoint: "analyze",
        success: false,
        errorMsg: "client_abort",
        ip: req.ip,
        latencyMs: Date.now() - startedAt,
        model: modelName,
      });
    };
    req.on("close", onClientClose);

    try {
      // 先告诉前端开始了，并把当前配额发过去
      send("start", {
        quota: { used: req.quotaUsed, total: req.quotaTotal },
      });

      const { fullContent } = await callGLMStream({
        model: modelName,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: safeTemperature,
        max_tokens,
        thinkingMode: resolveThinking("analyze"),
        onReasoningChunk: (chunk) => send("reasoning", { text: chunk }),
        onContentChunk: (chunk) => send("content", { text: chunk }),
        abortSignal: clientAbortController.signal,
      });

      if (clientAborted) return; // 已经在 onClientClose 处理过了

      // 流结束，整体 JSON 解析
      const parsed = parseJsonSafe(fullContent);

      if (!parsed) {
        console.error(
          "AI 流式返回无法解析 JSON，原文:",
          fullContent.slice(0, 800)
        );
        db.writeAuditLog({
          familyId: req.familyId,
          endpoint: "analyze",
          success: false,
          errorMsg: "json_parse_failed",
          ip: req.ip,
          latencyMs: Date.now() - startedAt,
          model: modelName,
        });
        send("error", {
          error: "AI 返回的 JSON 无法解析。通常重试一次即可。",
          preview: fullContent.slice(0, 200),
          status: 502,
        });
        return;
      }

      db.writeAuditLog({
        familyId: req.familyId,
        endpoint: "analyze",
        success: true,
        ip: req.ip,
        latencyMs: Date.now() - startedAt,
        model: modelName,
      });

      send("done", {
        data: parsed,
        quota: { used: req.quotaUsed, total: req.quotaTotal },
      });
    } catch (err) {
      if (err.isClientAbort || clientAborted) return;

      console.error("分析失败（流式）:", err.message);

      db.writeAuditLog({
        familyId: req.familyId,
        endpoint: "analyze",
        success: false,
        errorMsg: err.isTimeout ? "thinking_timeout" : err.message,
        ip: req.ip,
        latencyMs: Date.now() - startedAt,
        model: modelName,
      });

      // 超时退配额
      if (err.isTimeout) {
        try {
          await db.decrementDailyUsage?.(req.familyId);
        } catch (_) {}
      }

      send("error", {
        error: err.message || "服务器内部错误",
        code: err.isTimeout ? "ai_timeout" : undefined,
        status: err.status,
      });
    } finally {
      clearInterval(heartbeat);
      req.off("close", onClientClose);
      if (!res.writableEnded) res.end();
    }
  }
);

// ============================================================
// 接口 2: /api/vision  — 拍照识图 + OCR
// ============================================================
app.post(
  "/api/vision",
  requireAccessPassword,
  requireFamilyRateLimit,
  requireAIQuota("vision"),
  async (req, res) => {
    const { imageBase64, subject = "数学", kidGrade = "一年级" } = req.body;

    if (!imageBase64) {
      return res.status(400).json({ error: "缺少 imageBase64 参数" });
    }

    const visionModel = process.env.AI_VISION_MODEL || "glm-4v-flash";
    const startedAt = req.aiStartTime || Date.now();

    const promptText = `这是一张${kidGrade}${subject}作业/试卷的照片。请做三件事：

1. 识别图中的题目（尽量原文）
2. 如能看清，识别孩子写的答案，以及是否有批改标记（红勾 √ 红叉 ×）
3. 重点：详细描述图中的所有视觉信息（除题目文字之外的部分），让没有视觉能力的 AI 也能仅凭这段文字理解这道题——
   · 几何图形：形状、相对位置、长度/角度的标注、阴影部分、辅助线
   · 实物图：物品种类、数量、颜色（如 5 个苹果 + 3 个梨）
   · 钟面：时针分针指向、几点几分
   · 人民币：面值、张数
   · 统计图：横纵轴含义、各柱/线的数值
   · 看图说话：场景中的人/动物/物品、动作、表情
   · 拼音/笔画：字的写法特征、错误位置
   如果题目纯文字没有图，本字段填 null。

请只返回以下格式的 JSON，不要有任何前言或代码块标记。字符串内部若需引用字符或词，用中文直角引号 「」 或书名号 『』，绝不使用双引号。

{
  "recognized_problem": "题目原文，尽量完整；如有多道题只取最显眼的一道",
  "kid_answer": "孩子写的答案；看不清或没写写 null",
  "correct_mark": "正确 或 错误 或 未批改",
  "image_description": "图中视觉信息的精确描述（≤200字），纯文字题填 null",
  "observation": "你注意到的其他有用信息，比如涂改痕迹、题号、题型等（一句话即可）"
}`;

    try {
      const content = await callGLM({
        model: visionModel,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: promptText },
              {
                type: "image_url",
                image_url: {
                  url: imageBase64.startsWith("data:")
                    ? imageBase64
                    : `data:image/jpeg;base64,${imageBase64}`,
                },
              },
            ],
          },
        ],
        temperature: 0.3,
        max_tokens: 1500,
        useJsonFormat: false,
        thinkingMode: resolveThinking("vision"), // v4.3: env 控制（建议设 disabled，OCR 不需要思考）
      });

      const parsed = parseJsonSafe(content);
      const latencyMs = Date.now() - startedAt;

      if (!parsed) {
        console.error("视觉模型返回无法解析:", content.slice(0, 500));
        db.writeAuditLog({
          familyId: req.familyId,
          endpoint: "vision",
          success: true, // 有返回，只是解析失败
          errorMsg: "json_parse_failed_degraded",
          ip: req.ip,
          latencyMs,
          model: visionModel,
        });
        return res.json({
          data: {
            recognized_problem: content.slice(0, 200),
            kid_answer: null,
            correct_mark: "未批改",
            image_description: null,
            observation: "(AI 没能返回结构化结果，以上是原始识别文字，请手动整理)",
          },
          warning: "识图结果结构化失败，已降级为原始文本",
          quota: { used: req.quotaUsed, total: req.quotaTotal },
        });
      }

      db.writeAuditLog({
        familyId: req.familyId,
        endpoint: "vision",
        success: true,
        ip: req.ip,
        latencyMs,
        model: visionModel,
      });
      res.json({ data: parsed, quota: { used: req.quotaUsed, total: req.quotaTotal } });
    } catch (err) {
      console.error("识图失败:", err);
      db.writeAuditLog({
        familyId: req.familyId,
        endpoint: "vision",
        success: false,
        errorMsg: err.message,
        ip: req.ip,
        latencyMs: Date.now() - startedAt,
        model: visionModel,
      });
      res.status(500).json({ error: err.message || "服务器内部错误" });
    }
  }
);

// ============================================================
// 复习题 prompt 构造（v4.6 看图题增强 + v4.7 唯一来源）
// ============================================================
// v4.7 改动：原 /api/review-quiz 流式端点已废弃，所有出题流量统一走
// /api/cached-quiz/:momentId 的 SSE 端点（带总线/合流/缓存）。
// 这个 prompt 函数是出题逻辑的单一来源。
function buildQuizPrompt({
  originalProblem,
  originalMisconception,
  originalImageDescription,
  subject,
  kidGrade,
  recentQuizzes, // v4.8: 这道题最近出过的几道复习题，用于去重
}) {
  // v4.8.2: 语文出题时强约束用字范围，避免冒出孩子还没学的超纲字。
  // 不塞完整字表（token 太贵且 AI 也不会逐字检查），用累计识字量做软约束。
  const chineseCharBlock = subject === "语文"
    ? `

【出题用字范围（重要）】
请只用孩子年级范围内学过的常用字。按部编版教材累计识字量：
  · 一年级 ≈ 700 字  · 二年级 ≈ 1600 字  · 三年级 ≈ 2000 字
  · 四年级 ≈ 2500 字 · 五~六年级在 3000 常用字以内
情境不得不用超纲字时，请在该字后用括号加拼音（如"踱(duó)步"）。
专有名词（人名/地名）不受此限。`
    : "";

  const system = `你是小学${subject || "数学"}老师，正在帮家长给${kidGrade || "低年级"}的孩子出一道复习考察题。
你的任务是基于孩子之前做错的题，出一道同一考点、但场景/数字完全不同的新题，来验证孩子是否真掌握了那个知识点。

出题前请先在内部分步思考（不要把思考过程写进最终 JSON）：
  Step 1. 原题考察的知识点究竟是什么？用一句话说清。
  Step 2. 设计新题的情境与数字。
  Step 3. 一步一步算出 / 推出 标准答案。
  Step 4. 把答案代回题面再读一遍，确认题目问的就是这个答案。
  Step 5. 若涉及笔顺、笔画数、拼音、成语、典故等有标准答案的内容，
          务必按教材/国标填写，宁可放弃该题型改出别的，也不要凭印象答错。

【看图题特别说明】
  如果原题需要看图（你会从原题描述里看到「图中信息」字样），那么你出的新题大概率也需要图。
  这种情况下，请在 quiz_svg 字段里直接生成一个 SVG，让家长可以直接展示给孩子看。
  SVG 规则：
    · 只用纯 SVG 标签（rect, circle, line, polyline, polygon, path, text 等），不要有 <script>、不要有事件属性、不要 foreignObject
    · viewBox 用 "0 0 400 300" 这种合适的尺寸，不要写 width/height（让前端自适应）
    · 文字用中文宋体或黑体；尺寸标注、题号、单位都画出来
    · 颜色不要太花哨，黑/灰/红/蓝即可
    · 风格简洁清晰，像教辅书的插图，不追求美术感

  ⚠️ 结构性图（竖式、网格、表格）的"工程纪律"——非常重要，错了孩子直接做不了：
    1. 出图前先在心里定网格：列宽 col=40，行高 row=40，左边距 left=80，顶部 top=40
    2. 同一列的所有数字（含进位/借位/横线/答案）必须用同一个 x 坐标
       例：个位列 x=240，十位列 x=200，百位列 x=160——千万不要逐个数字现想 x
    3. 文字水平居中：text-anchor="middle"（数字在列中央），加法/减法符号也用 middle
    4. 加法/减法/竖式除法的横线必须画出来，长度从最左列延伸到最右列再多 10px：
       <line x1=最左 x2=最右+10 y1=横线y y2=横线y stroke="black" stroke-width="2"/>
    5. 数位顺序自检：对齐前先在心里确认"个位最右、依次往左是十位百位"，不要颠倒

  ✅ 正确的两位数加法竖式示例（23 + 45）：
    <svg viewBox="0 0 320 200" xmlns="http://www.w3.org/2000/svg">
      <text x="240" y="60" font-size="32" text-anchor="middle" font-family="serif">2</text>
      <text x="280" y="60" font-size="32" text-anchor="middle" font-family="serif">3</text>
      <text x="180" y="110" font-size="32" text-anchor="middle" font-family="serif">+</text>
      <text x="240" y="110" font-size="32" text-anchor="middle" font-family="serif">4</text>
      <text x="280" y="110" font-size="32" text-anchor="middle" font-family="serif">5</text>
      <line x1="200" y1="125" x2="300" y2="125" stroke="black" stroke-width="2"/>
    </svg>
    注意：23 的"3"和 45 的"5"都在 x=280（个位列），"2"和"4"都在 x=240（十位列）。
    横线 y=125 在第二行下方、答案上方，长度从 x=200 延伸到 x=300 覆盖了所有数位。

  ❌ 不要这样（数位错位）：
    <text x="240" y="60">2</text><text x="280" y="60">3</text>  ← 23 个位在 x=280
    <text x="280" y="110">4</text><text x="320" y="110">5</text>  ← 45 个位跑到 x=320 了！
    会变成上下错位一列，孩子做不了。

  如果原题不需要图、新题也不需要图，quiz_svg 字段填 null（或省略）。${chineseCharBlock}

只返回 JSON，字符串内部引用字符请用『』或「」，不要用双引号。`;

  const imageDescBlock = originalImageDescription
    ? `\n原题的图中信息：${originalImageDescription}\n（这是视觉模型识别后写的描述。新题如果也是看图题，请基于同一考点重新设计图。）`
    : "";

  // v4.8: 历史题去重段。不是每次都有（第一次出题时为空数组）。
  // 如果给的题面太长，全塞进去会撑大 prompt token，按 80 字截断
  const recentBlock =
    recentQuizzes && recentQuizzes.length > 0
      ? `\n之前已经出过的考察题（共 ${recentQuizzes.length} 道，请避免雷同——情境、数字、问法都要不一样）：\n${recentQuizzes
          .map((q, i) => `  ${i + 1}. ${(q || "").slice(0, 80)}`)
          .join("\n")}\n`
      : "";

  const user = `孩子之前做错的题：${originalProblem}${imageDescBlock}
那次分析认为的认知偏差：${originalMisconception || "（无记录）"}${recentBlock}
请出一道新题考察同一个知识点，要求：
- 数字或情境要不一样（不能只是换个数字）${recentQuizzes && recentQuizzes.length > 0 ? "，且与上面列出的历史题都不雷同" : ""}
- 难度相当，不要突然拔高
- 适合${kidGrade || "低年级"}

返回格式：
{
  "quiz_question": "新题的完整题面",
  "quiz_svg": "如果新题需要图，写一段合法的 SVG 字符串；不需要图则填 null",
  "expected_answer": "参考答案（只给答案本身，不要解题过程）",
  "key_check": "家长该重点观察孩子答题过程中的什么（≤40字）",
  "if_correct": "孩子答对了说明什么（≤30字）",
  "if_wrong": "孩子又答错了可能是什么问题（≤40字）"
}`;

  return { system, user };
}

// ============================================================
// 讲解卡 prompt 构造（v4.9）
// ============================================================
// 触发：moment.wrong_streak >= 3 时不再出题，改让 AI 写一段
// "家长可以照着讲给孩子听" 的脚本。这是产品的"切换模式"环节——
// 系统主动承认"再让 ta 做一道大概率还是错"，把麦克风递给家长。
//
// 与 buildQuizPrompt 的关键差别：
//   · 受众是家长（"你为家长准备一段他可以照着讲的话"），不是孩子
//   · 强调先共情再讲道理（教学心理学的 I do, we do, you do 序列）
//   · 必须用具象类比（披萨/积木/糖果），不能停留在抽象符号
//   · 只解释一个核心混淆点，不顺便讲第二件事
//   · 必带一道验证题（讲完后让孩子做），保证学习闭环
//
// previousAttempts: 这道题之前已经生成过的讲解卡（"换角度" 时塞进来），
//                   AI 看到要换一个完全不同的类比/角度
// ============================================================
function buildExplanationPrompt({
  originalProblem,
  originalMisconception,
  originalImageDescription,
  subject,
  kidName,
  kidGrade,
  wrongStreak,
  recentQuizzes,
  previousAttempts, // [{ analogyCore, script }]，按时间倒序
}) {
  const isChinese = subject === "语文";

  // 语文用字范围约束（同 buildQuizPrompt 的逻辑，对讲解卡里的练习题也适用）
  const chineseCharBlock = isChinese
    ? `

【出题用字范围（适用于 verify_problem）】
verify_problem 的题面请只用孩子年级范围内学过的常用字。按部编版教材累计识字量：
  · 一年级 ≈ 700 字  · 二年级 ≈ 1600 字  · 三年级 ≈ 2000 字
  · 四年级 ≈ 2500 字 · 五~六年级在 3000 常用字以内
情境不得不用超纲字时，请在该字后用括号加拼音（如"踱(duó)步"）。`
    : "";

  const system = `你是一位极有耐心、极擅长跟低龄孩子讲道理的小学${subject || "数学"}老师。
你**不**直接对孩子说话，你在为家长准备一段他可以照着讲给孩子听的话。

【这一刻的处境】
家长的孩子在某个知识点上已经反复做错了。再让 ta 做一道题大概率还是会错——
不是因为练得不够，是因为 ta 脑子里这块的"理解地基"还没搭好。
你的任务不是出题，是给家长一段能搭起这个地基的话。

【写作原则】
1. 先共情，再讲道理。开场白要让孩子感到 ta 不是笨——而是这件事本身就难。
2. 用孩子生活里有的东西打比方。披萨/积木/小动物/糖果/书包，比抽象符号好十倍。
3. 一次只解释一个核心混淆点。不要顺便讲第二件事。
4. 让孩子从被动听变成主动说。脚本最后要有一个让孩子复述的提问。
5. 家长是普通家长，不是数学博士。脚本要口语化，能读出声不拗口。
6. 不要用"乖""听话""不许"这类带评判的词。陪伴感的关键是平等。

【SVG 规则（visual_svg / verify_svg 共用）】
  · 只用纯 SVG 标签（rect, circle, line, polyline, polygon, path, text 等），
    不要有 <script>、不要有事件属性、不要 foreignObject
  · viewBox 用 "0 0 400 300" 这种合适的尺寸，不要写 width/height
  · 文字用中文宋体或黑体；尺寸/数量标注清楚
  · 颜色简洁（黑/灰/红/蓝），风格像教辅书插图，不追求美术感
  · visual_svg 要直接对应 script 里的类比（讲披萨的话 SVG 就画圆+切片）
  · verify_svg 是验证题用的，配题面

  ⚠️ 结构性图（竖式、网格、表格）的"工程纪律"：
    1. 出图前先在心里定网格：列宽 col=40，行高 row=40
    2. 同一列的所有数字必须用同一个 x 坐标（不要逐个数字现想 x）
    3. 文字水平居中：text-anchor="middle"
    4. 加法/减法/竖式除法的横线必须画出来，长度覆盖所有数位列
    5. 个位在最右、十位在中间、百位在更左——不要颠倒

  正确的两位数加法竖式（23+45）：
    个位列 x=280（"3"和"5"都在这）、十位列 x=240（"2"和"4"都在这）、
    "+"号 x=180、横线从 x=200 到 x=300。
    错误的：上下两数的个位 x 不一样——会错位、孩子做不了${chineseCharBlock}

【输出格式】
严格 JSON，字符串内部引用字符请用『』或「」，不要用双引号。不要 markdown：
{
  "opening": "给家长的开场白，让孩子放下防御感（≤40字）",
  "analogy_core": "本次用什么比方，一句话讲清（≤30字，如『把分数想成切披萨』）",
  "script": "完整讲解脚本，家长可以照着念（100-180字，口语化）",
  "visual_svg": "和 script 里类比对应的 SVG；不需要图则填 null",
  "check_question": "讲完后让孩子自己复述/解释的提问（≤30字）",
  "verify_problem": "讲解后让孩子做的一道验证题（题面）",
  "verify_svg": "verify_problem 配的图；不需要图则填 null",
  "verify_answer": "verify_problem 的参考答案（只是答案本身，不是解题过程）"
}`;

  const imageDescBlock = originalImageDescription
    ? `\n原题的图中信息：${originalImageDescription}`
    : "";

  const misconceptionBlock = originalMisconception
    ? `\n之前 AI 分析过这道题，认为孩子的认知偏差是：${originalMisconception}`
    : "";

  // 之前已经出过的复习题：让 AI 知道哪些"题面变体"已经试过了
  const recentQuizzesBlock =
    recentQuizzes && recentQuizzes.length > 0
      ? `\n之前已经给 ta 出过这些复习题（都没解决问题，说明问题不在练习量上）：\n${recentQuizzes
          .map((q, i) => `  ${i + 1}. ${(q || "").slice(0, 80)}`)
          .join("\n")}`
      : "";

  // "换角度" 时把上次的讲解塞进来，要求 AI 用完全不同的类比
  const alternativeBlock =
    previousAttempts && previousAttempts.length > 0
      ? `\n\n【重要：上次的讲解角度没奏效，请换一个完全不同的类比/切入点】
之前已经讲过 ${previousAttempts.length} 次，用过的类比：
${previousAttempts
  .map((p, i) => `  ${i + 1}. ${p.analogyCore || "（无）"}`)
  .join("\n")}
这次绝对不要再用上面这些类比，换一个角度。比如：
  · 之前用了"切披萨"，这次可以用"分糖果"或"几格巧克力"
  · 之前用了"图里几个小动物"，这次可以用"算手指头"或"积木数量"
要让家长看到一个真正不同的讲法，而不是同一个意思换措辞。`
      : "";

  const user = `孩子：${kidName || "孩子"}，${kidGrade || "低年级"}
学科：${subject || "数学"}

ta 在这道题上已经"独立失败"了 ${wrongStreak || 3} 次（中间隔了至少 12 小时算独立）：
原题：${originalProblem}${imageDescBlock}${misconceptionBlock}${recentQuizzesBlock}${alternativeBlock}

请按上面的写作原则，写一段家长可以照着讲给孩子听的脚本。
记住：你不是给 ta 再出一道题，你是在帮家长把这块"理解地基"重新搭起来。`;

  return { system, user };
}
// 设计要点：
// · 一条管道处理三种场景：缓存命中、生成中合流、全新生成。
// · GET 是 SSE 流式（不再是 POST），客户端用 EventSource 即可订阅。
// · 服务端总线（generationBus）保证同一道题在任一时刻最多有一次 AI 调用，
//   后续连接进来的客户端"附着"到正在跑的生成任务，回放历史 chunk + 接收新 chunk。
// · DELETE 不变：用户答完/拒绝后清缓存。
//
// SSE 事件协议：
//   event: start    data: { startedAt, alreadyRunning, model? }
//   event: reasoning data: { text, total }     // text 是新增 chunk，total 是累计长度
//   event: content   data: { text, total }
//   event: done     data: { quiz, cached }     // 完整 quiz 对象
//   event: error    data: { error, code? }
// ============================================================

// 总线条目结构：
//   { familyId, startedAt, reasoningChunks: [], contentChunks: [], done: false,
//     finalQuiz: null, error: null, subscribers: Set<send>, finalizeTimer? }
//
// 生命周期：
//   1) 第一个请求触发：创建条目，启动 callGLMStream
//   2) AI chunks 进来：push 到 chunks 数组 + 推给所有 subscribers
//   3) AI 结束：parsed 写 cached_quizzes，给 subscribers 推 done，标记 done=true
//   4) 30 秒后清掉条目（让短期内进来的连接也能直接拿到 done）；30 秒内的连接走 cached 表
//
// 单进程内存就够用 —— 多进程部署时需要换成 Redis pub/sub，但目前不是问题。
const generationBus = new Map();

// 把已有 chunks 回放给一个 send 函数（新订阅者刚连进来时调）
function replayBusEntry(entry, send) {
  if (entry.reasoningChunks.length > 0) {
    // 一次性把累积的 reasoning 推给客户端，让 thinking 立刻出现
    const fullReasoning = entry.reasoningChunks.join("");
    send("reasoning", { text: fullReasoning, total: fullReasoning.length });
  }
  if (entry.contentChunks.length > 0) {
    const fullContent = entry.contentChunks.join("");
    send("content", { text: fullContent, total: fullContent.length });
  }
}

// 触发 AI 调用 + 把结果广播到 entry.subscribers
async function runGeneration({ familyId, momentId, entry, system, user, modelName }) {
  const abortController = new AbortController();
  // entry 上挂一份控制器，将来万一需要取消可以用（目前没用到，但留着以防扩展）
  entry.abortController = abortController;

  const broadcast = (event, payload) => {
    for (const send of entry.subscribers) {
      try {
        send(event, payload);
      } catch (_) {
        // 单个订阅者写失败不影响其他
      }
    }
  };

  try {
    const { fullContent } = await callGLMStream({
      model: modelName,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.2,
      max_tokens: 4500,
      thinkingMode: resolveThinking("quiz"),
      onReasoningChunk: (chunk) => {
        entry.reasoningChunks.push(chunk);
        broadcast("reasoning", {
          text: chunk,
          total: entry.reasoningChunks.reduce((s, c) => s + c.length, 0),
        });
      },
      onContentChunk: (chunk) => {
        entry.contentChunks.push(chunk);
        broadcast("content", {
          text: chunk,
          total: entry.contentChunks.reduce((s, c) => s + c.length, 0),
        });
      },
      abortSignal: abortController.signal,
    });

    // AI 完成，解析 JSON
    const parsed = parseJsonSafe(fullContent);
    if (!parsed || !parsed.quiz_question) {
      entry.error = { error: "AI 返回的 JSON 无法解析", preview: fullContent.slice(0, 200) };
      broadcast("error", entry.error);
      db.writeAuditLog({
        familyId,
        endpoint: "review-quiz-cache",
        success: false,
        errorMsg: "json_parse_failed",
        latencyMs: Date.now() - entry.startedAt,
        model: modelName,
      });
    } else {
      // 写缓存（saveCachedQuiz 幂等）
      const saved = await db.saveCachedQuiz(familyId, momentId, parsed);
      entry.finalQuiz = saved || parsed;
      // v4.8.2: done 事件带 quota，让 UI 上的"今日 AI 用量"能即时刷新
      broadcast("done", {
        quiz: entry.finalQuiz,
        cached: false,
        quota: entry.quotaSnapshot || null,
      });
      db.writeAuditLog({
        familyId,
        endpoint: "review-quiz-cache",
        success: true,
        latencyMs: Date.now() - entry.startedAt,
        model: modelName,
      });
    }
  } catch (err) {
    console.error("出题失败 (bus):", err.message);
    entry.error = {
      error: err.message || "AI 调用失败",
      code: err.isTimeout ? "ai_timeout" : undefined,
    };
    broadcast("error", entry.error);
    db.writeAuditLog({
      familyId,
      endpoint: "review-quiz-cache",
      success: false,
      errorMsg: err.isTimeout ? "thinking_timeout" : err.message,
      latencyMs: Date.now() - entry.startedAt,
      model: modelName,
    });
  } finally {
    entry.done = true;
    // 30 秒缓冲：晚来的客户端还能立刻拿到 done（直接读 entry.finalQuiz）
    // 之后再清掉条目，让新一轮连接走 DB 缓存路径
    entry.finalizeTimer = setTimeout(() => {
      generationBus.delete(momentId);
    }, 30000);
  }
}

app.get(
  "/api/cached-quiz/:momentId",
  requireAccessPassword,
  // requireAIQuota 不能简单挂上来：因为如果命中缓存 / 合流到已有任务，本次不消耗配额。
  // 把配额检查放进 handler 内部，按真正的 AI 调用决定是否扣。
  async (req, res) => {
    const momentId = req.params.momentId;
    const familyId = req.familyId;

    // ===== SSE 头部 =====
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const send = (event, payload) => {
      if (res.writableEnded) return;
      try {
        res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
      } catch (_) {
        // 写入失败（比如客户端早断了），忽略
      }
    };

    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(`: heartbeat\n\n`);
    }, 15000);

    // 客户端断开时清理
    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      // 从总线条目的 subscribers 中移除（如果还在那的话）
      const entry = generationBus.get(momentId);
      if (entry) entry.subscribers.delete(send);
    };
    req.on("close", cleanup);

    try {
      // ===== 路径 1：DB 缓存命中 =====
      // 最快路径，直接返回完整 quiz 然后结束
      const cached = await db.getCachedQuiz(familyId, momentId);
      if (cached) {
        // v4.8.2: 缓存命中不扣配额，但也把今日已用量发回去
        // 让 UI 上的"今日 AI 用量"保持准确（特别是用户刚开 app 时）
        let used = 0;
        try {
          used = await db.getTodayUsage(familyId);
        } catch (_) {}
        send("start", { startedAt: Date.now(), alreadyRunning: false });
        send("done", {
          quiz: cached,
          cached: true,
          quota: { used, total: req.familyQuota },
        });
        cleanup();
        if (!res.writableEnded) res.end();
        return;
      }

      // ===== 路径 2：合流到已在跑的总线条目 =====
      const existing = generationBus.get(momentId);
      if (existing) {
        // 通知客户端：有任务在跑，并告知它开始时间（让前端能算"已等多久"）
        send("start", {
          startedAt: existing.startedAt,
          alreadyRunning: true,
        });
        // 把已经累积的 chunks 回放
        replayBusEntry(existing, send);
        // 如果已经完成了（在 30 秒缓冲期内），直接 done/error
        if (existing.done) {
          if (existing.finalQuiz) {
            // v4.8.2: 合流命中 done 也带 quota
            send("done", {
              quiz: existing.finalQuiz,
              cached: false,
              quota: existing.quotaSnapshot || null,
            });
          } else if (existing.error) {
            send("error", existing.error);
          }
          cleanup();
          if (!res.writableEnded) res.end();
          return;
        }
        // 还没完成：注册成订阅者，跟着接收后续 chunks 和最终事件
        // 包一层 wrapper，做"完成时自动清理"
        const wrapped = (event, payload) => {
          send(event, payload);
          if (event === "done" || event === "error") {
            cleanup();
            if (!res.writableEnded) res.end();
          }
        };
        existing.subscribers.add(wrapped);
        // 注意 cleanup() 里删的是 send，但订阅者是 wrapped，
        // 客户端断开时 wrapped 会留在 subscribers 里直到广播失败。
        // 修正：把 wrapped 也存到一个本地变量，cleanup 删它
        req.on("close", () => existing.subscribers.delete(wrapped));
        return; // 不 res.end()，等广播
      }

      // ===== 路径 3：全新生成 =====
      // v4.9 调整：先取 moment 检查 wrong_streak >= 3，再扣配额。
      // 这样万一前端漏判直接调了 cached-quiz，后端拒绝时不会误扣配额。
      const moment = await db.getMoment(familyId, momentId);
      if (!moment) {
        send("error", { error: "原题不存在" });
        cleanup();
        if (!res.writableEnded) res.end();
        return;
      }

      // wrong_streak >= 3 的题不再出复习题，应该走讲解卡端点。
      // 前端正常会自己判断并切到讲解卡屏，这里是后端兜底。
      if (Number(moment.wrongStreak) >= 3) {
        send("error", {
          error: "这道题反复错过几次了，应该用讲解卡模式而不是再出题",
          code: "should_explain",
        });
        cleanup();
        if (!res.writableEnded) res.end();
        return;
      }

      // 这次真的要调 AI，扣配额。
      // incrementDailyUsage 既检查又 +1，原子操作；返回 { ok, current, quota }
      const quotaResult = await db.incrementDailyUsage(familyId, req.familyQuota);
      if (!quotaResult.ok) {
        send("error", {
          error: `今日 AI 次数已用完（${quotaResult.current}/${quotaResult.quota}），明天 0 点重置。`,
          code: "quota_exceeded",
          detail: { current: quotaResult.current, quota: quotaResult.quota },
        });
        cleanup();
        if (!res.writableEnded) res.end();
        return;
      }

      const kid = await db.getKid(familyId, moment.kidId);

      // v4.8: 取这道题最近 5 道历史复习题，塞进 prompt 让 AI 避开重复
      // 失败容错：拿不到历史也不影响出题，只是失去去重效果
      let recentQuizzes = [];
      try {
        recentQuizzes = await db.listRecentQuizHistory(momentId, 5);
      } catch (e) {
        console.warn("取历史题失败（不影响出题）:", e.message);
      }

      const { system, user } = buildQuizPrompt({
        originalProblem: moment.problem,
        originalMisconception: moment.analysis?.misconception?.title,
        originalImageDescription: moment.imageDescription,
        subject: moment.subject || "数学",
        kidGrade: kid?.grade || "低年级",
        recentQuizzes,
      });
      const modelName = resolveModel("quiz");

      // 创建总线条目
      const entry = {
        familyId,
        startedAt: Date.now(),
        reasoningChunks: [],
        contentChunks: [],
        done: false,
        finalQuiz: null,
        error: null,
        subscribers: new Set(),
        // v4.8.2: 此次扣配额后的快照。done 事件带回去让 UI 刷新用量。
        quotaSnapshot: { used: quotaResult.current, total: quotaResult.quota },
      };
      generationBus.set(momentId, entry);

      // 自己也加入订阅者（这样广播时本连接也收到）
      const wrapped = (event, payload) => {
        send(event, payload);
        if (event === "done" || event === "error") {
          cleanup();
          if (!res.writableEnded) res.end();
        }
      };
      entry.subscribers.add(wrapped);
      req.on("close", () => entry.subscribers.delete(wrapped));

      // 通知客户端：开始
      send("start", {
        startedAt: entry.startedAt,
        alreadyRunning: false,
        model: modelName,
      });

      // 启动 AI 调用（异步，不 await）。
      // 完成时 runGeneration 内部会广播 done/error 给所有订阅者，
      // 各订阅者的 wrapped 会自己 res.end()。
      runGeneration({
        familyId,
        momentId,
        entry,
        system,
        user,
        modelName,
      }).catch((err) => {
        // runGeneration 内部已经 broadcast error 了，这里只是兜底防漏 catch
        console.error("runGeneration 未捕获异常:", err);
      });
    } catch (err) {
      // 路径选择/DB 查询本身的错误
      console.error("cached-quiz GET 处理失败:", err);
      send("error", { error: err.message || "服务器内部错误" });
      cleanup();
      if (!res.writableEnded) res.end();
    }
  }
);

app.delete(
  "/api/cached-quiz/:momentId",
  requireAccessPassword,
  async (req, res) => {
    try {
      await db.deleteCachedQuiz(req.familyId, req.params.momentId);
      // v4.7 Phase 2：用户点"换一道"时除了清 DB 缓存，也得清内存总线条目，
      // 否则下一次 GET 还会合流到老的生成任务，拿到一样的题。
      const entry = generationBus.get(req.params.momentId);
      if (entry) {
        if (entry.finalizeTimer) clearTimeout(entry.finalizeTimer);
        if (entry.abortController) entry.abortController.abort();
        generationBus.delete(req.params.momentId);
      }
      res.json({ ok: true });
    } catch (err) {
      console.error("删缓存复习题失败:", err);
      res.status(500).json({ error: err.message });
    }
  }
);

// ============================================================
// 接口: POST /api/quiz-history/:momentId  — 记录一次复习题答完的结果
//   v4.8: 仅写历史
//   v4.9 PR1: 改走 markQuizResult，同时维护 wrong_streak / interval_days，
//             并把新值回给前端，让前端无需再请求一次 GET /moments
// ============================================================
// 时机：家长在复习屏点"答对了/答错了/跳过"那一刻，前端调这个接口。
// 入参 body：{ quizQuestion, expectedAnswer, result }
//   · quizQuestion 必填 —— 用来构成"已出过的题"集合
//   · expectedAnswer 可选 —— 调试时知道当时 AI 给的标准答案
//   · result: "correct" | "wrong" | "skipped"
//
// v4.8 时这个接口是纯写入的 fire-and-forget，前端不解析返回。
// v4.9 PR1 起返回 { ok, wrongStreak, intervalDays, lastWrongAt }，
// 老前端忽略多余字段不会出错；新前端可用 wrongStreak 即时切换 UI。
// ============================================================
app.post(
  "/api/quiz-history/:momentId",
  requireAccessPassword,
  async (req, res) => {
    try {
      // v4.8.1: quizSvg 也接收（看图题的图）
      const { quizQuestion, quizSvg, expectedAnswer, result } = req.body || {};
      if (!quizQuestion) {
        return res.status(400).json({ error: "缺少 quizQuestion" });
      }
      // 取 moment 拿 kid_id（写历史需要）。如果 moment 已经被删了就忽略。
      const moment = await db.getMoment(req.familyId, req.params.momentId);
      if (!moment) {
        return res.status(404).json({ error: "原题不存在" });
      }
      const updated = await db.markQuizResult({
        familyId: req.familyId,
        momentId: req.params.momentId,
        kidId: moment.kidId,
        result,
        quizQuestion,
        quizSvg,
        expectedAnswer,
      });
      res.json({ ok: true, ...(updated || {}) });
    } catch (err) {
      console.error("记录复习题历史失败:", err);
      res.status(500).json({ error: err.message });
    }
  }
);

// ============================================================
// 接口: GET /api/quiz-history/:momentId  — 取这道题完整复习历史（v4.8 档 1）
// ============================================================
// 用于时刻详情页的"复习记录"展示区。
// 返回按时间倒序的全部历史(不分页)：
//   一道题正常情况下被复习的次数不会超过 20 次（间隔翻倍很快），
//   全量返回更直观。如果未来某些用户出现极端情况，再加分页。
// ============================================================
app.get(
  "/api/quiz-history/:momentId",
  requireAccessPassword,
  async (req, res) => {
    try {
      // 先验证 moment 属于该家庭，避免越权读
      const moment = await db.getMoment(req.familyId, req.params.momentId);
      if (!moment) {
        return res.status(404).json({ error: "原题不存在" });
      }
      const history = await db.listQuizHistoryForMoment(req.params.momentId);
      res.json({ data: history });
    } catch (err) {
      console.error("读复习题历史失败:", err);
      res.status(500).json({ error: err.message });
    }
  }
);

// ============================================================
// 接口: /api/explanation-card/:momentId — 讲解卡 SSE 流式生成（v4.9）
// ============================================================
// 触发场景：moment.wrong_streak >= 3 时，前端不再调 /api/cached-quiz，
//          改调这个端点拿一张"给家长照着讲"的卡。
//
// 与 cached-quiz 端点的差别：
//   · 不做"已生成缓存"路径——讲解卡不预生成（家长不点不生成），
//     每次"换角度"也都是新生成，所以不需要 DB 缓存查询那一层。
//   · 不做"合流到已在跑的任务"——讲解卡是用户主动点击触发，
//     同一 moment 同时有两路点击的概率几乎为零，不上总线机制简化代码。
//   · 配额扣的是 explanation 这个名义（独立审计/统计），不混入 quiz。
//
// 入参：
//   query.angle = "default" | "alternative"
//     "alternative" 表示是"换角度"，会把这道题之前生成的讲解卡当作
//     "已尝试过的角度"塞进 prompt，要求 AI 换一个完全不同的类比。
//
// SSE 事件协议（与 cached-quiz 同款）：
//   event: start      data: { startedAt, model }
//   event: reasoning  data: { text, total }
//   event: content    data: { text, total }
//   event: done       data: { card }   // 完整的 explanation_card 对象（已落库）
//   event: error      data: { error, code? }
// ============================================================
app.get(
  "/api/explanation-card/:momentId",
  requireAccessPassword,
  // 同 cached-quiz：配额检查放进 handler 内部按需扣
  async (req, res) => {
    const momentId = req.params.momentId;
    const familyId = req.familyId;
    const angle = req.query.angle === "alternative" ? "alternative" : "default";

    // ===== SSE 头部 =====
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const send = (event, payload) => {
      if (res.writableEnded) return;
      try {
        res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
      } catch (_) {}
    };

    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(`: heartbeat\n\n`);
    }, 15000);

    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
    };
    req.on("close", cleanup);

    try {
      // 取原题
      const moment = await db.getMoment(familyId, momentId);
      if (!moment) {
        send("error", { error: "原题不存在" });
        cleanup();
        if (!res.writableEnded) res.end();
        return;
      }

      // "换角度" 上限保护：本道题已经生成 >= 3 张卡时拒绝再生成
      // （第 1 张是默认讲解，第 2/3 张是两次换角度，再换就该转向"先放放"了）
      if (angle === "alternative") {
        const existingCount = await db.countExplanationCardsForMoment(momentId);
        if (existingCount >= 3) {
          send("error", {
            error: "这道题已经讲过几次了，建议先放一放，过几天再说",
            code: "max_alternatives_reached",
          });
          cleanup();
          if (!res.writableEnded) res.end();
          return;
        }
      }

      // 配额扣减
      const quotaResult = await db.incrementDailyUsage(familyId, req.familyQuota);
      if (!quotaResult.ok) {
        send("error", {
          error: `今日 AI 次数已用完（${quotaResult.current}/${quotaResult.quota}），明天 0 点重置。`,
          code: "quota_exceeded",
          detail: { current: quotaResult.current, quota: quotaResult.quota },
        });
        cleanup();
        if (!res.writableEnded) res.end();
        return;
      }

      const kid = await db.getKid(familyId, moment.kidId);

      // 取最近的复习题历史，让 AI 知道"哪些题面变体已经试过且都没解决问题"
      let recentQuizzes = [];
      try {
        recentQuizzes = await db.listRecentQuizHistory(momentId, 5);
      } catch (e) {
        console.warn("取历史题失败（不影响讲解卡生成）:", e.message);
      }

      // "换角度" 时取该 moment 之前所有讲解卡，让 AI 避开旧类比
      let previousAttempts = [];
      if (angle === "alternative") {
        try {
          const prevCards = await db.listExplanationCardsByMoment(familyId, momentId);
          previousAttempts = prevCards.map((c) => ({
            analogyCore: c.analogyCore,
            script: c.script,
          }));
        } catch (e) {
          console.warn("取讲解卡历史失败（不影响生成）:", e.message);
        }
      }

      const { system, user } = buildExplanationPrompt({
        originalProblem: moment.problem,
        originalMisconception: moment.analysis?.misconception?.title,
        originalImageDescription: moment.imageDescription,
        subject: moment.subject || "数学",
        kidName: kid?.name,
        kidGrade: kid?.grade || "低年级",
        wrongStreak: moment.wrongStreak || 3,
        recentQuizzes,
        previousAttempts,
      });

      // 讲解卡用 analyze 模型档（推理深度 > 出题）
      const modelName = resolveModel("explanation");
      const startedAt = Date.now();
      send("start", { startedAt, model: modelName });

      const reasoningBuf = [];
      const contentBuf = [];

      const { fullContent } = await callGLMStream({
        model: modelName,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: 0.4, // 讲解卡比出题需要更多创造性（找类比），稍微调高
        max_tokens: 4500,
        thinkingMode: resolveThinking("explanation"),
        onReasoningChunk: (chunk) => {
          reasoningBuf.push(chunk);
          send("reasoning", {
            text: chunk,
            total: reasoningBuf.reduce((s, c) => s + c.length, 0),
          });
        },
        onContentChunk: (chunk) => {
          contentBuf.push(chunk);
          send("content", {
            text: chunk,
            total: contentBuf.reduce((s, c) => s + c.length, 0),
          });
        },
      });

      const parsed = parseJsonSafe(fullContent);
      if (!parsed || !parsed.script) {
        send("error", {
          error: "AI 返回的 JSON 无法解析",
          preview: fullContent.slice(0, 200),
        });
        db.writeAuditLog({
          familyId,
          endpoint: "explanation-card",
          success: false,
          errorMsg: "json_parse_failed",
          latencyMs: Date.now() - startedAt,
          model: modelName,
        });
        cleanup();
        if (!res.writableEnded) res.end();
        return;
      }

      // 落库
      const cardId = `ec${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
      const saved = await db.createExplanationCard({
        id: cardId,
        familyId,
        momentId,
        triggerWrongStreak: moment.wrongStreak || 3,
        opening: parsed.opening,
        analogyCore: parsed.analogy_core,
        script: parsed.script,
        visualSvg: parsed.visual_svg,
        checkQuestion: parsed.check_question,
        verifyProblem: parsed.verify_problem,
        verifySvg: parsed.verify_svg,
        verifyAnswer: parsed.verify_answer,
        model: modelName,
      });

      // v4.8.2: done 事件带 quota，UI 上的"今日 AI 用量"即时刷新
      send("done", {
        card: saved,
        quota: { used: quotaResult.current, total: quotaResult.quota },
      });
      db.writeAuditLog({
        familyId,
        endpoint: "explanation-card",
        success: true,
        latencyMs: Date.now() - startedAt,
        model: modelName,
      });
      cleanup();
      if (!res.writableEnded) res.end();
    } catch (err) {
      console.error("讲解卡生成失败:", err.message);
      send("error", {
        error: err.message || "AI 调用失败",
        code: err.isTimeout ? "ai_timeout" : undefined,
      });
      db.writeAuditLog({
        familyId,
        endpoint: "explanation-card",
        success: false,
        errorMsg: err.isTimeout ? "thinking_timeout" : err.message,
        model: undefined,
      });
      cleanup();
      if (!res.writableEnded) res.end();
    }
  }
);

// ============================================================
// 接口: GET /api/explanation-cards/:momentId — 取讲解卡历史
// ============================================================
// 用于 moment 详情页的 "讲解历史" tab。
// 全量返回，按时间倒序（最新在前）。一道题正常 1~3 张，不分页。
// ============================================================
app.get(
  "/api/explanation-cards/:momentId",
  requireAccessPassword,
  async (req, res) => {
    try {
      // 先验证 moment 属于该家庭，避免越权读
      const moment = await db.getMoment(req.familyId, req.params.momentId);
      if (!moment) {
        return res.status(404).json({ error: "原题不存在" });
      }
      const cards = await db.listExplanationCardsByMoment(
        req.familyId,
        req.params.momentId
      );
      res.json({ data: cards });
    } catch (err) {
      console.error("读讲解卡历史失败:", err);
      res.status(500).json({ error: err.message });
    }
  }
);

// ============================================================
// 接口: POST /api/explanation-card/:cardId/feedback
// ============================================================
// 家长点了讲解卡底部三个按钮中的任何一个，前端调这个接口写反馈：
//   · "explained_then_practice"  → "讲完了让 ta 再做一道"
//   · "needed_more_angle"        → "还需要更多解释"（前端会再调 GET ?angle=alternative）
//   · "shelved"                  → "先放一放"（前端会同时把 moment.status 改为 暂搁）
// 这是 fire-and-forget 接口，写反馈失败不打扰用户主流程。
// ============================================================
app.post(
  "/api/explanation-card/:cardId/feedback",
  requireAccessPassword,
  async (req, res) => {
    try {
      const { feedback } = req.body || {};
      const ALLOWED = ["explained_then_practice", "needed_more_angle", "shelved"];
      if (!ALLOWED.includes(feedback)) {
        return res.status(400).json({ error: "不合法的 feedback 值" });
      }
      const ok = await db.updateExplanationCardFeedback(
        req.familyId,
        req.params.cardId,
        feedback
      );
      if (!ok) return res.status(404).json({ error: "讲解卡不存在" });
      res.json({ ok: true });
    } catch (err) {
      console.error("写讲解卡反馈失败:", err);
      res.status(500).json({ error: err.message });
    }
  }
);

// ============================================================
// 数据接口：/api/data（一次拿全部）
// ============================================================
app.get("/api/data", requireAccessPassword, async (req, res) => {
  try {
    const data = await db.exportAll(req.familyId);
    // v4.7: 顺便把"已缓存复习题"的 moment_id 集合带回去，
    // 前端首页就知道哪些题不用预热（已有缓存）、哪些需要预热。
    // 这是个轻量查询：只是 SELECT 一列，几百条都是 ms 级。
    const cachedQuizMomentIds = await db.listCachedQuizMomentIds(req.familyId);
    // v4.8.2: 同时返回今日已用配额。否则只有 analyze / vision 端点会广播 quota
    // 事件，UI 上的"今日 AI 用量"会停在 0，直到第一次 analyze/vision 才填上。
    let todayUsed = 0;
    try {
      todayUsed = await db.getTodayUsage(req.familyId);
    } catch (e) {
      console.warn("查今日用量失败（不影响主流程）:", e.message);
    }
    res.json({
      data,
      cachedQuizMomentIds,
      family: { name: req.familyName, quotaTotal: req.familyQuota },
      quota: { used: todayUsed, total: req.familyQuota },
    });
  } catch (err) {
    console.error("读取数据失败:", err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// 数据接口：Kids
// ============================================================
app.post("/api/kids", requireAccessPassword, async (req, res) => {
  try {
    const kid = req.body;
    if (!kid.id || !kid.name) {
      return res.status(400).json({ error: "缺少 id 或 name" });
    }
    const created = await db.createKid(req.familyId, kid);
    res.json({ data: created });
  } catch (err) {
    console.error("创建孩子失败:", err);
    res.status(500).json({ error: err.message });
  }
});

app.patch("/api/kids/:id", requireAccessPassword, async (req, res) => {
  try {
    const updated = await db.updateKid(req.familyId, req.params.id, req.body);
    if (!updated) return res.status(404).json({ error: "孩子不存在" });
    res.json({ data: updated });
  } catch (err) {
    console.error("更新孩子失败:", err);
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/kids/:id", requireAccessPassword, async (req, res) => {
  try {
    await db.deleteKid(req.familyId, req.params.id);
    res.json({ ok: true });
  } catch (err) {
    console.error("删除孩子失败:", err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// 数据接口：Moments
// ============================================================

// v4.6: 单条 moment 详情（带图）
// 列表接口为了性能不返 image_data，前端要看图（编辑页 / 详情页）时调这个
app.get("/api/moments/:id", requireAccessPassword, async (req, res) => {
  try {
    const m = await db.getMoment(req.familyId, req.params.id);
    if (!m) return res.status(404).json({ error: "时刻不存在" });
    res.json({ data: m });
  } catch (err) {
    console.error("获取时刻失败:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/moments", requireAccessPassword, async (req, res) => {
  try {
    const m = req.body;
    if (!m.id || !m.kidId || !m.problem) {
      return res.status(400).json({ error: "缺少 id / kidId / problem" });
    }
    const kid = await db.getKid(req.familyId, m.kidId);
    if (!kid) {
      return res.status(400).json({ error: "kidId 不属于当前家庭" });
    }
    const created = await db.createMoment(req.familyId, m);
    res.json({ data: created });
  } catch (err) {
    console.error("创建时刻失败:", err);
    res.status(err instanceof TypeError ? 400 : 500).json({ error: err.message });
  }
});

app.patch("/api/moments/:id", requireAccessPassword, async (req, res) => {
  try {
    const updated = await db.updateMoment(req.familyId, req.params.id, req.body);
    if (!updated) return res.status(404).json({ error: "时刻不存在" });
    // v4.7 Phase 2：题面或图描述变更时，db.updateMoment 内部会自动 DELETE
    // cached_quizzes 表的对应行；这里再清一下内存里正在跑的总线条目（如果有），
    // 避免：有人正合流着这道题的生成，结果拿到的是基于"老题面"的新题。
    if (
      req.body.problem !== undefined ||
      req.body.imageDescription !== undefined
    ) {
      const entry = generationBus.get(req.params.id);
      if (entry) {
        // 通知所有订阅者：题改了，请重连
        for (const subscriber of entry.subscribers) {
          try {
            subscriber("error", {
              error: "原题已被修改，请重新出题",
              code: "moment_changed",
            });
          } catch (_) {}
        }
        if (entry.finalizeTimer) clearTimeout(entry.finalizeTimer);
        if (entry.abortController) entry.abortController.abort();
        generationBus.delete(req.params.id);
      }
    }
    res.json({ data: updated });
  } catch (err) {
    console.error("更新时刻失败:", err);
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/moments/:id", requireAccessPassword, async (req, res) => {
  try {
    await db.deleteMoment(req.familyId, req.params.id);
    // v4.7 Phase 2：删 moment 时清总线条目（cached_quizzes 表 ON DELETE CASCADE 已自动）
    const entry = generationBus.get(req.params.id);
    if (entry) {
      for (const subscriber of entry.subscribers) {
        try {
          subscriber("error", {
            error: "原题已被删除",
            code: "moment_deleted",
          });
        } catch (_) {}
      }
      if (entry.finalizeTimer) clearTimeout(entry.finalizeTimer);
      if (entry.abortController) entry.abortController.abort();
      generationBus.delete(req.params.id);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("删除时刻失败:", err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// 数据接口：Settings（存 activeKidId 这类 UI 状态）
// ============================================================
app.put("/api/settings/:key", requireAccessPassword, async (req, res) => {
  try {
    const value = req.body.value;
    if (typeof value !== "string") {
      return res.status(400).json({ error: "value 必须是字符串" });
    }
    await db.setSetting(req.familyId, req.params.key, value);
    res.json({ ok: true });
  } catch (err) {
    console.error("保存设置失败:", err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// 数据接口：一次性迁移（从 localStorage 导出的 JSON 导入）
// ============================================================
app.post("/api/import", requireAccessPassword, async (req, res) => {
  try {
    const result = await db.importFromJson(req.familyId, req.body);
    res.json({ data: result });
  } catch (err) {
    console.error("导入失败:", err);
    const isValidationError = err instanceof TypeError || err instanceof RangeError;
    res.status(isValidationError ? 400 : 500).json({ error: err.message });
  }
});

// ============================================================
// 数据接口：导出 JSON 备份
// v4.6: 备份场景需要带图片，否则用户备份的 JSON 缺图
// ============================================================
app.get("/api/export", requireAccessPassword, async (req, res) => {
  try {
    const data = await db.exportAll(req.familyId, { withImages: true });
    res.json({ data });
  } catch (err) {
    console.error("导出失败:", err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// 健康检查
// ============================================================
app.get("/api/health", async (req, res) => {
  let dbStatus = "ok";
  try {
    await db.getPool().query("SELECT 1");
  } catch (e) {
    dbStatus = `error: ${e.message}`;
  }
  const healthy = dbStatus === "ok";
  res.status(healthy ? 200 : 503).json({
    status: healthy ? "ok" : "degraded",
    version: APP_VERSION,
    time: new Date().toISOString(),
    models: {
      analyze: process.env.AI_MODEL_ANALYZE || process.env.AI_MODEL || "(未配置)",
      quiz: process.env.AI_MODEL_QUIZ || process.env.AI_MODEL || "(未配置)",
      explanation:
        process.env.AI_MODEL_EXPLANATION || process.env.AI_MODEL || "(未配置)",
      vision: process.env.AI_VISION_MODEL || "(未配置 - 识图不可用)",
    },
    thinking: {
      analyze: resolveThinking("analyze"),
      quiz: resolveThinking("quiz"),
      explanation: resolveThinking("explanation"),
      vision: resolveThinking("vision"),
    },
    json_format: process.env.AI_USE_JSON_FORMAT !== "false" ? "开启" : "关闭",
    streaming: ["analyze", "cached-quiz", "explanation-card"],
    database: dbStatus,
  });
});

// ============================================================
// 启动
// ============================================================
async function start() {
  try {
    await db.initSchema();
    console.log("✅ 数据库就绪");
  } catch (err) {
    console.error("❌ 数据库初始化失败:", err.message);
    console.error("   检查 .env 里的 DB_HOST / DB_USER / DB_PASSWORD / DB_NAME");
    process.exit(1);
  }

  app.listen(PORT, HOST, () => {
    console.log(`✅ 陪学笔记后端 v${APP_VERSION} 运行在 http://${HOST}:${PORT}`);
    console.log(`   AI 端点:   ${process.env.AI_ENDPOINT}`);
    console.log(`   分析模型:  ${process.env.AI_MODEL_ANALYZE || process.env.AI_MODEL}`);
    console.log(`   出题模型:  ${process.env.AI_MODEL_QUIZ || process.env.AI_MODEL}`);
    console.log(`   讲解模型:  ${process.env.AI_MODEL_EXPLANATION || process.env.AI_MODEL}`);
    console.log(`   视觉模型:  ${process.env.AI_VISION_MODEL || "(未配置，识图不可用)"}`);
    console.log(`   JSON 模式: ${process.env.AI_USE_JSON_FORMAT !== "false" ? "开启 ✓" : "关闭"}`);
    console.log(
      `   思考模式: analyze=${resolveThinking("analyze")} ` +
        `vision=${resolveThinking("vision")} ` +
        `quiz=${resolveThinking("quiz")} ` +
        `explanation=${resolveThinking("explanation")}`
    );
    console.log(`   流式输出: /api/analyze ✓  /api/cached-quiz ✓ (v4.7 总线合流)`);
    console.log(`   数据库:    ${process.env.DB_NAME}@${process.env.DB_HOST}:${process.env.DB_PORT || 3306}`);
    // v4.8.2: 实际登录走 families 表的 bcrypt 比对，
    // .env 里的 ACCESS_PASSWORD 仅在 v3→v4 老库迁移时一次性用作"默认家庭"密码。
    // 日常运行不再读这个变量，所以不再打"已设置 / 危险"误导提示。
    // 创建家庭请用：node admin.mjs create --name=... --password=...
  });
}

start();
