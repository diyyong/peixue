// ============================================================
// 陪学笔记本 v2（支持拍照识图、变式练习、孩子画像、复盘考察）
// ============================================================

import { useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback, memo, Component } from "react";
import {
  ArrowLeft,
  Plus,
  Loader2,
  ChevronRight,
  MessageSquareQuote,
  Target,
  Eye,
  Feather,
  CornerDownRight,
  Search,
  MoreHorizontal,
  Trash2,
  RefreshCw,
  Download,
  Upload,
  CheckCircle2,
  X,
  Camera,
  ImageIcon,
  Sparkles,
  BookOpen,
  User,
  Pencil,
  BrainCircuit,
  HelpCircle,
  Heart,         // v4.9: 讲解卡 opening
  Lightbulb,     // v4.9: 讲解卡 analogy_core
  MessageCircle, // v4.9: 讲解卡 check_question
  Coffee,        // v4.9: 讲解卡 "先放一放" 按钮
  RotateCcw,     // v4.9: 讲解卡 "换角度" 按钮
} from "lucide-react";

import {
  calcMemoryStats,
  nextInterval,
  pickReviewCandidates,
} from "./review.js";
import { sanitizeSvg } from "./sanitizeSvg.js";

// ============================================================
// 🔧 后端配置
// ============================================================
const BACKEND = {
  analyze: "/api/analyze",
  vision: "/api/vision",
  // v4.7 Phase 2: /api/review-quiz 已废弃，统一走 /api/cached-quiz/:id (SSE)
  cachedQuiz: "/api/cached-quiz",
  // v4.8: 复习题历史记录
  quizHistory: "/api/quiz-history",
  // v4.9: 讲解卡（反复错题的"切换模式"端点）
  explanationCard: "/api/explanation-card",        // GET SSE / POST :id/feedback
  explanationCardList: "/api/explanation-cards",   // GET 历史列表
  data: "/api/data",
  kids: "/api/kids",
  moments: "/api/moments",
  settings: "/api/settings",
  importData: "/api/import",
  exportData: "/api/export",
  // 本地开发时加前缀 "http://127.0.0.1:3001"
};

// 访问密码：从 localStorage 存取
// localStorage 的安全访问封装 —— iOS Safari 在隐私浏览或某些状态下
// localStorage.getItem / setItem 会抛 SecurityError / QuotaExceededError，
// 整个 React 应用会因此挂掉。所有 localStorage 调用统一走这个包装。
const safeStorage = {
  get(key) {
    try {
      return localStorage.getItem(key) || "";
    } catch (e) {
      console.warn("localStorage 读取失败:", e.message);
      return "";
    }
  },
  set(key, value) {
    try {
      if (value) localStorage.setItem(key, value);
      else localStorage.removeItem(key);
    } catch (e) {
      console.warn("localStorage 写入失败:", e.message);
    }
  },
  remove(key) {
    try {
      localStorage.removeItem(key);
    } catch (e) {
      // 忽略
    }
  },
};

const ACCESS_PASSWORD_KEY = "pei-xue-access-password";
const getAccessPassword = () => safeStorage.get(ACCESS_PASSWORD_KEY);
const setAccessPassword = (pw) => safeStorage.set(ACCESS_PASSWORD_KEY, pw);

// "我是谁"：本设备上的使用者名字（附在新建 moment 的 created_by 字段上）
const SIGNATURE_KEY = "pei-xue-signature";
const getSignature = () => safeStorage.get(SIGNATURE_KEY);
const setSignature = (name) => safeStorage.set(SIGNATURE_KEY, name);

// v5.0：模块级常量，配合 useMemo 当作"data 还没加载时的稳定空数组"返回，
// 让下游 useMemo 的依赖比较不会因为每次渲染 `[]` 都是新引用而误触发。
// Object.freeze 防止任何地方意外 push 进去。
const EMPTY_ARRAY = Object.freeze([]);

// ============================================================
// 🌐 API 客户端
// ============================================================
const defaultKidProfile = {
  current_topics: "",
  strengths: "",
  weaknesses: "",
  notes: "",
};

async function apiRequest(method, url, body = null) {
  const pw = getAccessPassword();
  if (!pw) throw new Error("需要先设置访问密码。到『备份 & 设置』里填写。");

  const headers = { "X-Access-Password": pw };
  const opts = { method, headers };
  if (body !== null) {
    headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }

  let response;
  try {
    response = await fetch(url, opts);
  } catch (netErr) {
    throw new Error(`网络连接失败：${netErr.message}。检查后端是否在线。`);
  }

  // 状态码先读 body，再按 code 字段做细分
  const json = await response.json().catch(() => ({}));

  if (!response.ok) {
    const err = new Error(json.error || `请求失败 HTTP ${response.status}`);
    err.code = json.code; // family_expired | quota_exceeded | wrong_password | rate_limited ...
    err.status = response.status;
    err.detail = json; // 带上整个响应，比如配额信息
    throw err;
  }

  // 如果响应里带了 quota 信息（AI 调用后），广播给 UI 让它刷新显示
  if (json.quota && typeof json.quota.used === "number") {
    try {
      window.dispatchEvent(
        new CustomEvent("peixue:quota", { detail: json.quota })
      );
    } catch (e) {
      // 忽略
    }
  }

  return json;
}

const api = {
  loadAll: () =>
    apiRequest("GET", BACKEND.data).then((r) => ({
      ...normalizeData(r.data),
      // v4.7: 后端额外返回的"已缓存复习题"id 集合
      cachedQuizMomentIds: r.cachedQuizMomentIds || [],
      family: r.family || null,
      // v4.8.2: 后端把今日已用配额一起返回了，避免 UI 在首次 analyze/vision 前显示 0
      quota: r.quota || null,
    })),
  createKid: (kid) => apiRequest("POST", BACKEND.kids, kid).then((r) => r.data),
  updateKid: (id, changes) =>
    apiRequest("PATCH", `${BACKEND.kids}/${id}`, changes).then((r) => r.data),
  deleteKid: (id) => apiRequest("DELETE", `${BACKEND.kids}/${id}`),
  // v4.6: 列表接口为节省带宽不返图片本体（只有 hasImage 标志）。
  // 编辑/查看含图时刻时调这个拿完整数据。
  getMomentDetail: (id) =>
    apiRequest("GET", `${BACKEND.moments}/${id}`).then((r) => r.data),
  createMoment: (m) => apiRequest("POST", BACKEND.moments, m).then((r) => r.data),
  updateMoment: (id, changes) =>
    apiRequest("PATCH", `${BACKEND.moments}/${id}`, changes).then((r) => r.data),
  deleteMoment: (id) => apiRequest("DELETE", `${BACKEND.moments}/${id}`),
  // v4.7 Phase 2: GET cached-quiz 已改成 SSE 流式（generateReviewQuiz 直接消费），
  //              不再有"非流式 GET 取缓存"和"非流式 POST 触发预热"这两个 JSON 接口。
  //              所以这里只剩 DELETE。
  deleteCachedQuiz: (momentId) =>
    apiRequest("DELETE", `${BACKEND.cachedQuiz}/${momentId}`),
  // v4.8: 上报复习题答题结果到历史。fire-and-forget 用法，失败不影响主流程。
  recordQuizHistory: (momentId, payload) =>
    apiRequest("POST", `${BACKEND.quizHistory}/${momentId}`, payload),
  // v4.8 档 1: 取这道题完整复习历史，给时刻详情页"复习记录"区块用。
  listQuizHistory: (momentId) =>
    apiRequest("GET", `${BACKEND.quizHistory}/${momentId}`).then((r) => r.data || []),
  // v4.9: 讲解卡历史列表（详情页"讲解历史"tab 用）
  listExplanationCards: (momentId) =>
    apiRequest("GET", `${BACKEND.explanationCardList}/${momentId}`).then(
      (r) => r.data || []
    ),
  // v4.9: 讲解卡反馈（三按钮之一）。fire-and-forget 用法。
  // feedback ∈ "explained_then_practice" | "needed_more_angle" | "shelved"
  recordExplanationCardFeedback: (cardId, feedback) =>
    apiRequest("POST", `${BACKEND.explanationCard}/${cardId}/feedback`, {
      feedback,
    }),
  setSetting: (key, value) =>
    apiRequest("PUT", `${BACKEND.settings}/${key}`, { value }),
  importJson: (data) => apiRequest("POST", BACKEND.importData, data).then((r) => r.data),
  exportJson: () => apiRequest("GET", BACKEND.exportData).then((r) => r.data),
};

// ============================================================
// prefetchService（v4.7 Phase 2）：复习题预热调度器
// ============================================================
// 用 generateReviewQuiz（SSE）作为预热请求，丢弃所有 chunks，只关心 done。
// 后端 generationBus 保证同一道题最多一次 AI 调用：
//   · 这条预热连接还在飞时，家长进复习屏点开 → ReviewScreen 也开一条 SSE 连接，
//     后端识别到 bus 条目已有，回放历史 reasoning + 续后续 chunks 给那条连接，
//     家长看到的是连贯的流式体验。AI 调用还是只有这一次。
//
// 调度规则：
// · 同时最多 2 个在飞（CONCURRENCY=2），剩下的进队列等
// · 同 momentId 不重复入队
// · 失败静默：预热失败不弹 toast，console.warn 即可
// · onSuccess(momentId)：成功后回调，让上层 setState 把它加进 cachedSet
//
// 调度器是模块级单例，全 app 共享。
// ============================================================
const prefetchService = (() => {
  const CONCURRENCY = 2;
  let inFlight = 0;
  const queue = []; // { momentId, onSuccess }
  const known = new Set(); // 已经在飞或排队的 id，去重用

  const tick = () => {
    while (inFlight < CONCURRENCY && queue.length > 0) {
      const { momentId, onSuccess } = queue.shift();
      inFlight++;

      // 预热：调用 generateReviewQuiz 但所有回调都丢弃。
      // 这条 SSE 连接驱动 AI 调用，并把结果写入后端缓存。
      generateReviewQuiz({ moment: { id: momentId } })
        .then((quiz) => {
          if (quiz && quiz.quiz_question && onSuccess) {
            onSuccess(momentId);
          }
        })
        .catch((err) => {
          // 静默：预热失败不弹 toast。
          console.warn(`预热复习题失败 (${momentId}):`, err.message);
        })
        .finally(() => {
          inFlight--;
          known.delete(momentId);
          tick();
        });
    }
  };

  return {
    /**
     * 把 momentIds 加入预热队列。重复 id 自动去重。
     */
    enqueue(momentIds, onSuccess) {
      for (const id of momentIds) {
        if (known.has(id)) continue;
        known.add(id);
        queue.push({ momentId: id, onSuccess });
      }
      tick();
    },
    drain() {
      queue.length = 0;
      // known 不整体清：in-flight 的还在跑，结束时会自己 known.delete
    },
  };
})();

// ============================================================
// useStickyBottom v4：流式输出场景的"贴底滚动"
// ============================================================
// v3 之前各版的真正 bug：listener 没绑上！
//   流式开始时 reasoning="" 所以 <details> 不渲染，ref.current=null。
//   useEffect 用空依赖只跑一次（mount 时），那一次因为 ref.current 是 null
//   直接 return —— 监听器永远没绑。第一个 chunk 来 details 出现时，
//   useEffect 已不会再跑，wheel/touch 事件没人接收，stickRef 永远是 true。
//
// v4 改用 callback ref：React 在 DOM 节点真正挂载/卸载时回调，
// 时机精确。绑定逻辑只在 callback 里跑，避免 ref.current=null 的尴尬。
//
// 设计（沿用 v3 的职责分离）：
//   · 默认 stickRef=true（贴底）
//   · 用户物理动作（wheel/touch）→ 立即 stickRef=false
//   · scroll 事件只能"恢复跟随"——必须严格到底（≤4px）
const useIsoLayoutEffect =
  typeof useLayoutEffect === "function" ? useLayoutEffect : useEffect;

function useStickyBottom(deps = []) {
  const elRef = useRef(null);
  const stickRef = useRef(true);
  const cleanupRef = useRef(null);

  // callback ref：React 会在 DOM 元素挂载时调用 setRef(node)，
  // 卸载时调用 setRef(null)。比 useRef + useEffect 更可靠。
  const setRef = useCallback((node) => {
    // 旧节点先解绑
    if (cleanupRef.current) {
      cleanupRef.current();
      cleanupRef.current = null;
    }
    elRef.current = node;
    if (!node) return;

    const AT_BOTTOM_EPSILON = 4;

    const onScroll = () => {
      const distanceFromBottom =
        node.scrollHeight - node.scrollTop - node.clientHeight;
      // 只做"恢复跟随"。距底 > 4px 时不动 stickRef，
      // 让 wheel/touch 设的 false 稳定保持下来。
      if (distanceFromBottom <= AT_BOTTOM_EPSILON) {
        stickRef.current = true;
      }
    };

    const onUserInput = () => {
      stickRef.current = false;
    };

    node.addEventListener("scroll", onScroll, { passive: true });
    node.addEventListener("wheel", onUserInput, { passive: true });
    node.addEventListener("touchstart", onUserInput, { passive: true });
    node.addEventListener("touchmove", onUserInput, { passive: true });

    cleanupRef.current = () => {
      node.removeEventListener("scroll", onScroll);
      node.removeEventListener("wheel", onUserInput);
      node.removeEventListener("touchstart", onUserInput);
      node.removeEventListener("touchmove", onUserInput);
    };
  }, []);

  // 内容变化时尝试贴底
  useIsoLayoutEffect(() => {
    const el = elRef.current;
    if (!el) return;
    if (stickRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, deps);

  return setRef;
}

function normalizeData(parsed) {
  const kids = (parsed.kids || []).map((k) => ({
    ...k,
    profile: { ...defaultKidProfile, ...(k.profile || {}) },
  }));
  return {
    kids,
    moments: parsed.moments || [],
    activeKidId: parsed.activeKidId || kids[0]?.id || null,
  };
}

// v4.6: 列表里的 moment 不持有 imageData（base64 几百KB×N 太重）。
// 创建/更新 后端会把含图的完整对象返回来，前端在塞进 list state 前先剥掉 imageData。
// hasImage 标志由后端 SQL 算好（image_data IS NOT NULL），保留。
function stripImageDataForList(moment) {
  if (!moment) return moment;
  const { imageData, ...rest } = moment;
  // 如果后端返回了 imageData 但 hasImage 没设置，自动补
  if (rest.hasImage === undefined) {
    rest.hasImage = !!imageData;
  }
  return rest;
}

// 旧版本 localStorage 兼容：如果本地还有 v1/v2 的数据，给用户提供一键迁移
const LEGACY_KEYS = ["pei-xue-notebook-v2", "pei-xue-notebook-v1"];
function getLegacyLocalData() {
  for (const key of LEGACY_KEYS) {
    try {
      const raw = localStorage.getItem(key);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed.kids && parsed.moments) {
          return { key, data: parsed };
        }
      }
    } catch (e) {
      // 跳过损坏的数据
    }
  }
  return null;
}

// ============================================================
// 🖼️ 图片处理工具
// ============================================================
// v4.6: 默认尺寸从 1400/0.72 降到 1100/0.65。
// 数学/语文作业纸的字在这个分辨率仍清晰可读，但 base64 体积差不多减半，
// 100~200KB 一张图存到 DB 才不会让 moments 表臃肿。
async function compressImage(file, maxEdge = 1100, quality = 0.65) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const { width, height } = img;
        const scale = Math.min(1, maxEdge / Math.max(width, height));
        const w = Math.round(width * scale);
        const h = Math.round(height * scale);
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, w, h);
        const dataUrl = canvas.toDataURL("image/jpeg", quality);
        resolve(dataUrl); // data:image/jpeg;base64,...
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// 渲染清洗后的 SVG。组件而非内联函数 —— 配合 useMemo 避免每次渲染都解析。
function SafeSvg({ raw, className = "", style = {} }) {
  const cleaned = useMemo(() => sanitizeSvg(raw), [raw]);
  if (!cleaned) return null;
  return (
    <div
      className={className}
      style={{
        // 让 SVG 撑满父容器宽度，高度按 viewBox 自适应
        display: "block",
        width: "100%",
        maxWidth: "100%",
        ...style,
      }}
      // SVG 已经过白名单清洗，可以放心 dangerouslySetInnerHTML
      dangerouslySetInnerHTML={{ __html: cleaned }}
    />
  );
}

// ============================================================
// 🤖 AI 调用（按学科 + 画像 的 prompt）
// ============================================================

const COMMON_JSON_RULES = `⚠️ JSON 输出规则（非常重要）：
1. 只返回 JSON 对象，不要 markdown 代码块、不要前言尾言
2. 字符串值内部若需引用字符、词语、或标点，只用中文直角引号「」或书名号『』，绝不使用双引号（无论中英文）
3. 不要在字符串里换行，必要时用分号代替`;

// v4.6: 看图题 + SVG 输出规则
//   · 用户可能在 user prompt 里给出"图中信息"字段（视觉模型识别后写的描述）
//     这种情况下原题是看图题，分析时要充分利用这段描述
//   · 变式题、可视化建议涉及图形的，请直接吐 SVG，前端会清洗后渲染
const SVG_RULES = `📐 关于看图题的特别说明：
· 如果 user 消息中出现「图中信息」字段，说明原题需要看图。请仔细基于这段描述理解题目。
· 你给出的 variations（变式题）如果也是看图题，请在该题的 svg 字段里直接生成 SVG 让家长展示给孩子看。
· visual_approach（直观方式）如果是用图来辅助讲解，可在 visual_approach_svg 字段里给出 SVG。
· SVG 规则：只用纯 SVG 标签（rect/circle/line/polyline/polygon/path/text/g/defs 等），
  不要 <script>、不要事件属性、不要 foreignObject。viewBox 用 "0 0 400 300" 这种合适尺寸，
  不写 width/height（让前端自适应）。文字标注用中文，颜色限黑/灰/红/蓝。
  风格简洁清晰，像教辅书插图，不追求美术感。
· 如果某个变式题不需要图（纯文字题），svg 字段填 null。

⚠️ 结构性图（竖式、网格、表格）的"工程纪律"——非常重要：
1. 出图前先在心里定网格：列宽 40px，行高 40px
2. 同一列的所有数字必须用同一个 x 坐标（不要逐字符现想 x）
3. 文字加 text-anchor="middle"，让数字在列中央
4. 加法/减法/竖式除法的横线必须画出来，长度覆盖所有数位列
5. 个位最右、十位中间、百位更左——绝不颠倒

正确的两位数加法竖式 23+45 示例（注意上下两行的"3"和"5"都在 x=280，"2"和"4"都在 x=240）：
<svg viewBox="0 0 320 200" xmlns="http://www.w3.org/2000/svg">
  <text x="240" y="60" font-size="32" text-anchor="middle">2</text>
  <text x="280" y="60" font-size="32" text-anchor="middle">3</text>
  <text x="180" y="110" font-size="32" text-anchor="middle">+</text>
  <text x="240" y="110" font-size="32" text-anchor="middle">4</text>
  <text x="280" y="110" font-size="32" text-anchor="middle">5</text>
  <line x1="200" y1="125" x2="300" y2="125" stroke="black" stroke-width="2"/>
</svg>

错误的（不要这样）：
- 上下两行的个位 x 不一样 → 数位错位，孩子做不了
- 没画横线 → 加法竖式不完整`;

const MATH_SYSTEM_PROMPT = `你是一位极有经验的小学数学教师和认知发展研究者，现在辅助家长辅导自己的孩子。
你不是对着孩子说话，你是对着家长说话。家长是主辅导者，你是副驾驶——任务不是"教会孩子"，而是帮家长用更好的方式引导孩子自己想通。
请根据孩子的年级自动调整语言和引导深度：一年级侧重具象、故事感；高年级可引入抽象关系、一题多解。
${COMMON_JSON_RULES}
${SVG_RULES}`;

const CHINESE_SYSTEM_PROMPT = `你是一位极有经验的小学语文教师，辅助家长辅导自己的孩子。
你最擅长分析：拼音错误（声调/平翘舌/前后鼻音/整体认读）、识字错误（形近字/同音字/部件）、写字问题（笔顺/结构）。
对看图说话、造句、阅读理解这类开放性问题，你会诚实告诉家长"AI 帮不上太多"（用 confidence=低），但仍给出一些引导方向。
你对家长说话，不对孩子说话。请根据孩子的年级调整语言难度。

【出题用字范围（重要）】
你给出的练习题（variations / verify_understanding）请只用孩子年级范围内学过的常用字。
按部编版教材常识粗略对应（累计识字量）：
  · 一年级 ≈ 700 字  · 二年级 ≈ 1600 字  · 三年级 ≈ 2000 字
  · 四年级 ≈ 2500 字 · 五~六年级在 3000 常用字以内
出题情境不得不用到超纲字时，请在该字后用括号加拼音（如"踱(duó)步"）。
专有名词（人名/地名）不受此限。
${COMMON_JSON_RULES}
${SVG_RULES}`;

function buildAnalyzeUserPrompt({ problem, context, kid, subject, imageDescription }) {
  const profile = kid.profile || {};
  const profileBits = [];
  if (profile.current_topics) profileBits.push(`近期在学：${profile.current_topics}`);
  if (profile.strengths) profileBits.push(`已掌握较好：${profile.strengths}`);
  if (profile.weaknesses) profileBits.push(`已知薄弱点：${profile.weaknesses}`);
  if (profile.notes) profileBits.push(`其他情况：${profile.notes}`);
  const profileStr = profileBits.length ? `\n孩子画像：\n${profileBits.join("；")}\n` : "";

  // v4.6: 看图题的图描述塞进 prompt
  const imageBlock = imageDescription
    ? `\n图中信息（视觉模型识别）：${imageDescription}\n`
    : "";

  return `孩子：${kid.name}，${kid.grade}
学科：${subject}${profileStr}
发生的情况：${problem}${imageBlock}
${context ? `家长的补充观察：${context}` : ""}

请以家长副驾驶的视角分析，返回严格 JSON（不要 markdown）：
{
  "misconception": {
    "title": "推测孩子的认知偏差是什么（≤20字，具体可验证）",
    "explanation": "向家长说明这个偏差的本质、为何此年龄段常见（≤120字）",
    "confidence": "高",
    "alternatives": "如果这个判断不对还可能是什么原因（≤60字）"
  },
  "socratic_questions": ["三个循序渐进的问题，每个≤30字"],
  "visual_approach": "推荐一种直观方式让孩子体会这个概念（≤80字）",
  "visual_approach_svg": "如果直观方式可用图示，提供合法 SVG；否则填 null",
  "verify_understanding": "用一道具体的题验证孩子是否真懂",
  "variations": [
    {"level": "同类", "prompt": "与原题同类型但换数字或情境的题", "svg": "若该题需要图则提供 SVG，否则填 null", "answer": "参考答案（只是答案，不是解题过程）"},
    {"level": "变式", "prompt": "考察同一知识点但换一种问法的题", "svg": "若该题需要图则提供 SVG，否则填 null", "answer": "参考答案"},
    {"level": "延伸", "prompt": "通了这个之后，向前走一小步的题", "svg": "若该题需要图则提供 SVG，否则填 null", "answer": "参考答案"}
  ],
  "look_ahead": "这个概念通了之后，下一个相关概念是什么（≤50字）",
  "tag": "${subject === "语文" ? "从以下选一:拼音|识字|写字|表达|理解|好问题|习惯" : "从以下选一:误区|计算|好问题|习惯|概念"}"
}`;
}

// ============================================================
// 错题分析（v4.3 流式版）
// ============================================================
// 兼容性：
//   · 后端是 v4.3+ 时走 SSE，期间通过回调把 reasoning / content 增量推出来
//   · 后端是 v4.2 旧版（响应是普通 JSON）时，自动按非流式处理，调用方无感
// 回调（都是可选）：
//   · onStart(payload)        —— SSE 开始，payload 含 quota
//   · onReasoning(textChunk)  —— AI 思考过程的增量文本
//   · onContent(textChunk)    —— AI 答案 JSON 的增量文本
async function analyzeWithAI({
  problem,
  context,
  kid,
  subject,
  imageDescription, // v4.6: 看图题的图描述
  onStart,
  onReasoning,
  onContent,
} = {}) {
  const system = subject === "语文" ? CHINESE_SYSTEM_PROMPT : MATH_SYSTEM_PROMPT;
  const user = buildAnalyzeUserPrompt({ problem, context, kid, subject, imageDescription });

  const pw = getAccessPassword();
  if (!pw) throw new Error("需要先设置访问密码。请到『备份 & 设置』里填写。");

  const response = await fetch(BACKEND.analyze, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Access-Password": pw,
      Accept: "text/event-stream",
    },
    body: JSON.stringify({ system, user, temperature: 0.5, max_tokens: 5500 }),
  });

  // —— 非 SSE 响应（认证错 / 限流 / 旧后端）走旧逻辑 ——
  const ct = response.headers.get("Content-Type") || "";
  if (!ct.includes("text/event-stream")) {
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const err = new Error(body.error || `后端返回 ${response.status}`);
      err.code = body.code;
      err.status = response.status;
      err.detail = body;
      if (response.status === 401) err.message = body.error || "访问密码错误。";
      if (response.status === 429) {
        err.message = body.error || "请求太频繁，稍等几分钟再试。";
      }
      throw err;
    }
    if (!body.data) throw new Error(body.error || "后端未返回 data 字段");
    if (body.quota) {
      try {
        window.dispatchEvent(
          new CustomEvent("peixue:quota", { detail: body.quota })
        );
      } catch (_) {}
    }
    return body.data;
  }

  // —— SSE 解析 ——
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let finalData = null;
  let finalError = null;

  outer: while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const events = buffer.split("\n\n");
    buffer = events.pop();

    for (const evRaw of events) {
      let eventName = "message";
      let dataStr = "";
      for (const line of evRaw.split("\n")) {
        if (!line || line.startsWith(":")) continue;
        if (line.startsWith("event:")) {
          eventName = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          dataStr += line.slice(5).replace(/^ /, "");
        }
      }
      if (!dataStr) continue;

      let payload;
      try {
        payload = JSON.parse(dataStr);
      } catch {
        continue;
      }

      switch (eventName) {
        case "start":
          if (payload.quota) {
            try {
              window.dispatchEvent(
                new CustomEvent("peixue:quota", { detail: payload.quota })
              );
            } catch (_) {}
          }
          onStart?.(payload);
          break;
        case "reasoning":
          onReasoning?.(payload.text || "");
          break;
        case "content":
          onContent?.(payload.text || "");
          break;
        case "done":
          finalData = payload.data;
          if (payload.quota) {
            try {
              window.dispatchEvent(
                new CustomEvent("peixue:quota", { detail: payload.quota })
              );
            } catch (_) {}
          }
          break outer;
        case "error":
          finalError = payload;
          break outer;
      }
    }
  }

  if (finalError) {
    const err = new Error(finalError.error || "AI 出错");
    err.code = finalError.code;
    err.status = finalError.status;
    throw err;
  }
  if (!finalData) throw new Error("AI 流意外结束，未拿到结果。重试一次试试。");
  return finalData;
}

// ============================================================
// 📷 视觉识图调用
// ============================================================
async function visionRecognize({ imageBase64, subject, kidGrade }) {
  const pw = getAccessPassword();
  if (!pw) throw new Error("需要先设置访问密码。");

  const response = await fetch(BACKEND.vision, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Access-Password": pw,
    },
    body: JSON.stringify({ imageBase64, subject, kidGrade }),
  });

  if (response.status === 401) throw new Error("访问密码错误。");
  if (response.status === 429) throw new Error("请求太频繁，稍等几分钟再试。");

  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `后端返回 ${response.status}`);
  if (!body.data) throw new Error("识图失败");

  return body.data;
}

