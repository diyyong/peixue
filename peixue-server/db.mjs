// ============================================================
// 陪学笔记本 · 数据库层（MySQL）
// ============================================================
// 设计原则：
// - 一个部署可以管理多个家庭；所有家庭数据查询必须按 family_id 隔离。
// - 访问密码以 bcrypt hash 存在 families 表，认证成功后只访问对应家庭。
// - 所有时间戳用 BIGINT 存毫秒（兼容前端现有 Date.now() 格式）。
// - analysis 字段用 JSON 类型存（MySQL 5.7+），省去序列化/反序列化。
// ============================================================

import mysql from "mysql2/promise";
import "dotenv/config";

let pool = null;

export function getPool() {
  if (pool) return pool;
  const opts = {
    user: process.env.DB_USER || "peixue",
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_NAME || "peixue",
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    charset: "utf8mb4",
    timezone: "+08:00",
  };
  // 优先 unix socket（如果配置了）
  if (process.env.DB_SOCKET_PATH) {
    opts.socketPath = process.env.DB_SOCKET_PATH;
  } else {
    opts.host = process.env.DB_HOST || "127.0.0.1";
    opts.port = Number(process.env.DB_PORT) || 3306;
  }
  pool = mysql.createPool(opts);
  return pool;
}

// ============================================================
// Schema 初始化：启动时检查表是否存在，不存在就建
// 支持从旧 schema（无 family_id）平滑升级到新 schema
// ============================================================
export async function initSchema() {
  const db = getPool();

  // families：家庭表
  await db.query(`
    CREATE TABLE IF NOT EXISTS families (
      id VARCHAR(64) PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      expires_at BIGINT NOT NULL,
      daily_quota INT NOT NULL DEFAULT 100,
      note VARCHAR(500),
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      INDEX idx_expires (expires_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // kids（加 family_id）
  await db.query(`
    CREATE TABLE IF NOT EXISTS kids (
      id VARCHAR(64) PRIMARY KEY,
      family_id VARCHAR(64) NOT NULL,
      name VARCHAR(100) NOT NULL,
      grade VARCHAR(50),
      avatar VARCHAR(16),
      since VARCHAR(100),
      profile_current_topics TEXT,
      profile_strengths TEXT,
      profile_weaknesses TEXT,
      profile_notes TEXT,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      deleted TINYINT(1) DEFAULT 0,
      INDEX idx_family (family_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // moments（加 family_id；外键保留 kid_id）
  // v4.6: 新增 image_data / image_description 两列，支持看图题
  //   · image_data: 压缩后的 base64 dataURL（含 data:image/jpeg;base64,…前缀）
  //                 用 MEDIUMTEXT 上限 16MB，单图 100~300KB 完全够
  //   · image_description: 视觉模型识别后写出的"图里有什么"（50~150字）
  //                 给后续不带视觉的文本模型当眼睛用
  // v4.9: 新增 wrong_streak / last_wrong_at 两列，给"反复错→讲解卡"用
  //   · wrong_streak: 连续答错次数。带 12h 间隔判定（同 12h 内多次错只算 1）。
  //                   答对清零；讲解卡走完后第一次答对也清零。
  //   · last_wrong_at: 上次答错的时间戳。判 12h 间隔时用；同时给"冷却期"
  //                    过滤——过去 12h 内错过的题暂时不出现在复习池里，
  //                    给孩子换个状态再练。
  await db.query(`
    CREATE TABLE IF NOT EXISTS moments (
      id VARCHAR(64) PRIMARY KEY,
      family_id VARCHAR(64) NOT NULL,
      kid_id VARCHAR(64) NOT NULL,
      subject VARCHAR(20),
      problem TEXT NOT NULL,
      context TEXT,
      analysis JSON,
      reflection TEXT,
      tag VARCHAR(50),
      status VARCHAR(20),
      interval_days INT NOT NULL DEFAULT 1,
      wrong_streak INT NOT NULL DEFAULT 0,
      last_wrong_at BIGINT,
      image_data MEDIUMTEXT,
      image_description TEXT,
      created_by VARCHAR(50),
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      INDEX idx_family (family_id),
      INDEX idx_kid (kid_id),
      INDEX idx_created (created_at),
      CONSTRAINT fk_moments_kid FOREIGN KEY (kid_id)
        REFERENCES kids(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // app_settings（加 family_id 作为复合主键的一部分）
  await db.query(`
    CREATE TABLE IF NOT EXISTS app_settings (
      family_id VARCHAR(64) NOT NULL,
      k VARCHAR(50) NOT NULL,
      v TEXT,
      updated_at BIGINT NOT NULL,
      PRIMARY KEY (family_id, k)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // daily_usage：每个家庭每天的 AI 调用计数
  await db.query(`
    CREATE TABLE IF NOT EXISTS daily_usage (
      family_id VARCHAR(64) NOT NULL,
      usage_date DATE NOT NULL,
      call_count INT NOT NULL DEFAULT 0,
      updated_at BIGINT NOT NULL,
      PRIMARY KEY (family_id, usage_date),
      INDEX idx_date (usage_date)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // audit_log：每次 AI 调用的审计记录（不含 prompt 内容，尊重隐私）
  await db.query(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      family_id VARCHAR(64) NOT NULL,
      endpoint VARCHAR(50) NOT NULL,
      success TINYINT(1) NOT NULL,
      error_msg VARCHAR(255),
      ip VARCHAR(64),
      latency_ms INT,
      model VARCHAR(100),
      created_at BIGINT NOT NULL,
      INDEX idx_family_time (family_id, created_at),
      INDEX idx_time (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // cached_quizzes（v4.7）：复习考察题的预生成缓存
  // ─────────────────────────────────────────────────────────
  // 设计要点：
  // · 每道 moment 最多缓存一道复习题 → moment_id 当主键
  // · ON DELETE CASCADE：moment 被删，缓存自动清，免维护
  // · 不设过期时间。缓存只在三种情况下失效：
  //     1) 家长做完该题 → 后端 DELETE
  //     2) 家长拒绝该题（再出一题） → 后端 DELETE
  //     3) 原 moment 的题面/图描述被改 → updateMoment 时自动 DELETE
  // · 写入接口幂等：发现已有缓存就直接返回，不调 AI，所以前端
  //   随便重复触发预热请求都不会重复消耗 token
  // cached_quizzes（v4.7）：复习考察题的预生成缓存（前面已说明）
  await db.query(`
    CREATE TABLE IF NOT EXISTS cached_quizzes (
      moment_id VARCHAR(64) PRIMARY KEY,
      family_id VARCHAR(64) NOT NULL,
      quiz_question TEXT NOT NULL,
      quiz_svg MEDIUMTEXT,
      expected_answer TEXT,
      key_check TEXT,
      if_correct TEXT,
      if_wrong TEXT,
      generated_at BIGINT NOT NULL,
      INDEX idx_family (family_id),
      CONSTRAINT fk_cache_moment FOREIGN KEY (moment_id)
        REFERENCES moments(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // quiz_history（v4.8）：每道 AI 出过的复习题的历史
  // ─────────────────────────────────────────────────────────
  // 用途：
  //   1) 出题去重：下次出题时把最近 3-5 道历史题塞进 prompt，避免 AI 出重复
  //   2) 学习轨迹：以后做"孩子档案页统计"功能的数据基础
  //
  // 设计：
  //   · 每道复习题答完都写一行（answered_at 设为家长确认结果时间）
  //   · 题面变了 / 删 moment 时，CASCADE 自动清掉对应历史
  //     —— 这是合理的，因为旧题的"考察"已没意义
  //   · result 字段记录答对/错/跳过/未答完，给统计用
  //   · 不存 quiz_svg 等附加字段（去重 prompt 只需要题面文本，节省存储）
  //
  // 索引：
  //   (moment_id, answered_at) —— 给"取这道题最近 N 次历史"用，最常见查询
  //   (family_id, answered_at) —— 给"这个家庭最近一段时间的统计"用
  // v4.8.1: 加 quiz_svg 列，看图题的图也要存进历史
  await db.query(`
    CREATE TABLE IF NOT EXISTS quiz_history (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      moment_id VARCHAR(64) NOT NULL,
      family_id VARCHAR(64) NOT NULL,
      kid_id VARCHAR(64) NOT NULL,
      quiz_question TEXT NOT NULL,
      quiz_svg MEDIUMTEXT,
      expected_answer TEXT,
      result VARCHAR(20),
      answered_at BIGINT NOT NULL,
      INDEX idx_moment_time (moment_id, answered_at),
      INDEX idx_family_time (family_id, answered_at),
      INDEX idx_kid_time (kid_id, answered_at),
      CONSTRAINT fk_history_moment FOREIGN KEY (moment_id)
        REFERENCES moments(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // explanation_cards（v4.9）：讲解卡历史
  // ─────────────────────────────────────────────────────────
  // 触发：moment.wrong_streak >= 3 时，复习屏不再出题，改弹讲解卡。
  // 目标：给家长一段可以照着讲的脚本（开场+类比+完整讲解+SVG+复述提问+验证题），
  //       对应教学法上的"先共情，再用具象类比，最后让孩子复述"。
  //
  // 字段语义：
  //   · for_moment_id: 关联到原错题；moment 删时 CASCADE
  //   · trigger_wrong_streak: 触发时这道题已经错了几次（用于事后分析）
  //   · 五大块内容字段（opening / analogy_core / script / visual_svg /
  //                     check_question / verify_problem / verify_svg / verify_answer）
  //   · used_at: 家长按了"讲完了让 ta 做一道"的时间；null 表示卡还没用过
  //   · user_feedback: 三个按钮的反馈值
  //         "explained_then_practice"  讲完了让 ta 再做一道
  //         "needed_more_angle"        还需要更多解释（生成下一张卡）
  //         "shelved"                  先放一放，moment 进暂搁
  //   · model: 生成这张卡用的模型（同 audit_log 的字段语义）
  //
  // 索引：
  //   (moment_id, created_at) —— 取一道题的讲解历史，最常见查询
  //   (family_id, created_at) —— 家庭范围统计用
  await db.query(`
    CREATE TABLE IF NOT EXISTS explanation_cards (
      id VARCHAR(64) PRIMARY KEY,
      family_id VARCHAR(64) NOT NULL,
      moment_id VARCHAR(64) NOT NULL,
      trigger_wrong_streak INT NOT NULL,
      opening TEXT,
      analogy_core VARCHAR(255),
      script TEXT,
      visual_svg MEDIUMTEXT,
      check_question TEXT,
      verify_problem TEXT,
      verify_svg MEDIUMTEXT,
      verify_answer TEXT,
      model VARCHAR(100),
      created_at BIGINT NOT NULL,
      used_at BIGINT,
      user_feedback VARCHAR(40),
      INDEX idx_moment_time (moment_id, created_at),
      INDEX idx_family_time (family_id, created_at),
      CONSTRAINT fk_explanation_moment FOREIGN KEY (moment_id)
        REFERENCES moments(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // —— 迁移：旧库（v3 无 family_id）如果存在 kids 但没 family_id 列，补上
  await migrateV3ToV4(db);

  // —— 迁移：v4 老库可能没有 interval_days 列（间隔重复需要），补上
  await migrateAddIntervalDays(db);

  // —— 迁移：v4.6 给 moments 表补 image_data / image_description 列（看图题）
  await migrateAddImageFields(db);

  // —— 迁移：v4.8.1 给 quiz_history 表补 quiz_svg 列（看图题历史也要存图）
  await migrateAddQuizSvgToHistory(db);

  // —— 迁移：v4.9 给 moments 表补 wrong_streak / last_wrong_at 列
  await migrateAddWrongStreakFields(db);
}

// v4.9: 给 moments 表补 wrong_streak / last_wrong_at 列。
// 老库（v4.8.x 时部署的）moments 已存在但没这两列，新建库的 CREATE 已含。
// 迁移幂等：检测到已有列就跳过单列。
async function migrateAddWrongStreakFields(db) {
  const [cols] = await db.query(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'moments'
       AND COLUMN_NAME IN ('wrong_streak', 'last_wrong_at')`
  );
  const existing = new Set(cols.map((c) => c.COLUMN_NAME));
  if (!existing.has("wrong_streak")) {
    console.log("⚙️  给 moments 表补 wrong_streak 列（连续错次数，触发讲解卡用）...");
    await db.query(
      `ALTER TABLE moments ADD COLUMN wrong_streak INT NOT NULL DEFAULT 0
       AFTER interval_days`
    );
  }
  if (!existing.has("last_wrong_at")) {
    console.log("⚙️  给 moments 表补 last_wrong_at 列（12h 冷却用）...");
    await db.query(
      `ALTER TABLE moments ADD COLUMN last_wrong_at BIGINT
       AFTER wrong_streak`
    );
  }
  if (existing.size < 2) {
    console.log("✅ 反复错题相关字段已就绪");
  }
}

// v4.8.1: quiz_history 表补 quiz_svg 列。
// 老库（v4.8.0 时部署的）quiz_history 已存在但没这列，新建库的 CREATE 已含此列，
// 所以这个迁移是幂等的：检测到已有列就跳过。
async function migrateAddQuizSvgToHistory(db) {
  // 先确认 quiz_history 表存在，否则 ALTER 会报错（首次启动 CREATE 会兜底）
  const [tables] = await db.query(
    `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'quiz_history'`
  );
  if (tables.length === 0) return; // 表都没有，CREATE 已经把列建好了，无需迁移

  const [cols] = await db.query(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'quiz_history'
       AND COLUMN_NAME = 'quiz_svg'`
  );
  if (cols.length > 0) return; // 已有，跳过

  console.log("⚙️  给 quiz_history 表补 quiz_svg 列（看图题历史的图）...");
  await db.query(
    `ALTER TABLE quiz_history ADD COLUMN quiz_svg MEDIUMTEXT AFTER quiz_question`
  );
  console.log("✅ quiz_history.quiz_svg 已就绪");
}

// 给已有 moments 表补 image_data / image_description 列（看图题需要）
async function migrateAddImageFields(db) {
  const [cols] = await db.query(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'moments'
       AND COLUMN_NAME IN ('image_data', 'image_description')`
  );
  const existing = new Set(cols.map((c) => c.COLUMN_NAME));
  if (!existing.has("image_data")) {
    console.log("⚙️  给 moments 表补 image_data 列（看图题图片存储）...");
    await db.query(
      `ALTER TABLE moments ADD COLUMN image_data MEDIUMTEXT AFTER interval_days`
    );
  }
  if (!existing.has("image_description")) {
    console.log("⚙️  给 moments 表补 image_description 列（图像描述）...");
    await db.query(
      `ALTER TABLE moments ADD COLUMN image_description TEXT AFTER image_data`
    );
  }
  if (existing.size < 2) {
    console.log("✅ 看图题字段已就绪");
  }
}

// 给已有 moments 表补 interval_days 列（间隔重复算法用）
async function migrateAddIntervalDays(db) {
  const [cols] = await db.query(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'moments'
       AND COLUMN_NAME = 'interval_days'`
  );
  if (cols.length > 0) return; // 已有，跳过

  console.log("⚙️  给 moments 表补 interval_days 列...");
  await db.query(
    `ALTER TABLE moments ADD COLUMN interval_days INT NOT NULL DEFAULT 1
     AFTER status`
  );
  console.log("✅ interval_days 列已添加，默认值 1（次日复习）");
}

// 从 v3 无 family_id 的 schema 升级到 v4
async function migrateV3ToV4(db) {
  // 检查 kids 表是否有 family_id 列
  const [cols] = await db.query(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'kids'`
  );
  const hasFamily = cols.some((c) => c.COLUMN_NAME === "family_id");
  if (hasFamily) return; // 新库或已迁移过，跳过

  // 老库已有数据，需要迁移：创建默认家庭，把现有数据挂过去
  console.log("⚙️  检测到 v3 旧库，开始迁移到 v4...");

  // 从环境变量拿老的 ACCESS_PASSWORD 作为默认家庭密码。绝不静默使用
  // 公共默认密码，否则旧库迁移完成后会直接暴露家庭数据。
  const legacyPw = (process.env.ACCESS_PASSWORD || "").trim();
  if (!legacyPw || legacyPw === "changeme") {
    throw new Error(
      "检测到 v3 旧库，但未设置安全的 ACCESS_PASSWORD。请在 .env 配置原访问密码后重启迁移。"
    );
  }
  const bcrypt = (await import("bcryptjs")).default;
  const pwHash = await bcrypt.hash(legacyPw, 10);

  const defaultFamilyId = "default";
  const now = Date.now();
  const oneYearLater = now + 365 * 24 * 60 * 60 * 1000;

  await db.query(
    `INSERT INTO families (id, name, password_hash, expires_at, daily_quota, note, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE updated_at = VALUES(updated_at)`,
    [defaultFamilyId, "默认家庭（迁移）", pwHash, oneYearLater, 1000,
     "从 v3 ACCESS_PASSWORD 自动迁移。建议用 admin.mjs 重设密码", now, now]
  );

  // 现有 kids 加 family_id 列并全部归属到 default
  await db.query(`ALTER TABLE kids ADD COLUMN family_id VARCHAR(64) NOT NULL DEFAULT 'default'`);
  await db.query(`UPDATE kids SET family_id = 'default'`);
  await db.query(`ALTER TABLE kids ALTER COLUMN family_id DROP DEFAULT`);
  await db.query(`ALTER TABLE kids ADD INDEX idx_family (family_id)`);

  // 现有 moments 加 family_id
  await db.query(`ALTER TABLE moments ADD COLUMN family_id VARCHAR(64) NOT NULL DEFAULT 'default'`);
  await db.query(`UPDATE moments SET family_id = 'default'`);
  await db.query(`ALTER TABLE moments ALTER COLUMN family_id DROP DEFAULT`);
  await db.query(`ALTER TABLE moments ADD INDEX idx_family (family_id)`);

  // app_settings 重建主键（加 family_id）
  // 老表是 PRIMARY KEY (k)，新表需要 PRIMARY KEY (family_id, k)
  const [settingsRows] = await db.query(`SELECT k, v, updated_at FROM app_settings`);
  await db.query(`DROP TABLE app_settings`);
  await db.query(`
    CREATE TABLE app_settings (
      family_id VARCHAR(64) NOT NULL,
      k VARCHAR(50) NOT NULL,
      v TEXT,
      updated_at BIGINT NOT NULL,
      PRIMARY KEY (family_id, k)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  for (const row of settingsRows) {
    await db.query(
      `INSERT INTO app_settings (family_id, k, v, updated_at) VALUES (?, ?, ?, ?)`,
      ["default", row.k, row.v, row.updated_at]
    );
  }

  console.log(`✅ v3→v4 迁移完成：创建默认家庭 id=default，现有数据已归属`);
  console.log(`   默认家庭密码为原 ACCESS_PASSWORD，配额 1000/天，一年后过期`);
  console.log(`   建议运行 admin.mjs 改密码和配额`);
}

// ============================================================
// Kids CRUD（全部按 family_id 过滤）
// ============================================================
export async function listKids(familyId) {
  const db = getPool();
  const [rows] = await db.query(
    "SELECT * FROM kids WHERE family_id = ? AND deleted = 0 ORDER BY created_at ASC",
    [familyId]
  );
  return rows.map(rowToKid);
}

export async function getKid(familyId, id) {
  const db = getPool();
  const [rows] = await db.query(
    "SELECT * FROM kids WHERE family_id = ? AND id = ? AND deleted = 0",
    [familyId, id]
  );
  return rows[0] ? rowToKid(rows[0]) : null;
}

export async function createKid(familyId, kid) {
  const db = getPool();
  const now = Date.now();
  const p = kid.profile || {};
  await db.query(
    `INSERT INTO kids (id, family_id, name, grade, avatar, since,
      profile_current_topics, profile_strengths, profile_weaknesses, profile_notes,
      created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      kid.id,
      familyId,
      kid.name,
      kid.grade || "一年级",
      kid.avatar || "🌱",
      kid.since || new Date().toLocaleDateString("zh-CN"),
      p.current_topics || "",
      p.strengths || "",
      p.weaknesses || "",
      p.notes || "",
      now,
      now,
    ]
  );
  return await getKid(familyId, kid.id);
}

export async function updateKid(familyId, id, changes) {
  const db = getPool();
  const fields = [];
  const values = [];

  if (changes.name !== undefined) { fields.push("name = ?"); values.push(changes.name); }
  if (changes.grade !== undefined) { fields.push("grade = ?"); values.push(changes.grade); }
  if (changes.avatar !== undefined) { fields.push("avatar = ?"); values.push(changes.avatar); }

  if (changes.profile) {
    const p = changes.profile;
    if (p.current_topics !== undefined) {
      fields.push("profile_current_topics = ?");
      values.push(p.current_topics);
    }
    if (p.strengths !== undefined) {
      fields.push("profile_strengths = ?");
      values.push(p.strengths);
    }
    if (p.weaknesses !== undefined) {
      fields.push("profile_weaknesses = ?");
      values.push(p.weaknesses);
    }
    if (p.notes !== undefined) {
      fields.push("profile_notes = ?");
      values.push(p.notes);
    }
  }

  if (fields.length === 0) return await getKid(familyId, id);

  fields.push("updated_at = ?");
  values.push(Date.now());
  values.push(familyId);
  values.push(id);

  await db.query(
    `UPDATE kids SET ${fields.join(", ")} WHERE family_id = ? AND id = ? AND deleted = 0`,
    values
  );
  return await getKid(familyId, id);
}

export async function deleteKid(familyId, id) {
  const db = getPool();
  await db.query("DELETE FROM kids WHERE family_id = ? AND id = ?", [familyId, id]);
  return true;
}

// ============================================================
// Moments CRUD（全部按 family_id 过滤）
// ============================================================
// 性能注意：image_data 字段可能是几百 KB 的 base64，
// 列表查询 (listMoments / exportAll) 不应返回它，否则 N 条 = N×几百KB。
// 做法：列表 SELECT 时显式列字段，把 image_data 排除在外，
//      只用 (image_data IS NOT NULL) 算出一个 has_image 布尔标志。
// 单条查询 (getMoment) 才返完整字段（含图）。
//
// ⚠️ 必须给每个字段加 m. 前缀。listMoments 是 moments JOIN kids，
// id / family_id / kid_id / created_at 这些列两表都有，不加前缀会报
// "Column 'id' in SELECT is ambiguous"。
// ============================================================
const MOMENT_LIST_COLS = `
  m.id, m.family_id, m.kid_id, m.subject, m.problem, m.context, m.analysis,
  m.reflection, m.tag, m.status, m.interval_days,
  m.wrong_streak, m.last_wrong_at,
  (m.image_data IS NOT NULL) AS has_image,
  m.image_description,
  m.created_by, m.created_at, m.updated_at
`;

export async function listMoments(familyId) {
  const db = getPool();
  const [rows] = await db.query(
    `SELECT ${MOMENT_LIST_COLS} FROM moments m
     INNER JOIN kids k
       ON m.kid_id = k.id AND k.family_id = m.family_id AND k.deleted = 0
     WHERE m.family_id = ?
     ORDER BY m.created_at DESC`,
    [familyId]
  );
  return rows.map(rowToMoment);
}

export async function getMoment(familyId, id) {
  const db = getPool();
  const [rows] = await db.query(
    "SELECT * FROM moments WHERE family_id = ? AND id = ?",
    [familyId, id]
  );
  return rows[0] ? rowToMoment(rows[0], { withImage: true }) : null;
}

// v5.0 性能修复：createMoment / updateMoment 之后返回给前端的 moment
// 不应包含 image_data 字段（可能几百 KB 的 base64）。
// 客户端原本就持有 imageData（用户刚上传/编辑的），列表 state 也只存瘦身版，
// 返回完整版只是浪费一来一回的带宽（这是「保存要 2-3 秒」的主因之一）。
// 列字段与 MOMENT_LIST_COLS 一致，但去掉了 JOIN（单条查询不需要 kids 表）。
export async function getMomentLite(familyId, id) {
  const db = getPool();
  const [rows] = await db.query(
    `SELECT
      id, family_id, kid_id, subject, problem, context, analysis,
      reflection, tag, status, interval_days,
      wrong_streak, last_wrong_at,
      (image_data IS NOT NULL) AS has_image,
      image_description,
      created_by, created_at, updated_at
     FROM moments WHERE family_id = ? AND id = ?`,
    [familyId, id]
  );
  return rows[0] ? rowToMoment(rows[0]) : null;
}

export async function createMoment(familyId, m) {
  const db = getPool();
  const now = Date.now();
  const kid = await getKid(familyId, m.kidId);
  if (!kid) throw new TypeError("kidId 不属于当前家庭");
  await db.query(
    `INSERT INTO moments (id, family_id, kid_id, subject, problem, context, analysis,
      reflection, tag, status, interval_days, wrong_streak, last_wrong_at,
      image_data, image_description,
      created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      m.id,
      familyId,
      m.kidId,
      m.subject || "数学",
      m.problem,
      m.context || "",
      m.analysis ? JSON.stringify(m.analysis) : null,
      m.reflection || "",
      m.tag || "新",
      m.status || "已记录",
      Number.isFinite(m.intervalDays) ? m.intervalDays : 1,
      Number.isFinite(m.wrongStreak) ? m.wrongStreak : 0,
      Number.isFinite(m.lastWrongAt) ? m.lastWrongAt : null,
      m.imageData || null,
      m.imageDescription || null,
      m.created_by || null,
      m.createdAt || now,
      now,
    ]
  );
  // v5.0：返回不含 image_data 的轻量版本。客户端本就持有 imageData。
  // 把它原样回传只会让保存请求来回多走几百 KB，把保存延迟从 ~500ms 拖到 2-3s。
  return await getMomentLite(familyId, m.id);
}

export async function updateMoment(familyId, id, changes) {
  const db = getPool();
  const fields = [];
  const values = [];

  const fieldMap = {
    subject: "subject",
    problem: "problem",
    context: "context",
    reflection: "reflection",
    tag: "tag",
    status: "status",
    intervalDays: "interval_days",
    wrongStreak: "wrong_streak",
    lastWrongAt: "last_wrong_at",
    imageData: "image_data",
    imageDescription: "image_description",
    created_by: "created_by",
  };

  for (const [key, col] of Object.entries(fieldMap)) {
    if (changes[key] !== undefined) {
      fields.push(`${col} = ?`);
      // imageData / imageDescription：null 表示删除
      values.push(changes[key] === null ? null : changes[key]);
    }
  }

  if (changes.analysis !== undefined) {
    fields.push("analysis = ?");
    values.push(changes.analysis ? JSON.stringify(changes.analysis) : null);
  }

  if (fields.length === 0) return await getMomentLite(familyId, id);

  fields.push("updated_at = ?");
  values.push(Date.now());
  values.push(familyId);
  values.push(id);

  await db.query(
    `UPDATE moments SET ${fields.join(", ")} WHERE family_id = ? AND id = ?`,
    values
  );

  // v4.7: 题面或图描述变了，原先预生成的复习题就不再适用了，清掉缓存。
  // 修改其他字段（status/reflection/intervalDays 等）不影响缓存的有效性，
  // 不要无脑清，否则用户做完题打 status="已理解" 时也会触发清缓存浪费。
  if (changes.problem !== undefined || changes.imageDescription !== undefined) {
    await db.query(
      "DELETE FROM cached_quizzes WHERE family_id = ? AND moment_id = ?",
      [familyId, id]
    );
  }

  // v5.0：同 createMoment，返回不含 image_data 的轻量版本，省掉一次几百 KB 回传。
  return await getMomentLite(familyId, id);
}

export async function deleteMoment(familyId, id) {
  const db = getPool();
  await db.query("DELETE FROM moments WHERE family_id = ? AND id = ?", [familyId, id]);
  return true;
}

// ============================================================
// App Settings（按 family_id 隔离）
// ============================================================
export async function getSetting(familyId, key, fallback = null) {
  const db = getPool();
  const [rows] = await db.query(
    "SELECT v FROM app_settings WHERE family_id = ? AND k = ?",
    [familyId, key]
  );
  return rows[0]?.v ?? fallback;
}

export async function setSetting(familyId, key, value) {
  const db = getPool();
  const now = Date.now();
  await db.query(
    `INSERT INTO app_settings (family_id, k, v, updated_at) VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE v = VALUES(v), updated_at = VALUES(updated_at)`,
    [familyId, key, value, now]
  );
}

// ============================================================
// 一次性从 JSON 导入（迁移旧数据，只影响指定家庭）
// ============================================================
export function validateImportPayload(json) {
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    throw new TypeError("导入内容必须是 JSON 对象");
  }

  const kids = json.kids;
  const moments = json.moments;
  if (!Array.isArray(kids) || !Array.isArray(moments)) {
    throw new TypeError("导入内容缺少 kids 或 moments 数组");
  }
  if (kids.length > 1000 || moments.length > 100000) {
    throw new RangeError("导入数据超出安全上限");
  }

  const kidIds = new Set();
  for (const kid of kids) {
    if (!kid || typeof kid.id !== "string" || !kid.id.trim() || !kid.name) {
      throw new TypeError("每个孩子都必须有有效的 id 和 name");
    }
    if (kidIds.has(kid.id)) throw new TypeError(`孩子 id 重复: ${kid.id}`);
    kidIds.add(kid.id);
  }

  const momentIds = new Set();
  for (const moment of moments) {
    if (
      !moment ||
      typeof moment.id !== "string" ||
      !moment.id.trim() ||
      typeof moment.kidId !== "string" ||
      !moment.problem
    ) {
      throw new TypeError("每条记录都必须有有效的 id、kidId 和 problem");
    }
    if (momentIds.has(moment.id)) throw new TypeError(`记录 id 重复: ${moment.id}`);
    if (!kidIds.has(moment.kidId)) {
      throw new TypeError(`记录 ${moment.id} 引用了导入包之外的孩子`);
    }
    momentIds.add(moment.id);
  }

  if (json.activeKidId && !kidIds.has(json.activeKidId)) {
    throw new TypeError("activeKidId 引用了导入包之外的孩子");
  }

  return { kids, moments };
}

export async function importFromJson(familyId, json) {
  const { kids, moments } = validateImportPayload(json);
  const db = getPool();
  const conn = await db.getConnection();
  let importedKids = 0;
  let importedMoments = 0;

  try {
    await conn.beginTransaction();

    // 只清空该家庭现有数据
    await conn.query("DELETE FROM moments WHERE family_id = ?", [familyId]);
    await conn.query("DELETE FROM kids WHERE family_id = ?", [familyId]);

    for (const k of kids) {
      const p = k.profile || {};
      await conn.query(
        `INSERT INTO kids (id, family_id, name, grade, avatar, since,
          profile_current_topics, profile_strengths, profile_weaknesses, profile_notes,
          created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          k.id,
          familyId,
          k.name,
          k.grade || "一年级",
          k.avatar || "🌱",
          k.since || "",
          p.current_topics || "",
          p.strengths || "",
          p.weaknesses || "",
          p.notes || "",
          Date.now(),
          Date.now(),
        ]
      );
      importedKids++;
    }

    for (const m of moments) {
      await conn.query(
        `INSERT INTO moments (id, family_id, kid_id, subject, problem, context, analysis,
          reflection, tag, status, interval_days, wrong_streak, last_wrong_at,
          image_data, image_description,
          created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          m.id,
          familyId,
          m.kidId,
          m.subject || "数学",
          m.problem,
          m.context || "",
          m.analysis ? JSON.stringify(m.analysis) : null,
          m.reflection || "",
          m.tag || "新",
          m.status || "已记录",
          Number.isFinite(m.intervalDays) ? m.intervalDays : 1,
          Number.isFinite(m.wrongStreak) ? m.wrongStreak : 0,
          Number.isFinite(m.lastWrongAt) ? m.lastWrongAt : null,
          m.imageData || null,
          m.imageDescription || null,
          m.created_by || null,
          m.createdAt || Date.now(),
          m.updatedAt || m.createdAt || Date.now(),
        ]
      );
      importedMoments++;
    }

    if (json.activeKidId) {
      await conn.query(
        `INSERT INTO app_settings (family_id, k, v, updated_at) VALUES (?, 'activeKidId', ?, ?)
         ON DUPLICATE KEY UPDATE v = VALUES(v), updated_at = VALUES(updated_at)`,
        [familyId, json.activeKidId, Date.now()]
      );
    }

    await conn.commit();
    return { kids: importedKids, moments: importedMoments };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// ============================================================
// 全量导出（只导出指定家庭的数据）
// withImages=true 时把图片 base64 一并导出（用于备份下载）
// 普通的 GET /api/data 列表加载场景设 false（避免一次几十 MB）
// ============================================================
export async function exportAll(familyId, { withImages = false } = {}) {
  const kids = await listKids(familyId);
  const moments = withImages
    ? await listMomentsFull(familyId)
    : await listMoments(familyId);
  const activeKidId = await getSetting(familyId, "activeKidId", kids[0]?.id || null);
  return { kids, moments, activeKidId };
}

// 内部用：把所有 moment 都带图返回（仅备份导出时调用）
async function listMomentsFull(familyId) {
  const db = getPool();
  const [rows] = await db.query(
    `SELECT m.* FROM moments m
     INNER JOIN kids k
       ON m.kid_id = k.id AND k.family_id = m.family_id AND k.deleted = 0
     WHERE m.family_id = ?
     ORDER BY m.created_at DESC`,
    [familyId]
  );
  return rows.map((r) => rowToMoment(r, { withImage: true }));
}

// ============================================================
// 行转换（DB row → 前端期望的对象形状）
// ============================================================
function rowToKid(row) {
  return {
    id: row.id,
    name: row.name,
    grade: row.grade,
    avatar: row.avatar,
    since: row.since,
    profile: {
      current_topics: row.profile_current_topics || "",
      strengths: row.profile_strengths || "",
      weaknesses: row.profile_weaknesses || "",
      notes: row.profile_notes || "",
    },
  };
}

function rowToMoment(row, { withImage = false } = {}) {
  // mysql2 对 JSON 列通常已经自动 parse 成对象；
  // 少数环境下（老版本 / 特定配置）可能返回字符串，做个兼容。
  let analysis = row.analysis;
  if (typeof analysis === "string" && analysis.length > 0) {
    try {
      analysis = JSON.parse(analysis);
    } catch (e) {
      console.warn("analysis 字段不是有效 JSON:", analysis.slice(0, 100));
      analysis = null;
    }
  }
  // has_image：列表查询时 SQL 算好的；单条查询则看 image_data 是否非空
  // mysql2 可能把 boolean expr 返成 0/1 或 Buffer，统一转成 boolean
  let hasImage;
  if (row.has_image !== undefined) {
    hasImage = !!Number(row.has_image);
  } else {
    hasImage = !!row.image_data;
  }
  const out = {
    id: row.id,
    kidId: row.kid_id,
    subject: row.subject,
    problem: row.problem,
    context: row.context || "",
    analysis: analysis || null,
    reflection: row.reflection || "",
    tag: row.tag,
    status: row.status,
    intervalDays: Number(row.interval_days) || 1,
    wrongStreak: Number(row.wrong_streak) || 0,
    lastWrongAt: row.last_wrong_at != null ? Number(row.last_wrong_at) : null,
    hasImage,
    imageDescription: row.image_description || null,
    created_by: row.created_by,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
  if (withImage) {
    out.imageData = row.image_data || null;
  }
  return out;
}

// ============================================================
// Cached Quizzes（v4.7：复习题预生成缓存）
// ============================================================
// 接口：
//   getCachedQuiz(familyId, momentId)            → quiz | null
//   saveCachedQuiz(familyId, momentId, quiz)     → quiz（幂等：已有则跳过 AI 调用）
//   deleteCachedQuiz(familyId, momentId)         → void
//   listCachedQuizMomentIds(familyId)            → string[] （前端用来知道哪些题已缓存）
//   hasCachedQuiz(familyId, momentId)            → boolean  （saveCachedQuiz 内部用）
// ============================================================

function rowToCachedQuiz(row) {
  if (!row) return null;
  return {
    momentId: row.moment_id,
    quiz_question: row.quiz_question,
    quiz_svg: row.quiz_svg || null,
    expected_answer: row.expected_answer,
    key_check: row.key_check,
    if_correct: row.if_correct,
    if_wrong: row.if_wrong,
    generatedAt: Number(row.generated_at),
  };
}

export async function getCachedQuiz(familyId, momentId) {
  const db = getPool();
  const [rows] = await db.query(
    "SELECT * FROM cached_quizzes WHERE family_id = ? AND moment_id = ?",
    [familyId, momentId]
  );
  return rowToCachedQuiz(rows[0]);
}

// 幂等写入：缓存已存在就什么都不做，直接返回现有缓存。
// 这是预热"安全阀"——前端无论触发多少次，只有第一次会真的写。
export async function saveCachedQuiz(familyId, momentId, quiz) {
  const db = getPool();
  const existing = await getCachedQuiz(familyId, momentId);
  if (existing) return existing;

  await db.query(
    `INSERT INTO cached_quizzes
       (moment_id, family_id, quiz_question, quiz_svg, expected_answer,
        key_check, if_correct, if_wrong, generated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE moment_id = moment_id`, // 并发场景的兜底：几乎同时两个请求都过了 SELECT，第二个 INSERT 静默失败
    [
      momentId,
      familyId,
      quiz.quiz_question || "",
      quiz.quiz_svg || null,
      quiz.expected_answer || "",
      quiz.key_check || "",
      quiz.if_correct || "",
      quiz.if_wrong || "",
      Date.now(),
    ]
  );
  return await getCachedQuiz(familyId, momentId);
}

export async function deleteCachedQuiz(familyId, momentId) {
  const db = getPool();
  await db.query(
    "DELETE FROM cached_quizzes WHERE family_id = ? AND moment_id = ?",
    [familyId, momentId]
  );
}

// 列表只返 moment_id 集合，前端就能在首页/复习屏知道"哪些题已经预热好了"
// 用 set 而不是带详情：详情交给 GET /api/cached-quiz/:id 单条拉
export async function listCachedQuizMomentIds(familyId) {
  const db = getPool();
  const [rows] = await db.query(
    "SELECT moment_id FROM cached_quizzes WHERE family_id = ?",
    [familyId]
  );
  return rows.map((r) => r.moment_id);
}

// ============================================================
// Quiz History（v4.8）：复习题历史记录
// ============================================================
// 用法时序：
//   1) AI 出题成功时（cached_quizzes 表写入）→ 不写历史，因为孩子还没做
//   2) 家长在复习屏点"答对了/答错了" → 调 recordQuizHistory，写一行
//      入参从前端 ReviewScreen 传过来（题面 + result）
//   3) 出题前 → 调 listRecentQuizHistory(momentId, 5)，把最近 5 道题面塞 prompt 去重
//
// 注意：cached_quizzes 用 moment_id 做主键（每题最多一条缓存），
//       quiz_history 用自增 id（每题可以有 N 条记录）。
// ============================================================

export async function recordQuizHistory({
  momentId,
  familyId,
  kidId,
  quizQuestion,
  quizSvg, // v4.8.1: 看图题的 SVG
  expectedAnswer,
  result, // "correct" | "wrong" | "skipped"
}) {
  const db = getPool();
  await db.query(
    `INSERT INTO quiz_history
       (moment_id, family_id, kid_id, quiz_question, quiz_svg, expected_answer, result, answered_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      momentId,
      familyId,
      kidId,
      quizQuestion || "",
      quizSvg || null,
      expectedAnswer || null,
      result || null,
      Date.now(),
    ]
  );
}

// 取一道题最近 N 道历史，用于出题去重
// 只返题面字符串数组，按时间倒序（最近的先）
// 注意：故意不返 quiz_svg —— 去重 prompt 只需要题面文本，svg 字符在 prompt 里
//       既占大量 token 又对 AI 判断"是否雷同"无帮助
export async function listRecentQuizHistory(momentId, limit = 5) {
  const db = getPool();
  const [rows] = await db.query(
    `SELECT quiz_question
     FROM quiz_history
     WHERE moment_id = ?
     ORDER BY answered_at DESC
     LIMIT ?`,
    [momentId, Number(limit) || 5]
  );
  return rows.map((r) => r.quiz_question).filter(Boolean);
}

// 取一道题完整复习历史，用于时刻详情页"复习记录"展示
// 比 listRecentQuizHistory 多返回字段：含 result / answered_at / quiz_svg
export async function listQuizHistoryForMoment(momentId) {
  const db = getPool();
  const [rows] = await db.query(
    `SELECT id, quiz_question, quiz_svg, expected_answer, result, answered_at
     FROM quiz_history
     WHERE moment_id = ?
     ORDER BY answered_at DESC`,
    [momentId]
  );
  return rows.map((r) => ({
    id: r.id,
    quizQuestion: r.quiz_question,
    quizSvg: r.quiz_svg || null,
    expectedAnswer: r.expected_answer || null,
    result: r.result || null,
    answeredAt: Number(r.answered_at),
  }));
}

// 后续档 2 用：按家庭聚合统计
// 现在不调，但留接口在这，前端要做统计页时直接加路由就行
export async function getQuizHistoryStats(familyId, kidId, sinceMs = 0) {
  const db = getPool();
  const [rows] = await db.query(
    `SELECT result, COUNT(*) AS cnt
     FROM quiz_history
     WHERE family_id = ? AND kid_id = ? AND answered_at >= ?
     GROUP BY result`,
    [familyId, kidId, sinceMs]
  );
  const stats = { correct: 0, wrong: 0, skipped: 0, total: 0 };
  for (const r of rows) {
    const k = r.result || "skipped";
    if (stats[k] !== undefined) stats[k] = Number(r.cnt);
    stats.total += Number(r.cnt);
  }
  return stats;
}

// ============================================================
// Families CRUD（只给 admin.mjs 用，API 层不会暴露）
// ============================================================
import bcrypt from "bcryptjs";
import crypto from "crypto";

export async function listFamilies() {
  const db = getPool();
  const [rows] = await db.query(
    `SELECT id, name, expires_at, daily_quota, note, created_at, updated_at
     FROM families ORDER BY created_at DESC`
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    expiresAt: Number(r.expires_at),
    dailyQuota: r.daily_quota,
    note: r.note || "",
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  }));
}

export function validateNewFamilyPassword(password) {
  if (typeof password !== "string" || password.length < 12) {
    throw new TypeError("家庭访问密码至少需要 12 个字符；建议使用独特的长密码短语");
  }
  if (/^(?:changeme|password|123456|replace-with)/i.test(password)) {
    throw new TypeError("请把示例密码替换为真实的独特强密码");
  }
  return password;
}

async function assertFamilyPasswordAvailable(password, excludeFamilyId = null) {
  const db = getPool();
  const [rows] = await db.query("SELECT id, password_hash FROM families");
  for (const row of rows) {
    if (row.id === excludeFamilyId) continue;
    if (await bcrypt.compare(password, row.password_hash)) {
      throw new TypeError("该访问密码已被另一个家庭使用；每个家庭必须使用不同密码");
    }
  }
}

export async function createFamily({ name, password, expiresAt, dailyQuota, note }) {
  const db = getPool();
  validateNewFamilyPassword(password);
  await assertFamilyPasswordAvailable(password);
  const id = crypto.randomUUID();
  const passwordHash = await bcrypt.hash(password, 10);
  const now = Date.now();
  await db.query(
    `INSERT INTO families (id, name, password_hash, expires_at, daily_quota, note,
      created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, name, passwordHash, expiresAt, dailyQuota, note || "", now, now]
  );
  return id;
}

export async function updateFamily(id, { name, password, expiresAt, dailyQuota, note }) {
  const db = getPool();
  const fields = [];
  const values = [];
  if (name !== undefined) { fields.push("name = ?"); values.push(name); }
  if (password !== undefined) {
    validateNewFamilyPassword(password);
    await assertFamilyPasswordAvailable(password, id);
    fields.push("password_hash = ?");
    values.push(await bcrypt.hash(password, 10));
  }
  if (expiresAt !== undefined) { fields.push("expires_at = ?"); values.push(expiresAt); }
  if (dailyQuota !== undefined) { fields.push("daily_quota = ?"); values.push(dailyQuota); }
  if (note !== undefined) { fields.push("note = ?"); values.push(note); }
  if (fields.length === 0) return false;
  fields.push("updated_at = ?");
  values.push(Date.now());
  values.push(id);
  const [result] = await db.query(
    `UPDATE families SET ${fields.join(", ")} WHERE id = ?`,
    values
  );
  if (result.affectedRows > 0 && password !== undefined) {
    // 密码一改，旧密码不应在缓存 TTL 内继续有效。
    authCache.clear();
  }
  return result.affectedRows > 0;
}

export async function deleteFamily(id) {
  const db = getPool();
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    // 级联删：家庭的所有数据
    await conn.query("DELETE FROM moments WHERE family_id = ?", [id]);
    await conn.query("DELETE FROM kids WHERE family_id = ?", [id]);
    await conn.query("DELETE FROM app_settings WHERE family_id = ?", [id]);
    await conn.query("DELETE FROM daily_usage WHERE family_id = ?", [id]);
    // audit_log 保留（历史记录，不删）
    await conn.query("DELETE FROM families WHERE id = ?", [id]);
    await conn.commit();
    authCache.clear();
    return true;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// ============================================================
// 密码校验 —— 服务端验密码的核心函数
// 由于 bcrypt 比较慢（10 轮 cost 大约 60-100ms），加内存缓存避免每请求都算
// ============================================================
const authCache = new Map(); // key: SHA-256(完整密码) → { familyId, ttl }
const AUTH_CACHE_TTL = 5 * 60 * 1000; // 5 分钟

export function createAuthCacheKey(password) {
  return crypto
    .createHash("sha256")
    .update(String(password), "utf8")
    .digest("base64url");
}

export async function authenticateByPassword(password) {
  if (!password) return { ok: false, reason: "no_password" };
  const db = getPool();

  // 查所有家庭，对每个家庭尝试比对（家庭数量 <100 时性能完全够）
  const [rows] = await db.query(
    `SELECT id, name, password_hash, expires_at, daily_quota FROM families`
  );
  if (rows.length === 0) return { ok: false, reason: "no_family" };

  // 先查缓存命中
  // 旧实现只用了“前 8 字符 + 长度”，不同密码可能得到同一个缓存键，
  // 从而绕过 bcrypt。这里用完整密码的单向摘要作为进程内缓存键；既不保留
  // 明文，也把可利用碰撞降到密码认证场景下可忽略的程度。
  const cacheKey = createAuthCacheKey(password);
  const cached = authCache.get(cacheKey);
  if (cached && cached.ttl > Date.now()) {
    // 摘要精确命中后，确认家庭仍存在；过期信息使用数据库的最新值。
    const matched = rows.find((r) => r.id === cached.familyId);
    if (matched) {
      return checkExpiryAndReturn(matched);
    }
  }

  // 逐个比对。正常情况下 admin 会阻止重复密码；这里仍检测旧数据中的
  // 重复项，避免同一个密码悄悄登录到排序靠前的另一个家庭。
  let matchedRow = null;
  for (const row of rows) {
    const matched = await bcrypt.compare(password, row.password_hash);
    if (matched) {
      if (matchedRow) return { ok: false, reason: "ambiguous_password" };
      matchedRow = row;
    }
  }

  if (matchedRow) {
    authCache.set(cacheKey, {
      familyId: matchedRow.id,
      ttl: Date.now() + AUTH_CACHE_TTL,
    });
    return checkExpiryAndReturn(matchedRow);
  }

  return { ok: false, reason: "wrong_password" };
}

function checkExpiryAndReturn(row) {
  const now = Date.now();
  const expiresAt = Number(row.expires_at);
  if (expiresAt < now) {
    return { ok: false, reason: "expired", familyId: row.id, familyName: row.name };
  }
  return {
    ok: true,
    familyId: row.id,
    familyName: row.name,
    dailyQuota: row.daily_quota,
    expiresAt,
  };
}

// ============================================================
// 每日配额管理
// ============================================================
// 本地时区的今日日期字符串 YYYY-MM-DD
function todayStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// 原子增加用量并返回新值；如果超过 quota 则不增加、返回失败
export async function incrementDailyUsage(familyId, quota) {
  const db = getPool();
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    // 锁定当日行（不存在则创建）
    await conn.query(
      `INSERT INTO daily_usage (family_id, usage_date, call_count, updated_at)
       VALUES (?, ?, 0, ?)
       ON DUPLICATE KEY UPDATE family_id = family_id`,
      [familyId, todayStr(), Date.now()]
    );

    const [rows] = await conn.query(
      `SELECT call_count FROM daily_usage
       WHERE family_id = ? AND usage_date = ? FOR UPDATE`,
      [familyId, todayStr()]
    );
    const current = rows[0]?.call_count ?? 0;

    if (current >= quota) {
      await conn.commit();
      return { ok: false, current, quota };
    }

    await conn.query(
      `UPDATE daily_usage SET call_count = call_count + 1, updated_at = ?
       WHERE family_id = ? AND usage_date = ?`,
      [Date.now(), familyId, todayStr()]
    );
    await conn.commit();
    return { ok: true, current: current + 1, quota };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// 退还一次配额（超时 / 客户端断开 / AI 调用最终失败时调）
// 不会减到负数；如果今天还没有 daily_usage 行就什么也不做（说明从来没扣过）。
// 谨慎使用 —— 只在"已经扣了但不应该扣"的场景调，避免计数失真。
export async function decrementDailyUsage(familyId) {
  const db = getPool();
  await db.query(
    `UPDATE daily_usage
       SET call_count = GREATEST(call_count - 1, 0), updated_at = ?
     WHERE family_id = ? AND usage_date = ?`,
    [Date.now(), familyId, todayStr()]
  );
}

// 查询某家庭"今日"的用量数（前端首页配额展示用）。
// 没有记录时返回 0（说明今天还没调过 AI）。
export async function getTodayUsage(familyId) {
  const db = getPool();
  const [rows] = await db.query(
    `SELECT call_count FROM daily_usage
     WHERE family_id = ? AND usage_date = ?`,
    [familyId, todayStr()]
  );
  return rows[0]?.call_count ?? 0;
}

// 查询某家庭最近 N 天的用量（admin.mjs 用）
export async function getUsageHistory(familyId, days = 7) {
  const db = getPool();
  const [rows] = await db.query(
    `SELECT usage_date, call_count FROM daily_usage
     WHERE family_id = ? AND usage_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
     ORDER BY usage_date DESC`,
    [familyId, days]
  );
  return rows.map((r) => ({
    date: r.usage_date.toISOString ? r.usage_date.toISOString().slice(0, 10) : String(r.usage_date),
    count: r.call_count,
  }));
}

// ============================================================
// 审计日志
// ============================================================
export async function writeAuditLog({ familyId, endpoint, success, errorMsg, ip, latencyMs, model }) {
  const db = getPool();
  try {
    await db.query(
      `INSERT INTO audit_log (family_id, endpoint, success, error_msg, ip, latency_ms, model, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        familyId,
        endpoint,
        success ? 1 : 0,
        errorMsg ? errorMsg.slice(0, 255) : null,
        ip || null,
        latencyMs ?? null,
        model || null,
        Date.now(),
      ]
    );
  } catch (e) {
    // 写审计失败不应影响主流程
    console.error("审计日志写入失败:", e.message);
  }
}

export async function getRecentAuditLogs(familyId, limit = 50) {
  const db = getPool();
  const [rows] = await db.query(
    `SELECT endpoint, success, error_msg, ip, latency_ms, model, created_at
     FROM audit_log WHERE family_id = ?
     ORDER BY created_at DESC LIMIT ?`,
    [familyId, limit]
  );
  return rows;
}

// ============================================================
// Explanation Cards（v4.9：讲解卡）
// ============================================================
// 触发：moment.wrong_streak >= 3 时不再出题，改弹讲解卡。
// 接口：
//   createExplanationCard(...)            → card  (insert 后返回完整对象)
//   getExplanationCard(familyId, id)      → card | null
//   listExplanationCardsByMoment(...)     → card[]，按时间倒序（最新在前）
//   countExplanationCardsForMoment(momentId, sinceMs?)
//                                          → number  ("换角度" 次数计数)
//   updateExplanationCardFeedback(familyId, id, feedback)
//                                          → bool  (写 used_at + user_feedback)
// ============================================================
function rowToExplanationCard(row) {
  if (!row) return null;
  return {
    id: row.id,
    momentId: row.moment_id,
    triggerWrongStreak: Number(row.trigger_wrong_streak) || 0,
    opening: row.opening || "",
    analogyCore: row.analogy_core || "",
    script: row.script || "",
    visualSvg: row.visual_svg || null,
    checkQuestion: row.check_question || "",
    verifyProblem: row.verify_problem || "",
    verifySvg: row.verify_svg || null,
    verifyAnswer: row.verify_answer || "",
    model: row.model || null,
    createdAt: Number(row.created_at),
    usedAt: row.used_at != null ? Number(row.used_at) : null,
    userFeedback: row.user_feedback || null,
  };
}

export async function createExplanationCard({
  id,
  familyId,
  momentId,
  triggerWrongStreak,
  opening,
  analogyCore,
  script,
  visualSvg,
  checkQuestion,
  verifyProblem,
  verifySvg,
  verifyAnswer,
  model,
}) {
  const db = getPool();
  const now = Date.now();
  await db.query(
    `INSERT INTO explanation_cards
       (id, family_id, moment_id, trigger_wrong_streak,
        opening, analogy_core, script, visual_svg,
        check_question, verify_problem, verify_svg, verify_answer,
        model, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      familyId,
      momentId,
      Number.isFinite(triggerWrongStreak) ? triggerWrongStreak : 0,
      opening || "",
      // analogy_core 是 VARCHAR(255)，截断防越界
      (analogyCore || "").slice(0, 255),
      script || "",
      visualSvg || null,
      checkQuestion || "",
      verifyProblem || "",
      verifySvg || null,
      verifyAnswer || "",
      model || null,
      now,
    ]
  );
  return await getExplanationCard(familyId, id);
}

export async function getExplanationCard(familyId, id) {
  const db = getPool();
  const [rows] = await db.query(
    "SELECT * FROM explanation_cards WHERE family_id = ? AND id = ?",
    [familyId, id]
  );
  return rows[0] ? rowToExplanationCard(rows[0]) : null;
}

// 取一道题的全部讲解卡，按 created_at 倒序（最新在前）
// 数量上限：一道题正常最多 1~3 张（"换角度" 上限 2 次），全量返不分页
export async function listExplanationCardsByMoment(familyId, momentId) {
  const db = getPool();
  const [rows] = await db.query(
    `SELECT * FROM explanation_cards
     WHERE family_id = ? AND moment_id = ?
     ORDER BY created_at DESC`,
    [familyId, momentId]
  );
  return rows.map(rowToExplanationCard);
}

// 计数这道题已经生成过几张讲解卡（含已 feedback 和未 feedback 的）
// sinceMs：可选，只数这个时间戳之后的（用于"本轮反复错"窗口内的换角度次数限制）
export async function countExplanationCardsForMoment(momentId, sinceMs = 0) {
  const db = getPool();
  const [rows] = await db.query(
    `SELECT COUNT(*) AS cnt FROM explanation_cards
     WHERE moment_id = ? AND created_at >= ?`,
    [momentId, sinceMs || 0]
  );
  return Number(rows[0]?.cnt) || 0;
}

// 写反馈 + used_at（家长按下三个按钮中任一时调）
// feedback: "explained_then_practice" | "needed_more_angle" | "shelved"
// 返回 true 表示更新成功，false 表示卡不存在或不属于该家庭
export async function updateExplanationCardFeedback(familyId, id, feedback) {
  const db = getPool();
  const [result] = await db.query(
    `UPDATE explanation_cards
     SET used_at = ?, user_feedback = ?
     WHERE family_id = ? AND id = ?`,
    [Date.now(), feedback || null, familyId, id]
  );
  return result.affectedRows > 0;
}
