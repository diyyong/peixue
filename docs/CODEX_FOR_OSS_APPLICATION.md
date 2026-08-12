# Codex for OSS 申请建议

更新日期：2026-08-12

官方页面：[Codex for Open Source](https://developers.openai.com/community/codex-for-oss) · [申请表](https://openai.com/zh-Hans-CN/form/codex-for-oss/)

## 官方目前明确了什么

OpenAI 官方页面说明：开源项目维护者可以申请六个月的 ChatGPT Pro with Codex、按项目评估的 Codex Security 访问，以及面向 PR 评审、维护自动化、发布流程等核心 OSS 工作的 API credits。官方邀请核心维护者或广泛使用的公共项目申请；项目不完全符合这些条件、但对生态有重要作用时，也可以申请并解释原因。

这意味着审核重点应是**真实项目与维护价值**，不是堆砌关键词。官方页面没有把“双语 README”列为资格条件。

## 要不要双语

建议双语，但分工要清楚：

- `README.md` 用中文服务核心用户，顶部放醒目的 English 链接
- `README.en.md` 完整覆盖用途、安装、架构、隐私、贡献和限制
- GitHub About 用简洁英文，并保留“中文友好”这一定位
- 申请表优先用英文，让跨地区评审者不依赖翻译即可核验
- Issue 和 PR 接受中英文，不要求每条讨论都维护两份翻译

双语能降低评审和国际贡献门槛，但不会替代公共源码、真实使用、维护记录和清晰许可证。

## 现在是否适合申请

**仍建议先完成公开首发再提交。** 当前本地工作区已经有可构建前端源码、依赖锁文件、第三方许可证、CI 和安全文档，但还没有可供审核者访问的公共 GitHub URL、Release 与维护/采用证据。下一步是：

1. 由维护者确认版权归属与 MIT 许可证选择，轮换真实凭据
2. 用 Docker 从空数据库完成一次端到端验收
3. 公开仓库并发布至少一个可安装 Release
4. 积累一段真实维护记录和可验证的使用反馈
5. 再用下面的证据写申请

新项目并非不能申请；官方允许“对生态很重要但不完全符合条件”的项目解释原因。但新仓库仅靠漂亮文案，不会比可验证证据更有说服力。

## GitHub 应怎样呈现

推荐仓库描述：

```text
Self-hosted AI learning companion for families—growth records, spaced reviews, and teach-back cards. 中文友好。
```

推荐一句英文定位：

```text
Peixue helps Chinese-speaking families turn everyday learning struggles into a private, reviewable growth process that parents can guide—not outsource—to AI.
```

README 首屏应回答：

- 谁使用：陪孩子学习的家长或照护者
- 核心问题：错题和观察容易散失，复习时机与讲法难以持续
- 独特方法：家长记录 → AI 辅助分析 → 间隔复习 → teach-back 讲解卡
- 为什么开源：允许家庭自托管并选择模型供应商，降低儿童数据集中化风险
- 如何验证：一键部署、匿名演示、测试、版本发布、公开 roadmap

不要把“使用 AI”“教育公益”本身当作影响证明，也不要声称未经验证的准确率、用户数、合规性或安全性。

## 申请证据表

| 想表达的内容 | 最有力的公开证据 |
| --- | --- |
| 我是核心维护者 | Contributors/commit 历史、Release 发布者、Issue/PR 处理记录 |
| 项目是真正开源且可用 | Public repo、可识别 License、源码与锁文件、CI、安装成功记录 |
| 有真实使用 | 经同意的匿名采用数字、Release 下载、公开讨论、外部 Issue/PR、部署反馈 |
| 对生态或人群重要 | 明确的未满足需求、用户反馈链接、被其他项目/文章引用、可复用的技术组件 |
| 会持续维护 | roadmap、规律 Release、已关闭 Issue、迁移与安全政策 |
| Codex 资源会产生杠杆 | 具体测试/安全/PR/发布自动化计划及可衡量目标 |

Stars 可以是真实信号之一，但不要买 star、互刷或把 star 当作唯一影响指标。儿童产品更适合采用隐私友好的、明确征得同意的汇总数据。

## 可直接改写的英文申请草稿

方括号内容必须替换为真实、可公开核验的信息；没有证据的句子直接删除，不要猜数字。

### Project summary

```text
Peixue is a self-hosted, open-source learning companion for Chinese-speaking families. It helps parents capture a child's mistakes, questions, and learning observations, then turn them into a reviewable growth record, spaced practice, and parent-led teach-back cards. The goal is to help parents stay involved in the learning process rather than hand it over to an AI tutor.

The project combines a PWA, an Express/MySQL backend, image-question support, multi-family isolation, backups, and configurable Chat Completions-compatible model providers. Self-hosting and provider choice are important because the product handles sensitive child learning data.
```

### Your role

```text
I created Peixue and am its core maintainer. I designed the parent-child learning workflow, implemented the application and database migrations, maintain deployment and security documentation, triage issues, and review releases and contributions.

Public maintainer evidence: [CONTRIBUTORS/COMMITS/RELEASES URLS]
```

### Usage and impact

选择符合真实情况的一版。

已有可验证采用时：

```text
As of [DATE], Peixue is used by [VERIFIABLE NUMBER] families/deployments across [SCOPE]. Evidence includes [PUBLIC LINKS OR PRIVACY-SAFE MEASUREMENT METHOD]. Users have reported [SPECIFIC, CONSENTED, ANONYMIZED OUTCOME]. The project serves an underserved workflow: Chinese-language, parent-led learning support that can be self-hosted instead of sending a family's complete learning history to a centralized product.
```

尚处于早期时：

```text
Peixue began as software I built for my own family's real learning workflow and is now being opened so other families and educators can inspect, self-host, and improve it. It is early and I do not yet claim broad adoption. I believe it is worth supporting because there are few open, Chinese-first tools that treat the parent as the guide, combine longitudinal learning records with spaced review, and allow families to control hosting and model-provider choices.
```

### How Codex would help the OSS work

```text
I would use ChatGPT Pro with Codex to expand regression tests around family isolation, import/export, MySQL migrations, SSE cancellation, and model-provider compatibility; review incoming pull requests; reproduce issues; maintain Chinese and English documentation; and improve accessibility.

Because Peixue handles child learning records and optional question images, I would use any eligible Codex Security access to examine authentication boundaries, data export/import paths, image and SVG handling, dependency risk, and deployment defaults, then publish fixes and security guidance for self-hosters.

If API credits are available, I would use them for open-source maintainer automation such as PR triage and review, reproducible issue checks, release-note preparation, and dependency-update validation—not as a substitute for the end-user inference costs of hosted Peixue deployments.
```

### Six-month outcomes

```text
Within six months, I plan to deliver: [N] automated tests for the highest-risk data boundaries; documented compatibility for [N] text/vision model configurations; [N] accessible and privacy-safe starter issues for contributors; a repeatable release pipeline; and response/merge targets for community issues and pull requests. Progress will be visible at [ROADMAP URL].
```

只填写你确实愿意承担的数字。小而可信的目标优于宏大、无法核验的承诺。

## 提交前最后检查

- 所有链接在无登录浏览器中可打开
- README 英文版不是只有一句摘要
- 快速开始能从空环境复现
- 前端源码、依赖清单和第三方许可证完整
- 申请中的用户数、部署数、评价和路线目标有来源
- 没有上传儿童数据或为了统计而增加不必要追踪
- 明确区分 Codex 维护用途与产品终端用户的模型调用成本
- 文案诚实说明当前阶段、限制和你的核心维护角色