// ============================================================
// 📝 复习出题调用（v4.4 流式版）
// ============================================================
// ============================================================
// generateReviewQuiz（v4.7 Phase 2 重写）
// ============================================================
// 唯一的出题入口。对接 GET /api/cached-quiz/:momentId（SSE 流式）。
//
// 后端协议会自动选择三条路径之一，前端不用关心：
//   1) DB 缓存命中 → 一个 done 事件，秒到
//   2) 内存总线合流 → 回放累积的 reasoning/content，然后接收后续 chunks，
//      家长看到的是连贯的"AI 在思考"流式体验
//   3) 全新生成 → start + 流式 chunks + done
//
// 回调（全部可选）：
//   onStart({ startedAt, alreadyRunning, model? }) - 后端生成任务的元信息
//   onReasoning(chunk)                              - thinking 文本（增量）
//   onContent(chunk)                                - 题目正文（增量）
// 返回：完整的 quiz 对象 { quiz_question, quiz_svg, expected_answer, ... }
// ============================================================
async function generateReviewQuiz({
  moment,
  onStart,
  onReasoning,
  onContent,
  abortSignal,
} = {}) {
  const pw = getAccessPassword();
  if (!pw) throw new Error("需要先设置访问密码。");

  // 注：后端从 moment 拿原题信息，不需要前端 body
  const url = `${BACKEND.cachedQuiz}/${encodeURIComponent(moment.id)}`;
  const response = await fetch(url, {
    method: "GET",
    headers: {
      "X-Access-Password": pw,
      Accept: "text/event-stream",
    },
    signal: abortSignal,
  });

  // —— 非 SSE 响应（错误）走旧逻辑 ——
  const ct = response.headers.get("Content-Type") || "";
  if (!ct.includes("text/event-stream")) {
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const err = new Error(body.error || `后端返回 ${response.status}`);
      err.code = body.code;
      err.status = response.status;
      err.detail = body;
      if (response.status === 401) err.message = body.error || "访问密码错误。";
      throw err;
    }
    throw new Error("后端返回非 SSE 响应");
  }

  // —— SSE 解析 ——
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let finalQuiz = null;
  let finalError = null;

  outer: while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const events = buffer.split("\n\n");
    buffer = events.pop();

    for (const evRaw of events) {
      let eventName = "message";
      let dataStr = "";
      for (const line of evRaw.split("\n")) {
        if (!line || line.startsWith(":")) continue;
        if (line.startsWith("event:")) {
          eventName = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          dataStr += line.slice(5).replace(/^ /, "");
        }
      }
      if (!dataStr) continue;

      let payload;
      try {
        payload = JSON.parse(dataStr);
      } catch {
        continue;
      }

      switch (eventName) {
        case "start":
          onStart?.(payload);
          break;
        case "reasoning":
          // payload.text 是增量 chunk（合流路径回放时会一次性给完整累积，也按 chunk 处理）
          if (payload.text) onReasoning?.(payload.text);
          break;
        case "content":
          if (payload.text) onContent?.(payload.text);
          break;
        case "done":
          finalQuiz = payload.quiz;
          // v4.8.2: 后端在 done 里捎带了 quota，广播让 UI 上的"今日 AI 用量"刷新
          if (payload.quota && typeof payload.quota.used === "number") {
            try {
              window.dispatchEvent(
                new CustomEvent("peixue:quota", { detail: payload.quota })
              );
            } catch (_) {}
          }
          break outer;
        case "error":
          finalError = payload;
          break outer;
      }
    }
  }

  if (finalError) {
    const err = new Error(finalError.error || "AI 出错");
    err.code = finalError.code;
    err.status = finalError.status;
    err.detail = finalError.detail;
    throw err;
  }
  if (!finalQuiz)
    throw new Error("AI 流意外结束，未拿到结果。重试一次试试。");
  return finalQuiz;
}

// ============================================================
// generateExplanationCard（v4.9）
// ============================================================
// 讲解卡 SSE 流式生成。结构与 generateReviewQuiz 平行，但消费的事件协议
// 末尾事件是 done: { card }（不是 done: { quiz }）。
//
// angle: "default" | "alternative"
//   "alternative" 表示家长按了"还需要更多解释"，生成时让 AI 换一个完全不同的类比。
// ============================================================
async function generateExplanationCard({
  moment,
  angle = "default",
  onStart,
  onReasoning,
  onContent,
  abortSignal,
} = {}) {
  const pw = getAccessPassword();
  if (!pw) throw new Error("需要先设置访问密码。");

  const url =
    `${BACKEND.explanationCard}/${encodeURIComponent(moment.id)}` +
    (angle === "alternative" ? "?angle=alternative" : "");
  const response = await fetch(url, {
    method: "GET",
    headers: {
      "X-Access-Password": pw,
      Accept: "text/event-stream",
    },
    signal: abortSignal,
  });

  // 非 SSE 响应（错误）走旧逻辑
  const ct = response.headers.get("Content-Type") || "";
  if (!ct.includes("text/event-stream")) {
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const err = new Error(body.error || `后端返回 ${response.status}`);
      err.code = body.code;
      err.status = response.status;
      err.detail = body;
      if (response.status === 401) err.message = body.error || "访问密码错误。";
      throw err;
    }
    throw new Error("后端返回非 SSE 响应");
  }

  // SSE 解析（与 generateReviewQuiz 同款，区别在 done 拿 card 而非 quiz）
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let finalCard = null;
  let finalError = null;

  outer: while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const events = buffer.split("\n\n");
    buffer = events.pop();

    for (const evRaw of events) {
      let eventName = "message";
      let dataStr = "";
      for (const line of evRaw.split("\n")) {
        if (!line || line.startsWith(":")) continue;
        if (line.startsWith("event:")) {
          eventName = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          dataStr += line.slice(5).replace(/^ /, "");
        }
      }
      if (!dataStr) continue;

      let payload;
      try {
        payload = JSON.parse(dataStr);
      } catch {
        continue;
      }

      switch (eventName) {
        case "start":
          onStart?.(payload);
          break;
        case "reasoning":
          if (payload.text) onReasoning?.(payload.text);
          break;
        case "content":
          if (payload.text) onContent?.(payload.text);
          break;
        case "done":
          finalCard = payload.card;
          // v4.8.2: 后端 done 里捎带 quota，广播让 UI"今日 AI 用量"即时刷新
          if (payload.quota && typeof payload.quota.used === "number") {
            try {
              window.dispatchEvent(
                new CustomEvent("peixue:quota", { detail: payload.quota })
              );
            } catch (_) {}
          }
          break outer;
        case "error":
          finalError = payload;
          break outer;
      }
    }
  }

  if (finalError) {
    const err = new Error(finalError.error || "AI 出错");
    err.code = finalError.code;
    err.status = finalError.status;
    err.detail = finalError.detail;
    throw err;
  }
  if (!finalCard)
    throw new Error("AI 流意外结束，未拿到讲解卡。重试一次试试。");
  return finalCard;
}

// ============================================================
// 视觉基础
// ============================================================
function PaperBg({ children }) {
  return (
    <div
      className="min-h-screen w-full relative"
      style={{
        backgroundColor: "#F8F4EB",
        backgroundImage: `
          radial-gradient(ellipse at 20% 10%, rgba(184, 156, 102, 0.08) 0%, transparent 50%),
          radial-gradient(ellipse at 80% 90%, rgba(45, 90, 61, 0.06) 0%, transparent 50%)
        `,
        color: "#1F1B16",
      }}
    >
      <div
        className="absolute inset-0 pointer-events-none opacity-[0.18]"
        style={{
          backgroundImage: `
            linear-gradient(rgba(31, 27, 22, 0.4) 1px, transparent 1px),
            linear-gradient(90deg, rgba(31, 27, 22, 0.4) 1px, transparent 1px)
          `,
          backgroundSize: "40px 40px",
          maskImage: "radial-gradient(ellipse at center, black 30%, transparent 85%)",
        }}
      />
      <div className="relative">{children}</div>
    </div>
  );
}

function Logo() {
  return (
    <div className="inline-flex items-center gap-2">
      <Feather size={16} strokeWidth={1.5} style={{ color: "#2D5A3D" }} />
      <span className="serif italic text-lg tracking-wide">陪学笔记</span>
    </div>
  );
}

