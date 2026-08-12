#!/usr/bin/env node
// ============================================================
// 陪学笔记 · 家庭管理 CLI
//
// 用法：
//   node admin.mjs list
//   PEIXUE_FAMILY_PASSWORD="..." node admin.mjs create --name="示例家庭" --password-env --days=365 --quota=100
//   PEIXUE_FAMILY_PASSWORD="..." node admin.mjs update <id> --password-env
//   node admin.mjs update <id> --days=180 --quota=200
//   node admin.mjs delete <id>
//   node admin.mjs usage <id> [--days=7]
//   node admin.mjs audit <id> [--limit=50]
//   PEIXUE_FAMILY_PASSWORD="..." node admin.mjs reset-password <id> --password-env
//
// 要求：和 server.mjs 在同一目录，能读到 .env
// ============================================================

import "dotenv/config";
import * as db from "./db.mjs";
import readline from "node:readline";

// —— 参数解析 ——
function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (const arg of argv.slice(2)) {
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq > -1) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        flags[arg.slice(2)] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { command: positional[0], args: positional.slice(1), flags };
}

// —— 输出辅助 ——
const c = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

function fmtDate(ms) {
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

function daysFromNow(ms) {
  const delta = ms - Date.now();
  const days = Math.round(delta / 86400000);
  if (days < 0) return c.red(`已过期 ${-days} 天`);
  if (days < 7) return c.yellow(`${days} 天后`);
  return `${days} 天后`;
}

async function confirm(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((r) => {
    rl.question(`${prompt} [y/N] `, (ans) => {
      rl.close();
      r(/^y(es)?$/i.test(ans.trim()));
    });
  });
}

function parseDaysFlag(flags, fallback) {
  if (flags.days) return Number(flags.days);
  if (flags.expires) {
    // 支持 --expires=2026-12-31
    const t = Date.parse(flags.expires);
    if (isNaN(t)) throw new Error(`日期格式不对: ${flags.expires}`);
    return Math.ceil((t - Date.now()) / 86400000);
  }
  return fallback;
}

function passwordFromFlags(flags) {
  if (flags["password-env"]) {
    const password = process.env.PEIXUE_FAMILY_PASSWORD;
    if (!password) {
      throw new Error("--password-env 需要环境变量 PEIXUE_FAMILY_PASSWORD");
    }
    return password;
  }
  return flags.password;
}

// —— 命令实现 ——

async function cmdList() {
  await db.initSchema();
  const families = await db.listFamilies();
  if (families.length === 0) {
    console.log(c.dim("(没有家庭)"));
    return;
  }
  console.log();
  console.log(c.bold(" id".padEnd(40) + "name".padEnd(16) + "expires".padEnd(22) + "quota".padEnd(8) + "note"));
  console.log(c.dim(" " + "─".repeat(100)));
  for (const f of families) {
    const expires = `${fmtDate(f.expiresAt).slice(0, 10)} (${daysFromNow(f.expiresAt)})`;
    console.log(
      " " +
        f.id.padEnd(39) + " " +
        f.name.padEnd(15) + " " +
        expires.padEnd(21).slice(0, 21) + " " +
        String(f.dailyQuota).padEnd(7) + " " +
        (f.note || "").slice(0, 40)
    );
  }
  console.log();
  console.log(c.dim(`共 ${families.length} 个家庭`));
}

async function cmdCreate(flags) {
  const password = passwordFromFlags(flags);
  if (!flags.name || !password) {
    throw new Error("需要 --name，以及 --password 或 --password-env");
  }
  const days = parseDaysFlag(flags, 365);
  const quota = Number(flags.quota || 100);
  const note = flags.note || "";

  const expiresAt = Date.now() + days * 86400000;
  await db.initSchema();
  const id = await db.createFamily({
    name: flags.name,
    password,
    expiresAt,
    dailyQuota: quota,
    note,
  });
  console.log(c.green(`✅ 已创建家庭`));
  console.log(`   id:     ${id}`);
  console.log(`   name:   ${flags.name}`);
  console.log(`   quota:  ${quota}/天`);
  console.log(`   expires: ${fmtDate(expiresAt).slice(0, 10)} (${days} 天后)`);
  console.log();
  console.log(c.dim(`把下面这句话发给对方：`));
  console.log();
  console.log(`  访问地址：${flags.url || "https://你的域名"}`);
  console.log(`  访问密码：${password}`);
  console.log(`  每日额度：${quota} 次 AI 调用`);
  console.log(`  有效期至：${fmtDate(expiresAt).slice(0, 10)}`);
}

async function cmdUpdate(id, flags) {
  await db.initSchema();
  const changes = {};
  if (flags.name !== undefined) changes.name = flags.name;
  if (flags.password !== undefined || flags["password-env"]) {
    changes.password = passwordFromFlags(flags);
  }
  if (flags.note !== undefined) changes.note = flags.note;
  if (flags.quota !== undefined) changes.dailyQuota = Number(flags.quota);
  if (flags.days !== undefined || flags.expires !== undefined) {
    const days = parseDaysFlag(flags, 0);
    changes.expiresAt = Date.now() + days * 86400000;
  }
  if (Object.keys(changes).length === 0) {
    throw new Error("没有要改的字段。支持 --name --password --quota --days 或 --expires --note");
  }
  const ok = await db.updateFamily(id, changes);
  if (!ok) {
    console.log(c.red(`❌ 家庭 ${id} 不存在`));
    return;
  }
  console.log(c.green(`✅ 已更新`));
  const f = (await db.listFamilies()).find((x) => x.id === id);
  if (f) {
    console.log(`   ${f.name} · 配额 ${f.dailyQuota}/天 · ${daysFromNow(f.expiresAt)}`);
  }
}

async function cmdDelete(id) {
  await db.initSchema();
  const families = await db.listFamilies();
  const f = families.find((x) => x.id === id);
  if (!f) {
    console.log(c.red(`❌ 家庭 ${id} 不存在`));
    return;
  }
  console.log(c.yellow(`⚠️  即将删除家庭 "${f.name}" (${f.id})`));
  console.log(c.yellow(`   以及该家庭的所有 kids / moments / settings / daily_usage 数据`));
  console.log(c.yellow(`   审计日志会保留`));
  const ok = await confirm("确认删除？");
  if (!ok) {
    console.log(c.dim("已取消"));
    return;
  }
  await db.deleteFamily(id);
  console.log(c.green(`✅ 已删除`));
}

async function cmdUsage(id, flags) {
  await db.initSchema();
  const families = await db.listFamilies();
  const f = families.find((x) => x.id === id);
  if (!f) {
    console.log(c.red(`❌ 家庭 ${id} 不存在`));
    return;
  }
  const days = Number(flags.days || 7);
  const history = await db.getUsageHistory(id, days);
  console.log();
  console.log(c.bold(`${f.name} · 近 ${days} 天用量（配额 ${f.dailyQuota}/天）`));
  console.log(c.dim("─".repeat(50)));
  if (history.length === 0) {
    console.log(c.dim("(没有调用记录)"));
    return;
  }
  for (const row of history) {
    const bar = "█".repeat(Math.min(30, Math.round((row.count / f.dailyQuota) * 30)));
    const pct = ((row.count / f.dailyQuota) * 100).toFixed(0);
    const color = row.count >= f.dailyQuota ? c.red : row.count >= f.dailyQuota * 0.8 ? c.yellow : c.green;
    console.log(`  ${row.date}  ${color(bar.padEnd(30))}  ${row.count}/${f.dailyQuota}  (${pct}%)`);
  }
}

async function cmdAudit(id, flags) {
  await db.initSchema();
  const limit = Number(flags.limit || 50);
  const logs = await db.getRecentAuditLogs(id, limit);
  console.log();
  console.log(c.bold(`近 ${limit} 条调用记录`));
  console.log(c.dim("─".repeat(90)));
  if (logs.length === 0) {
    console.log(c.dim("(没有记录)"));
    return;
  }
  for (const log of logs) {
    const ok = log.success ? c.green("✓") : c.red("✗");
    const t = fmtDate(Number(log.created_at));
    const ep = log.endpoint.padEnd(12);
    const lat = log.latency_ms != null ? `${log.latency_ms}ms`.padStart(7) : "     - ";
    const extra = log.error_msg ? c.red(` [${log.error_msg}]`) : "";
    const model = log.model ? c.dim(` ${log.model}`) : "";
    const ip = log.ip ? c.dim(` ${log.ip}`) : "";
    console.log(`  ${t}  ${ok}  ${ep}  ${lat}${model}${ip}${extra}`);
  }
}

async function cmdResetPassword(id, flags) {
  const password = passwordFromFlags(flags);
  if (!password) throw new Error("需要 --password=新密码 或 --password-env");
  await db.initSchema();
  const ok = await db.updateFamily(id, { password });
  if (!ok) {
    console.log(c.red(`❌ 家庭 ${id} 不存在`));
    return;
  }
  console.log(c.green(`✅ 密码已重置`));
  console.log(c.dim(`   告诉对方新密码是：${password}`));
}

// —— 主入口 ——

async function main() {
  const { command, args, flags } = parseArgs(process.argv);

  if (!command || command === "help" || flags.help) {
    console.log(`陪学笔记 · 家庭管理

命令：
  list                          列出所有家庭
  create --name=<> (--password=<> | --password-env) [--days=365] [--quota=100] [--note=<>] [--url=<>]
                                新建家庭
  update <id> [--name=] [--password= | --password-env] [--quota=] [--days=] [--expires=] [--note=]
                                修改家庭
  reset-password <id> (--password=<新密码> | --password-env)
                                重置密码（快捷命令）
  delete <id>                   删除家庭（会级联删所有数据）
  usage <id> [--days=7]         看最近 N 天用量柱状图
  audit <id> [--limit=50]       看最近 N 条调用日志

示例：
  PEIXUE_FAMILY_PASSWORD="..." node admin.mjs create --name="示例家庭" --password-env --quota=150 --days=180
  node admin.mjs list
  node admin.mjs usage 6f...
  node admin.mjs update 6f... --quota=300
  PEIXUE_FAMILY_PASSWORD="..." node admin.mjs reset-password 6f... --password-env
`);
    process.exit(0);
  }

  try {
    switch (command) {
      case "list":
        await cmdList();
        break;
      case "create":
        await cmdCreate(flags);
        break;
      case "update":
        if (!args[0]) throw new Error("需要家庭 id");
        await cmdUpdate(args[0], flags);
        break;
      case "reset-password":
        if (!args[0]) throw new Error("需要家庭 id");
        await cmdResetPassword(args[0], flags);
        break;
      case "delete":
        if (!args[0]) throw new Error("需要家庭 id");
        await cmdDelete(args[0]);
        break;
      case "usage":
        if (!args[0]) throw new Error("需要家庭 id");
        await cmdUsage(args[0], flags);
        break;
      case "audit":
        if (!args[0]) throw new Error("需要家庭 id");
        await cmdAudit(args[0], flags);
        break;
      default:
        console.error(c.red(`未知命令: ${command}`));
        console.error(`运行 ${c.bold("node admin.mjs help")} 看用法`);
        process.exit(1);
    }
  } catch (err) {
    console.error(c.red(`❌ ${err.message}`));
    if (flags.verbose) console.error(err.stack);
    process.exit(1);
  }

  // 关闭连接池让进程退出
  try {
    await db.getPool().end();
  } catch (e) {}
}

main();
