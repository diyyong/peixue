# 已知限制 / Known limitations

这份文件记录当前版本的边界，避免部署者把项目能力或安全性理解得过高。

## 产品与使用

- 界面目前以中文家庭场景为主，尚未实现完整 UI 国际化；英文 README 不代表应用界面已有英文版。
- PWA 需要连接自托管服务器，不支持离线新增或编辑记录。
- 家庭成员共享一个家庭密码；目前没有个人账号、双因素认证或自助密码找回。管理员只能重置密码，无法读取其明文。
- JSON 导入会覆盖当前家庭数据。导入、升级或数据库恢复前必须另做备份。
- 尚未验证大规模家庭数、超大图片库或高并发部署；当前定位是小规模自托管。

## AI 与教学

- AI 可能误识别图片、推断错误概念、生成错误答案或不合适的讲法。家长必须先检查再给孩子使用。
- 当前适配的是 Chat Completions 风格 JSON/SSE 接口。不同供应商对视觉消息、`response_format`、thinking 字段和流式事件的实现不同，不能假定任意“OpenAI-compatible”服务都能直接工作。
- 项目不是教师、医疗或专业教育评估的替代品，也不承诺学习效果或准确率。

## 隐私、安全与合规

- 题目文字和用户选择的图片会发送给部署者配置的 AI 供应商；项目无法控制该供应商的数据留存或训练政策。
- 项目没有宣称符合 GDPR、COPPA、PIPL 或任何地区的儿童隐私、教育或医疗合规要求。部署者必须自行评估并取得必要同意。
- 浏览器会在本地存储家庭密码；共享设备上的用户应在使用后清除站点数据。

## 当前验证范围

- CI 覆盖仓库隐私/结构检查、前端 Lint/单元测试/构建、后端单元测试、生产依赖审计和容器构建。
- 真实浏览器端到端流程、手机 PWA 安装、模型供应商兼容性及从空数据库完成的 Docker 验收仍是首发清单中的人工项目。

---

The current UI is Chinese-first, requires an online self-hosted server, and uses one shared password per family. AI output must be reviewed by a parent, provider compatibility varies, and the project makes no regulatory-compliance or learning-outcome claims. See the Chinese sections above and the [release checklist](OPEN_SOURCE_CHECKLIST.md) for the complete, authoritative list.