function formatRelative(timestamp) {
  const now = Date.now();
  const diff = now - timestamp;
  const day = 24 * 60 * 60 * 1000;
  if (diff < 60 * 1000) return "刚刚";
  if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / 3600000)} 小时前`;
  if (diff < 2 * day) return "昨天";
  if (diff < 7 * day) return `${Math.floor(diff / day)} 天前`;
  const d = new Date(timestamp);
  const thisYear = new Date().getFullYear();
  if (d.getFullYear() === thisYear) return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
  return `${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()}`;
}

// ============================================================
// 主 App
// ============================================================
// ============================================================
// 错误边界：Safari 或 React 渲染崩溃时兜底，避免白屏
// ============================================================
class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    console.error("ErrorBoundary 捕获:", error, info);
  }
  render() {
    if (this.state.error) {
      const msg = this.state.error?.message || String(this.state.error);
      return (
        <div
          style={{
            minHeight: "100vh",
            backgroundColor: "#F8F4EB",
            color: "#1F1B16",
            padding: "40px 24px",
            fontFamily: "-apple-system, PingFang SC, sans-serif",
          }}
        >
          <div style={{ maxWidth: 480, margin: "0 auto" }}>
            <h1 style={{ fontSize: 24, marginBottom: 12, fontWeight: 400 }}>
              应用出错了
            </h1>
            <p
              style={{
                fontSize: 14,
                opacity: 0.7,
                lineHeight: 1.7,
                marginBottom: 16,
              }}
            >
              页面渲染时遇到错误。通常刷新一下就好。如果一直不行，请把下面的错误信息截图发给开发者。
            </p>
            <pre
              style={{
                fontSize: 11,
                padding: 12,
                backgroundColor: "rgba(139, 69, 19, 0.08)",
                borderLeft: "2px solid rgba(139, 69, 19, 0.4)",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                overflow: "auto",
                maxHeight: 200,
                marginBottom: 20,
              }}
            >
              {msg}
              {"\n\n"}
              {this.state.error?.stack?.slice(0, 500) || ""}
            </pre>
            <button
              onClick={() => window.location.reload()}
              style={{
                padding: "10px 20px",
                backgroundColor: "#2D5A3D",
                color: "#F8F4EB",
                border: "none",
                borderRadius: 2,
                fontSize: 14,
                cursor: "pointer",
              }}
            >
              刷新页面
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  return (
    <ErrorBoundary>
      <AppInner />
    </ErrorBoundary>
  );
}

function AppInner() {
  const [data, setData] = useState(null); // null = 未加载
  const [bootState, setBootState] = useState("loading"); // loading | ready | auth | error
  const [bootError, setBootError] = useState(null);
  const [syncing, setSyncing] = useState(false);
  // 家庭信息（从 /api/data 拿到）和最新一次 AI 调用的配额用量
  const [family, setFamily] = useState(null); // { name, quotaTotal }
  const [quota, setQuota] = useState(null); // { used, total } — 每次 AI 调用后刷新

  // v4.7: 已缓存复习题的 momentId 集合
  // · 初始从 /api/data 一并加载
  // · 预热成功后由 prefetchService 的 onSuccess 回调追加
  // · 做完题/拒绝/原题改了 时移除
  // 用 Set 而非 Array：复习屏频繁查"这条题缓存了吗"，O(1) 比 .includes() 快
  const [cachedQuizSet, setCachedQuizSet] = useState(() => new Set());

  const [screen, setScreen] = useState("home");
  const [editingMomentId, setEditingMomentId] = useState(null);
  // v4.9: 讲解卡屏正在讲哪道 moment（带 wrongStreak、imageDescription 等完整字段）
  // 在 ReviewScreen 里 wrongStreak >= 3 时由 onOpenExplanationCard 设置；
  // 离开讲解卡屏时清空（或保留至下次切，反正路由切走就看不到了）
  const [explainingMoment, setExplainingMoment] = useState(null);

  const [form, setForm] = useState({
    problem: "",
    context: "",
    subject: "数学",
    imageData: null, // v4.6: 看图题的图（base64 dataURL）
    imageDescription: null, // 视觉模型识别的图描述
  });
  const [copilotResult, setCopilotResult] = useState(null);
  const [loading, setLoading] = useState(false);
  // v4.3 流式：思考过程 + 答案预览（loading 时实时展示给用户）
  const [analysisReasoning, setAnalysisReasoning] = useState("");
  const [analysisContentPreview, setAnalysisContentPreview] = useState("");
  const [reflection, setReflection] = useState("");
  const [error, setError] = useState(null);

  // v5.0：保存进行中的状态。承载两件事：
  //   1) 给用户即时反馈（按钮 spinner + 文案变化），让 2~3s 的等待不再感觉"卡住"
  //   2) 防止双击 / 三击造成的重复提交（旧版没任何防抖，连点 2 次会建 2 条 moment）
  // 值约定：
  //   · null     —— 没在保存
  //   · "draft"  —— 点的是"先记下"
  //   · "understood" / "needReview" / "later" / "reactivate"
  //                —— 点的是 CopilotScreen 的某个保存按钮
  // 用 ref 拦最早一拍：setState 是异步的，第一次 click 还没引起重渲染时，
  // 第二次 click 已经进 saveMoment 了。ref 是同步写，保证只有第一次能通过。
  const [savingButton, setSavingButton] = useState(null);
  const savingRef = useRef(false);

  // v5.0：编辑现有 moment 时，imageData 是异步从 /api/moments/:id 拉过来的。
  // 在拉完之前用户可能就点了保存，此时 form.imageData 还是 null —— 旧逻辑会把
  // 这个 null 当成"显式删除"发给后端，原图就丢了。
  // 用 ref 显式标记"图还在路上"，saveMoment 看到此状态时不带 imageData 字段
  // （让后端不要动 image_data 列），等图加载完再编辑保存。
  const imageLoadingRef = useRef(false);

  // toast 现在支持两种形态：
  //   · 字符串："已保存" —— 2.4 秒后自动消失
  //   · 对象  ：{ msg, onUndo, undoLabel?, duration? } —— 带"撤销"按钮，停留更久
  //              点撤销 / 自动到期都会关闭
  const [toast, setToast] = useState(null);
  const toastTimerRef = useRef(null);
  // 当前 toast 是否是"不可打断"的撤销 toast 的 ref（避免普通 toast 覆盖它，
  // 让用户失去撤销机会而后台还在跑删除定时器）
  const undoToastActiveRef = useRef(false);
  const showToast = (msg) => {
    // 撤销 toast 优先级最高：期间普通 toast 静默，避免抢走撤销按钮
    if (undoToastActiveRef.current) {
      console.info("[toast 忽略，撤销窗口期内]:", msg);
      return;
    }
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast(msg);
    toastTimerRef.current = setTimeout(() => setToast(null), 2400);
  };
  // 带"撤销"按钮的 toast。返回一个 dismiss 函数，外部也可以主动关闭。
  // 默认显示 6 秒，足够人反应过来。
  const showUndoToast = ({ msg, onUndo, undoLabel = "撤销", duration = 6000 }) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    undoToastActiveRef.current = true;
    let undone = false;
    const dismiss = () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
      undoToastActiveRef.current = false;
      setToast(null);
    };
    const handleUndo = () => {
      if (undone) return;
      undone = true;
      try { onUndo?.(); } catch (_) {}
      dismiss();
    };
    setToast({ msg, onUndo: handleUndo, undoLabel, _isUndo: true });
    toastTimerRef.current = setTimeout(dismiss, duration);
    return { dismiss, isUndone: () => undone };
  };

  // -------- 初始加载 --------
  const loadFromServer = async () => {
    try {
      const loaded = await api.loadAll();
      setData({
        kids: loaded.kids,
        moments: loaded.moments,
        activeKidId: loaded.activeKidId,
      });
      // v4.7: 后端把"已缓存复习题"id 一起返回了，前端建索引
      setCachedQuizSet(new Set(loaded.cachedQuizMomentIds || []));
      if (loaded.family) setFamily(loaded.family);
      // v4.8.2: 后端把"今日已用配额"也一起返了。之前 quota 只有在 analyze/vision
      // 端点 SSE 返回时才会更新，导致刚进 app 时显示 0（即使今天已经出过复习题）。
      if (loaded.quota) setQuota(loaded.quota);
      setBootState("ready");
      setBootError(null);
    } catch (e) {
      console.error(e);
      // 按后端 code 精准分流
      if (e.code === "no_password" || e.code === "wrong_password") {
        setBootState("auth");
        // 如果之前存过密码但现在失效了，清掉让用户重新输
        if (e.code === "wrong_password") setAccessPassword("");
      } else if (e.code === "family_expired") {
        setBootState("expired");
        setBootError(e.message);
      } else if (!getAccessPassword()) {
        setBootState("auth");
      } else {
        setBootState("error");
        setBootError(e.message);
      }
    }
  };

  useEffect(() => {
    if (!getAccessPassword()) {
      setBootState("auth");
    } else {
      loadFromServer();
    }
  }, []);

  // 监听 AI 响应里的 quota 信息，实时更新 UI 上的配额展示
  useEffect(() => {
    const handler = (e) => setQuota(e.detail);
    window.addEventListener("peixue:quota", handler);
    return () => window.removeEventListener("peixue:quota", handler);
  }, []);

  // v5.0：data.kids / data.moments 引用稳定（同一次 setData 返回的同一份对象），
  // 但 `data?.kids || []` 这种写法会让 `[]` 兜底变成每次新引用，下游 useMemo
  // 的依赖检查就会一直失败。直接传 data?.xxx，让 React 知道引用其实没变。
  // 用 useMemo 把可能 undefined 的情况兜成稳定的同一个空数组。
  const kids = useMemo(() => data?.kids || EMPTY_ARRAY, [data?.kids]);
  const moments = useMemo(() => data?.moments || EMPTY_ARRAY, [data?.moments]);
  const activeKidId = data?.activeKidId;
  // v5.0: useMemo —— activeKid 之前是裸 .find()，AppInner 每次重渲染都会
  // 重新遍历 kids 数组。虽然 kids 通常 1~3 个不大，但下游 useMemo(deps=[activeKid?.id])
  // 会因为 activeKid 引用变化而触发链式重算。锁定引用稳定。
  const activeKid = useMemo(
    () => kids.find((k) => k.id === activeKidId) || kids[0],
    [kids, activeKidId]
  );

  const kidMoments = useMemo(
    () =>
      moments
        .filter((m) => m.kidId === activeKid?.id)
        .sort((a, b) => b.createdAt - a.createdAt),
    [moments, activeKid?.id]
  );

  const reviewCandidates = useMemo(
    () => pickReviewCandidates(kidMoments),
    [kidMoments]
  );

  // ============================================================
  // v4.7: 预热前 3 道复习题
  // ============================================================
  // 触发时机：在 ready 状态、有 reviewCandidates 时一次性提交。
  // 因为预热接口幂等（已缓存就直接返回不调 AI），useEffect 重复触发也不会浪费 token。
  // 只取前 3 道，理由：
  //   · 家长点进复习屏后通常做 3-5 道就停了
  //   · 预热太多会跟孩子正在做的"分析"/"出题"抢 AI 排队
  //   · 万一家长真的连做 5+ 道，预热可以一边做一边追（见 ReviewScreen 里的"接班预热"逻辑）
  // 依赖项设计：故意只依赖 reviewCandidates 的 id 序列，不依赖整个对象，
  //   避免 moments 任何字段变化都重新触发（虽然幂等，但能减无效请求）。
  const prefetchTargetIds = useMemo(
    () => reviewCandidates.slice(0, 3).map((c) => c.moment.id).join(","),
    [reviewCandidates]
  );

  // v5.0：首页"该复习了"卡片上"N 题已备好"的数。之前是在 JSX 里裸算，
  // 每次 AppInner 重渲染都会 .slice().filter().length 一遍。锁定记忆化。
  const reviewReadyCount = useMemo(
    () =>
      reviewCandidates
        .slice(0, 3)
        .filter((c) => cachedQuizSet.has(c.moment.id)).length,
    [reviewCandidates, cachedQuizSet]
  );

  // v5.0：编辑某条 moment 时它当前的 status（CopilotScreen 用来判断是否"暂搁"）。
  // 之前是在 JSX 里 .find()，moments 大几百条时每次重渲染都全表扫一遍。
  const editingCurrentStatus = useMemo(() => {
    if (!editingMomentId) return null;
    return moments.find((m) => m.id === editingMomentId)?.status || null;
  }, [editingMomentId, moments]);

  useEffect(() => {
    if (bootState !== "ready") return;
    if (!prefetchTargetIds) return;
    const ids = prefetchTargetIds.split(",").filter(Boolean);
    // 已缓存的过滤掉，本地就能判断；省得发幂等请求
    const need = ids.filter((id) => !cachedQuizSet.has(id));
    if (need.length === 0) return;
    prefetchService.enqueue(need, (id) => {
      // 单个预热成功了，把它加进 cachedQuizSet
      // 用 functional setter 避免 stale closure
      setCachedQuizSet((prev) => {
        if (prev.has(id)) return prev;
        const next = new Set(prev);
        next.add(id);
        return next;
      });
    });
  }, [bootState, prefetchTargetIds, cachedQuizSet]);

  // 简单 helper：把 API 调用的错误转成 toast
  const withErrorToast = async (promise, successMsg) => {
    setSyncing(true);
    try {
      const result = await promise;
      if (successMsg) showToast(successMsg);
      return result;
    } catch (e) {
      // 按 code 给更友好的提示
      if (e.code === "quota_exceeded") {
        showToast(`今日 AI 次数已用完，明天 0 点重置`);
      } else if (e.code === "rate_limited") {
        showToast(`请求太快，稍等一下再来`);
      } else if (e.code === "family_expired") {
        showToast(`账号已过期，联系管理员续期`);
        // 密码还有效但家庭过期 → 丢回登录页让用户看到解释
        setBootState("expired");
        setBootError(e.message);
      } else {
        showToast(`失败：${e.message}`);
      }
      throw e;
    } finally {
      setSyncing(false);
    }
  };

  // -------- 动作 --------
  const startNewMoment = () => {
    setEditingMomentId(null);
    setForm({
      problem: "",
      context: "",
      subject: "数学",
      imageData: null,
      imageDescription: null,
    });
    setCopilotResult(null);
    setReflection("");
    setError(null);
    setScreen("new");
  };

  // v4.6: 编辑/查看时刻时，列表里的 moment 可能没有 imageData（性能优化），
  // 如果它有图（hasImage=true），需要去后端拉一次完整数据。
  // useCallback 让引用稳定，配合下游 MomentCard 的 React.memo 才能生效。
  // 依赖列表为空：内部用到的全是 setState setter，setter 在组件生命周期内永远是同一引用。
  const startEditMoment = useCallback(async (moment) => {
    setEditingMomentId(moment.id);
    setForm({
      problem: moment.problem,
      context: moment.context || "",
      subject: moment.subject || "数学",
      imageData: moment.imageData || null,
      imageDescription: moment.imageDescription || null,
    });
    setCopilotResult(moment.analysis || null);
    setReflection(moment.reflection || "");
    setError(null);
    setScreen(moment.analysis ? "copilot" : "new");

    // 列表数据里没带 imageData，但有图：异步拉完整版补进 form
    if (moment.hasImage && !moment.imageData) {
      // v5.0：标记图还在路上。saveMoment 会查这个 ref，没拉完前不把 imageData 字段
      // 带进 PATCH payload，防止"图未加载完就保存→后端把 image_data 设为 NULL"丢图。
      imageLoadingRef.current = true;
      try {
        const full = await api.getMomentDetail(moment.id);
        // 用户可能已经切换到别的屏幕了，不要覆盖；只在仍在编辑同一条时更新
        setEditingMomentId((curId) => {
          if (curId === moment.id) {
            setForm((f) => ({
              ...f,
              imageData: full.imageData || null,
              imageDescription: full.imageDescription || f.imageDescription,
            }));
          }
          return curId;
        });
      } catch (e) {
        // 拉图失败不影响其他编辑
        console.warn("拉取图片失败:", e.message);
      } finally {
        imageLoadingRef.current = false;
      }
    }
  }, []);

  // 把 AI 调用错误转成用户友好的提示文字
  const friendlyAIError = (e) => {
    if (e.code === "quota_exceeded") {
      const d = e.detail || {};
      return `今日 AI 额度已用完（${d.current || ""}/${d.quota || ""}），明天 0 点后重置。`;
    }
    if (e.code === "rate_limited") return "请求太快，稍等 1 分钟再试。";
    if (e.code === "family_expired") return "账号已过期，请联系管理员续期。";
    return e.message || "AI 遇到问题，再试一次";
  };

  const runAnalysis = async () => {
    if (!form.problem.trim()) return;
    setScreen("copilot");
    setLoading(true);
    setError(null);
    setCopilotResult(null);
    setAnalysisReasoning("");
    setAnalysisContentPreview("");
    try {
      const result = await analyzeWithAI({
        problem: form.problem,
        context: form.context,
        kid: activeKid,
        subject: form.subject,
        imageDescription: form.imageDescription, // v4.6
        onReasoning: (chunk) => setAnalysisReasoning((p) => p + chunk),
        onContent: (chunk) => setAnalysisContentPreview((p) => p + chunk),
      });
      setCopilotResult(result);
    } catch (e) {
      console.error(e);
      setError(friendlyAIError(e));
      if (e.code === "family_expired") {
        setBootState("expired");
        setBootError(e.message);
      }
    } finally {
      setLoading(false);
    }
  };

  const reanalyze = async () => {
    setLoading(true);
    setError(null);
    setAnalysisReasoning("");
    setAnalysisContentPreview("");
    try {
      const result = await analyzeWithAI({
        problem: form.problem,
        context: form.context,
        kid: activeKid,
        subject: form.subject,
        imageDescription: form.imageDescription, // v4.6
        onReasoning: (chunk) => setAnalysisReasoning((p) => p + chunk),
        onContent: (chunk) => setAnalysisContentPreview((p) => p + chunk),
      });
      setCopilotResult(result);
    } catch (e) {
      setError(friendlyAIError(e));
      if (e.code === "family_expired") {
        setBootState("expired");
        setBootError(e.message);
      }
    } finally {
      setLoading(false);
    }
  };

  // v5.0：saveMoment 接受第二个参数 buttonKey 用于标识"是哪个按钮触发的"，
  // 让被点的按钮显示 spinner、其他按钮 disable 但不亮 spinner，体感更清晰。
  // 兼容旧调用方式：buttonKey 不传时默认 "default"。
  const saveMoment = async (
    { asStatus = "待复盘" } = {},
    buttonKey = "default"
  ) => {
    if (!form.problem.trim()) return;
    // v5.0 双击防抖：ref 在第一次 click 同步写为 true，第二次 click 立刻 return。
    // 这一拍比 setState 早，是保证不会重复创建 moment 的最后防线。
    if (savingRef.current) return;
    savingRef.current = true;
    setSavingButton(buttonKey);

    try {
      const now = Date.now();
      const signature = getSignature();

      if (editingMomentId) {
        // v4.7: 检查题面或图描述是否变化。后端 updateMoment 在这两个字段变化时会
        // 自动 DELETE cached_quizzes 行；前端 state 这边要同步把 set 项删掉，
        // 否则首页 hasCache 标志/统计还以为这道题已经预热好。
        const oldMoment = moments.find((m) => m.id === editingMomentId);
        const problemChanged =
          oldMoment &&
          (oldMoment.problem !== form.problem.trim() ||
            (oldMoment.imageDescription || null) !==
              (form.imageDescription || null));

        // v5.0 安全检查：避免"图片异步加载未完成就保存导致图丢失"。
        // 编辑时 imageData 是瘦身版列表里没的，要异步从 /api/moments/:id 拉完整对象
        // 才能填进 form.imageData。如果用户在那 100~500ms 内就点了保存，form.imageData
        // 还是 null，旧逻辑会把 imageData: null 发给后端，后端当成"显式删除"，原图就没了。
        // 解决：imageLoadingRef 为 true（图还在路上）时不把 imageData 写进 payload，
        //      让后端"不要动 image_data 列"。imageDescription 不受影响 —— 它在列表里
        //      就有，用户可以马上看到和编辑，必须保证它的修改能写回。
        const imagePayload = {
          imageDescription: form.imageDescription,
        };
        if (!imageLoadingRef.current) {
          imagePayload.imageData = form.imageData;
        }

        const updated = await withErrorToast(
          api.updateMoment(editingMomentId, {
            subject: form.subject || "数学",
            problem: form.problem.trim(),
            context: form.context.trim(),
            analysis: copilotResult,
            reflection: reflection.trim(),
            tag: copilotResult?.tag || "新",
            status: asStatus,
            // v4.6: 图字段。明确传 null 表示删除（用户点了"移除图片"）。
            // 不传则后端不动该列。
            // v5.0: 图未加载完时不传，避免数据丢失（见 imagePayload 注释）。
            ...imagePayload,
            // v4.9: 从"暂搁"转出（家长点"重新加入复习"）时清零 wrongStreak。
            // 否则旧的 wrongStreak >= 3 还在，激活后下次进复习屏会立刻再触发讲解卡，
            // 形成死循环。激活意味着家长认为孩子状态已经准备好，从头算。
            // 注意：保留 lastWrongAt 不动 —— 12h 冷却让它隔一阵子再进池，是好事。
            ...(oldMoment?.status === "暂搁" && asStatus !== "暂搁"
              ? { wrongStreak: 0 }
              : {}),
          }),
          "已更新"
        );
        setData((prev) => ({
          ...prev,
          moments: prev.moments.map((m) =>
            m.id === editingMomentId ? stripImageDataForList(updated) : m
          ),
        }));
        if (problemChanged) {
          setCachedQuizSet((prev) => {
            if (!prev.has(editingMomentId)) return prev;
            const next = new Set(prev);
            next.delete(editingMomentId);
            return next;
          });
        }
      } else {
        const newMoment = {
          id: `m${now}`,
          kidId: activeKid.id,
          subject: form.subject || "数学",
          problem: form.problem.trim(),
          context: form.context.trim(),
          analysis: copilotResult,
          reflection: reflection.trim(),
          tag: copilotResult?.tag || "新",
          status: asStatus,
          imageData: form.imageData || null, // v4.6
          imageDescription: form.imageDescription || null,
          created_by: signature || null,
          createdAt: now,
        };
        const created = await withErrorToast(
          api.createMoment(newMoment),
          "已保存到档案"
        );
        // 列表里只放瘦身版（不含 imageData）—— 详情/编辑时再按需拉
        // v5.0 起后端已经返回 lite 版本（不含 imageData），stripImageDataForList
        // 实际是个 no-op，但保留作为兼容老后端的兜底。
        setData((prev) => ({
          ...prev,
          moments: [stripImageDataForList(created), ...prev.moments],
        }));
      }

      setEditingMomentId(null);
      setForm({
        problem: "",
        context: "",
        subject: "数学",
        imageData: null,
        imageDescription: null,
      });
      setCopilotResult(null);
      setReflection("");
      setScreen("home");
    } catch (e) {
      // withErrorToast 已经提示过了
    } finally {
      // 无论成功失败：清掉保存中状态，让按钮可以再点（失败时用户可能想重试）
      savingRef.current = false;
      setSavingButton(null);
    }
  };

  // useCallback 包：让 MomentCard 的 React.memo 比对 onDelete 时引用稳定。
  // 不依赖 screen —— 改用 setScreen(prev => prev === "copilot" ? "home" : prev) 模式。
  // ─────────────────────────────────────────────────────────
  // v4.8.2: 改成"软删除 + 6 秒撤销窗口"。
  // 之前用 confirm("无法恢复") 拦一道；现实是手指误碰一样会按下确认。
  // 现在：先从 UI 抽掉，弹一个带"撤销"按钮的 toast，6 秒后才真正调
  // api.deleteMoment 落库。期间点撤销 → 完整恢复（包括缓存复习题 set）。
  // ─────────────────────────────────────────────────────────
  const deleteMoment = useCallback((id) => {
    let snapshotMoment = null;
    let wasInCachedSet = false;
    let undone = false;

    // 1) 从 UI 抽走，备份够回滚的状态
    setData((prev) => {
      snapshotMoment = prev.moments.find((m) => m.id === id) || null;
      return { ...prev, moments: prev.moments.filter((m) => m.id !== id) };
    });
    setCachedQuizSet((prev) => {
      if (!prev.has(id)) return prev;
      wasInCachedSet = true;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    setScreen((prev) => (prev === "copilot" ? "home" : prev));

    // 2) 6 秒后才真删
    const timer = setTimeout(async () => {
      if (undone) return;
      try {
        await api.deleteMoment(id);
        // 后端 ON DELETE CASCADE 会清掉 cached_quizzes，前端 set 已在抽走时同步过
      } catch (e) {
        // 服务器删失败：把数据放回去，并提示
        if (snapshotMoment) {
          setData((prev) => ({ ...prev, moments: [...prev.moments, snapshotMoment] }));
        }
        if (wasInCachedSet) {
          setCachedQuizSet((prev) => {
            const next = new Set(prev);
            next.add(id);
            return next;
          });
        }
        showToast(`删除失败，已恢复：${e.message || ""}`);
      }
    }, 6000);

    // 3) 撤销 toast
    showUndoToast({
      msg: "已删除",
      onUndo: () => {
        undone = true;
        clearTimeout(timer);
        if (snapshotMoment) {
          setData((prev) => ({ ...prev, moments: [...prev.moments, snapshotMoment] }));
        }
        if (wasInCachedSet) {
          setCachedQuizSet((prev) => {
            const next = new Set(prev);
            next.add(id);
            return next;
          });
        }
        showToast("已恢复");
      },
      duration: 6000,
    });
  }, []);

  // useCallback 包：让 MomentCard 的 React.memo 比对 onUpdateStatus 时引用稳定。
  // ─────────────────────────────────────────────────────────
  // v4.8.2: 改成"乐观更新"。
  // 之前是 await api.updateMoment 再 setData，导致复习屏点"真会了，过"后
  // 必须等服务器往返完毕（2~3 秒）才前进到下一题，体感很卡。
  // 现在：本地 state 先改，UI 当帧前进；后台异步同步服务器，失败则回滚 + 提示。
  // 副作用补偿：服务器最终返回的完整 moment（含 image_data 等）合并回去时
  // 会触发一次"权威值刷新"，所以乐观期间的小差异（updatedAt 戳）会被纠正。
  // ─────────────────────────────────────────────────────────
  const updateMomentStatus = useCallback(async (id, statusOrChanges) => {
    // 兼容两种调用方式：
    //   updateMomentStatus(id, "已理解")
    //   updateMomentStatus(id, { status: "已理解", intervalDays: 4 })
    const changes =
      typeof statusOrChanges === "string"
        ? { status: statusOrChanges }
        : statusOrChanges;

    // 1) 立刻改本地 state —— UI 当帧前进
    //    snapshot 留作回滚（万一服务器写失败要恢复）
    let snapshot = null;
    setData((prev) => {
      snapshot = prev.moments.find((m) => m.id === id) || null;
      return {
        ...prev,
        moments: prev.moments.map((m) =>
          m.id === id
            ? { ...m, ...changes, updatedAt: Date.now() }
            : m
        ),
      };
    });

    // 2) 后台同步服务器
    try {
      const updated = await api.updateMoment(id, changes);
      // 用服务器权威值覆盖一次（确保 updatedAt 等与服务器一致）
      setData((prev) => ({
        ...prev,
        moments: prev.moments.map((m) =>
          m.id === id ? stripImageDataForList(updated) : m
        ),
      }));
    } catch (e) {
      // 3) 写失败：回滚本地，并提示
      if (snapshot) {
        setData((prev) => ({
          ...prev,
          moments: prev.moments.map((m) => (m.id === id ? snapshot : m)),
        }));
      }
      // 按错误码出更友好的提示（和 withErrorToast 的口径保持一致）
      let msg;
      if (e.code === "quota_exceeded") msg = "今日 AI 次数已用完，明天 0 点重置";
      else if (e.code === "rate_limited") msg = "请求太快，稍等一下再来";
      else if (e.code === "family_expired") msg = "账号已过期，联系管理员续期";
      else msg = `保存失败，已撤销改动：${e.message || ""}`;
      showToast(msg);
    }
  }, []);

  const switchKid = async (kidId) => {
    setData((prev) => ({ ...prev, activeKidId: kidId }));
    setScreen("home");
    // 后台异步存 activeKidId，失败就算了，不打扰用户
    api.setSetting("activeKidId", kidId).catch(() => {});
  };

  const addKid = async (name, grade) => {
    const id = `k${Date.now()}`;
    const avatars = ["🌱", "🌊", "🌻", "🌙", "🪐", "🦊", "🐨"];
    const newKid = {
      id,
      name,
      grade,
      avatar: avatars[kids.length % avatars.length],
      since: new Date().toLocaleDateString("zh-CN", { year: "numeric", month: "long" }),
      profile: { ...defaultKidProfile },
    };
    try {
      const created = await withErrorToast(
        api.createKid(newKid),
        `已为 ${name} 开始记录`
      );
      setData((prev) => ({
        ...prev,
        kids: [...prev.kids, created],
        activeKidId: created.id,
      }));
      api.setSetting("activeKidId", created.id).catch(() => {});
    } catch (e) {
      // 已 toast
    }
  };

  const updateKidProfile = async (kidId, profile) => {
    try {
      const updated = await withErrorToast(
        api.updateKid(kidId, { profile }),
        "画像已更新"
      );
      setData((prev) => ({
        ...prev,
        kids: prev.kids.map((k) => (k.id === kidId ? updated : k)),
      }));
    } catch (e) {
      // 已 toast
    }
  };

  const updateKidBasic = async (kidId, changes) => {
    try {
      const updated = await withErrorToast(api.updateKid(kidId, changes));
      setData((prev) => ({
        ...prev,
        kids: prev.kids.map((k) => (k.id === kidId ? updated : k)),
      }));
    } catch (e) {
      // 已 toast
    }
  };

  const exportData = async () => {
    try {
      const snapshot = await withErrorToast(api.exportJson());
      const blob = new Blob([JSON.stringify(snapshot, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `陪学笔记_${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      showToast("已导出备份");
    } catch (e) {
      // 已 toast
    }
  };

  const importData = (file) => {
    const reader = new FileReader();
    reader.onload = async (e) => {
      let imported;
      try {
        imported = JSON.parse(e.target.result);
        if (!imported.kids || !imported.moments) throw new Error("格式不对");
      } catch (err) {
        alert("文件格式不对，无法导入");
        return;
      }
      if (
        !confirm(
          `将导入 ${imported.kids.length} 个孩子、${imported.moments.length} 条记录。会覆盖当前数据库的所有数据。继续？`
        )
      )
        return;
      try {
        const result = await withErrorToast(api.importJson(imported));
        await loadFromServer();
        showToast(`已导入 ${result.kids} 个孩子、${result.moments} 条记录`);
      } catch (err) {
        // 已 toast
      }
    };
    reader.readAsText(file);
  };

  const migrateFromLocal = async () => {
    const legacy = getLegacyLocalData();
    if (!legacy) {
      alert("本地没有发现旧版本的数据");
      return;
    }
    if (
      !confirm(
        `本地找到 ${legacy.data.kids?.length || 0} 个孩子、${legacy.data.moments
          ?.length || 0} 条记录。迁移到服务器后会覆盖数据库现有数据。继续？`
      )
    )
      return;
    try {
      const result = await withErrorToast(api.importJson(legacy.data));
      await loadFromServer();
      showToast(
        `已迁移 ${result.kids} 个孩子、${result.moments} 条记录。可以清空本地缓存了。`
      );
    } catch (e) {
      // 已 toast
    }
  };

  const clearLocalData = () => {
    if (!confirm("清空浏览器本地缓存（旧版数据）？服务器数据不受影响。")) return;
    LEGACY_KEYS.forEach((k) => safeStorage.remove(k));
    showToast("本地缓存已清空");
  };

  // -------- 引导态：还没输入密码 --------
  if (bootState === "auth") {
    return (
      <PaperBg>
        <div className="max-w-md mx-auto px-6 py-20">
          <AuthGate
            onAuth={(pw) => {
              setAccessPassword(pw);
              setBootState("loading");
              loadFromServer();
            }}
          />
        </div>
      </PaperBg>
    );
  }

  // -------- 引导态：加载中 --------
  if (bootState === "loading" || !data) {
    return (
      <PaperBg>
        <div className="min-h-[60vh] flex items-center justify-center">
          <div className="text-center">
            <Loader2
              size={20}
              className="animate-spin mx-auto mb-3 opacity-50"
              strokeWidth={1.5}
            />
            <div className="serif italic text-sm opacity-60">正在从云端同步…</div>
          </div>
        </div>
      </PaperBg>
    );
  }

  // -------- 引导态：家庭账号过期 --------
  if (bootState === "expired") {
    return (
      <PaperBg>
        <div className="max-w-md mx-auto px-6 py-20 text-center">
          <div className="serif text-2xl mb-3" style={{ fontWeight: 400 }}>
            账号已过期
          </div>
          <div
            className="text-sm opacity-80 mb-4 p-4 text-left"
            style={{
              backgroundColor: "rgba(183, 121, 31, 0.08)",
              borderLeft: "2px solid rgba(183, 121, 31, 0.4)",
            }}
          >
            {bootError}
          </div>
          <div className="text-xs opacity-60 leading-relaxed mb-6 text-left">
            联系一下这个应用的管理员（给你密码的那个人），请他帮你续期。
            续期后用原密码登录即可，数据都还在。
          </div>
          <button
            onClick={() => {
              setAccessPassword("");
              setBootState("auth");
            }}
            className="text-sm px-4 py-2"
            style={{
              backgroundColor: "#2D5A3D",
              color: "#F8F4EB",
              borderRadius: "2px",
            }}
          >
            换一个密码登录
          </button>
        </div>
      </PaperBg>
    );
  }

  // -------- 引导态：出错 --------
  if (bootState === "error") {
    return (
      <PaperBg>
        <div className="max-w-md mx-auto px-6 py-20 text-center">
          <div className="serif text-2xl mb-3" style={{ fontWeight: 400 }}>
            连不上云端
          </div>
          <div
            className="text-sm opacity-70 mb-4 p-3 text-left"
            style={{
              backgroundColor: "rgba(139, 69, 19, 0.06)",
              borderLeft: "2px solid rgba(139, 69, 19, 0.3)",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {bootError}
          </div>
          <button
            onClick={() => {
              setBootState("loading");
              loadFromServer();
            }}
            className="text-sm px-4 py-2"
            style={{
              backgroundColor: "#2D5A3D",
              color: "#F8F4EB",
              borderRadius: "2px",
            }}
          >
            <RefreshCw size={14} className="inline mr-1" /> 重试
          </button>
          <button
            onClick={() => {
              setAccessPassword("");
              setBootState("auth");
            }}
            className="ml-3 text-xs opacity-70 hover:opacity-100"
          >
            重新输入密码
          </button>
        </div>
      </PaperBg>
    );
  }

  // -------- 没有孩子（可能数据库全空）--------
  if (!activeKid) {
    return (
      <PaperBg>
        <div className="max-w-md mx-auto px-6 py-20 text-center">
          <div className="serif text-2xl mb-3">还没有孩子</div>
          <div className="text-sm opacity-60 mb-6">
            数据库是空的。添加一个孩子开始吧。
          </div>
          <AddFirstKidForm onAdd={addKid} />
        </div>
      </PaperBg>
    );
  }

  return (
    <PaperBg>
      <style>{`
        /*
         * 字体使用系统字体栈（见 index.html），不依赖 Google Fonts，
         * 避免国内访问 fonts.googleapis.com / fonts.gstatic.com 超时。
         * serif 用系统自带的衬线中文字体，iOS 上是 Songti SC，Android 上是 Noto Serif CJK。
         */
        * {
          font-family: -apple-system, BlinkMacSystemFont, "PingFang SC",
                       "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue",
                       Arial, sans-serif;
        }
        .serif {
          font-family: "Songti SC", "Noto Serif CJK SC", "Noto Serif SC",
                       "Source Han Serif SC", Georgia, "Times New Roman", serif;
        }

        @keyframes fade-up { from { transform: translateY(8px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
        @keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }
        @keyframes toast-in { from { transform: translateY(20px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
        .fade-up { animation: fade-up 0.5s cubic-bezier(0.2, 0.8, 0.2, 1) both; }
        .fade-up-1 { animation: fade-up 0.5s cubic-bezier(0.2, 0.8, 0.2, 1) 0.05s both; }
        .fade-up-2 { animation: fade-up 0.5s cubic-bezier(0.2, 0.8, 0.2, 1) 0.1s both; }
        .fade-up-3 { animation: fade-up 0.5s cubic-bezier(0.2, 0.8, 0.2, 1) 0.15s both; }
        .fade-up-4 { animation: fade-up 0.5s cubic-bezier(0.2, 0.8, 0.2, 1) 0.2s both; }
        .fade-up-5 { animation: fade-up 0.5s cubic-bezier(0.2, 0.8, 0.2, 1) 0.25s both; }
        .fade-in { animation: fade-in 0.6s ease-out both; }
        .toast-in { animation: toast-in 0.3s ease-out both; }

        .ink-underline {
          background-image: linear-gradient(90deg, #2D5A3D 0%, #2D5A3D 100%);
          background-repeat: no-repeat;
          background-size: 100% 2px;
          background-position: 0 100%;
          padding-bottom: 2px;
        }
      `}</style>

      <div className="max-w-2xl mx-auto px-6 py-8">
        <TopBar screen={screen} setScreen={setScreen} syncing={syncing} />

        {screen === "home" && (
          <HomeScreen
            kid={activeKid}
            kids={kids}
            moments={kidMoments}
            reviewCount={reviewCandidates.length}
            // v4.7: 已预热好的复习题数（前端 cachedQuizSet ∩ reviewCandidates 前 3 道）
            // 显示在首页"该复习了"那个卡上，让家长知道首题会秒开
            // v5.0：改用 useMemo 锁定的 reviewReadyCount，避免每次重渲染都重算。
            reviewReadyCount={reviewReadyCount}
            onNew={startNewMoment}
            onOpen={startEditMoment}
            onTimeline={() => setScreen("timeline")}
            onReview={() => setScreen("review")}
            onProfile={() => setScreen("profile")}
            onSwitchKid={switchKid}
            onAddKid={addKid}
            onUpdateStatus={updateMomentStatus}
            onDelete={deleteMoment}
          />
        )}

        {screen === "new" && (
          <NewMomentScreen
            form={form}
            setForm={setForm}
            onSubmit={runAnalysis}
            onSave={() => saveMoment({ asStatus: "已记录" }, "draft")}
            savingButton={savingButton}
            kid={activeKid}
            isEditing={!!editingMomentId}
          />
        )}

        {screen === "copilot" && (
          <CopilotScreen
            form={form}
            result={copilotResult}
            loading={loading}
            reasoning={analysisReasoning}
            streamingContent={analysisContentPreview}
            error={error}
            reflection={reflection}
            setReflection={setReflection}
            onReanalyze={reanalyze}
            onSave={saveMoment}
            savingButton={savingButton}
            onDelete={editingMomentId ? () => deleteMoment(editingMomentId) : null}
            isEditing={!!editingMomentId}
            momentId={editingMomentId}
            // v4.9: 把当前 moment 的 status 传进去，让"暂搁"状态能显示激活按钮。
            // 编辑时用 editingMomentId 从 moments 里查；新建时为 null。
            // v5.0：从 useMemo 的 editingCurrentStatus 取，避免重渲染时 .find() 全表扫。
            currentStatus={editingCurrentStatus}
          />
        )}

        {screen === "timeline" && (
          <TimelineScreen
            kid={activeKid}
            moments={kidMoments}
            onOpen={startEditMoment}
            onUpdateStatus={updateMomentStatus}
            onDelete={deleteMoment}
          />
        )}

        {screen === "review" && (
          <ReviewScreen
            kid={activeKid}
            candidates={reviewCandidates}
            onUpdateStatus={updateMomentStatus}
            onBack={() => setScreen("home")}
            // v4.7：缓存相关
            cachedQuizSet={cachedQuizSet}
            onMarkCached={(id) =>
              setCachedQuizSet((prev) => {
                if (prev.has(id)) return prev;
                const next = new Set(prev);
                next.add(id);
                return next;
              })
            }
            onMarkUncached={(id) =>
              setCachedQuizSet((prev) => {
                if (!prev.has(id)) return prev;
                const next = new Set(prev);
                next.delete(id);
                return next;
              })
            }
            // v4.9: wrongStreak >= 3 时从复习屏切到讲解卡屏
            onOpenExplanationCard={(moment) => {
              setExplainingMoment(moment);
              setScreen("explain");
            }}
          />
        )}

        {/* v4.9: 讲解卡屏 */}
        {screen === "explain" && explainingMoment && (
          <ExplanationCardScreen
            kid={activeKid}
            moment={explainingMoment}
            onUpdateStatus={updateMomentStatus}
            onBack={() => {
              // 从讲解卡屏返回：默认回首页
              // ("讲完了让 ta 再做一道" 也回首页—— streak 已清零，下次进复习屏
              // 自然能再被推到家长面前；不必直接弹回复习屏给孩子立即追问，
              // 让孩子先消化讲解，过段时间再验证，效果更好。)
              setExplainingMoment(null);
              setScreen("home");
            }}
          />
        )}

        {screen === "profile" && (
          <ProfileScreen
            kid={activeKid}
            onUpdateProfile={(p) => updateKidProfile(activeKid.id, p)}
            onUpdateBasic={(c) => updateKidBasic(activeKid.id, c)}
            onBack={() => setScreen("home")}
          />
        )}

        {screen === "settings" && (
          <SettingsScreen
            kids={kids}
            moments={moments}
            onExport={exportData}
            onImport={importData}
            onRefresh={() => {
              loadFromServer();
              showToast("已从云端刷新");
            }}
            onMigrate={migrateFromLocal}
            onClearLocal={clearLocalData}
            hasLegacy={!!getLegacyLocalData()}
            family={family}
            quota={quota}
          />
        )}

        <div className="mt-16 text-center text-xs opacity-40 serif italic">
          — 给 {activeKid?.name || "每一个孩子"}，以及所有认真陪伴的家长 —
        </div>
      </div>

      {toast && (
        <div className="fixed bottom-8 left-1/2 -translate-x-1/2 toast-in z-50">
          <div
            className="serif text-sm px-4 py-2.5 flex items-center gap-3"
            style={{
              backgroundColor: "#1F1B16",
              color: "#F8F4EB",
              borderRadius: "2px",
              boxShadow: "2px 2px 0 rgba(45, 90, 61, 0.5)",
            }}
          >
            <span>{typeof toast === "string" ? toast : toast.msg}</span>
            {typeof toast === "object" && toast._isUndo && (
              <button
                onClick={toast.onUndo}
                className="text-xs underline underline-offset-2 opacity-90 hover:opacity-100"
                style={{ color: "#F8F4EB" }}
              >
                {toast.undoLabel || "撤销"}
              </button>
            )}
          </div>
        </div>
      )}
    </PaperBg>
  );
}

// ============================================================
// 顶栏
// ============================================================
function TopBar({ screen, setScreen, syncing }) {
  return (
    <div className="flex items-center justify-between mb-10 fade-in">
      {screen !== "home" ? (
        <button
          onClick={() => setScreen("home")}
          className="flex items-center gap-1.5 text-sm opacity-60 hover:opacity-100 transition-opacity"
        >
          <ArrowLeft size={14} /> 返回
        </button>
      ) : (
        <Logo />
      )}
      <div className="flex items-center gap-3">
        {syncing && (
          <div
            className="flex items-center gap-1 text-[11px] opacity-50"
            title="正在同步到云端"
          >
            <Loader2 size={11} className="animate-spin" /> 同步中
          </div>
        )}
        {screen === "home" && (
          <button
            onClick={() => setScreen("settings")}
            className="text-xs opacity-50 hover:opacity-100"
          >
            备份 / 设置
          </button>
        )}
      </div>
    </div>
  );
}

// ============================================================
// 密码引导
// ============================================================
function AuthGate({ onAuth }) {
  const [pw, setPw] = useState("");
  return (
    <div className="fade-up">
      <div className="text-center mb-8">
        <Feather
          size={32}
          strokeWidth={1.2}
          style={{ color: "#2D5A3D" }}
          className="mx-auto mb-4"
        />
        <div className="serif text-3xl mb-2" style={{ fontWeight: 400 }}>
          陪学笔记
        </div>
        <div className="text-sm opacity-60 leading-relaxed">
          请输入家庭访问密码。
          <br />
          密码对 → 就能看到全家的记录。
        </div>
      </div>
      <input
        type="password"
        value={pw}
        onChange={(e) => setPw(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && pw.trim()) onAuth(pw.trim());
        }}
        placeholder="访问密码"
        autoFocus
        className="w-full px-4 py-3 mb-3 text-sm focus:outline-none"
        style={{
          border: "1px solid rgba(31, 27, 22, 0.2)",
          borderRadius: "2px",
          backgroundColor: "rgba(255, 255, 255, 0.6)",
        }}
      />
      <button
        onClick={() => pw.trim() && onAuth(pw.trim())}
        disabled={!pw.trim()}
        className="w-full py-3 text-sm disabled:opacity-40"
        style={{
          backgroundColor: "#2D5A3D",
          color: "#F8F4EB",
          borderRadius: "2px",
        }}
      >
        进入
      </button>
      <div className="text-[11px] opacity-50 italic text-center mt-4 leading-relaxed">
        密码不对？问家里另一个人要。
        <br />
        忘记密码时，请让服务器管理员为这个家庭重置密码。
      </div>
    </div>
  );
}

// ============================================================
// 添加第一个孩子（数据库全空时）
// ============================================================
function AddFirstKidForm({ onAdd }) {
  const [name, setName] = useState("");
  const [grade, setGrade] = useState("一年级");

  return (
    <div className="text-left">
      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="孩子的名字"
        className="w-full px-3 py-2 mb-2 text-sm focus:outline-none"
        style={{
          border: "1px solid rgba(31, 27, 22, 0.2)",
          borderRadius: "2px",
          backgroundColor: "rgba(255, 255, 255, 0.6)",
        }}
      />
      <select
        value={grade}
        onChange={(e) => setGrade(e.target.value)}
        className="w-full px-3 py-2 mb-3 text-sm focus:outline-none"
        style={{
          border: "1px solid rgba(31, 27, 22, 0.2)",
          borderRadius: "2px",
          backgroundColor: "rgba(255, 255, 255, 0.6)",
        }}
      >
        {[
          "幼儿园",
          "一年级",
          "二年级",
          "三年级",
          "四年级",
          "五年级",
          "六年级",
          "初一",
          "初二",
          "初三",
        ].map((g) => (
          <option key={g} value={g}>
            {g}
          </option>
        ))}
      </select>
      <button
        onClick={() => name.trim() && onAdd(name.trim(), grade)}
        disabled={!name.trim()}
        className="w-full py-2.5 text-sm disabled:opacity-40"
        style={{
          backgroundColor: "#2D5A3D",
          color: "#F8F4EB",
          borderRadius: "2px",
        }}
      >
        开始陪学 →
      </button>
    </div>
  );
}

