# 开源发布清单

这份清单按当前工作区的真实状态编写。带勾项目已经在本地完成；未勾项目必须由维护者补充或确认。

## 公开前硬门槛

- [x] **补回前端首选源码**：React/Vite/Tailwind 源文件、`package.json`、官方 registry 锁文件、构建命令和多阶段 Docker 镜像
- [x] **补齐前端第三方许可证**：已从实际安装的 React、React DOM、Scheduler、Lucide 与 DOMPurify 包核对，并随前端构建分发 notices
- [x] **确认版权归属**：维护者已确认有权发布全部代码和素材
- [x] **确认许可证选择**：维护者已确认使用 MIT License
- [ ] **轮换现有凭据**：即使 `.env` 从未提交，也建议在公开前轮换生产数据库密码、API key 和家庭密码
- [ ] **清理真实数据**：不要上传数据库、JSON 备份、日志、截图中的姓名/照片/IP/家庭 id 或真实错题
- [ ] **完成一次干净环境端到端验证**：从新 clone、复制 `.env.example`、启动、建家庭、记录、导出和恢复

> 公共仓库、源码、构建、CI 和自动检查已经补齐。仍需维护者轮换真实凭据并完成真实 Docker 端到端验收；有可核验的 Release 与维护记录后再提交 Codex for OSS 申请更有说服力。

## 已补齐的仓库基础

- [x] 中英文 README 与明确的快速开始
- [x] MIT `LICENSE`
- [x] `.gitignore` 排除 `.env`、依赖、备份和 `Zone.Identifier`
- [x] Docker Compose、前后端镜像与 SSE 反向代理配置
- [x] `.env.example`，不含真实凭据
- [x] `CONTRIBUTING.md`、`CODE_OF_CONDUCT.md`、`SECURITY.md`
- [x] Issue 表单、PR 模板、Dependabot 与基础 CI
- [x] 仓库静态自检脚本
- [x] 修复 PWA 清单引用不存在图标的问题
- [x] 前端干净安装、Lint 与生产构建纳入 CI
- [x] 前后端 npm 生产依赖审计纳入 CI

## 首发前体验检查

- [ ] 增加 3–5 张完全匿名的真实界面截图或 60–90 秒演示视频
- [x] 提供不含个人数据的演示数据导入文件
- [ ] 在手机和桌面浏览器验证安装、登录、记录、识图、复习、备份流程
- [ ] 用至少一个明确列出的文本模型与视觉模型完成兼容性验证
- [x] 说明 AI 调用成本、失败模式和不支持的接口/不可靠题型
- [x] 公开已知限制和短期 roadmap
- [ ] 建立至少 3 个适合外部贡献者的 Issue，并标记 `good first issue` / `help wanted`

## GitHub 发布后

- [ ] 设置 About 描述、项目主页、Social preview 和 topics
- [ ] 开启 Issues、Discussions、Private Vulnerability Reporting 与 Dependabot alerts
- [ ] 保护 `main` 分支，要求 CI 通过后合并
- [ ] 发布带变更说明的首个 Release，并附安装/升级说明
- [ ] 在 README 写明维护者和获得帮助的渠道
- [ ] 只记录真实、征得同意且不侵犯隐私的使用反馈和采用数据

## Codex for OSS 申请前

- [x] 仓库已公开，源码可构建，MIT License 已被 GitHub 识别
- [ ] 有可查看的维护活动：commit、Issue、PR、Release、路线图
- [ ] 能用链接证明你是核心维护者
- [ ] 能用真实数字或公开证据说明项目使用情况；没有数据就诚实说明
- [ ] 明确说明项目为何对开源生态或服务不足的人群重要
- [ ] 明确说明 Codex 将用于维护、测试、评审、安全和发布工作，而不是泛泛地“帮助写代码”
- [ ] 申请文案中的每个数字、奖项、用户评价和安全声明均可验证

申请草稿见 [CODEX_FOR_OSS_APPLICATION.md](CODEX_FOR_OSS_APPLICATION.md)。
