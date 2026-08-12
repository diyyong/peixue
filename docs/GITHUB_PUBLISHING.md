# 第一次发布到 GitHub

这份步骤假设你要把当前目录发布为新的公共仓库 `peixue`。在完成[开源发布清单](OPEN_SOURCE_CHECKLIST.md)中的硬门槛前，不要执行最后的公开推送。

## 1. 先决定这些信息

- 仓库名：建议 `peixue` 或 `peixue-learning-companion`
- 许可证：当前文件是 MIT；首次公开前确认是否符合你的长期意图
- 维护者公开联系方式：用于安全报告和社区行为问题
- 首页：有在线演示就填演示地址，没有可暂时留空

推荐 GitHub About 描述：

```text
Self-hosted AI learning companion for families—growth records, spaced reviews, and teach-back cards. 中文友好。
```

推荐 topics：

```text
education parenting edtech self-hosted spaced-repetition ai pwa nodejs mysql chinese
```

About 只有一个描述字段。建议用简洁英文覆盖国际评审者，再用“中文友好”指出主要用户；完整 README 保持中文主版与英文镜像。

## 2. 发布前检查本地文件

```bash
node scripts/check-repository.mjs
npm --prefix peixue-frontend ci
npm --prefix peixue-frontend run check
npm --prefix peixue-frontend audit --omit=dev
npm --prefix peixue-server ci
npm --prefix peixue-server test
npm --prefix peixue-server audit --omit=dev
git status --short --ignored
git check-ignore -v .env peixue-server/.env
git check-ignore -v qianduan yuanma
```

两条 `git check-ignore` 命令必须分别显示本地凭据和源码恢复目录被 `.gitignore` 排除。然后逐页阅读将要提交的内容：

```bash
git add .
git diff --cached --check
git diff --cached --stat
git status --short
```

不要只看文件名。检查 staged diff 中是否出现密码、token、真实域名、IP、儿童姓名、题目图片或数据库导出。二进制截图必须逐张人工检查。

如果误把密钥提交进任何本地 commit，仅从最新文件删除并不够；先轮换密钥，再清理整个 Git 历史，确认无误后才推送。

## 3. 创建首个 commit

先设置自己的 Git 身份：

```bash
git config user.name "你的公开名字"
git config user.email "你的 GitHub noreply 邮箱"
git commit -m "chore: prepare Peixue for open source"
```

建议使用 GitHub 提供的 `ID+username@users.noreply.github.com`，避免在 commit 中公开私人邮箱。

## 4. 创建公共仓库

### 用 GitHub 网页

1. 打开 GitHub，点击 **New repository**。
2. Owner 选你的账号，Repository name 填 `peixue`。
3. 填上面的 Description，选择 **Public**。
4. **不要**勾选自动添加 README、`.gitignore` 或 License；本地已有这些文件。
5. 创建后按页面给出的 existing repository 命令添加 `origin` 并推送。

```bash
git remote add origin https://github.com/YOUR_NAME/peixue.git
git push -u origin main
```

### 用 GitHub CLI

```bash
gh auth login
gh repo create peixue --public --source=. --remote=origin
git push -u origin main
```

不要在不知道目标账号或组织时直接复制命令执行；先用 `gh auth status` 确认登录身份。

## 5. 完善仓库页面

在仓库首页右侧 **About** 设置：

- Description 与 topics
- Website（在线演示存在时）
- Social preview：建议 1280×640，使用匿名界面或品牌图，不放儿童照片

在 **Settings** 中：

- 开启 Issues；有持续维护精力时再开启 Discussions
- 开启 Private Vulnerability Reporting、Dependabot alerts 与 dependency graph
- 给 `main` 添加保护规则，至少要求 CI 成功后合并
- 确认 Actions 默认权限为只读，只有需要时为单个 workflow 提权

随后创建：

1. 3–5 个真实 roadmap Issue，其中至少两个适合外部贡献者；可从 [`STARTER_ISSUES.md`](STARTER_ISSUES.md) 改写
2. 首个 Release，版本可与后端一致使用 `v4.8.1`
3. 一条带匿名截图的发布说明，写清适用人群、限制和安装路径

## 6. 让别人真的容易用

仓库描述只能帮助别人发现项目，采用通常取决于以下证据：

- 首屏 30 秒内看懂“谁用、解决什么、与错题本有何不同”
- 复制命令后能在干净环境启动
- 截图与演示使用完全虚构数据
- 失败时有明确错误和排障入口
- Issue 能得到回应，Release 有升级说明
- 项目公开已知限制，不夸大 AI 准确率或儿童隐私合规

发布后用真实用户的提问持续改 README，通常比堆更多宣传文字更有效。