// ============================================================
// 首页
// ============================================================
function HomeScreen({
  kid,
  kids,
  moments,
  reviewCount,
  reviewReadyCount, // v4.7: 已预热好可秒开的复习题数
  onNew,
  onOpen,
  onTimeline,
  onReview,
  onProfile,
  onSwitchKid,
  onAddKid,
  onUpdateStatus,
  onDelete,
}) {
  const [showAddKid, setShowAddKid] = useState(false);
  const [newKid, setNewKid] = useState({ name: "", grade: "一年级" });

  const recent = moments.slice(0, 5);
  const pending = moments.filter(
    (m) => m.status === "待复盘" || m.status === "进行中"
  ).length;

  return (
    <div>
      {/* 孩子档案 */}
      <div className="mb-8 fade-up">
        <div className="flex items-start gap-3 mb-2">
          <span className="text-5xl leading-none">{kid.avatar}</span>
          <div className="flex-1">
            <div className="flex items-baseline gap-2">
              <h1 className="serif text-4xl" style={{ fontWeight: 400 }}>
                {kid.name}
              </h1>
              <button
                onClick={onProfile}
                className="text-[11px] opacity-40 hover:opacity-100 flex items-center gap-0.5"
                title="编辑孩子画像"
              >
                <Pencil size={11} /> 画像
              </button>
            </div>
            <div className="text-sm opacity-60">
              {kid.grade} · 陪学自 {kid.since}
            </div>
          </div>
        </div>
        <div className="text-sm leading-relaxed opacity-70 max-w-md">
          {moments.length === 0 ? (
            <>这里还空白着。去记下第一个时刻吧。</>
          ) : (
            <>
              陪着 ta 走过{" "}
              <span
                className="serif italic font-semibold"
                style={{ color: "#2D5A3D" }}
              >
                {moments.length}
              </span>{" "}
              个思考的时刻。
              {pending > 0 && <>其中 {pending} 个还没完成复盘。</>}
            </>
          )}
        </div>
      </div>

      {/* 主 CTA */}
      <button
        onClick={onNew}
        className="w-full mb-4 fade-up-1"
        style={{
          backgroundColor: "#2D5A3D",
          color: "#F8F4EB",
          padding: "18px 24px",
          borderRadius: "2px",
          boxShadow: "3px 3px 0 rgba(31, 27, 22, 0.2)",
          transition: "transform 0.15s",
        }}
        onMouseEnter={(e) => (e.currentTarget.style.transform = "translate(-1px, -1px)")}
        onMouseLeave={(e) => (e.currentTarget.style.transform = "translate(0, 0)")}
      >
        <div className="flex items-center justify-between">
          <div className="text-left">
            <div className="serif text-xl mb-0.5">记录一个时刻</div>
            <div className="text-xs opacity-70">
              一道错题、一个困惑，或孩子问的一个问题
            </div>
          </div>
          <Plus size={20} strokeWidth={1.5} />
        </div>
      </button>

      {/* 复盘入口 */}
      {reviewCount > 0 && (
        <button
          onClick={onReview}
          className="w-full mb-8 fade-up-2 text-left"
          style={{
            backgroundColor: "rgba(183, 121, 31, 0.1)",
            padding: "14px 20px",
            borderRadius: "2px",
            border: "1px solid rgba(183, 121, 31, 0.3)",
          }}
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <BrainCircuit size={20} strokeWidth={1.5} style={{ color: "#B7791F" }} />
              <div>
                <div
                  className="serif text-base"
                  style={{ fontWeight: 500, color: "#8B4513" }}
                >
                  该复习了 · {reviewCount} 题待考察
                </div>
                <div className="text-xs opacity-60 mt-0.5">
                  按间隔重复算法挑出该回头看看的题，AI 出变式题考一考
                  {/* v4.7: 已预热好可秒开的题数。让家长心中有数：点进去就有题。 */}
                  {reviewReadyCount > 0 && (
                    <span
                      className="ml-1.5 font-semibold"
                      style={{ color: "#2D5A3D" }}
                      title="已预生成的复习题，点进去秒开。剩下的也会陆续准备好。"
                    >
                      · {reviewReadyCount} 题已备好
                    </span>
                  )}
                </div>
              </div>
            </div>
            <ChevronRight size={16} style={{ color: "#B7791F" }} />
          </div>
        </button>
      )}

      {/* 最近时刻 */}
      {moments.length > 0 && (
        <>
          <div className="mb-4 mt-4 flex items-baseline justify-between fade-up-2">
            <h2 className="serif text-xl" style={{ fontWeight: 500 }}>
              最近的时刻
            </h2>
            <button
              onClick={onTimeline}
              className="text-xs opacity-60 hover:opacity-100"
            >
              完整时间线 →
            </button>
          </div>
          <div className="space-y-3">
            {recent.map((m, i) => (
              <MomentCard
                key={m.id}
                moment={m}
                delay={i}
                onClick={onOpen}
                onUpdateStatus={onUpdateStatus}
                onDelete={onDelete}
              />
            ))}
          </div>
        </>
      )}

      {/* 首次使用提示 */}
      {moments.length === 0 && (
        <div
          className="text-sm leading-relaxed opacity-70 p-5 fade-up-2 mt-4"
          style={{
            backgroundColor: "rgba(45, 90, 61, 0.04)",
            borderLeft: "2px solid rgba(45, 90, 61, 0.3)",
          }}
        >
          <div className="serif italic mb-2" style={{ color: "#2D5A3D" }}>
            开始使用
          </div>
          <div>
            每当 {kid.name} 做错一道题、问你回答不上的问题、或某个概念表现出困惑，
            就点上面的"记录一个时刻"按下来。可以拍照，不用手打。
            <br />
            <br />
            AI 会帮你想想 ta 可能卡在哪里，给你三个引导问题，再给几道变式练习。
            <br />
            <br />
            建议先去『画像』里填一下 ta 最近学到哪里、哪里比较弱，AI 会更懂。
          </div>
        </div>
      )}

      {/* 切换孩子 */}
      <div
        className="mt-12 pt-8 fade-up-5"
        style={{ borderTop: "1px solid rgba(31, 27, 22, 0.1)" }}
      >
        <div className="text-xs opacity-50 mb-3 serif italic">还陪着的孩子们</div>
        <div className="flex gap-2 flex-wrap">
          {kids.map((k) => (
            <button
              key={k.id}
              onClick={() => onSwitchKid(k.id)}
              className="px-3 py-1.5 text-xs rounded-full transition-all hover:bg-black/5"
              style={{
                border: "1px solid rgba(31, 27, 22, 0.15)",
                backgroundColor:
                  k.id === kid.id ? "rgba(45, 90, 61, 0.08)" : "transparent",
                fontWeight: k.id === kid.id ? 600 : 400,
              }}
            >
              {k.avatar} {k.name} · {k.grade}
            </button>
          ))}
          <button
            onClick={() => setShowAddKid(!showAddKid)}
            className="px-3 py-1.5 text-xs rounded-full transition-all hover:bg-black/5"
            style={{ border: "1px dashed rgba(31, 27, 22, 0.2)" }}
          >
            + 添加
          </button>
        </div>

        {showAddKid && (
          <div
            className="mt-4 p-4"
            style={{
              backgroundColor: "rgba(255, 255, 255, 0.5)",
              border: "1px solid rgba(31, 27, 22, 0.12)",
              borderRadius: "4px",
            }}
          >
            <div className="text-xs opacity-50 mb-3 serif italic">添加孩子</div>
            <input
              type="text"
              placeholder="名字或昵称"
              value={newKid.name}
              onChange={(e) => setNewKid({ ...newKid, name: e.target.value })}
              className="w-full px-3 py-2 mb-2 bg-transparent text-sm focus:outline-none"
              style={{
                border: "1px solid rgba(31, 27, 22, 0.15)",
                borderRadius: "2px",
              }}
            />
            <select
              value={newKid.grade}
              onChange={(e) => setNewKid({ ...newKid, grade: e.target.value })}
              className="w-full px-3 py-2 mb-3 bg-transparent text-sm focus:outline-none"
              style={{
                border: "1px solid rgba(31, 27, 22, 0.15)",
                borderRadius: "2px",
              }}
            >
              {[
                "幼儿园",
                "一年级",
                "二年级",
                "三年级",
                "四年级",
                "五年级",
                "六年级",
                "初一",
                "初二",
                "初三",
              ].map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>
            <button
              disabled={!newKid.name.trim()}
              onClick={() => {
                onAddKid(newKid.name.trim(), newKid.grade);
                setNewKid({ name: "", grade: "一年级" });
                setShowAddKid(false);
              }}
              className="text-sm opacity-80 hover:opacity-100 disabled:opacity-30"
            >
              添加 →
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
// ============================================================
// 时刻卡片
// ============================================================
// ============================================================
// MemoryBadge：单题的记忆指标徽标（给 MomentCard 用）
// ============================================================
// 显示三档信息：
//   · 记忆 X% （颜色随保留率变化，红黄绿三档）
//   · 间隔 N 天
//   · "再 N 天复" / "已逾期 N 天" / "今天该复"
// hover 显示完整公式说明
// 已记录（没分析过）的不显示，避免误导
function MemoryBadge({ moment }) {
  if (moment.status === "已记录" || !moment.analysis) return null;
  const stats = calcMemoryStats(moment);
  const { interval, retention, dueDays, level } = stats;

  const colors = {
    overdue: "#8B4513",
    due: "#B7791F",
    fresh: "#2D5A3D",
  };
  const color = colors[level];

  const dueText =
    moment.status === "需复习"
      ? "等待复盘"
      : dueDays <= -0.5
      ? `逾期 ${Math.round(-dueDays)}天`
      : dueDays <= 0.5
      ? "今天该复"
      : `${Math.ceil(dueDays)}天后复`;

  const tooltipText =
    `记忆模型（艾宾浩斯曲线 R(t)=exp(-t/S)）` +
    `\n· 当前间隔 S = ${interval} 天` +
    `\n· 距上次 t = ${stats.ageDays.toFixed(1)} 天` +
    `\n· 预估保留率 R = ${Math.round(retention * 100)}%` +
    `\n答对一次间隔翻倍，最长 90 天；答错重置为 1 天。`;

  return (
    <div
      className="flex items-center gap-2 mt-2 pt-2 text-[10px]"
      style={{
        borderTop: "1px dashed rgba(31, 27, 22, 0.08)",
        color,
      }}
      title={tooltipText}
    >
      {/* 记忆保留率条 + 数字 */}
      <div className="flex items-center gap-1.5">
        <div
          className="relative overflow-hidden"
          style={{
            width: 40,
            height: 4,
            backgroundColor: "rgba(31, 27, 22, 0.08)",
            borderRadius: 2,
          }}
        >
          <div
            className="absolute left-0 top-0 h-full"
            style={{
              width: `${Math.max(2, Math.round(retention * 100))}%`,
              backgroundColor: color,
              transition: "width 0.4s ease",
            }}
          />
        </div>
        <span className="font-semibold tabular-nums">
          记忆 {Math.round(retention * 100)}%
        </span>
      </div>

      <span className="opacity-30">·</span>
      <span className="opacity-70 tabular-nums">间隔 {interval}天</span>
      <span className="opacity-30">·</span>
      <span className="opacity-70 tabular-nums">{dueText}</span>
    </div>
  );
}

// React.memo 让 MomentCard 只在 props 变化时重渲染。
// 时间线分批加载时，已经渲染的旧卡片 props 没变就不会重新走整套渲染流程，
// 200 条题里追加 50 条只会渲染新增的 50 条，旧的 200 个 React 树原地不动。
//
// 关键：父组件务必传"稳定引用"的 onClick/onDelete（用 useCallback 包），
// 否则每次父组件 setState（比如改搜索框）都会让所有卡片的 onClick 是新函数引用，
// memo 比对失败 → 全部重渲染 → memo 等于白做。
// 所以这里 onClick 接收 (moment) 而不是已经柯里化好的回调，
// 让父组件不用为每张卡现做箭头函数。
const MomentCard = memo(function MomentCardImpl({ moment, delay = 0, onClick, onUpdateStatus, onDelete }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    const close = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target))
        setMenuOpen(false);
    };
    if (menuOpen) document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [menuOpen]);

  const tagColor = {
    误区: "#8B4513",
    计算: "#4A5568",
    好问题: "#2D5A3D",
    习惯: "#B7791F",
    概念: "#6D28D9",
    拼音: "#0F766E",
    识字: "#B45309",
    写字: "#7C2D12",
    表达: "#4338CA",
    理解: "#9333EA",
    新: "#2D5A3D",
  };
  const statusStyle = {
    待复盘: { bg: "rgba(183, 121, 31, 0.1)", color: "#B7791F", label: "· 待复盘" },
    进行中: { bg: "rgba(183, 121, 31, 0.1)", color: "#B7791F", label: "· 进行中" },
    已理解: { bg: "rgba(45, 90, 61, 0.1)", color: "#2D5A3D", label: "✓ 已理解" },
    需复习: { bg: "rgba(139, 69, 19, 0.1)", color: "#8B4513", label: "↻ 需复习" },
    已记录: { bg: "rgba(45, 90, 61, 0.1)", color: "#2D5A3D", label: "· 已记录" },
    // v4.9: 反复错时家长主动暂搁的题。木色调呼应讲解卡屏；
    //       不参与自动调度（pickReviewCandidates 已过滤），但首页可见、可手动激活
    暂搁: { bg: "rgba(160, 82, 45, 0.1)", color: "#A0522D", label: "☕ 暂搁" },
  };
  const s = statusStyle[moment.status] || statusStyle["已记录"];
  const title =
    moment.analysis?.misconception?.title || moment.problem.slice(0, 30);
  // v4.6: 入场动画只给前 12 张，避免一屏内同时跑 50 个动画在低端机上抖动。
  // 后续分批加载进来的卡片直接静态出现，体验差异基本看不出来。
  const delayClass = delay < 12 ? `fade-up-${Math.min(delay + 2, 5)}` : "";

  return (
    <div
      className={`group p-4 transition-all hover:translate-x-1 relative ${delayClass}`}
      style={{
        backgroundColor: "rgba(255, 255, 255, 0.4)",
        borderLeft: `2px solid ${tagColor[moment.tag] || "#2D5A3D"}`,
        borderRadius: "0 4px 4px 0",
      }}
    >
      <div onClick={() => onClick(moment)} className="cursor-pointer">
        <div className="flex items-start justify-between mb-1.5 pr-8">
          <div className="flex items-center gap-2 flex-wrap">
            {moment.subject && (
              <span
                className="text-[9px] px-1.5 py-0.5 rounded-sm font-semibold tracking-wider"
                style={{
                  backgroundColor:
                    moment.subject === "语文"
                      ? "rgba(15, 118, 110, 0.1)"
                      : "rgba(45, 90, 61, 0.1)",
                  color:
                    moment.subject === "语文" ? "#0F766E" : "#2D5A3D",
                }}
              >
                {moment.subject}
              </span>
            )}
            <span
              className="text-[10px] uppercase tracking-wider font-semibold"
              style={{ color: tagColor[moment.tag] || "#2D5A3D" }}
            >
              {moment.tag}
            </span>
            {/* v4.6: 看图题用相机图标标识 */}
            {moment.hasImage && (
              <span
                className="opacity-50"
                title="包含题目图片"
                style={{ color: "#2D5A3D" }}
              >
                <ImageIcon size={11} strokeWidth={1.5} />
              </span>
            )}
            <span className="text-[11px] opacity-50">
              · {formatRelative(moment.createdAt)}
              {moment.created_by && (
                <span className="ml-1 opacity-80">· {moment.created_by}记</span>
              )}
            </span>
          </div>
          <span
            className="text-[11px] px-1.5 py-0.5 rounded-full whitespace-nowrap shrink-0"
            style={{ backgroundColor: s.bg, color: s.color }}
          >
            {s.label}
          </span>
        </div>
        <div className="serif text-base mb-1" style={{ fontWeight: 500 }}>
          {title}
        </div>
        <div className="text-xs opacity-60 italic line-clamp-2">
          {moment.problem}
        </div>
        {/* 记忆指标条（已记录/未分析的题不显示） */}
        <MemoryBadge moment={moment} />
      </div>

      {/* 更多菜单 */}
      <div className="absolute top-3 right-3" ref={menuRef}>
        <button
          onClick={(e) => {
            e.stopPropagation();
            setMenuOpen(!menuOpen);
          }}
          className="opacity-30 hover:opacity-70 p-1"
          aria-label="更多"
        >
          <MoreHorizontal size={14} />
        </button>
        {menuOpen && (
          <div
            className="absolute right-0 top-7 z-10 py-1 min-w-[140px]"
            style={{
              backgroundColor: "#FFFBF1",
              border: "1px solid rgba(31, 27, 22, 0.2)",
              borderRadius: "3px",
              boxShadow: "3px 3px 0 rgba(31, 27, 22, 0.08)",
            }}
          >
            {["已理解", "需复习", "待复盘"]
              .filter((st) => st !== moment.status)
              .map((st) => (
                <button
                  key={st}
                  onClick={(e) => {
                    e.stopPropagation();
                    onUpdateStatus(moment.id, st);
                    setMenuOpen(false);
                  }}
                  className="block w-full text-left px-3 py-1.5 text-xs hover:bg-black/5"
                >
                  标记为 {st}
                </button>
              ))}
            <div
              className="border-t my-1"
              style={{ borderColor: "rgba(31, 27, 22, 0.1)" }}
            />
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDelete(moment.id);
                setMenuOpen(false);
              }}
              className="block w-full text-left px-3 py-1.5 text-xs hover:bg-red-50 text-red-700"
            >
              删除
            </button>
          </div>
        )}
      </div>
    </div>
  );
});

// ============================================================
// 新时刻 / 编辑
// ============================================================
function NewMomentScreen({ form, setForm, onSubmit, onSave, savingButton, kid, isEditing }) {
  const isChinese = form.subject === "语文";
  return (
    <div className="fade-up">
      <div className="mb-8">
        <div className="text-xs opacity-50 mb-2 serif italic">
          {isEditing ? `编辑 ${kid.name} 的一条记录` : `为 ${kid.name} 记一笔`}
        </div>
        <h1 className="serif text-3xl mb-2" style={{ fontWeight: 400 }}>
          {isEditing ? "修改这个时刻" : "刚刚发生了什么？"}
        </h1>
        <p className="text-sm opacity-60 leading-relaxed">
          一道错题、一句没想通、一个你回答不上的好问题，都值得记下来。
          <br />
          我会帮你想想怎么和 ta 聊这件事。
        </p>
      </div>

      {/* 科目切换 */}
      <div className="mb-4 flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-wider opacity-40 font-semibold mr-2">
          学科
        </span>
        {["数学", "语文"].map((s) => (
          <button
            key={s}
            onClick={() => setForm((f) => ({ ...f, subject: s }))}
            className="px-4 py-1.5 text-sm transition-all"
            style={{
              backgroundColor: form.subject === s ? "#2D5A3D" : "transparent",
              color: form.subject === s ? "#F8F4EB" : "inherit",
              border: "1px solid rgba(31, 27, 22, 0.2)",
              borderRadius: "2px",
              fontWeight: form.subject === s ? 600 : 400,
            }}
          >
            {s}
          </button>
        ))}
      </div>

      {/* 拍照入口（v4.6 重构）
          · 没图时：显示拍照按钮（无论新建还是编辑都允许）
          · 有图时：显示缩略图 + 图描述 + 移除按钮 */}
      {form.imageData ? (
        <div
          className="mb-4 p-3"
          style={{
            backgroundColor: "rgba(45, 90, 61, 0.04)",
            border: "1px dashed rgba(45, 90, 61, 0.3)",
            borderRadius: "4px",
          }}
        >
          {/* 顶部信息栏：标题 + 移除按钮 */}
          <div className="flex items-start justify-between gap-3 mb-2">
            <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider opacity-50 font-semibold">
              <ImageIcon size={11} strokeWidth={1.5} />
              <span>题目图（已保存）</span>
            </div>
            <button
              onClick={() =>
                setForm((f) => ({ ...f, imageData: null, imageDescription: null }))
              }
              className="text-xs opacity-50 hover:opacity-90 inline-flex items-center gap-1 shrink-0"
              title="移除图片，会让 AI 失去看图能力"
            >
              <X size={11} strokeWidth={1.5} /> 移除
            </button>
          </div>

          {/* v4.8.2: 图描述可编辑。AI 识图后把"图里有什么"写在这里，
              如果识别有偏差（认错物体、漏掉关键元素），家长可以直接修改，
              后端 PATCH /moments 会自动清掉这道题的复习题缓存。 */}
          <div
            className="mb-3"
            style={{
              backgroundColor: "rgba(255, 255, 255, 0.6)",
              borderRadius: "3px",
              border: "1px solid rgba(31, 27, 22, 0.1)",
            }}
          >
            <div className="px-3 pt-2 text-[10px] uppercase tracking-wider opacity-40 font-semibold flex items-center justify-between">
              <span>AI 看到的图（可修改）</span>
              {!form.imageDescription && (
                <span className="lowercase opacity-70 normal-case">
                  没有描述时 AI 出题仅靠文字
                </span>
              )}
            </div>
            <textarea
              value={form.imageDescription || ""}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  imageDescription: e.target.value || null,
                }))
              }
              placeholder="例如：图中有 3 只蓝色的鱼和 2 只红色的鱼"
              rows={2}
              className="w-full px-3 pb-2 pt-1 bg-transparent focus:outline-none resize-none text-xs leading-relaxed"
              style={{ color: "#1F1B16" }}
            />
          </div>
          {/* 原比例显示图，让家长看清原图细节 */}
          <img
            src={form.imageData}
            alt="题目图"
            className="rounded block"
            style={{
              maxWidth: "100%",
              maxHeight: 480,
              width: "auto",
              height: "auto",
              border: "1px solid rgba(31, 27, 22, 0.1)",
              backgroundColor: "rgba(255, 255, 255, 0.5)",
            }}
          />
        </div>
      ) : (
        <PhotoCapture
          kid={kid}
          subject={form.subject}
          onRecognized={(result) => {
            setForm((f) => ({
              ...f,
              problem: result.recognized_problem || f.problem,
              context:
                [
                  result.kid_answer ? `孩子写的：${result.kid_answer}` : "",
                  result.correct_mark && result.correct_mark !== "未批改"
                    ? `批改：${result.correct_mark}`
                    : "",
                  result.observation || "",
                ]
                  .filter(Boolean)
                  .join("；") || f.context,
              // v4.6: 保存图片本体 + 图描述
              imageData: result.imageData || null,
              imageDescription: result.image_description || null,
            }));
          }}
        />
      )}

      {/* 语文提示 */}
      {isChinese && (
        <div
          className="text-xs leading-relaxed mb-4 p-3 opacity-80"
          style={{
            backgroundColor: "rgba(45, 90, 61, 0.05)",
            borderLeft: "2px solid rgba(45, 90, 61, 0.3)",
          }}
        >
          <span className="font-semibold" style={{ color: "#2D5A3D" }}>
            语文 AI 擅长什么：
          </span>{" "}
          拼音错误、识字混淆、写字笔顺/结构问题。
          <br />
          对看图说话、造句、阅读理解这类开放题，AI 会老实告诉你它帮不上太多，建议你先记下来，自己凭直觉引导。
        </div>
      )}

      <FieldTextarea
        label="题目或问题"
        value={form.problem}
        onChange={(v) => setForm((f) => ({ ...f, problem: v }))}
        placeholder={
          isChinese
            ? "例如：把'chī'写成了'cī' / 不认识'瓜'字 / '人'写成了'入'"
            : "例如：2/5 + 1/5 他写成了 3/10"
        }
        rows={3}
        large
      />

      <FieldTextarea
        label="你的观察（可选但很有用）"
        value={form.context}
        onChange={(v) => setForm((f) => ({ ...f, context: v }))}
        placeholder="ta 是怎么想的？做的时候表现怎样？你问过 ta 什么？"
        rows={3}
      />

      <div className="text-xs opacity-50 leading-relaxed mb-6 px-1">
        <MessageSquareQuote size={14} className="inline mr-1.5 opacity-70" />
        观察越具体，AI 越能帮你想到合适的引导方式。"ta 犹豫了一下" 或 "ta 写得很快没犹豫"
        都是宝贵的信息。
      </div>

      <div className="flex gap-3">
        <button
          onClick={onSubmit}
          disabled={!form.problem.trim() || !!savingButton}
          className="flex-1 py-4 transition-all disabled:opacity-40"
          style={{
            backgroundColor: "#1F1B16",
            color: "#F8F4EB",
            borderRadius: "2px",
            boxShadow: "3px 3px 0 rgba(45, 90, 61, 0.3)",
          }}
          onMouseEnter={(e) =>
            !e.currentTarget.disabled &&
            (e.currentTarget.style.transform = "translate(-1px, -1px)")
          }
          onMouseLeave={(e) => (e.currentTarget.style.transform = "translate(0, 0)")}
        >
          <span className="flex items-center justify-center gap-2 serif text-base">
            让 AI 帮我想想 <ChevronRight size={16} strokeWidth={1.5} />
          </span>
        </button>
        {form.problem.trim() && (
          <button
            onClick={onSave}
            disabled={!!savingButton}
            className="px-4 py-4 text-sm transition-opacity disabled:opacity-40 disabled:cursor-wait"
            style={{
              opacity: savingButton ? undefined : 0.6,
            }}
            title="不分析，直接记录"
          >
            {savingButton === "draft" ? (
              <span className="inline-flex items-center gap-1.5">
                <Loader2 size={12} className="animate-spin" strokeWidth={1.5} />
                保存中…
              </span>
            ) : (
              "先记下"
            )}
          </button>
        )}
      </div>
    </div>
  );
}

