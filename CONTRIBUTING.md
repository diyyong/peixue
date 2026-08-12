# 贡献指南 / Contributing

感谢你愿意帮助陪学笔记。中文或英文 Issue、讨论和 Pull Request 都欢迎。

Thank you for helping Peixue. Issues, discussions, and pull requests are welcome in either Chinese or English.

## 开始之前 / Before you start

1. 阅读 [README](README.md)、[行为准则](CODE_OF_CONDUCT.md)和[安全政策](SECURITY.md)。
2. 搜索已有 Issue，避免重复；较大的功能先开 Issue 对齐范围。
3. 漏洞不要公开提交，使用 GitHub Private Vulnerability Reporting。
4. 不要上传任何真实儿童或家庭的数据。

Before opening a large change, search existing issues and start a proposal issue. Report vulnerabilities privately and never include real family data.

## 隐私红线 / Privacy rules

代码、测试、截图、日志、Issue 和 PR 中不得包含：

- 真实儿童姓名、照片、学校、年级与可识别信息
- 真实错题图片、家长观察或导出的学习档案
- 家庭访问密码、数据库密码、API key、`.env` 或数据库备份
- 模型供应商返回的、可能复述个人数据的原始日志

Use synthetic names and invented questions in every fixture and example. Redact tokens, hostnames, IP addresses, and family identifiers from logs.

## 开发环境 / Development setup

后端需要 Node.js 20+ 与 MySQL 8。最省事的完整环境是 Docker Compose：

```bash
cp .env.example .env
docker compose up -d --build
```

检查前端：

```bash
npm --prefix peixue-frontend ci
npm --prefix peixue-frontend run check
```

检查后端：

```bash
cd peixue-server
npm ci
npm test
npm audit --omit=dev
```

仓库级检查：

```bash
node scripts/check-repository.mjs
```

前端改动应修改 `peixue-frontend/src/`，不要提交 `dist/` 或手工编辑生成的压缩文件。生产镜像会在构建时运行 Vite。

## 提交一个改动 / Submitting a change

- 每个 PR 聚焦一个问题，并说明用户可见的变化与原因
- 关联 Issue；UI 改动提供匿名截图，API 改动提供请求/响应示例
- 数据库 schema 变更必须能从现有版本安全升级，并说明回滚或备份方案
- 新配置项同步更新 `.env.example` 与部署文档
- 行为变化增加相称的自动化测试；暂时无法测试时，在 PR 中说明验证证据
- 不要顺手格式化或重写无关文件

推荐提交信息使用简短的祈使句，例如：

```text
fix: keep family data isolated during import
docs: add model provider setup example
```

提交 PR 即表示你有权按仓库的 MIT 许可证贡献该内容。

By submitting a pull request, you confirm that you have the right to contribute the work under the repository's MIT License.
