<p align="center">
  <img src="peixue-frontend/public/seed.png" width="112" alt="陪学笔记图标" />
</p>

<h1 align="center">陪学笔记 · Peixue</h1>

<p align="center">
  面向家庭陪学的自托管 AI 学习记录工具：把错题、疑问和家长观察，变成可追踪的成长档案、间隔复习题和讲解卡。
</p>

<p align="center">
  中文 · <a href="README.en.md">English</a>
</p>

> [!NOTE]
> 项目正处于首次公开发布准备阶段。部署真实家庭数据前，请先阅读[隐私与安全](#隐私与安全)及[部署指南](docs/DEPLOYMENT.md)，并在升级前备份。

## 为什么做这个项目

陪学最难的往往不是再找一套题，而是记住孩子究竟卡在哪里、什么时候应该再问一次，以及家长怎样解释才能让孩子真正说懂。

陪学笔记围绕一次真实的亲子学习过程设计：家长记录一道错题、一个没想通的问题或一句观察；AI 帮忙整理可能的认知偏差和引导方式；系统再根据学习状态安排复习、变式练习与讲解卡。它强调“帮助家长更好地陪伴”，不替代教师、医生或专业教育评估。

## 主要能力

- 记录数学、语文错题、问题与家长观察，并形成孩子的成长档案
- 对文字题和图片题进行 AI 辅助分析，保留家长可编辑的判断
- 根据状态与间隔安排复习，生成同类题、变式题和延伸题
- 连续答错后生成可照着讲的讲解卡、复述问题与验证题
- 支持多家庭隔离、bcrypt 密码、每日 AI 配额和不含提示词的调用审计
- 支持 JSON 备份/恢复、PWA 安装与完整自托管
- 使用可配置的 OpenAI-compatible Chat Completions 端点，不绑定单一模型供应商

AI 可能出错，尤其是开放题、图片识别和答案判断。家长应在给孩子使用前检查生成内容。

## 快速开始（Docker）

需要 Docker Engine 与 Docker Compose，以及一个兼容 `/chat/completions` 的 AI 服务账号。

```bash
cp .env.example .env
```

编辑 `.env`，至少替换以下值：

- `DB_PASSWORD` 与 `MYSQL_ROOT_PASSWORD`
- `AI_ENDPOINT`、`AI_API_KEY`、`AI_MODEL`
- 使用图片题时还需配置 `AI_VISION_MODEL`

启动服务：

```bash
docker compose up -d --build
```

创建第一个家庭账号：

```bash
read -r -s -p "家庭访问密码（至少 12 个字符）: " PEIXUE_FAMILY_PASSWORD
echo
docker compose exec -e PEIXUE_FAMILY_PASSWORD="$PEIXUE_FAMILY_PASSWORD" \
  backend npm run admin -- create \
  --name="我的家" \
  --password-env \
  --days=3650 \
  --quota=100 \
  --url="http://localhost:8080"
unset PEIXUE_FAMILY_PASSWORD
```

打开 <http://localhost:8080>，在应用的“备份 & 设置”中输入刚创建的访问密码。

想先看看完整时间线，可在全新家庭中通过“备份 & 设置 → 导入”选择 [`examples/demo-backup.json`](examples/demo-backup.json)。演示内容全部为虚构数据；导入会覆盖当前家庭已有记录。

查看状态和日志：

```bash
docker compose ps
docker compose logs -f backend
curl http://localhost:8080/api/health
```

完整的生产部署、备份和升级说明见[部署指南](docs/DEPLOYMENT.md)；模型接口、费用、失败模式与隐私边界见 [AI 服务商指南](docs/AI_PROVIDER_GUIDE.md)。

## 架构

```text
浏览器 / PWA
     │  同源 HTTP(S)
     ▼
Nginx 静态站点 ── /api/* ──► Express 后端 ──► MySQL
                                      │
                                      └────────► AI 模型服务
```

仓库当前主要目录：

```text
peixue-frontend/   React/Vite/Tailwind Web/PWA 源码与 Nginx 镜像
peixue-server/     Express 后端、MySQL schema 与家庭管理 CLI
docs/              部署、开源发布和 Codex for OSS 申请材料
.github/           CI、Issue 表单与 Pull Request 模板
```

## 本地开发与检查

前端要求 Node.js 20.19 或更高版本。安装、检查并启动开发服务器：

```bash
npm --prefix peixue-frontend ci
npm --prefix peixue-frontend run check
npm --prefix peixue-frontend run dev
```

开发服务器默认把 `/api` 代理到 `http://127.0.0.1:3001`。

后端要求 Node.js 20 或更高版本和 MySQL 8：

```bash
cp .env.example peixue-server/.env
cd peixue-server
npm ci
npm test
npm start
```

仓库级隐私、结构与链接检查：

```bash
node scripts/check-repository.mjs
```

贡献代码前请先阅读[贡献指南](CONTRIBUTING.md)和[安全政策](SECURITY.md)。任何示例、Issue、日志或测试数据都不得包含真实儿童姓名、照片、题目图片、家庭密码、API 密钥或数据库备份。

## 隐私与安全

这个项目处理儿童学习记录，部署者必须格外谨慎：

- 生产环境必须使用 HTTPS，不要把后端 `3001` 端口或 MySQL 直接暴露到公网
- AI 分析时，题目文字和选择上传的图片会发送给你配置的模型供应商；请先确认其数据政策
- `.env`、数据库卷和导出的 JSON 都可能含敏感信息，必须加密备份并限制访问
- 家庭访问密码保存在浏览器本地存储中；不要在公用设备上长期登录
- 本项目没有宣称满足任何特定地区的儿童隐私或教育合规要求，部署者需自行评估

发现漏洞时请不要提交公开 Issue，按[安全政策](SECURITY.md)使用 GitHub Private Vulnerability Reporting。

## 路线与参与

当前重点是增加端到端回归测试、完善匿名界面演示、验证更多模型供应商，并继续加强家庭数据边界。欢迎从带有 `good first issue` 或 `help wanted` 标签的问题开始。

- [贡献指南](CONTRIBUTING.md)
- [获取帮助](SUPPORT.md)
- [行为准则](CODE_OF_CONDUCT.md)
- [变更记录](CHANGELOG.md)
- [已知限制](docs/KNOWN_LIMITATIONS.md)
- [AI 服务商兼容、费用与隐私指南](docs/AI_PROVIDER_GUIDE.md)
- [开源发布清单](docs/OPEN_SOURCE_CHECKLIST.md)
- [GitHub 发布步骤](docs/GITHUB_PUBLISHING.md)
- [Codex for OSS 申请建议与英文草稿](docs/CODEX_FOR_OSS_APPLICATION.md)
- [首发后贡献 Issue 草案](docs/STARTER_ISSUES.md)

## 许可证

本项目采用 [MIT License](LICENSE)。前端生产依赖的许可证随构建产物提供于 [`THIRD_PARTY_NOTICES.txt`](peixue-frontend/public/THIRD_PARTY_NOTICES.txt)。发布者仍需确认自己有权公开仓库中的全部代码、图片与素材。