// ============================================================
// 拍照识图组件（含裁切/框选交互）
// ============================================================
function PhotoCapture({ kid, subject, onRecognized }) {
  // idle | cropping | loading | done | error
  const [status, setStatus] = useState("idle");
  const [rawImage, setRawImage] = useState(null); // 压缩后但未裁切的原图 dataUrl
  const [preview, setPreview] = useState(null); // 最终送识别的图（可能是裁切后）
  const [error, setError] = useState(null);
  const [recognized, setRecognized] = useState(null);
  const fileInputRef = useRef(null);

  const handleFile = async (file) => {
    if (!file) return;
    setError(null);
    setRecognized(null);
    try {
      const dataUrl = await compressImage(file, 1400, 0.72);
      setRawImage(dataUrl);
      setStatus("cropping");
    } catch (e) {
      console.error(e);
      setError(e.message || "读取照片失败");
      setStatus("error");
    }
  };

  // 从裁切组件拿到最终图（可能裁过，也可能是原图）
  const handleCropConfirm = async (finalDataUrl) => {
    setPreview(finalDataUrl);
    setStatus("loading");
    try {
      const result = await visionRecognize({
        imageBase64: finalDataUrl,
        subject,
        kidGrade: kid.grade,
      });
      setRecognized(result);
      setStatus("done");
    } catch (e) {
      console.error(e);
      let msg = e.message || "识图失败";
      if (e.code === "quota_exceeded") {
        const d = e.detail || {};
        msg = `今日 AI 额度已用完（${d.current || ""}/${d.quota || ""}），明天再拍吧`;
      } else if (e.code === "rate_limited") {
        msg = "请求太快，稍等一下再拍";
      }
      setError(msg);
      setStatus("error");
    }
  };

  const confirmAndFill = () => {
    if (recognized) {
      // v4.6: 把识别结果 + 压缩后的 dataURL（preview）+ 图描述 一起回传
      // 这样父组件可以把图存起来供后续展示和保存
      onRecognized({
        ...recognized,
        imageData: preview, // 压缩后的 base64 dataURL
      });
    }
    reset();
  };

  const reset = () => {
    setStatus("idle");
    setRawImage(null);
    setPreview(null);
    setRecognized(null);
    setError(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  return (
    <div
      className="mb-4 p-3"
      style={{
        backgroundColor: "rgba(45, 90, 61, 0.04)",
        border: "1px dashed rgba(45, 90, 61, 0.3)",
        borderRadius: "4px",
      }}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(e) => handleFile(e.target.files?.[0])}
      />

      {status === "idle" && (
        <button
          onClick={() => fileInputRef.current?.click()}
          className="w-full flex items-center justify-center gap-2 py-2 text-sm"
          style={{ color: "#2D5A3D" }}
        >
          <Camera size={16} strokeWidth={1.5} />
          <span className="serif">拍一张题目的照片，AI 帮你识别</span>
        </button>
      )}

      {status === "cropping" && rawImage && (
        <ImageCropper
          src={rawImage}
          onConfirm={handleCropConfirm}
          onCancel={reset}
        />
      )}

      {status === "loading" && (
        <div className="py-6 text-center">
          {preview && (
            <img
              src={preview}
              alt="题目"
              className="max-h-40 mx-auto mb-3 rounded"
              style={{ border: "1px solid rgba(31, 27, 22, 0.1)" }}
            />
          )}
          <div className="inline-flex items-center gap-2 text-sm opacity-70">
            <Loader2 size={14} className="animate-spin" />
            <span className="serif italic">正在看题…</span>
          </div>
        </div>
      )}

      {status === "error" && (
        <div className="py-3 text-center">
          <div className="text-xs text-red-700 mb-2">{error}</div>
          <div className="flex gap-2 justify-center">
            {rawImage && (
              <button
                onClick={() => setStatus("cropping")}
                className="text-xs opacity-70 hover:opacity-100 underline"
              >
                重新框选
              </button>
            )}
            <button
              onClick={reset}
              className="text-xs opacity-70 hover:opacity-100 underline"
            >
              换一张
            </button>
          </div>
        </div>
      )}

      {status === "done" && recognized && (
        <div className="space-y-2">
          {preview && (
            <img
              src={preview}
              alt="题目"
              className="max-h-40 mx-auto rounded block"
              style={{ border: "1px solid rgba(31, 27, 22, 0.1)" }}
            />
          )}
          <div className="text-[10px] uppercase tracking-wider opacity-50 font-semibold mt-3">
            AI 看到的
          </div>
          <div
            className="text-sm p-2 leading-relaxed"
            style={{ backgroundColor: "rgba(255, 255, 255, 0.6)", borderRadius: "2px" }}
          >
            <div className="serif">{recognized.recognized_problem}</div>
            {(recognized.kid_answer ||
              (recognized.correct_mark && recognized.correct_mark !== "未批改")) && (
              <div className="text-xs opacity-70 mt-2 italic">
                {recognized.kid_answer && (
                  <>孩子写的：{recognized.kid_answer} </>
                )}
                {recognized.correct_mark !== "未批改" && <>· {recognized.correct_mark}</>}
              </div>
            )}
            {/* v4.6: 图描述。给家长一个透明度——AI 看懂图了没？
                这段描述会一并存进数据库，让后续没有视觉的文本模型也能用。 */}
            {recognized.image_description && (
              <div
                className="text-xs mt-2 pt-2 leading-relaxed flex items-start gap-1.5"
                style={{ borderTop: "1px dashed rgba(31, 27, 22, 0.1)" }}
              >
                <ImageIcon
                  size={11}
                  strokeWidth={1.5}
                  className="shrink-0 mt-0.5 opacity-50"
                />
                <span className="opacity-70">
                  <span className="font-semibold opacity-80">图中：</span>
                  {recognized.image_description}
                </span>
              </div>
            )}
          </div>
          <div className="flex gap-2 mt-2 flex-wrap">
            <button
              onClick={confirmAndFill}
              className="flex-1 min-w-[140px] text-sm py-2"
              style={{
                backgroundColor: "#2D5A3D",
                color: "#F8F4EB",
                borderRadius: "2px",
              }}
            >
              用这个内容填到下面 →
            </button>
            {rawImage && (
              <button
                onClick={() => {
                  setRecognized(null);
                  setStatus("cropping");
                }}
                className="text-xs px-3 opacity-70 hover:opacity-100"
                title="不满意这次识别，回去重新框选"
              >
                重新框选
              </button>
            )}
            <button
              onClick={reset}
              className="text-xs px-3 opacity-70 hover:opacity-100"
            >
              重拍
            </button>
          </div>
          <div className="text-[11px] opacity-50 italic text-center mt-1">
            填入后你还可以改，AI 识别偶尔会看错字
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================
// 图片裁切器（Canvas 实现，支持鼠标+触控）
// ============================================================
function ImageCropper({ src, onConfirm, onCancel }) {
  const canvasRef = useRef(null);
  const containerRef = useRef(null);
  const imgRef = useRef(null); // 已加载的 Image 对象
  const [imgLoaded, setImgLoaded] = useState(false);

  // 选框坐标（相对于原图的像素坐标，不是 canvas 坐标）
  const [crop, setCrop] = useState(null); // { x, y, w, h } 或 null

  // 交互状态
  const dragState = useRef(null);
  // dragState = { mode: 'draw' | 'move' | 'resize-nw' | 'resize-ne' | ... ,
  //               startClientX, startClientY, startCrop }

  // canvas 展示尺寸（CSS 像素）
  const [displaySize, setDisplaySize] = useState({ w: 0, h: 0 });
  // scale = 原图像素 / canvas CSS 像素
  const scaleRef = useRef(1);

  // —— 初始化：加载图片，设置 canvas 尺寸 ——
  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      imgRef.current = img;
      setImgLoaded(true);
    };
    img.src = src;
  }, [src]);

  useEffect(() => {
    if (!imgLoaded || !containerRef.current) return;

    // Safari 首次 mount 时 clientWidth 可能为 0（layout 还没算完），
    // 等一帧再测量，或者测到 0 时重试。
    let raf;
    const measure = () => {
      const container = containerRef.current;
      if (!container) return;
      const containerW = container.clientWidth;
      if (containerW === 0) {
        // 还没布局好，下一帧再试
        raf = requestAnimationFrame(measure);
        return;
      }
      const img = imgRef.current;
      const maxH = Math.min(520, window.innerHeight * 0.6);
      const ratio = img.width / img.height;
      let w = containerW;
      let h = w / ratio;
      if (h > maxH) {
        h = maxH;
        w = h * ratio;
      }
      setDisplaySize({ w, h });
      scaleRef.current = img.width / w;
    };
    raf = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(raf);
  }, [imgLoaded]);

  // —— 绘制 ——
  useEffect(() => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img || !displaySize.w) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = displaySize.w * dpr;
    canvas.height = displaySize.h * dpr;
    canvas.style.width = displaySize.w + "px";
    canvas.style.height = displaySize.h + "px";
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // 底图
    ctx.drawImage(img, 0, 0, displaySize.w, displaySize.h);

    if (crop) {
      // 把原图坐标转成 canvas 坐标
      const s = scaleRef.current;
      const cx = crop.x / s;
      const cy = crop.y / s;
      const cw = crop.w / s;
      const ch = crop.h / s;

      // 半透明遮罩：整个图上覆盖，然后挖掉选区
      ctx.save();
      ctx.fillStyle = "rgba(31, 27, 22, 0.55)";
      ctx.beginPath();
      ctx.rect(0, 0, displaySize.w, displaySize.h);
      ctx.rect(cx + cw, cy, -cw, ch); // 反向绘制挖洞
      ctx.fill("evenodd");
      ctx.restore();

      // 选框边
      ctx.strokeStyle = "#F8F4EB";
      ctx.lineWidth = 2;
      ctx.strokeRect(cx, cy, cw, ch);
      ctx.strokeStyle = "#2D5A3D";
      ctx.lineWidth = 1;
      ctx.strokeRect(cx, cy, cw, ch);

      // 四角手柄
      const handleSize = 10;
      ctx.fillStyle = "#2D5A3D";
      const corners = [
        [cx, cy],
        [cx + cw, cy],
        [cx, cy + ch],
        [cx + cw, cy + ch],
      ];
      corners.forEach(([hx, hy]) => {
        ctx.fillRect(hx - handleSize / 2, hy - handleSize / 2, handleSize, handleSize);
      });
    }
  }, [crop, displaySize, imgLoaded]);

  // —— 坐标转换 ——
  const getCanvasPoint = (e) => {
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const touch = e.touches?.[0] || e.changedTouches?.[0];
    const clientX = touch ? touch.clientX : e.clientX;
    const clientY = touch ? touch.clientY : e.clientY;
    return {
      x: clientX - rect.left,
      y: clientY - rect.top,
    };
  };

  // 判断点在选框的哪个区域：null | 'inside' | 'nw' | 'ne' | 'sw' | 'se'
  const hitTest = (canvasX, canvasY) => {
    if (!crop) return null;
    const s = scaleRef.current;
    const cx = crop.x / s;
    const cy = crop.y / s;
    const cw = crop.w / s;
    const ch = crop.h / s;
    const tol = 16; // 手柄命中容差，手指触控要大一点

    const nearLeft = Math.abs(canvasX - cx) < tol;
    const nearRight = Math.abs(canvasX - (cx + cw)) < tol;
    const nearTop = Math.abs(canvasY - cy) < tol;
    const nearBottom = Math.abs(canvasY - (cy + ch)) < tol;

    if (nearLeft && nearTop) return "nw";
    if (nearRight && nearTop) return "ne";
    if (nearLeft && nearBottom) return "sw";
    if (nearRight && nearBottom) return "se";
    if (canvasX >= cx && canvasX <= cx + cw && canvasY >= cy && canvasY <= cy + ch)
      return "inside";
    return null;
  };

  // —— 交互：按下 ——
  const handlePointerDown = (e) => {
    e.preventDefault();
    const { x, y } = getCanvasPoint(e);
    const hit = hitTest(x, y);
    const s = scaleRef.current;

    if (hit === "inside") {
      // 拖动
      dragState.current = {
        mode: "move",
        startX: x,
        startY: y,
        startCrop: { ...crop },
      };
    } else if (hit && hit !== "inside") {
      // 缩放
      dragState.current = {
        mode: `resize-${hit}`,
        startX: x,
        startY: y,
        startCrop: { ...crop },
      };
    } else {
      // 新建框
      dragState.current = {
        mode: "draw",
        startX: x,
        startY: y,
      };
      setCrop({ x: x * s, y: y * s, w: 0, h: 0 });
    }
  };

  // —— 交互：移动 ——
  const handlePointerMove = (e) => {
    if (!dragState.current) return;
    e.preventDefault();
    const { x, y } = getCanvasPoint(e);
    const s = scaleRef.current;
    const img = imgRef.current;

    const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

    if (dragState.current.mode === "draw") {
      const sx = dragState.current.startX;
      const sy = dragState.current.startY;
      const nx = Math.min(sx, x) * s;
      const ny = Math.min(sy, y) * s;
      const nw = Math.abs(x - sx) * s;
      const nh = Math.abs(y - sy) * s;
      setCrop({
        x: clamp(nx, 0, img.width),
        y: clamp(ny, 0, img.height),
        w: clamp(nw, 0, img.width - nx),
        h: clamp(nh, 0, img.height - ny),
      });
    } else if (dragState.current.mode === "move") {
      const dx = (x - dragState.current.startX) * s;
      const dy = (y - dragState.current.startY) * s;
      const start = dragState.current.startCrop;
      const nx = clamp(start.x + dx, 0, img.width - start.w);
      const ny = clamp(start.y + dy, 0, img.height - start.h);
      setCrop({ x: nx, y: ny, w: start.w, h: start.h });
    } else if (dragState.current.mode.startsWith("resize-")) {
      const corner = dragState.current.mode.slice(7);
      const dx = (x - dragState.current.startX) * s;
      const dy = (y - dragState.current.startY) * s;
      const start = dragState.current.startCrop;
      let nx = start.x, ny = start.y, nw = start.w, nh = start.h;

      if (corner.includes("w")) {
        const moveX = clamp(dx, -start.x, start.w - 20);
        nx = start.x + moveX;
        nw = start.w - moveX;
      }
      if (corner.includes("e")) {
        nw = clamp(start.w + dx, 20, img.width - start.x);
      }
      if (corner.includes("n")) {
        const moveY = clamp(dy, -start.y, start.h - 20);
        ny = start.y + moveY;
        nh = start.h - moveY;
      }
      if (corner.includes("s")) {
        nh = clamp(start.h + dy, 20, img.height - start.y);
      }
      setCrop({ x: nx, y: ny, w: nw, h: nh });
    }
  };

  // —— 交互：抬起 ——
  const handlePointerUp = () => {
    if (dragState.current?.mode === "draw") {
      // 选框太小（误触），清除
      setCrop((c) => {
        if (!c) return null;
        if (c.w < 30 || c.h < 30) return null;
        return c;
      });
    }
    dragState.current = null;
  };

  // —— 输出裁切后的图 ——
  const produceCroppedImage = () => {
    const img = imgRef.current;
    if (!crop || crop.w < 10 || crop.h < 10) return src; // 无框就返回全图
    const out = document.createElement("canvas");
    out.width = Math.round(crop.w);
    out.height = Math.round(crop.h);
    const ctx = out.getContext("2d");
    ctx.drawImage(
      img,
      crop.x, crop.y, crop.w, crop.h,
      0, 0, crop.w, crop.h
    );
    return out.toDataURL("image/jpeg", 0.85);
  };

  return (
    <div ref={containerRef}>
      <div className="mb-2 text-center">
        <div
          className="text-[11px] font-semibold mb-0.5"
          style={{ color: "#2D5A3D" }}
        >
          {crop ? "框已选好。可以拖动或拉四角微调。" : "只分析某一道题？在图上拖出一个框"}
        </div>
        <div className="text-[10px] opacity-50 italic">
          {crop ? "不满意就重新拖一个新框" : "不框也可以，整张图会送给 AI"}
        </div>
      </div>

      <div
        className="mx-auto block"
        style={{ width: displaySize.w || "auto", lineHeight: 0 }}
      >
        {imgLoaded ? (
          <canvas
            ref={canvasRef}
            style={{
              touchAction: "none",
              cursor: crop ? "move" : "crosshair",
              borderRadius: "2px",
              display: "block",
            }}
            onMouseDown={handlePointerDown}
            onMouseMove={handlePointerMove}
            onMouseUp={handlePointerUp}
            onMouseLeave={handlePointerUp}
            onTouchStart={handlePointerDown}
            onTouchMove={handlePointerMove}
            onTouchEnd={handlePointerUp}
          />
        ) : (
          <div className="py-8 text-center text-xs opacity-50 serif italic">
            加载中…
          </div>
        )}
      </div>

      <div className="flex gap-2 mt-3 flex-wrap">
        <button
          onClick={() => onConfirm(produceCroppedImage())}
          disabled={!imgLoaded}
          className="flex-1 min-w-[140px] text-sm py-2.5 disabled:opacity-40"
          style={{
            backgroundColor: "#2D5A3D",
            color: "#F8F4EB",
            borderRadius: "2px",
          }}
        >
          {crop && crop.w > 10 ? "用框里的内容识别 →" : "识别整张图 →"}
        </button>
        {crop && (
          <button
            onClick={() => setCrop(null)}
            className="text-xs px-3 opacity-70 hover:opacity-100"
            title="清除选框，改用整张图"
          >
            清除选框
          </button>
        )}
        <button
          onClick={onCancel}
          className="text-xs px-3 opacity-70 hover:opacity-100"
        >
          换一张
        </button>
      </div>
    </div>
  );
}

function FieldTextarea({ label, value, onChange, placeholder, rows = 3, large = false }) {
  return (
    <div
      className="mb-4 relative"
      style={{
        backgroundColor: "rgba(255, 255, 255, 0.5)",
        borderRadius: "4px",
        border: "1px solid rgba(31, 27, 22, 0.12)",
      }}
    >
      <div className="absolute top-3 left-4 text-[10px] uppercase tracking-wider opacity-40 font-semibold">
        {label}
      </div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={rows}
        className={`w-full px-4 pt-9 pb-4 bg-transparent focus:outline-none resize-none ${
          large ? "serif text-lg" : "text-sm leading-relaxed"
        }`}
        style={{ color: "#1F1B16" }}
      />
    </div>
  );
}

// ============================================================
// AI 分析结果
// ============================================================
function CopilotScreen({
  form,
  result,
  loading,
  reasoning = "",          // v4.3: 流式思考过程
  streamingContent = "",   // v4.3: 流式答案累积
  error,
  reflection,
  setReflection,
  onReanalyze,
  onSave,
  savingButton, // v5.0: 哪个保存按钮正在转 spinner（null = 没在保存）
  onDelete,
  isEditing,
  momentId, // v4.8: 编辑现有 moment 时传 id，让"复习记录"组件能去取历史
  currentStatus, // v4.9: 当前 moment 的 status，"暂搁"时显示激活按钮
}) {
  const reasoningScrollRef = useStickyBottom([reasoning]);

  if (loading) {
    // 状态文案：根据当前进展给用户一个明确的"AI 在干嘛"
    const phaseText = streamingContent
      ? "正在写答案…"
      : reasoning
      ? "正在思考…"
      : "已发送，等待 AI 响应…";

    return (
      <div className="fade-up py-10">
        <div className="text-center mb-6">
          <div className="inline-flex items-center gap-3 opacity-60">
            <Loader2 size={18} className="animate-spin" strokeWidth={1.5} />
            <span className="serif italic text-base">{phaseText}</span>
          </div>
        </div>

        {/* 思考过程：默认折叠，但答案还没开始写时自动展开，让用户看到东西在动 */}
        {reasoning && (
          <details
            className="max-w-md mx-auto mb-4"
            open={!streamingContent}
          >
            <summary className="text-xs opacity-50 cursor-pointer mb-2 select-none px-1">
              💭 AI 的思考过程（{reasoning.length} 字，点击折叠/展开）
            </summary>
            <div
              ref={reasoningScrollRef}
              className="text-xs opacity-70 leading-relaxed p-3 max-h-[60vh] overflow-y-auto whitespace-pre-wrap"
              style={{
                backgroundColor: "rgba(31, 27, 22, 0.04)",
                borderLeft: "2px solid rgba(31, 27, 22, 0.15)",
                fontFamily:
                  "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                wordBreak: "break-word",
              }}
            >
              {reasoning}
            </div>
          </details>
        )}

        {/* 答案预览：流式 JSON 没法边收边渲染，只显示"已收到 N 字" */}
        {streamingContent && (
          <div className="max-w-md mx-auto mb-4 text-xs opacity-50 leading-relaxed text-center">
            已收到答案 {streamingContent.length} 字，正在等模型写完…
          </div>
        )}

        {/* 还没收到任何东西时的引导文案（保留原版） */}
        {!reasoning && !streamingContent && (
          <div className="mt-8 max-w-xs mx-auto text-xs opacity-50 leading-relaxed text-center">
            每一次困惑都值得认真对待。
            <br />
            让我看看 ta 可能卡在哪里。
          </div>
        )}
      </div>
    );
  }

  if (error) {
    return (
      <div className="fade-up py-10">
        <div className="text-center mb-6">
          <div className="text-sm opacity-70 mb-2 serif italic">
            AI 这次没想通
          </div>
          <div
            className="text-xs opacity-60 leading-relaxed p-3 max-w-md mx-auto text-left"
            style={{
              backgroundColor: "rgba(139, 69, 19, 0.06)",
              borderLeft: "2px solid rgba(139, 69, 19, 0.3)",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {error}
          </div>
          <div className="text-[11px] opacity-40 mt-3 leading-relaxed">
            多数时候是模型一时抽风，重试就好。
          </div>
        </div>
        <div className="text-center">
          <button
            onClick={onReanalyze}
            className="text-sm opacity-80 hover:opacity-100 inline-flex items-center gap-1.5 px-4 py-2"
            style={{
              border: "1px solid rgba(31, 27, 22, 0.2)",
              borderRadius: "2px",
            }}
          >
            <RefreshCw size={14} /> 再试一次
          </button>
        </div>
      </div>
    );
  }

  if (!result) return null;

  return (
    <div className="space-y-8">
      <div
        className="fade-up-1 pb-6"
        style={{ borderBottom: "1px dashed rgba(31, 27, 22, 0.15)" }}
      >
        {/* 顶部：标题 + 重新想按钮 */}
        <div className="flex items-center justify-between mb-2">
          <div className="text-[10px] uppercase tracking-wider opacity-40 font-semibold">
            你记下的
          </div>
          <button
            onClick={onReanalyze}
            disabled={!!savingButton}
            className="text-xs opacity-50 hover:opacity-100 flex items-center gap-1 shrink-0 disabled:opacity-30 disabled:cursor-not-allowed"
            title="让 AI 重新分析"
          >
            <RefreshCw size={12} /> 重新想
          </button>
        </div>

        {/* 题目：占满宽度 */}
        <div className="serif text-xl mb-3 leading-relaxed" style={{ fontWeight: 500 }}>
          {form.problem}
        </div>

        {/* v4.6: 题目图。放题目下面，按原始比例显示，居中限宽，让家长能看清图。
           没图但有描述（异步加载中或老数据）时，回退到文字描述 */}
        {form.imageData ? (
          <div className="mb-3">
            <img
              src={form.imageData}
              alt="题目图"
              className="rounded block"
              style={{
                maxWidth: "100%",
                maxHeight: 480,
                width: "auto",
                height: "auto",
                border: "1px solid rgba(31, 27, 22, 0.1)",
                backgroundColor: "rgba(255, 255, 255, 0.5)",
              }}
            />
          </div>
        ) : (
          form.imageDescription && (
            <div className="text-xs opacity-60 mb-3 leading-relaxed flex items-start gap-1.5 italic">
              <ImageIcon
                size={11}
                strokeWidth={1.5}
                className="shrink-0 mt-0.5 opacity-70"
              />
              <span>图中：{form.imageDescription}</span>
            </div>
          )
        )}

        {/* 家长补充观察 */}
        {form.context && (
          <div className="text-sm opacity-60 italic leading-relaxed">
            "{form.context}"
          </div>
        )}
      </div>

      <Section
        number="01"
        label="我的判断"
        title="ta 可能卡在哪里"
        delayClass="fade-up-1"
      >
        <div className="mb-4">
          <div className="flex items-center gap-2 mb-2 flex-wrap">
            <div
              className="serif text-xl"
              style={{ fontWeight: 600, color: "#2D5A3D" }}
            >
              <span className="ink-underline">{result.misconception.title}</span>
            </div>
            <ConfidenceBadge level={result.misconception.confidence} />
          </div>
          <p className="text-sm leading-relaxed opacity-80">
            {result.misconception.explanation}
          </p>
        </div>
        {result.misconception.alternatives && (
          <div
            className="text-xs p-3 leading-relaxed"
            style={{
              backgroundColor: "rgba(139, 69, 19, 0.06)",
              borderLeft: "2px solid rgba(139, 69, 19, 0.3)",
              borderRadius: "0 2px 2px 0",
            }}
          >
            <span className="font-semibold opacity-70">但也可能是 —— </span>
            <span className="opacity-80">{result.misconception.alternatives}</span>
          </div>
        )}
      </Section>

      <Section
        number="02"
        label="可以这样问 ta"
        title="三个问题，让 ta 自己想通"
        delayClass="fade-up-2"
        badge={
          <span
            className="text-[10px] italic opacity-50 cursor-help"
            title="苏格拉底式提问（Socratic questioning）：通过环环相扣的发问引导对方自己得出结论，而非直接告知答案。源自古希腊哲学家苏格拉底的对话教学法。"
          >
            · 苏格拉底式
          </span>
        }
      >
        <div className="space-y-3">
          {result.socratic_questions?.map((q, i) => (
            <div key={i} className="flex gap-3 items-start">
              <div
                className="serif italic shrink-0 pt-0.5"
                style={{ color: "#2D5A3D", fontSize: "14px", minWidth: "48px" }}
              >
                {["第一问", "第二问", "第三问"][i]}
              </div>
              <div className="serif text-base leading-relaxed" style={{ fontWeight: 400 }}>
                "{q}"
              </div>
            </div>
          ))}
        </div>
        <div className="text-xs opacity-50 mt-4 italic leading-relaxed">
          关键不是 ta 答得对不对，而是让 ta 自己说出想法——这样你才能看见 ta 脑子里真实的样子。
        </div>
      </Section>

      <Section
        number="03"
        label="如果问不通"
        title={`换一种方式让 ta "感受" 到`}
        delayClass="fade-up-3"
        icon={<Eye size={14} strokeWidth={1.5} />}
      >
        <div className="text-sm leading-relaxed">{result.visual_approach}</div>
        {/* v4.6: 直观方式可附带 SVG */}
        {result.visual_approach_svg && (
          <div
            className="mt-3 p-3"
            style={{
              backgroundColor: "rgba(255, 255, 255, 0.6)",
              border: "1px solid rgba(31, 27, 22, 0.08)",
              borderRadius: "2px",
            }}
          >
            <SafeSvg raw={result.visual_approach_svg} />
          </div>
        )}
      </Section>

      <Section
        number="04"
        label="检验真懂"
        title={`等 ta 说 "懂了" 的时候`}
        delayClass="fade-up-4"
        icon={<Target size={14} strokeWidth={1.5} />}
      >
        <div className="text-sm leading-relaxed opacity-80">
          {result.verify_understanding}
        </div>
      </Section>

      {/* 变式练习 */}
      {Array.isArray(result.variations) && result.variations.length > 0 && (
        <Section
          number="05"
          label="举一反三"
          title="让 ta 试试这几道"
          delayClass="fade-up-5"
          icon={<Sparkles size={14} strokeWidth={1.5} />}
        >
          <div className="space-y-3">
            {result.variations.map((v, i) => (
              <VariationCard key={i} variation={v} />
            ))}
          </div>
          <div className="text-xs opacity-50 mt-4 italic leading-relaxed">
            三个难度层次：同类巩固、变式迁移、向前延伸。能做出两个以上，基本就真懂了。
          </div>
        </Section>
      )}

      {result.look_ahead && (
        <Section
          number="06"
          label="往后看"
          title="这道坎过了之后"
          delayClass="fade-up-5"
          icon={<CornerDownRight size={14} strokeWidth={1.5} />}
        >
          <div className="text-sm leading-relaxed opacity-80">
            {result.look_ahead}
          </div>
        </Section>
      )}

      {/* v4.8 档 1: 复习记录。
          只在编辑现有 moment 时显示——新建中的题没有 id 也没历史。
          组件内部会判断"无历史则不渲染"，所以从不会出现空标题。 */}
      {isEditing && momentId && (
        <QuizHistorySection momentId={momentId} />
      )}

      {/* v4.9: 讲解历史（同样只在编辑既有 moment 时显示）
          组件内部会判断"无讲解卡则不渲染" —— 没触发过反复错的题不会看到此区块 */}
      {isEditing && momentId && (
        <ExplanationHistorySection momentId={momentId} />
      )}

      {/* 反思 + 保存 */}
      <div
        className="pt-6 fade-up-5"
        style={{ borderTop: "1px dashed rgba(31, 27, 22, 0.15)" }}
      >
        <div className="mb-4">
          <div className="text-[10px] uppercase tracking-wider opacity-40 mb-2 font-semibold">
            {isEditing ? "反思（可编辑）" : "等你辅导完，回来记一笔"}
          </div>
          <div className="serif text-xl mb-3" style={{ fontWeight: 500 }}>
            今天和 ta 聊完，发生了什么？
          </div>
          <textarea
            value={reflection}
            onChange={(e) => setReflection(e.target.value)}
            placeholder="ta 反应怎样？哪个问题戳中了 ta？哪里还卡着？&#10;几年后你会感激今天记下的每一笔。"
            rows={4}
            className="w-full p-4 bg-transparent focus:outline-none resize-none text-sm leading-relaxed"
            style={{
              backgroundColor: "rgba(255, 255, 255, 0.5)",
              border: "1px solid rgba(31, 27, 22, 0.12)",
              borderRadius: "4px",
            }}
          />
        </div>

        {/* v4.9: 暂搁状态提示。木色调呼应讲解卡屏，让家长清楚"这道题被主动暂搁了"。
            点击"重新加入复习"按钮 = 把 status 改成"需复习"且 wrongStreak 清零。
            注意：这里不动 lastWrongAt。如果 12h 还没过，pickReviewCandidates 还会
            过滤这道题，要再等一段时间才会真的进复习池——这是合理的。 */}
        {isEditing && currentStatus === "暂搁" && (
          <div
            className="mb-4 p-3 flex items-center justify-between gap-3"
            style={{
              backgroundColor: "rgba(160, 82, 45, 0.08)",
              border: "1px solid rgba(160, 82, 45, 0.2)",
              borderRadius: "3px",
            }}
          >
            <div className="flex items-start gap-2 flex-1 min-w-0">
              <Coffee
                size={14}
                strokeWidth={1.5}
                className="shrink-0 mt-0.5"
                style={{ color: "#A0522D" }}
              />
              <div className="text-xs leading-relaxed opacity-80">
                这道题暂时不会自动出现在复习里。
                <br />
                等学校再讲一遍这个章节，或者你觉得 ta 状态好的时候，再来激活它。
              </div>
            </div>
            <button
              onClick={() => onSave({ asStatus: "需复习" }, "reactivate")}
              disabled={!!savingButton}
              className="text-xs px-3 py-1.5 shrink-0 transition-opacity hover:opacity-90 disabled:opacity-50 disabled:cursor-wait"
              style={{
                backgroundColor: "#A0522D",
                color: "#F8F4EB",
                borderRadius: "2px",
              }}
            >
              {savingButton === "reactivate" ? (
                <span className="inline-flex items-center gap-1">
                  <Loader2 size={11} className="animate-spin" strokeWidth={1.5} />
                  保存中…
                </span>
              ) : (
                "重新加入复习"
              )}
            </button>
          </div>
        )}

        <div className="flex flex-wrap gap-2 items-center">
          <button
            onClick={() => onSave({ asStatus: "已理解" }, "understood")}
            disabled={!!savingButton}
            className="px-4 py-2 text-sm flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-wait"
            style={{
              backgroundColor: "#2D5A3D",
              color: "#F8F4EB",
              borderRadius: "2px",
            }}
          >
            {savingButton === "understood" ? (
              <>
                <Loader2 size={14} className="animate-spin" strokeWidth={1.5} />
                保存中…
              </>
            ) : (
              <>
                <CheckCircle2 size={14} strokeWidth={2} /> 保存 · ta 已理解
              </>
            )}
          </button>
          <button
            onClick={() => onSave({ asStatus: "需复习" }, "needReview")}
            disabled={!!savingButton}
            className="px-4 py-2 text-sm disabled:opacity-40 disabled:cursor-wait"
            style={{
              backgroundColor: "rgba(139, 69, 19, 0.1)",
              color: "#8B4513",
              borderRadius: "2px",
            }}
          >
            {savingButton === "needReview" ? (
              <span className="inline-flex items-center gap-1.5">
                <Loader2 size={14} className="animate-spin" strokeWidth={1.5} />
                保存中…
              </span>
            ) : (
              "保存 · 还需复习"
            )}
          </button>
          <button
            onClick={() => onSave({ asStatus: "待复盘" }, "later")}
            disabled={!!savingButton}
            className="px-4 py-2 text-sm opacity-70 hover:opacity-100 disabled:opacity-40 disabled:cursor-wait"
          >
            {savingButton === "later" ? (
              <span className="inline-flex items-center gap-1.5">
                <Loader2 size={14} className="animate-spin" strokeWidth={1.5} />
                保存中…
              </span>
            ) : (
              "先存着，回头再复盘"
            )}
          </button>
          {isEditing && onDelete && (
            <button
              onClick={onDelete}
              disabled={!!savingButton}
              className="ml-auto text-xs text-red-700 opacity-70 hover:opacity-100 flex items-center gap-1 disabled:opacity-30"
            >
              <Trash2 size={12} /> 删除此条
            </button>
          )}
        </div>
      </div>

      {/* v4.5: 分析完成后，把思考过程作为可折叠区块保留在底部 */}
      {reasoning && reasoning.length > 0 && (
        <details className="fade-up">
          <summary className="text-xs opacity-40 cursor-pointer select-none py-2 px-1 hover:opacity-60 transition-opacity">
            💭 查看 AI 的思考过程（{reasoning.length} 字）
          </summary>
          <div
            className="mt-2 text-xs opacity-60 leading-relaxed p-3 max-h-[60vh] overflow-y-auto whitespace-pre-wrap"
            style={{
              backgroundColor: "rgba(31, 27, 22, 0.04)",
              borderLeft: "2px solid rgba(31, 27, 22, 0.15)",
              fontFamily:
                "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
              wordBreak: "break-word",
            }}
          >
            {reasoning}
          </div>
        </details>
      )}
    </div>
  );
}


function VariationCard({ variation }) {
  const [showAnswer, setShowAnswer] = useState(false);
  const levelColor = {
    同类: "#2D5A3D",
    变式: "#B7791F",
    延伸: "#6D28D9",
  };
  const c = levelColor[variation.level] || "#2D5A3D";

  return (
    <div
      className="p-3"
      style={{
        backgroundColor: "rgba(255, 255, 255, 0.6)",
        borderLeft: `2px solid ${c}`,
        borderRadius: "0 4px 4px 0",
      }}
    >
      <div
        className="text-[10px] uppercase tracking-wider font-semibold mb-1"
        style={{ color: c }}
      >
        {variation.level}
      </div>
      <div className="serif text-base leading-relaxed mb-2" style={{ fontWeight: 400 }}>
        {variation.prompt}
      </div>
      {/* v4.6: 看图变式题，AI 直接生成 SVG */}
      {variation.svg && (
        <div
          className="my-2 p-2"
          style={{
            backgroundColor: "rgba(255, 255, 255, 0.8)",
            border: "1px solid rgba(31, 27, 22, 0.08)",
            borderRadius: "2px",
          }}
        >
          <SafeSvg raw={variation.svg} />
        </div>
      )}
      <button
        onClick={() => setShowAnswer(!showAnswer)}
        className="text-[11px] opacity-50 hover:opacity-100 flex items-center gap-1"
      >
        <HelpCircle size={11} />
        {showAnswer ? "收起答案" : "看参考答案"}
      </button>
      {showAnswer && (
        <div
          className="text-xs mt-2 p-2 leading-relaxed"
          style={{
            backgroundColor: "rgba(45, 90, 61, 0.06)",
            borderRadius: "2px",
          }}
        >
          {variation.answer}
        </div>
      )}
    </div>
  );
}

// ============================================================
// QuizHistorySection（v4.8 档 1）
// ============================================================
// 时刻详情页底部的"复习记录"区块。
// 行为：
//   1) 进屏后异步拉历史（GET /api/quiz-history/:momentId）
//   2) 没历史 → 完全不渲染（避免出现空标题占位）
//   3) 有历史 → 默认折叠成一个标题行"复习记录(共 N 次)"
//      点击展开后显示每条记录：日期 + 结果 + 题面预览
//   4) 题面预览本身可点开看完整题面（避免长题撑爆列表）
// 设计原则：默认隐身、按需展开，不打扰主流程
// ============================================================
function QuizHistorySection({ momentId }) {
  const [history, setHistory] = useState(null); // null=未加载, []=空, [...]=有
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  // 每条记录是否展开看完整题面
  const [openIds, setOpenIds] = useState(() => new Set());

  useEffect(() => {
    if (!momentId) return;
    let alive = true;
    setLoading(true);
    api
      .listQuizHistory(momentId)
      .then((data) => {
        if (!alive) return;
        setHistory(Array.isArray(data) ? data : []);
      })
      .catch(() => {
        // 静默：拉历史失败就当没有历史，不打扰用户
        if (alive) setHistory([]);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [momentId]);

  // 没加载完 / 没历史 → 不渲染（保持 UI 干净）
  if (loading || !history || history.length === 0) return null;

  const total = history.length;
  // 统计：对/错/跳过 各几次
  const correctN = history.filter((h) => h.result === "correct").length;
  const wrongN = history.filter((h) => h.result === "wrong").length;
  const skippedN = history.filter((h) => h.result === "skipped").length;

  // 结果文案 + 颜色
  const resultStyle = {
    correct: { label: "✓ 对", color: "#2D5A3D", bg: "rgba(45, 90, 61, 0.08)" },
    wrong: { label: "✗ 错", color: "#8B4513", bg: "rgba(139, 69, 19, 0.08)" },
    skipped: { label: "– 跳过", color: "rgba(31, 27, 22, 0.5)", bg: "rgba(31, 27, 22, 0.04)" },
  };

  const fmtDate = (ts) => {
    const d = new Date(ts);
    const now = new Date();
    const isThisYear = d.getFullYear() === now.getFullYear();
    return isThisYear
      ? `${d.getMonth() + 1}月${d.getDate()}日`
      : `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
  };

  const toggleId = (id) => {
    setOpenIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="fade-up-5">
      <div className="flex items-baseline gap-3 mb-3">
        <span
          className="serif italic opacity-40 text-xs"
          style={{ letterSpacing: "0.05em" }}
        >
          07
        </span>
        <span className="text-[10px] uppercase tracking-wider opacity-50 font-semibold flex items-center gap-1.5">
          <BrainCircuit size={12} strokeWidth={1.5} />
          复习记录
        </span>
      </div>
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full text-left p-3 mb-3 transition-opacity"
        style={{
          backgroundColor: "rgba(255, 255, 255, 0.4)",
          border: "1px solid rgba(31, 27, 22, 0.08)",
          borderRadius: "3px",
        }}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="serif text-sm" style={{ fontWeight: 500 }}>
            这道题被复习过 {total} 次
          </div>
          <ChevronRight
            size={14}
            strokeWidth={1.5}
            className="opacity-50 shrink-0"
            style={{
              transform: expanded ? "rotate(90deg)" : "none",
              transition: "transform 0.15s ease",
            }}
          />
        </div>
        <div className="text-xs opacity-60 mt-1 flex gap-3">
          {correctN > 0 && (
            <span style={{ color: "#2D5A3D" }}>{correctN} 次答对</span>
          )}
          {wrongN > 0 && (
            <span style={{ color: "#8B4513" }}>{wrongN} 次答错</span>
          )}
          {skippedN > 0 && <span className="opacity-70">{skippedN} 次跳过</span>}
        </div>
      </button>

      {expanded && (
        <div className="space-y-2 pl-1">
          {history.map((h) => {
            const rs = resultStyle[h.result] || resultStyle.skipped;
            const isOpen = openIds.has(h.id);
            return (
              <div
                key={h.id}
                className="text-xs"
                style={{
                  borderLeft: `2px solid ${rs.color}`,
                  paddingLeft: 10,
                  paddingTop: 6,
                  paddingBottom: 6,
                }}
              >
                <div className="flex items-baseline gap-2 flex-wrap">
                  <span
                    className="text-[10px] font-semibold tracking-wider px-1.5 py-0.5 rounded-sm whitespace-nowrap"
                    style={{ color: rs.color, backgroundColor: rs.bg }}
                  >
                    {rs.label}
                  </span>
                  <span className="opacity-50 text-[11px] whitespace-nowrap">
                    {fmtDate(h.answeredAt)}
                  </span>
                </div>
                <button
                  onClick={() => toggleId(h.id)}
                  className="block text-left w-full mt-1 leading-relaxed opacity-80 hover:opacity-100"
                  style={{ wordBreak: "break-word" }}
                >
                  {isOpen
                    ? h.quizQuestion
                    : (h.quizQuestion || "").slice(0, 60) +
                      (h.quizQuestion && h.quizQuestion.length > 60 ? "…" : "")}
                </button>
                {/* v4.8.1: 看图题历史展开后，把当时的 SVG 也画出来。
                    SafeSvg 自带白名单清洗，可以放心渲染历史数据库中的字符串。 */}
                {isOpen && h.quizSvg && (
                  <div
                    className="mt-2 p-2"
                    style={{
                      backgroundColor: "rgba(255, 255, 255, 0.7)",
                      border: "1px solid rgba(31, 27, 22, 0.08)",
                      borderRadius: "2px",
                    }}
                  >
                    <SafeSvg raw={h.quizSvg} />
                  </div>
                )}
                {isOpen && h.expectedAnswer && (
                  <div
                    className="mt-1.5 px-2 py-1.5 text-[11px] leading-relaxed opacity-70"
                    style={{
                      backgroundColor: "rgba(45, 90, 61, 0.05)",
                      borderRadius: "2px",
                    }}
                  >
                    参考答案:{h.expectedAnswer}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ============================================================
// ExplanationHistorySection（v4.9）
// ============================================================
// 时刻详情页的"讲解历史"区块（在"复习记录"区块之后）。
// 一道题反复错触发讲解卡后，每次生成的卡都存在 explanation_cards 表里，
// 这里按时间倒序展示，让家长以后能回看陪 ta 翻越这道题的全过程。
//
// 行为同 QuizHistorySection：默认折叠，没历史则不渲染（避免空标题占位）。
// 区别：每张卡可点开看完整内容（opening / script / SVG / verify_problem 等）。
// ============================================================
function ExplanationHistorySection({ momentId }) {
  const [cards, setCards] = useState(null); // null=未加载, []=空, [...]=有
  const [expanded, setExpanded] = useState(false);
  const [openIds, setOpenIds] = useState(() => new Set());

  useEffect(() => {
    if (!momentId) return;
    let alive = true;
    api
      .listExplanationCards(momentId)
      .then((data) => {
        if (!alive) return;
        setCards(Array.isArray(data) ? data : []);
      })
      .catch(() => {
        if (alive) setCards([]);
      });
    return () => {
      alive = false;
    };
  }, [momentId]);

  if (!cards || cards.length === 0) return null;

  const fmtDate = (ts) => {
    const d = new Date(ts);
    const now = new Date();
    const isThisYear = d.getFullYear() === now.getFullYear();
    return isThisYear
      ? `${d.getMonth() + 1}月${d.getDate()}日`
      : `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
  };

  const feedbackLabel = (f) => {
    switch (f) {
      case "explained_then_practice":
        return "讲完后让 ta 又做了一道";
      case "needed_more_angle":
        return "需要换个角度再讲";
      case "shelved":
        return "暂搁了";
      default:
        return "未反馈";
    }
  };

  const toggleId = (id) => {
    setOpenIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="fade-up-5">
      <div className="flex items-baseline gap-3 mb-3">
        <span
          className="serif italic opacity-40 text-xs"
          style={{ letterSpacing: "0.05em" }}
        >
          08
        </span>
        <span className="text-[10px] uppercase tracking-wider opacity-50 font-semibold flex items-center gap-1.5">
          <BookOpen size={12} strokeWidth={1.5} />
          讲解历史
        </span>
      </div>
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full text-left p-3 mb-3 transition-opacity"
        style={{
          // 比"复习记录"稍暖一点的底色，呼应讲解卡屏的木色调
          backgroundColor: "rgba(245, 237, 220, 0.6)",
          border: "1px solid rgba(160, 82, 45, 0.15)",
          borderRadius: "3px",
        }}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="serif text-sm" style={{ fontWeight: 500 }}>
            为这道题准备过 {cards.length} 张讲解卡
          </div>
          <ChevronRight
            size={14}
            strokeWidth={1.5}
            className="opacity-50 shrink-0"
            style={{
              transform: expanded ? "rotate(90deg)" : "none",
              transition: "transform 0.15s ease",
            }}
          />
        </div>
        <div className="text-xs opacity-60 mt-1">
          反复错时 AI 会换一种讲法陪你陪 ta 一起翻越
        </div>
      </button>

      {expanded && (
        <div className="space-y-3 pl-1">
          {cards.map((c) => {
            const isOpen = openIds.has(c.id);
            return (
              <div
                key={c.id}
                className="text-xs"
                style={{
                  backgroundColor: "rgba(255, 255, 255, 0.5)",
                  border: "1px solid rgba(31, 27, 22, 0.08)",
                  borderRadius: "3px",
                }}
              >
                <button
                  onClick={() => toggleId(c.id)}
                  className="w-full text-left px-3 py-2 flex items-start gap-3"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline gap-2 mb-0.5">
                      <span className="opacity-60">{fmtDate(c.createdAt)}</span>
                      <span className="opacity-40">·</span>
                      <span style={{ color: "#A0522D" }}>
                        {c.analogyCore || "（未填类比）"}
                      </span>
                    </div>
                    <div className="opacity-50 text-[11px]">
                      触发时已错 {c.triggerWrongStreak} 次 ·{" "}
                      {feedbackLabel(c.userFeedback)}
                    </div>
                  </div>
                  <ChevronRight
                    size={12}
                    strokeWidth={1.5}
                    className="opacity-40 mt-0.5"
                    style={{
                      transform: isOpen ? "rotate(90deg)" : "none",
                      transition: "transform 0.15s ease",
                    }}
                  />
                </button>
                {isOpen && (
                  <div
                    className="px-3 pb-3 pt-1 leading-relaxed space-y-2.5"
                    style={{ borderTop: "1px dashed rgba(31, 27, 22, 0.1)" }}
                  >
                    {c.opening && (
                      <div>
                        <div className="opacity-50 text-[10px] uppercase tracking-wider mb-0.5">
                          开场
                        </div>
                        <div className="serif italic">"{c.opening}"</div>
                      </div>
                    )}
                    {c.script && (
                      <div>
                        <div className="opacity-50 text-[10px] uppercase tracking-wider mb-0.5">
                          讲解
                        </div>
                        <div className="whitespace-pre-wrap">{c.script}</div>
                      </div>
                    )}
                    {c.visualSvg && (
                      <div
                        className="p-2"
                        style={{
                          backgroundColor: "rgba(255, 255, 255, 0.7)",
                          borderRadius: "2px",
                        }}
                      >
                        <SafeSvg raw={c.visualSvg} />
                      </div>
                    )}
                    {c.checkQuestion && (
                      <div>
                        <div className="opacity-50 text-[10px] uppercase tracking-wider mb-0.5">
                          复述提问
                        </div>
                        <div className="serif italic">"{c.checkQuestion}"</div>
                      </div>
                    )}
                    {c.verifyProblem && (
                      <div>
                        <div className="opacity-50 text-[10px] uppercase tracking-wider mb-0.5">
                          验证题
                        </div>
                        <div>{c.verifyProblem}</div>
                        {c.verifyAnswer && (
                          <div
                            className="mt-1 px-2 py-1.5 text-[11px] opacity-70"
                            style={{
                              backgroundColor: "rgba(160, 82, 45, 0.06)",
                              borderRadius: "2px",
                            }}
                          >
                            参考答案：{c.verifyAnswer}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Section({ number, label, title, children, delayClass, icon, badge }) {
  return (
    <div className={delayClass}>
      <div className="flex items-baseline gap-3 mb-3">
        <span
          className="serif italic opacity-40 text-xs"
          style={{ letterSpacing: "0.05em" }}
        >
          {number}
        </span>
        <div>
          <div className="text-[10px] uppercase tracking-wider opacity-50 font-semibold flex items-center gap-1.5">
            {icon}
            {label}
          </div>
          <div className="serif text-lg mt-0.5 flex items-baseline gap-2" style={{ fontWeight: 500 }}>
            <span>{title}</span>
            {badge}
          </div>
        </div>
      </div>
      <div
        className="pl-6"
        style={{ borderLeft: "1px solid rgba(31, 27, 22, 0.08)" }}
      >
        {children}
      </div>
    </div>
  );
}

function ConfidenceBadge({ level }) {
  const styles = {
    高: { bg: "rgba(45, 90, 61, 0.1)", color: "#2D5A3D", label: "判断较肯定" },
    中: { bg: "rgba(183, 121, 31, 0.1)", color: "#B7791F", label: "不完全肯定" },
    低: { bg: "rgba(139, 69, 19, 0.1)", color: "#8B4513", label: "仅供参考" },
  };
  const s = styles[level] || styles["中"];
  return (
    <span
      className="text-[10px] px-2 py-0.5 rounded-full font-semibold"
      style={{ backgroundColor: s.bg, color: s.color }}
    >
      {s.label}
    </span>
  );
}
// ============================================================
// 复盘考察 Screen
// ============================================================
function ReviewScreen({
  kid,
  candidates,
  onUpdateStatus,
  onBack,
  cachedQuizSet,
  onMarkCached,
  onMarkUncached,
  onOpenExplanationCard, // v4.9: wrong_streak >= 3 触发讲解卡时调
}) {
  const [idx, setIdx] = useState(0);
  const [quiz, setQuiz] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [showAnswer, setShowAnswer] = useState(false);

  const [quizReasoning, setQuizReasoning] = useState("");
  const [quizContentPreview, setQuizContentPreview] = useState("");
  const reasoningScrollRef = useStickyBottom([quizReasoning]);

  // 防竞态：记录"目前正在等的请求是哪一题"，旧回调一律丢
  const activeMomentIdRef = useRef(null);

  const current = candidates[idx];

  /**
   * v4.7 Phase 2: 单路径出题流程
   *
   * loadQuiz 永远开一个新的 SSE 连接到后端，后端 generationBus 自动选路径：
   *   · 若 cached_quizzes 表已有 → 后端立刻 done 事件，前端秒到（不进 loading）
   *   · 若 generationBus 内存条目已有（预热在跑） → 后端把已累积的 reasoning 一次性回放给我们，
   *     然后续上后续 chunks，家长看到的是连贯的"AI 在思考"流式体验
   *   · 全新 → 后端调 AI 边生成边推
   *
   * 即使 prefetchService 已经为这道题开了一个连接（预热中），我们仍然开第二个连接。
   * 因为预热那条连接是丢弃 chunks 的，没法把流式数据交给 ReviewScreen 显示。
   * 后端的 generationBus 保证两条连接共享同一次 AI 调用，token 不会双扣。
   * force=true 时先等待旧缓存删除完成，再请求新题，避免并发竞态命中旧缓存。
   */
  const loadQuiz = async (moment, { force = false } = {}) => {
    activeMomentIdRef.current = moment.id;
    setLoading(true);
    setError(null);
    setQuiz(null);
    setShowAnswer(false);
    setQuizReasoning("");
    setQuizContentPreview("");

    // v4.9: wrongStreak >= 3 的题不走 cached-quiz，直接跳讲解卡。
    // 这是前端主动判断；同时 cached-quiz 后端也会兜底返回 code:"should_explain"。
    if (Number(moment.wrongStreak) >= 3) {
      setLoading(false);
      onOpenExplanationCard?.(moment);
      return;
    }

    try {
      if (force) {
        await api.deleteCachedQuiz(moment.id);
        if (activeMomentIdRef.current !== moment.id) return;
        onMarkUncached?.(moment.id);
      }

      const q = await generateReviewQuiz({
        moment,
        onReasoning: (chunk) => {
          if (activeMomentIdRef.current !== moment.id) return;
          // 合流路径：后端会一次性把累积的 reasoning 推过来（payload.text 就是完整累计），
          //         家长会看到 thinking "哗"地出现一大段，然后继续往下流——很自然
          // 全新路径：每次是真正的增量 chunk
          // 都用 += 拼接没问题：本次出题前 quizReasoning 已重置为 ""
          setQuizReasoning((p) => p + chunk);
        },
        onContent: (chunk) => {
          if (activeMomentIdRef.current !== moment.id) return;
          setQuizContentPreview((p) => p + chunk);
        },
      });
      if (activeMomentIdRef.current !== moment.id) return;
      setQuiz(q);

      // 后端已经在 SSE 流末端写好了 cached_quizzes 表，
      // 这里只需要更新前端 cachedSet 让首页"已备好 N 题"标记同步
      onMarkCached?.(moment.id);
    } catch (e) {
      if (activeMomentIdRef.current !== moment.id) return;
      // v4.9: 后端 cached-quiz 兜底——发现 wrongStreak >= 3 时返回 should_explain，
      // 前端切到讲解卡（极少触发，因为前端已经先判了，但以防本地状态滞后）
      if (e.code === "should_explain") {
        onOpenExplanationCard?.(moment);
        return;
      }
      let msg = e.message || "出题失败";
      if (e.code === "quota_exceeded") {
        const d = e.detail || {};
        msg = `今日 AI 额度已用完（${d.current || ""}/${d.quota || ""}），明天再来`;
      } else if (e.code === "rate_limited") {
        msg = "请求太快，稍等一下";
      } else if (e.code === "moment_changed") {
        msg = "原题已被修改，请重新出题";
      } else if (e.code === "moment_deleted") {
        msg = "原题已被删除";
      }
      setError(msg);
    } finally {
      if (activeMomentIdRef.current === moment.id) setLoading(false);
    }
  };

  // 关键：依赖 moment.id 而非 idx
  // 因为答对后 candidates 会缩短，idx 不变但 current 已经是下一题了
  useEffect(() => {
    if (current) loadQuiz(current.moment);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.moment?.id]);

  // v4.7: 接班预热
  // 进了复习屏意味着家长可能会连做几道。idx+1 idx+2 这两道也提前预热好，
  // 等家长做完当前题翻页时，下一题已经在缓存里了。
  // useEffect 依赖 idx 和 candidates 长度变化即触发；因 prefetchService 幂等，重复触发无害。
  useEffect(() => {
    if (!candidates || candidates.length === 0) return;
    const lookahead = [idx + 1, idx + 2]
      .map((i) => candidates[i]?.moment?.id)
      .filter(Boolean)
      .filter((id) => !cachedQuizSet.has(id));
    if (lookahead.length === 0) return;
    prefetchService.enqueue(lookahead, (id) => onMarkCached?.(id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idx, candidates.length]);

  if (!current) {
    return (
      <div className="fade-up py-16 text-center">
        <BrainCircuit
          size={40}
          strokeWidth={1}
          className="mx-auto mb-4 opacity-30"
        />
        <div className="serif text-lg mb-2">暂时没有要复习的题</div>
        <div className="text-xs opacity-60 max-w-xs mx-auto leading-relaxed">
          学过的题过几天再回来考察，效果最好。先去记录新的时刻吧。
        </div>
      </div>
    );
  }

  // markResult: 答对 / 答错 / 跳过
  // 答对 → status="已理解"，间隔翻倍，wrongStreak 清零
  // 答错 → status="需复习"，间隔重置为 1，且按 12h 间隔判定累加 wrongStreak
  //        如果累加后 >= 3 → 直接切到讲解卡屏，不再出复习题
  // 跳过 → 不动 status 和间隔，只往下一题
  const markResult = (kind) => {
      // v4.8: 把这次答题写进历史（无论对错跳过）。
      // fire-and-forget，失败不影响主流程。
      // 写历史在前面做：即使后续 onUpdateStatus 失败，历史也已经留了，
      //                方便事后排查"这次复习到底发生了什么"。
      // 跳过也记录：以后做统计时能看到"孩子跳过了多少题"，反映学习习惯。
      // v4.8.1: 看图题的 SVG 也一起上报，让历史里能完整重现当时的题
      if (quiz && quiz.quiz_question) {
        api
          .recordQuizHistory(current.moment.id, {
            quizQuestion: quiz.quiz_question,
            quizSvg: quiz.quiz_svg || null,
            expectedAnswer: quiz.expected_answer,
            result: kind === "correct" ? "correct" : kind === "wrong" ? "wrong" : "skipped",
          })
          .catch(() => {}); // 历史写失败不打扰用户
      }

      if (kind === "skip") {
        // 跳过：不消费缓存（这道题缓存留着，下次还能秒开）
        // idx 推到下一题
        if (idx < candidates.length - 1) setIdx(idx + 1);
        else onBack();
        return;
      }

      const isCorrect = kind === "correct";
      const newInterval = nextInterval(current.interval, isCorrect);

      // v4.9: 计算 wrongStreak / lastWrongAt
      // ─────────────────────────────────────────────────────────
      // 答对：streak 清零（讲解卡走完后再答对的也走这一条）。
      // 答错：判 12h 间隔 —— 距上次错 < 12h 算同一次状态不好，streak 不累加；
      //                    距上次错 >= 12h 或从未错过，是"独立"信号，streak += 1。
      //       两种情况都要更新 lastWrongAt。
      const now = Date.now();
      const HOURS_12_MS = 12 * 60 * 60 * 1000;
      const prevStreak = Number(current.moment.wrongStreak) || 0;
      const prevLastWrong = current.moment.lastWrongAt;
      let newStreak = prevStreak;
      let newLastWrong = prevLastWrong || null;
      if (isCorrect) {
        newStreak = 0;
      } else {
        const isIndependent =
          !prevLastWrong || now - prevLastWrong >= HOURS_12_MS;
        if (isIndependent) newStreak = prevStreak + 1;
        newLastWrong = now;
      }

      onUpdateStatus(current.moment.id, {
        status: isCorrect ? "已理解" : "需复习",
        intervalDays: newInterval,
        wrongStreak: newStreak,
        lastWrongAt: newLastWrong,
      });

      // v4.7: 这道题已经被消费了（无论对错），缓存的题已经"用过"，删掉。
      // 下次该复习时会重新预热出一道新题（不同情境/数字），避免家长记住答案。
      // fire-and-forget：不 await，失败也不影响流程
      api.deleteCachedQuiz(current.moment.id).catch(() => {});
      onMarkUncached?.(current.moment.id);

      // v4.9: 答错且累计 wrongStreak >= 3 → 切到讲解卡屏
      // 这是"系统知道何时该闭嘴"的关键时刻：再让 ta 做一道大概率还是错，
      // 改让 AI 写一段家长能照着讲的脚本，把麦克风递给家长。
      if (!isCorrect && newStreak >= 3) {
        // 把更新后的 moment 数据带过去（含新 wrongStreak/lastWrongAt），
        // 否则 ExplanationCardScreen 里读 wrongStreak 还是旧值
        const momentForExplanation = {
          ...current.moment,
          wrongStreak: newStreak,
          lastWrongAt: newLastWrong,
          status: "需复习",
          intervalDays: newInterval,
        };
        onOpenExplanationCard?.(momentForExplanation);
        return;
      }

      if (isCorrect) {
        // 答对：当前题会被 pickReviewCandidates 自动从列表剔除
        //   （updatedAt 重置 → ageDays≈0；interval 翻倍 → ageDays<interval 被过滤）
        // 所以 candidates 会"自动缩短"，原来 idx+1 那道题现在就在 idx 处。
        // 不要手动 +1，否则会跳过一题。
        // 唯一需要处理的：这是最后一题，列表会变空 → 退回主页。
        if (candidates.length <= 1) onBack();
        // 否则啥也不做：candidates 缩短后 useEffect 因 moment.id 变化自动触发
      } else {
        // v4.9: 答错后 12h 内这道题会被 pickReviewCandidates 过滤（冷却期），
        // 所以 candidates 实际上也会缩短。配合"idx 不动"的语义：
        //   · 当前题被过滤 → 原来 idx+1 那道现在在 idx 处 → useEffect 自动触发新题
        //   · 唯一边界：这是列表里最后一题（被过滤后列表空了） → 退回主页
        if (candidates.length <= 1) onBack();
        // 否则不动 idx：等 candidates 缩短后 useEffect 自动接管
      }
    };

  return (
    <div className="fade-up">
      <div className="mb-6">
        <div className="text-xs opacity-50 serif italic mb-1">
          {kid.name} 的复盘 · 第 {idx + 1} / {candidates.length} 题
        </div>
        <h1 className="serif text-3xl" style={{ fontWeight: 400 }}>
          再考考 ta
        </h1>
        <div className="text-sm opacity-60 mt-2 leading-relaxed">
          AI 会基于 {Math.round(current.age)} 天前这道错题，出一道同考点的变式题。
          读给 ta 听，看是不是真的学会了。
        </div>
        {/* 间隔重复标注（hover 看完整解释，克制风格） */}
        <div
          className="text-[11px] opacity-40 mt-2 italic flex items-center gap-1.5"
          title="间隔重复（Spaced Repetition）：基于艾宾浩斯遗忘曲线 R(t)=exp(-t/S)，每道题维护独立的复习间隔。答对一次，下次间隔翻倍（最长 90 天）；答错则重置为 1 天。这样真正掌握的题会逐渐'飞走'，把宝贵的复盘时段留给孩子还没真会的题。SuperMemo SM-2 / Anki 用的就是这套思路。"
        >
          <BrainCircuit size={11} strokeWidth={1.5} />
          <span>按间隔重复算法挑出该回头看看的题</span>
        </div>
      </div>

      {/* 原题回顾 */}
      <div
        className="p-3 mb-6 text-sm"
        style={{
          backgroundColor: "rgba(31, 27, 22, 0.04)",
          borderRadius: "2px",
          borderLeft: "2px solid rgba(31, 27, 22, 0.2)",
        }}
      >
        <div className="text-[10px] uppercase tracking-wider opacity-40 font-semibold mb-1 flex items-center justify-between gap-2">
          <span>{Math.round(current.age)} 天前的错题</span>
          <span
            className="normal-case tracking-normal opacity-80"
            title={`本题当前间隔 ${current.interval} 天，距上次已 ${Math.round(current.age)} 天。R(t)=exp(-t/S) 估算的当前记忆保留率：${Math.round(current.retention * 100)}%。`}
            style={{
              color:
                current.retention < 0.25
                  ? "#8B4513"
                  : current.retention < 0.4
                  ? "#B7791F"
                  : "#2D5A3D",
            }}
          >
            记忆约剩 {Math.round(current.retention * 100)}% · 间隔 {current.interval}天
          </span>
        </div>
        {/* v4.6: 看图题就把图描述也展示出来，让家长有上下文。
            原图 base64 可能没在列表里，懒得为了"原题回顾"再单独拉一次，
            所以这里只用文字描述（imageDescription 列表里有）。 */}
        <div className="serif text-sm opacity-80 italic line-clamp-2">
          {current.moment.problem}
        </div>
        {current.moment.imageDescription && (
          <div className="text-xs opacity-60 mt-1 leading-relaxed flex items-start gap-1.5">
            <ImageIcon
              size={11}
              strokeWidth={1.5}
              className="shrink-0 mt-0.5 opacity-70"
            />
            <span className="line-clamp-2 italic">
              {current.moment.imageDescription}
            </span>
          </div>
        )}
        {current.moment.analysis?.misconception?.title && (
          <div className="text-xs opacity-60 mt-1">
            当时判断：{current.moment.analysis.misconception.title}
          </div>
        )}
      </div>

      {/* v4.7 Phase 2: 统一流式 UI
          后端无论走"缓存命中/合流回放/全新生成"哪条路径，前端都拿到一致的 SSE 流。
          · 缓存命中：直接 done，根本不进 loading 状态
          · 合流回放：会一次性收到累积的 reasoning（家长感觉"AI 思考特别快"），然后续上后续 chunks
          · 全新生成：从 0 开始流
          家长不需要知道走的是哪条路径——体验就是"AI 在思考 / 写题"，简洁一致。 */}
      {loading && (() => {
        const loadingPhase = quizContentPreview
          ? "正在写题…"
          : quizReasoning
          ? "正在思考新题…"
          : "已发送，等待 AI 响应…";
        return (
          <div className="py-8">
            <div className="text-center mb-5">
              <Loader2
                size={18}
                className="animate-spin mx-auto mb-2 opacity-60"
                strokeWidth={1.5}
              />
              <div className="text-sm opacity-60 serif italic">{loadingPhase}</div>
            </div>

            {quizReasoning && (
              <details className="max-w-md mx-auto mb-3" open={!quizContentPreview}>
                <summary className="text-xs opacity-50 cursor-pointer mb-2 select-none px-1">
                  💭 AI 的思考过程（{quizReasoning.length} 字）
                </summary>
                <div
                  ref={reasoningScrollRef}
                  className="text-xs opacity-70 leading-relaxed p-3 max-h-[60vh] overflow-y-auto whitespace-pre-wrap"
                  style={{
                    backgroundColor: "rgba(31, 27, 22, 0.04)",
                    borderLeft: "2px solid rgba(31, 27, 22, 0.15)",
                    fontFamily:
                      "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                    wordBreak: "break-word",
                  }}
                >
                  {quizReasoning}
                </div>
              </details>
            )}

            {quizContentPreview && (
              <div className="max-w-md mx-auto mb-3 text-xs opacity-50 leading-relaxed text-center">
                已收到题目 {quizContentPreview.length} 字，正在等模型写完…
              </div>
            )}
          </div>
        );
      })()}

      {error && !loading && (
        <div className="py-8 text-center">
          <div className="text-xs text-red-700 mb-3">{error}</div>
          <button
            onClick={() => {
              loadQuiz(current.moment, { force: true });
            }}
            className="text-sm px-4 py-2"
            style={{
              border: "1px solid rgba(31, 27, 22, 0.2)",
              borderRadius: "2px",
            }}
          >
            <RefreshCw size={12} className="inline mr-1" /> 换一题
          </button>
        </div>
      )}

      {quiz && !loading && (
        <div>
          <div
            className="p-5 mb-4"
            style={{
              backgroundColor: "rgba(255, 255, 255, 0.6)",
              borderLeft: "3px solid #2D5A3D",
              borderRadius: "0 4px 4px 0",
            }}
          >
            <div
              className="text-[10px] uppercase tracking-wider opacity-50 font-semibold mb-2"
              style={{ color: "#2D5A3D" }}
            >
              新题（考察同一考点）
            </div>
            <div className="serif text-lg leading-relaxed" style={{ fontWeight: 500 }}>
              {quiz.quiz_question}
            </div>
            {/* v4.6: 看图题的图 */}
            {quiz.quiz_svg && (
              <div
                className="mt-3 p-3"
                style={{
                  backgroundColor: "rgba(255, 255, 255, 0.5)",
                  border: "1px solid rgba(31, 27, 22, 0.1)",
                  borderRadius: "2px",
                }}
              >
                <SafeSvg raw={quiz.quiz_svg} />
              </div>
            )}
          </div>

          {quiz.key_check && (
            <div
              className="text-xs p-3 mb-4 leading-relaxed"
              style={{
                backgroundColor: "rgba(45, 90, 61, 0.05)",
                borderLeft: "2px solid rgba(45, 90, 61, 0.3)",
              }}
            >
              <span className="font-semibold" style={{ color: "#2D5A3D" }}>
                读题时重点看：
              </span>{" "}
              {quiz.key_check}
            </div>
          )}

          <button
            onClick={() => setShowAnswer(!showAnswer)}
            className="text-xs opacity-60 hover:opacity-100 mb-4 flex items-center gap-1"
          >
            <HelpCircle size={12} />
            {showAnswer ? "收起参考答案" : "看参考答案"}
          </button>
          {showAnswer && (
            <div
              className="p-3 mb-4 text-sm"
              style={{
                backgroundColor: "rgba(45, 90, 61, 0.06)",
                borderRadius: "2px",
              }}
            >
              <div className="font-semibold mb-1 text-xs">参考答案</div>
              <div>{quiz.expected_answer}</div>
            </div>
          )}

          <div
            className="grid grid-cols-2 gap-2 p-3 mb-6 text-xs"
            style={{
              backgroundColor: "rgba(255, 255, 255, 0.4)",
              borderRadius: "2px",
              border: "1px solid rgba(31, 27, 22, 0.08)",
            }}
          >
            <div>
              <div className="font-semibold opacity-60 mb-1">答对了的话</div>
              <div className="opacity-80 leading-relaxed">{quiz.if_correct}</div>
            </div>
            <div>
              <div className="font-semibold opacity-60 mb-1">又答错了的话</div>
              <div className="opacity-80 leading-relaxed">{quiz.if_wrong}</div>
            </div>
          </div>

          {/* 行动按钮 */}
          <div className="text-[10px] uppercase tracking-wider opacity-40 font-semibold mb-2">
            ta 做得怎么样？
          </div>
          <div className="flex flex-wrap gap-2 mb-6">
            <button
              onClick={() => markResult("correct")}
              className="flex-1 min-w-[140px] px-4 py-3 text-sm flex items-center justify-center gap-1.5"
              style={{
                backgroundColor: "#2D5A3D",
                color: "#F8F4EB",
                borderRadius: "2px",
              }}
            >
              <CheckCircle2 size={14} /> 真会了，过
            </button>
            <button
              onClick={() => markResult("wrong")}
              className="flex-1 min-w-[140px] px-4 py-3 text-sm"
              style={{
                backgroundColor: "rgba(139, 69, 19, 0.12)",
                color: "#8B4513",
                borderRadius: "2px",
              }}
            >
              还不行，留着再练
            </button>
          </div>

          <div className="text-center">
            <button
              onClick={() => {
                loadQuiz(current.moment, { force: true });
              }}
              className="text-xs opacity-60 hover:opacity-100 mr-4 inline-flex items-center gap-1"
            >
              <RefreshCw size={11} /> 换一道
            </button>
            {idx < candidates.length - 1 && (
              <button
                onClick={() => markResult("skip")}
                className="text-xs opacity-60 hover:opacity-100"
              >
                跳过这题 →
              </button>
            )}
          </div>
        </div>
      )}

      {/* v4.5: 出题完成后保留思考过程为可折叠区块 */}
      {!loading && quiz && quizReasoning && quizReasoning.length > 0 && (
        <details className="fade-up mt-4">
          <summary className="text-xs opacity-40 cursor-pointer select-none py-2 px-1 hover:opacity-60 transition-opacity">
            💭 查看 AI 的出题思考（{quizReasoning.length} 字）
          </summary>
          <div
            className="mt-2 text-xs opacity-60 leading-relaxed p-3 max-h-[60vh] overflow-y-auto whitespace-pre-wrap"
            style={{
              backgroundColor: "rgba(31, 27, 22, 0.04)",
              borderLeft: "2px solid rgba(31, 27, 22, 0.15)",
              fontFamily:
                "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
              wordBreak: "break-word",
            }}
          >
            {quizReasoning}
          </div>
        </details>
      )}
    </div>
  );
}

// ============================================================
// ExplanationCardScreen（v4.9）：讲解卡屏
// ============================================================
// 触发：moment.wrong_streak >= 3 时从 ReviewScreen 跳过来。
// 结构：流式生成 →（生成完）卡片本体 → 三个按钮分流。
//
// 三按钮语义：
//   ① "讲完了，让 ta 再做一道"  → wrongStreak 清零（onUpdateStatus），
//                                  写 feedback="explained_then_practice"，
//                                  返回复习屏（这道题会以 streak=0 重新进入流程）
//   ② "还需要更多解释"        → 写 feedback="needed_more_angle"，
//                                  调 generateExplanationCard angle="alternative"
//                                  生成下一张卡，本屏覆盖渲染。
//                                  上限：本道题已生成 >= 3 张时禁用此按钮。
//   ③ "先放一放"              → moment.status = "暂搁"（不清 streak），
//                                  写 feedback="shelved"，返回首页
//
// 视觉风格：底色稍暖（米色 → 浅木色调），明确传达"换了模式：在陪伴，不是在做题"
// ============================================================
function ExplanationCardScreen({
  kid,
  moment,
  onUpdateStatus,
  onBack,
}) {
  const [card, setCard] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [reasoning, setReasoning] = useState("");
  const [contentPreview, setContentPreview] = useState("");
  const reasoningScrollRef = useStickyBottom([reasoning]);

  // 验证题答案：默认折叠，家长点了才展开
  const [showVerifyAnswer, setShowVerifyAnswer] = useState(false);
  // "换角度" 已用了几次（本会话内）；用于按钮禁用提示
  const [angleAttempts, setAngleAttempts] = useState(0);
  // 防竞态：跨"换角度"重新加载时，丢弃旧请求的 chunks
  const activeReqRef = useRef(0);

  // 生成讲解卡（首次 default、后续 alternative）
  const loadCard = async (angle = "default") => {
    const reqId = activeReqRef.current + 1;
    activeReqRef.current = reqId;

    setLoading(true);
    setError(null);
    setCard(null);
    setReasoning("");
    setContentPreview("");
    setShowVerifyAnswer(false);

    try {
      const c = await generateExplanationCard({
        moment,
        angle,
        onReasoning: (chunk) => {
          if (activeReqRef.current !== reqId) return;
          setReasoning((p) => p + chunk);
        },
        onContent: (chunk) => {
          if (activeReqRef.current !== reqId) return;
          setContentPreview((p) => p + chunk);
        },
      });
      if (activeReqRef.current !== reqId) return;
      setCard(c);
    } catch (e) {
      if (activeReqRef.current !== reqId) return;
      let msg = e.message || "讲解卡生成失败";
      if (e.code === "quota_exceeded") {
        const d = e.detail || {};
        msg = `今日 AI 额度已用完（${d.current || ""}/${d.quota || ""}），明天再来`;
      } else if (e.code === "max_alternatives_reached") {
        msg = "这道题已经讲过几次了，建议先放一放，过几天再说";
      } else if (e.code === "rate_limited") {
        msg = "请求太快，稍等一下";
      }
      setError(msg);
    } finally {
      if (activeReqRef.current === reqId) setLoading(false);
    }
  };

  // 组件挂载时启动首次生成
  useEffect(() => {
    loadCard("default");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── 三按钮处理 ──────────────────────────────────────────────
  const handleExplainedThenPractice = () => {
    if (card) {
      api
        .recordExplanationCardFeedback(card.id, "explained_then_practice")
        .catch(() => {});
    }
    // 清 wrongStreak 让这道题重新走出题流程；status 保持"需复习"让它能优先入池；
    // 不动 lastWrongAt，让 12h 冷却仍然生效——下一次复习自然推到明天，
    // 这是好事：让孩子先消化今天的讲解，不要立刻验证。
    onUpdateStatus(moment.id, { wrongStreak: 0 });
    onBack();
  };

  const handleNeedMoreAngle = () => {
    if (card) {
      api
        .recordExplanationCardFeedback(card.id, "needed_more_angle")
        .catch(() => {});
    }
    setAngleAttempts((n) => n + 1);
    loadCard("alternative");
  };

  const handleShelve = () => {
    if (card) {
      api.recordExplanationCardFeedback(card.id, "shelved").catch(() => {});
    }
    // 暂搁：不清 streak（保留"反复错"的事实信号），改 status 让它退出复习池
    onUpdateStatus(moment.id, { status: "暂搁" });
    onBack();
  };

  // ── 视觉常量 ──────────────────────────────────────────────
  const WARM_BG = "#F5EDDC";   // 比主背景更暖的米黄
  const WARM_BG_DARK = "#EDE0C5";
  const ACCENT = "#A0522D";    // 木色，区别于复习屏的墨绿

  return (
    <div className="fade-up">
      {/* 顶部导航 */}
      <div className="mb-6 flex items-start justify-between gap-3">
        <button
          onClick={onBack}
          className="text-xs opacity-60 hover:opacity-90 inline-flex items-center gap-1"
        >
          <ArrowLeft size={12} strokeWidth={1.5} /> 返回
        </button>
        <div className="text-xs opacity-50 serif italic text-right">
          {kid?.name || "孩子"} · 反复错题
        </div>
      </div>

      <div className="mb-3">
        <h1 className="serif text-3xl" style={{ fontWeight: 400 }}>
          陪 ta 讲一会儿
        </h1>
        <div className="text-sm opacity-70 mt-2 leading-relaxed">
          这道题已经反复错过 {moment.wrongStreak || 3} 次。AI 不再出题，
          而是给你一段可以照着讲给孩子听的话。
        </div>
      </div>

      {/* 原题回顾（小卡，提醒家长讲什么） */}
      <details
        className="mb-5 text-xs"
        style={{
          backgroundColor: "rgba(255, 255, 255, 0.5)",
          borderRadius: "3px",
          border: "1px solid rgba(31, 27, 22, 0.08)",
        }}
      >
        <summary
          className="px-3 py-2 cursor-pointer opacity-70 select-none"
          style={{ listStyle: "none" }}
        >
          原题（点开看）
        </summary>
        <div className="px-3 pb-3 pt-1 leading-relaxed opacity-80">
          {moment.problem}
          {moment.imageDescription && (
            <div className="mt-1 opacity-60 italic">
              图：{moment.imageDescription}
            </div>
          )}
        </div>
      </details>

      {/* 错误态 */}
      {error && (
        <div
          className="mb-4 px-4 py-3 text-sm"
          style={{
            backgroundColor: "#FEEBEB",
            border: "1px solid #F4C5C5",
            borderRadius: "3px",
            color: "#8B2727",
          }}
        >
          {error}
        </div>
      )}

      {/* 加载中：显示 thinking 流 */}
      {loading && (
        <div
          className="px-5 py-6 mb-5"
          style={{
            backgroundColor: WARM_BG,
            borderRadius: "4px",
            border: `1px solid ${WARM_BG_DARK}`,
          }}
        >
          <div className="flex items-center gap-2 mb-3 text-sm opacity-70">
            <Loader2 size={14} className="animate-spin" strokeWidth={1.5} />
            <span>AI 正在想用什么类比讲清楚这道题...</span>
          </div>
          {reasoning && (
            <div
              ref={reasoningScrollRef}
              className="text-[11px] leading-relaxed opacity-50 max-h-40 overflow-y-auto whitespace-pre-wrap"
              style={{ fontFamily: "ui-monospace, monospace" }}
            >
              {reasoning}
            </div>
          )}
          {contentPreview && (
            <div className="mt-3 text-[11px] leading-relaxed opacity-50 text-center">
              已收到讲解内容 {contentPreview.length} 字，正在等模型写完…
            </div>
          )}
        </div>
      )}

      {/* 卡片本体（生成完才显示） */}
      {!loading && !error && card && (
        <div
          className="mb-5"
          style={{
            backgroundColor: WARM_BG,
            borderRadius: "4px",
            border: `1px solid ${WARM_BG_DARK}`,
            padding: "20px 22px",
          }}
        >
          {/* opening - 开场白，醒目展示 */}
          {card.opening && (
            <div className="mb-5">
              <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider opacity-50 font-semibold mb-2">
                <Heart size={11} strokeWidth={1.5} style={{ color: ACCENT }} />
                <span>先这样开场</span>
              </div>
              <div
                className="text-base leading-relaxed serif italic"
                style={{ color: "#3a2418" }}
              >
                "{card.opening}"
              </div>
            </div>
          )}

          {/* analogy_core - 核心类比 */}
          {card.analogyCore && (
            <div className="mb-5">
              <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider opacity-50 font-semibold mb-2">
                <Lightbulb size={11} strokeWidth={1.5} style={{ color: ACCENT }} />
                <span>用这个比方</span>
              </div>
              <div className="text-sm leading-relaxed opacity-90">
                {card.analogyCore}
              </div>
            </div>
          )}

          {/* script - 完整讲解脚本 */}
          {card.script && (
            <div className="mb-5">
              <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider opacity-50 font-semibold mb-2">
                <BookOpen size={11} strokeWidth={1.5} style={{ color: ACCENT }} />
                <span>完整讲解（你可以照着念）</span>
              </div>
              <div className="text-sm leading-[1.85] whitespace-pre-wrap">
                {card.script}
              </div>
            </div>
          )}

          {/* visual_svg - 配图 */}
          {card.visualSvg && (
            <div
              className="mb-5 px-3 py-3"
              style={{
                backgroundColor: "rgba(255, 255, 255, 0.7)",
                borderRadius: "3px",
              }}
            >
              <SafeSvg raw={card.visualSvg} />
            </div>
          )}

          {/* check_question - 让孩子复述 */}
          {card.checkQuestion && (
            <div
              className="mb-5 px-4 py-3"
              style={{
                backgroundColor: "rgba(255, 255, 255, 0.5)",
                borderRadius: "3px",
                borderLeft: `2px solid ${ACCENT}`,
              }}
            >
              <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider opacity-50 font-semibold mb-1.5">
                <MessageCircle size={11} strokeWidth={1.5} style={{ color: ACCENT }} />
                <span>讲完后让 ta 自己说一遍</span>
              </div>
              <div className="text-sm leading-relaxed serif italic">
                "{card.checkQuestion}"
              </div>
            </div>
          )}

          {/* verify_problem - 验证题 */}
          {card.verifyProblem && (
            <div className="mb-2">
              <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider opacity-50 font-semibold mb-2">
                <Pencil size={11} strokeWidth={1.5} style={{ color: ACCENT }} />
                <span>再做这道验证一下</span>
              </div>
              <div className="text-sm leading-relaxed mb-2">
                {card.verifyProblem}
              </div>
              {card.verifySvg && (
                <div
                  className="my-3 px-3 py-3"
                  style={{
                    backgroundColor: "rgba(255, 255, 255, 0.7)",
                    borderRadius: "3px",
                  }}
                >
                  <SafeSvg raw={card.verifySvg} />
                </div>
              )}
              {card.verifyAnswer && (
                <button
                  onClick={() => setShowVerifyAnswer((s) => !s)}
                  className="text-xs opacity-60 hover:opacity-90 inline-flex items-center gap-1 mt-1"
                >
                  {showVerifyAnswer ? "收起答案" : "查看答案"}
                  <ChevronRight
                    size={11}
                    strokeWidth={1.5}
                    style={{
                      transform: showVerifyAnswer ? "rotate(90deg)" : "none",
                      transition: "transform 0.15s",
                    }}
                  />
                </button>
              )}
              {showVerifyAnswer && card.verifyAnswer && (
                <div
                  className="mt-2 px-3 py-2 text-sm"
                  style={{
                    backgroundColor: "rgba(255, 255, 255, 0.6)",
                    borderRadius: "3px",
                    color: "#5c3a2d",
                  }}
                >
                  {card.verifyAnswer}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* 三按钮（生成完才显示） */}
      {!loading && card && (
        <div className="space-y-2">
          <button
            onClick={handleExplainedThenPractice}
            className="w-full px-4 py-3 text-sm flex items-center justify-between transition-colors"
            style={{
              backgroundColor: "#2D5A3D",
              color: "#F8F4EB",
              borderRadius: "3px",
            }}
          >
            <span className="flex items-center gap-2">
              <CheckCircle2 size={14} strokeWidth={1.5} />
              讲完了，让 ta 再做一道
            </span>
            <ChevronRight size={14} strokeWidth={1.5} />
          </button>

          <button
            onClick={handleNeedMoreAngle}
            disabled={angleAttempts >= 2}
            className="w-full px-4 py-3 text-sm flex items-center justify-between transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            style={{
              backgroundColor: "rgba(255, 255, 255, 0.6)",
              color: "#1F1B16",
              borderRadius: "3px",
              border: "1px solid rgba(31, 27, 22, 0.15)",
            }}
            title={
              angleAttempts >= 2
                ? "已经换过两次角度了，建议先放一放"
                : "AI 会用完全不同的类比再讲一次"
            }
          >
            <span className="flex items-center gap-2">
              <RotateCcw size={14} strokeWidth={1.5} />
              {angleAttempts >= 2
                ? "已经换过两次了"
                : `还需要更多解释（换个角度${
                    angleAttempts > 0 ? `，已换 ${angleAttempts} 次` : ""
                  }）`}
            </span>
          </button>

          <button
            onClick={handleShelve}
            className="w-full px-4 py-3 text-sm flex items-center justify-between transition-colors"
            style={{
              backgroundColor: "transparent",
              color: "#1F1B16",
              borderRadius: "3px",
              border: "1px solid rgba(31, 27, 22, 0.12)",
              opacity: 0.85,
            }}
          >
            <span className="flex items-center gap-2 opacity-80">
              <Coffee size={14} strokeWidth={1.5} />
              先放一放，过几天再说
            </span>
          </button>
        </div>
      )}

      {/* thinking 折叠（生成完后保留，给好奇的家长看） */}
      {!loading && reasoning && (
        <details className="mt-6 text-[11px] opacity-60">
          <summary className="cursor-pointer select-none">AI 怎么想的</summary>
          <div
            className="mt-2 px-3 py-2 max-h-60 overflow-y-auto whitespace-pre-wrap leading-relaxed"
            style={{
              backgroundColor: "rgba(0, 0, 0, 0.04)",
              borderRadius: "3px",
              fontFamily: "ui-monospace, monospace",
            }}
          >
            {reasoning}
          </div>
        </details>
      )}
    </div>
  );
}

// ============================================================
// 孩子画像编辑 Screen
// ============================================================
function ProfileScreen({ kid, onUpdateProfile, onUpdateBasic, onBack }) {
  const [profile, setProfile] = useState(kid.profile || defaultKidProfile);
  const [name, setName] = useState(kid.name);
  const [grade, setGrade] = useState(kid.grade);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    setProfile(kid.profile || defaultKidProfile);
    setName(kid.name);
    setGrade(kid.grade);
    setDirty(false);
  }, [kid.id]); // eslint-disable-line

  const save = () => {
    if (name !== kid.name || grade !== kid.grade) {
      onUpdateBasic({ name, grade });
    }
    onUpdateProfile(profile);
    setDirty(false);
  };

  return (
    <div className="fade-up max-w-md">
      <div className="mb-6">
        <div className="text-xs opacity-50 serif italic mb-1">
          {kid.name} 的画像
        </div>
        <h1 className="serif text-3xl mb-2" style={{ fontWeight: 400 }}>
          让 AI 更懂 ta
        </h1>
        <p className="text-sm opacity-60 leading-relaxed">
          填得越具体，AI 在分析错题时就越能对症下药。随时可以回来更新——
          每隔几周更新一次最好，反映 ta 当前的状态。
        </p>
      </div>

      {/* 基本信息 */}
      <div className="mb-6 space-y-3">
        <div>
          <div className="text-[10px] uppercase tracking-wider opacity-40 font-semibold mb-1">
            名字
          </div>
          <input
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setDirty(true);
            }}
            className="w-full px-3 py-2 text-sm focus:outline-none"
            style={{
              border: "1px solid rgba(31, 27, 22, 0.15)",
              borderRadius: "2px",
              backgroundColor: "rgba(255, 255, 255, 0.5)",
            }}
          />
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wider opacity-40 font-semibold mb-1">
            年级
          </div>
          <select
            value={grade}
            onChange={(e) => {
              setGrade(e.target.value);
              setDirty(true);
            }}
            className="w-full px-3 py-2 text-sm focus:outline-none"
            style={{
              border: "1px solid rgba(31, 27, 22, 0.15)",
              borderRadius: "2px",
              backgroundColor: "rgba(255, 255, 255, 0.5)",
            }}
          >
            {[
              "幼儿园",
              "一年级",
              "二年级",
              "三年级",
              "四年级",
              "五年级",
              "六年级",
              "初一",
              "初二",
              "初三",
            ].map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* 画像字段 */}
      <div className="space-y-5 mb-8">
        <ProfileField
          label="近期在学"
          placeholder="例如：语文第 5 单元（识字二），数学学到 20 以内加减法"
          hint="具体到单元或知识点。AI 会结合当前进度分析"
          value={profile.current_topics}
          onChange={(v) => {
            setProfile({ ...profile, current_topics: v });
            setDirty(true);
          }}
        />
        <ProfileField
          label="已掌握较好的"
          placeholder="例如：拼音整体认读基本稳；数感不错，10以内运算流畅"
          hint="写 ta 的长板，AI 就不会在这些地方啰嗦"
          value={profile.strengths}
          onChange={(v) => {
            setProfile({ ...profile, strengths: v });
            setDirty(true);
          }}
        />
        <ProfileField
          label="已知薄弱点"
          placeholder="例如：前后鼻音 in/ing 混淆；形近字如'入/人、大/太'容易错；进位加法不熟"
          hint="写出当前的难点，AI 会更对症"
          value={profile.weaknesses}
          onChange={(v) => {
            setProfile({ ...profile, weaknesses: v });
            setDirty(true);
          }}
        />
        <ProfileField
          label="其他情况"
          placeholder="例如：专注度约 15 分钟；对故事情境敏感；写字慢但工整"
          hint="任何对辅导有帮助的信息都可以写"
          value={profile.notes}
          onChange={(v) => {
            setProfile({ ...profile, notes: v });
            setDirty(true);
          }}
        />
      </div>

      <div className="flex gap-3 items-center">
        <button
          onClick={save}
          disabled={!dirty}
          className="px-5 py-2.5 text-sm disabled:opacity-30"
          style={{
            backgroundColor: "#2D5A3D",
            color: "#F8F4EB",
            borderRadius: "2px",
          }}
        >
          {dirty ? "保存画像" : "已是最新"}
        </button>
        {dirty && (
          <button
            onClick={onBack}
            className="text-sm opacity-60 hover:opacity-100"
          >
            不保存，返回
          </button>
        )}
      </div>
    </div>
  );
}

function ProfileField({ label, placeholder, hint, value, onChange }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider opacity-50 font-semibold mb-1">
        {label}
      </div>
      <textarea
        value={value || ""}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={2}
        className="w-full px-3 py-2 text-sm leading-relaxed focus:outline-none resize-none"
        style={{
          border: "1px solid rgba(31, 27, 22, 0.15)",
          borderRadius: "2px",
          backgroundColor: "rgba(255, 255, 255, 0.5)",
        }}
      />
      {hint && (
        <div className="text-[11px] opacity-40 mt-1 italic leading-relaxed">
          {hint}
        </div>
      )}
    </div>
  );
}

// ============================================================
// 完整时间线 + 搜索 + 筛选
// ============================================================
// v4.6: 时间线分批渲染参数
//   · 初始渲染 50 条，足够覆盖刚进入时屏幕能滑两三屏
//   · 每次"加载更多"再追加 50 条
//   · 触发条件：底部哨兵进入视口（IntersectionObserver），或者用户点底部按钮
// 50 条是经过权衡的：
//   - 太少（如 20）：滑得快的用户每屏都要等加载，体感卡顿
//   - 太多（如 100+）：低端 Android 首屏就感受到压力，失去意义
//   - 50 条 ~4000 个 DOM 节点，任何 2018 年后的手机都流畅
const TIMELINE_PAGE_SIZE = 50;

function TimelineScreen({ kid, moments, onOpen, onUpdateStatus, onDelete }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("全部");
  const [subjectFilter, setSubjectFilter] = useState("全部学科");
  const [visibleCount, setVisibleCount] = useState(TIMELINE_PAGE_SIZE);

  const filtered = useMemo(() => {
    let result = moments;
    if (subjectFilter !== "全部学科") {
      result = result.filter((m) => (m.subject || "数学") === subjectFilter);
    }
    if (filter !== "全部") {
      result = result.filter((m) =>
        filter === "待复盘"
          ? m.status === "待复盘" || m.status === "进行中"
          : m.status === filter
      );
    }
    if (query.trim()) {
      const q = query.toLowerCase();
      result = result.filter(
        (m) =>
          m.problem.toLowerCase().includes(q) ||
          m.context?.toLowerCase().includes(q) ||
          m.reflection?.toLowerCase().includes(q) ||
          m.analysis?.misconception?.title?.toLowerCase().includes(q) ||
          m.tag?.toLowerCase().includes(q) ||
          // v4.6: 看图题的描述也参与搜索
          // 例如搜"三角形"能找到图中是三角形的题
          m.imageDescription?.toLowerCase().includes(q)
      );
    }
    return result;
  }, [moments, query, filter, subjectFilter]);

  // v4.6: 任何筛选条件变化都把分页重置回第一页，
  // 否则 "搜索 → 没找到 → 清空搜索 → 还停留在 vc=50" 体验不一致
  useEffect(() => {
    setVisibleCount(TIMELINE_PAGE_SIZE);
  }, [query, filter, subjectFilter]);

  // 实际要渲染的子集；其余的题暂不挂载
  const visible = useMemo(
    () => filtered.slice(0, visibleCount),
    [filtered, visibleCount]
  );
  const hasMore = visibleCount < filtered.length;

  // v4.6: IntersectionObserver 自动加载更多
  // 哨兵 div（loadMoreRef）在距离底部 300px 时触发，让加载与滚动几乎无感衔接
  const loadMoreRef = useRef(null);
  useEffect(() => {
    if (!hasMore) return;
    const node = loadMoreRef.current;
    if (!node) return;
    // 兼容性兜底：老浏览器没有 IntersectionObserver 就走"加载更多"按钮
    if (typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          // 用 functional setter 避免闭包陷阱
          setVisibleCount((c) => Math.min(c + TIMELINE_PAGE_SIZE, filtered.length));
        }
      },
      { rootMargin: "300px 0px" } // 提前 300px 触发，给加载留缓冲
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, filtered.length]);

  const grouped = useMemo(() => {
    const groups = {};
    visible.forEach((m) => {
      const d = new Date(m.createdAt);
      const key = `${d.getFullYear()} 年 ${d.getMonth() + 1} 月`;
      if (!groups[key]) groups[key] = [];
      groups[key].push(m);
    });
    return groups;
  }, [visible]);

  // 整体记忆概览：分析过的题里，按 retention 分三档统计
  const memoryOverview = useMemo(() => {
    const analyzed = moments.filter((m) => m.analysis && m.status !== "已记录");
    if (analyzed.length === 0) return null;
    let healthy = 0,
      due = 0,
      overdue = 0,
      cooling = 0; // v4.9: 冷却中的题数（已含在 due 里，单独计来给 tooltip 用）
    let avgRetention = 0;
    for (const m of analyzed) {
      const stats = calcMemoryStats(m);
      avgRetention += stats.retention;
      if (stats.level === "fresh") healthy++;
      else if (stats.level === "due") due++;
      else overdue++;
      if (stats.inCooldown) cooling++;
    }
    avgRetention /= analyzed.length;
    return { total: analyzed.length, healthy, due, overdue, cooling, avgRetention };
  }, [moments]);

  return (
    <div className="fade-up">
      <div className="mb-6">
        <div className="text-xs opacity-50 serif italic mb-2">
          {kid.name} 的成长时间线 · 共 {moments.length} 条
        </div>
        <h1 className="serif text-3xl" style={{ fontWeight: 400 }}>
          ta 走过的每一步
        </h1>
      </div>

      {/* 记忆健康度概览（hover 看完整说明，克制） */}
      {memoryOverview && (
        <div
          className="mb-6 p-3 fade-up-1"
          style={{
            backgroundColor: "rgba(255, 255, 255, 0.5)",
            border: "1px solid rgba(31, 27, 22, 0.08)",
            borderRadius: "3px",
          }}
          title={`基于艾宾浩斯遗忘曲线 R(t)=exp(-t/S) 估算的整体记忆健康度。\n共分析过 ${memoryOverview.total} 道题，平均预估保留率 ${Math.round(
            memoryOverview.avgRetention * 100
          )}%。`}
        >
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] uppercase tracking-wider opacity-50 font-semibold">
              记忆健康度
            </span>
            <span className="text-[11px] opacity-60 tabular-nums">
              平均保留率 {Math.round(memoryOverview.avgRetention * 100)}%
            </span>
          </div>
          {/* 三段彩条 */}
          <div
            className="flex h-1.5 overflow-hidden"
            style={{ borderRadius: 2, backgroundColor: "rgba(31, 27, 22, 0.06)" }}
          >
            {memoryOverview.healthy > 0 && (
              <div
                style={{
                  width: `${(memoryOverview.healthy / memoryOverview.total) * 100}%`,
                  backgroundColor: "#2D5A3D",
                }}
              />
            )}
            {memoryOverview.due > 0 && (
              <div
                style={{
                  width: `${(memoryOverview.due / memoryOverview.total) * 100}%`,
                  backgroundColor: "#B7791F",
                }}
              />
            )}
            {memoryOverview.overdue > 0 && (
              <div
                style={{
                  width: `${(memoryOverview.overdue / memoryOverview.total) * 100}%`,
                  backgroundColor: "#8B4513",
                }}
              />
            )}
          </div>
          <div className="flex gap-3 mt-2 text-[10px] opacity-70 flex-wrap">
            {/* v4.6 文案修复：让"该复了"跟首页的"待考察"严格对应（都是 overdue=间隔已到）。
               原来"该复了"放在 due（预警）上，跟首页 N 题待考察看上去对不上号。
               现在：
                 · 记得牢 = fresh（间隔没到，记忆还稳）
                 · 快忘了 = due（间隔还没到，但保留率已 <60%；预警，还没该考）
                 · 该复了 = overdue（间隔到了，这才是首页"待考察"对应的那一类）
               时间线 "该复了 N" === 首页 "N 题待考察"，前后口径一致。 */}
            <span style={{ color: "#2D5A3D" }}>
              ● 记得牢 {memoryOverview.healthy}
            </span>
            <span
              style={{ color: "#B7791F" }}
              title={
                memoryOverview.cooling > 0
                  ? `间隔还没到但记忆保留率已低于 60%（含 ${memoryOverview.cooling} 道刚答错冷却中、12 小时内不再出现的）。预警，还不需要立刻考察。`
                  : "间隔还没到，但记忆保留率已低于 60%。预警，还不需要立刻考察。"
              }
            >
              ● 快忘了 {memoryOverview.due}
            </span>
            <span style={{ color: "#8B4513" }} title="间隔已到（或被标记为需复习），就是首页『待考察』那一栏。">
              ● 该复了 {memoryOverview.overdue}
            </span>
          </div>
        </div>
      )}

      <div className="mb-6 space-y-3">
        <div
          className="flex items-center gap-2 px-3 py-2"
          style={{
            backgroundColor: "rgba(255, 255, 255, 0.5)",
            border: "1px solid rgba(31, 27, 22, 0.12)",
            borderRadius: "4px",
          }}
        >
          <Search size={14} className="opacity-50" />
          <input
            type="text"
            placeholder="搜索题目、反思、知识点……"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="flex-1 bg-transparent text-sm focus:outline-none"
          />
          {query && (
            <button
              onClick={() => setQuery("")}
              className="opacity-50 hover:opacity-100"
            >
              <X size={14} />
            </button>
          )}
        </div>
        <div className="flex gap-1.5 flex-wrap">
          {["全部学科", "数学", "语文"].map((s) => (
            <button
              key={s}
              onClick={() => setSubjectFilter(s)}
              className="px-3 py-1 text-xs rounded-full transition-all"
              style={{
                border: "1px solid rgba(31, 27, 22, 0.15)",
                backgroundColor: subjectFilter === s ? "rgba(45, 90, 61, 0.15)" : "transparent",
                fontWeight: subjectFilter === s ? 600 : 400,
              }}
            >
              {s}
            </button>
          ))}
        </div>
        <div className="flex gap-1.5 flex-wrap">
          {["全部", "待复盘", "需复习", "已理解"].map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className="px-3 py-1 text-xs rounded-full transition-all"
              style={{
                border: "1px solid rgba(31, 27, 22, 0.15)",
                backgroundColor: filter === f ? "#1F1B16" : "transparent",
                color: filter === f ? "#F8F4EB" : "inherit",
              }}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="py-10 text-center text-sm opacity-50 serif italic">
          {moments.length === 0 ? "还没有记录" : "没找到符合的记录"}
        </div>
      ) : (
        <div className="space-y-8">
          {Object.entries(grouped).map(([period, items]) => (
            <div key={period}>
              <div
                className="text-[10px] uppercase tracking-wider opacity-40 font-semibold mb-3 pb-1"
                style={{ borderBottom: "1px dashed rgba(31, 27, 22, 0.1)" }}
              >
                {period} · {items.length} 条
              </div>
              <div className="space-y-3">
                {items.map((m, i) => (
                  <MomentCard
                    key={m.id}
                    moment={m}
                    delay={i}
                    onClick={onOpen}
                    onUpdateStatus={onUpdateStatus}
                    onDelete={onDelete}
                  />
                ))}
              </div>
            </div>
          ))}

          {/* v4.6: 加载更多
              · 有更多时：显示哨兵 + 按钮（哨兵入视口自动加载，按钮兜底无障碍/老浏览器）
              · 已到底：显示"已显示全部 N 条"
              · 数量过少（<=PAGE_SIZE）：什么都不显示，避免噪声 */}
          {hasMore ? (
            <div ref={loadMoreRef} className="pt-2 pb-4 text-center">
              <button
                onClick={() =>
                  setVisibleCount((c) =>
                    Math.min(c + TIMELINE_PAGE_SIZE, filtered.length)
                  )
                }
                className="text-xs opacity-50 hover:opacity-90 inline-flex items-center gap-2 px-4 py-2"
                style={{
                  border: "1px dashed rgba(31, 27, 22, 0.2)",
                  borderRadius: 4,
                }}
              >
                <RefreshCw size={11} strokeWidth={1.5} />
                加载更多 · 已显示 {visible.length} / {filtered.length}
              </button>
            </div>
          ) : (
            filtered.length > TIMELINE_PAGE_SIZE && (
              <div className="pt-2 pb-4 text-center text-[11px] opacity-40 italic">
                · 已显示全部 {filtered.length} 条 ·
              </div>
            )
          )}
        </div>
      )}
    </div>
  );
}

// ============================================================
// 设置
// ============================================================
function SettingsScreen({
  kids,
  moments,
  onExport,
  onImport,
  onRefresh,
  onMigrate,
  onClearLocal,
  hasLegacy,
  family,
  quota,
}) {
  const fileInputRef = useRef(null);
  const [password, setPassword] = useState(getAccessPassword());
  const [passwordSaved, setPasswordSaved] = useState(false);
  const [signature, setSig] = useState(getSignature());
  const [sigSaved, setSigSaved] = useState(false);

  const earliestDate =
    moments.length > 0
      ? new Date(
          Math.min(...moments.map((m) => m.createdAt))
        ).toLocaleDateString("zh-CN")
      : "—";

  return (
    <div className="fade-up max-w-md">
      <h1 className="serif text-3xl mb-2" style={{ fontWeight: 400 }}>
        备份 & 设置
      </h1>
      <p className="text-sm opacity-60 leading-relaxed mb-8">
        数据存在家里的服务器上。家庭成员用同一个访问密码，看到的是同一份记录。
      </p>

      {/* 访问密码 */}
      <div
        className="mb-6 p-4"
        style={{
          backgroundColor: "rgba(45, 90, 61, 0.05)",
          borderLeft: "2px solid rgba(45, 90, 61, 0.3)",
        }}
      >
        <div className="text-[10px] uppercase tracking-wider opacity-60 font-semibold mb-2">
          访问密码
        </div>
        <div className="text-xs opacity-70 leading-relaxed mb-3">
          家里所有人共用这一个密码。换设备 / 换浏览器时需要重新输入。
        </div>
        <div className="flex gap-2">
          <input
            type="password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              setPasswordSaved(false);
            }}
            placeholder="访问密码"
            className="flex-1 px-3 py-2 text-sm focus:outline-none"
            style={{
              border: "1px solid rgba(31, 27, 22, 0.15)",
              borderRadius: "2px",
              backgroundColor: "white",
            }}
          />
          <button
            onClick={() => {
              setAccessPassword(password);
              setPasswordSaved(true);
              setTimeout(() => setPasswordSaved(false), 2000);
            }}
            className="px-4 py-2 text-sm"
            style={{
              backgroundColor: "#2D5A3D",
              color: "#F8F4EB",
              borderRadius: "2px",
            }}
          >
            {passwordSaved ? "已保存 ✓" : "保存"}
          </button>
        </div>
      </div>

      {/* 我是谁 */}
      <div
        className="mb-6 p-4"
        style={{
          backgroundColor: "rgba(45, 90, 61, 0.03)",
          borderLeft: "2px solid rgba(45, 90, 61, 0.2)",
        }}
      >
        <div className="text-[10px] uppercase tracking-wider opacity-60 font-semibold mb-2">
          我是谁（可选）
        </div>
        <div className="text-xs opacity-70 leading-relaxed mb-3">
          填上名字（比如「爸爸」「妈妈」），以后这台设备记的每条时刻会带上署名。
          方便你们俩翻记录时看到是谁记的。留空也行。
        </div>
        <div className="flex gap-2">
          <input
            type="text"
            value={signature}
            onChange={(e) => {
              setSig(e.target.value);
              setSigSaved(false);
            }}
            placeholder="例如：爸爸"
            className="flex-1 px-3 py-2 text-sm focus:outline-none"
            style={{
              border: "1px solid rgba(31, 27, 22, 0.15)",
              borderRadius: "2px",
              backgroundColor: "white",
            }}
          />
          <button
            onClick={() => {
              setSignature(signature.trim());
              setSigSaved(true);
              setTimeout(() => setSigSaved(false), 2000);
            }}
            className="px-4 py-2 text-sm"
            style={{
              backgroundColor: "rgba(31, 27, 22, 0.8)",
              color: "#F8F4EB",
              borderRadius: "2px",
            }}
          >
            {sigSaved ? "已保存 ✓" : "保存"}
          </button>
        </div>
      </div>

      {/* 家庭信息 + 今日配额 */}
      {family && (
        <div
          className="mb-6 p-4"
          style={{
            backgroundColor: "rgba(45, 90, 61, 0.04)",
            border: "1px solid rgba(45, 90, 61, 0.15)",
            borderRadius: "4px",
          }}
        >
          <div className="flex items-baseline justify-between mb-2">
            <span className="text-[10px] uppercase tracking-wider opacity-50 font-semibold">
              当前家庭
            </span>
            <span className="serif text-base" style={{ fontWeight: 500 }}>
              {family.name}
            </span>
          </div>
          {(() => {
            const used = quota?.used ?? 0;
            const total = quota?.total ?? family.quotaTotal ?? 0;
            const pct = total > 0 ? Math.min(100, (used / total) * 100) : 0;
            const color =
              pct >= 100 ? "#8B4513" : pct >= 80 ? "#B7791F" : "#2D5A3D";
            return (
              <div>
                <div className="flex items-baseline justify-between text-xs mb-1.5">
                  <span className="opacity-60">今日 AI 用量</span>
                  <span
                    className="font-semibold"
                    style={{ color }}
                  >
                    {used} / {total}
                  </span>
                </div>
                <div
                  className="h-1.5 rounded-full overflow-hidden"
                  style={{ backgroundColor: "rgba(31, 27, 22, 0.08)" }}
                >
                  <div
                    style={{
                      width: `${pct}%`,
                      height: "100%",
                      backgroundColor: color,
                      transition: "width 0.4s ease",
                    }}
                  />
                </div>
                {quota === null && (
                  <div className="text-[10px] opacity-40 italic mt-1.5">
                    记一道题或做一次识图，会显示今天的实际用量
                  </div>
                )}
              </div>
            );
          })()}
        </div>
      )}

      {/* 统计 */}
      <div className="space-y-3 mb-6">
        <StatRow label="陪着的孩子" value={`${kids.length} 个`} />
        <StatRow label="累计时刻" value={`${moments.length} 条`} />
        <StatRow label="最早一条" value={earliestDate} />
      </div>

      {/* 云端同步 */}
      <div className="space-y-2 mb-6">
        <button
          onClick={onRefresh}
          className="w-full flex items-center justify-between px-4 py-3 text-sm"
          style={{
            backgroundColor: "rgba(255, 255, 255, 0.5)",
            border: "1px solid rgba(31, 27, 22, 0.15)",
            borderRadius: "2px",
          }}
        >
          <span className="flex items-center gap-2">
            <RefreshCw size={16} strokeWidth={1.5} /> 从云端刷新
          </span>
          <ChevronRight size={14} />
        </button>
        <div className="text-[11px] opacity-50 italic leading-relaxed px-1">
          另一个家庭成员在其他设备记了内容？点这里拉到本设备。
        </div>
      </div>

      {/* 导入导出 */}
      <div className="space-y-2 mb-6">
        <button
          onClick={onExport}
          className="w-full flex items-center justify-between px-4 py-3 text-sm"
          style={{
            backgroundColor: "rgba(255, 255, 255, 0.5)",
            border: "1px solid rgba(31, 27, 22, 0.15)",
            borderRadius: "2px",
          }}
        >
          <span className="flex items-center gap-2">
            <Download size={16} strokeWidth={1.5} /> 导出为 JSON 备份
          </span>
          <ChevronRight size={14} />
        </button>

        <input
          ref={fileInputRef}
          type="file"
          accept=".json,application/json"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onImport(file);
            e.target.value = "";
          }}
        />
        <button
          onClick={() => fileInputRef.current?.click()}
          className="w-full flex items-center justify-between px-4 py-3 text-sm"
          style={{
            backgroundColor: "rgba(255, 255, 255, 0.5)",
            border: "1px solid rgba(31, 27, 22, 0.15)",
            borderRadius: "2px",
          }}
        >
          <span className="flex items-center gap-2">
            <Upload size={16} strokeWidth={1.5} /> 从 JSON 文件导入（覆盖云端）
          </span>
          <ChevronRight size={14} />
        </button>
        <div className="text-[11px] opacity-50 italic leading-relaxed px-1">
          建议每月导出一次到网盘，应对服务器故障。
        </div>
      </div>

      {/* 从本地迁移（仅在有旧数据时显示） */}
      {hasLegacy && (
        <div
          className="mb-6 p-4"
          style={{
            backgroundColor: "rgba(183, 121, 31, 0.08)",
            borderLeft: "2px solid rgba(183, 121, 31, 0.5)",
          }}
        >
          <div
            className="text-xs font-semibold mb-2"
            style={{ color: "#8B4513" }}
          >
            发现本地旧版本数据
          </div>
          <div className="text-xs opacity-80 leading-relaxed mb-3">
            这台浏览器上还留着旧版本（本地存储）的数据。点下面的按钮一键迁移到服务器。
            迁移完成后，建议再清空本地缓存保持干净。
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={onMigrate}
              className="px-3 py-1.5 text-xs"
              style={{
                backgroundColor: "#B7791F",
                color: "#F8F4EB",
                borderRadius: "2px",
              }}
            >
              迁移到云端 →
            </button>
            <button
              onClick={onClearLocal}
              className="px-3 py-1.5 text-xs opacity-80 hover:opacity-100"
              style={{
                border: "1px solid rgba(183, 121, 31, 0.4)",
                borderRadius: "2px",
              }}
            >
              清空本地缓存
            </button>
          </div>
        </div>
      )}

      <div
        className="p-4 text-xs leading-relaxed"
        style={{
          backgroundColor: "rgba(45, 90, 61, 0.04)",
          borderLeft: "2px solid rgba(45, 90, 61, 0.3)",
        }}
      >
        <div className="font-semibold mb-1" style={{ color: "#2D5A3D" }}>
          关于数据安全
        </div>
        <div className="opacity-80">
          记录存在家里的 MySQL 数据库。建议定期在服务器上备份一下（mysqldump），
          或定期在这里导出 JSON 存到网盘。
          清空数据库的操作不在这个界面——太危险，请直接登服务器做。
        </div>
      </div>
    </div>
  );
}

function StatRow({ label, value }) {
  return (
    <div
      className="flex items-baseline justify-between py-2"
      style={{ borderBottom: "1px dashed rgba(31, 27, 22, 0.1)" }}
    >
      <span className="text-sm opacity-60">{label}</span>
      <span className="serif text-base">{value}</span>
    </div>
  );
}
