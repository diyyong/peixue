# AI 服务商兼容、费用与隐私指南

陪学笔记不附带模型、API key 或免费额度。部署者需要自行选择并支付 AI 服务商；项目只负责把家庭配置的请求发送到该服务商。

## 1. 接口兼容范围

后端目前支持 **OpenAI-compatible Chat Completions** 风格接口，不支持 Responses API、Assistants API、工具调用或供应商专有 SDK。`AI_ENDPOINT` 必须是完整的 `/chat/completions` 地址，并满足以下约定：

- 使用 `Authorization: Bearer <AI_API_KEY>` 与 JSON 请求体
- 非流式响应正文位于 `choices[0].message.content`
- 流式响应使用 `data:` SSE 帧，正文位于 `choices[0].delta.content`
- 如返回思考过程，可使用 `choices[0].delta.reasoning_content` 或 `reasoning`
- 流式响应应正常结束；兼容接口通常发送 `data: [DONE]`
- 视觉模型接受 OpenAI 风格的文字与图片多模态消息

“OpenAI-compatible”不是完整标准。相同模型经不同网关提供时，字段、上下文上限、图片格式、超时和内容策略都可能不同，必须在自己的部署上验证。

## 2. 配置项

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `AI_ENDPOINT` | 是 | 完整 Chat Completions 请求地址 |
| `AI_API_KEY` | 是 | 服务商密钥，只保存在服务器 `.env` 中 |
| `AI_MODEL` | 是 | 分析、出题和讲解的默认文本模型 |
| `AI_MODEL_ANALYZE` | 否 | 单独覆盖错题分析模型 |
| `AI_MODEL_QUIZ` | 否 | 单独覆盖复习题模型 |
| `AI_MODEL_EXPLANATION` | 否 | 单独覆盖讲解卡模型 |
| `AI_VISION_MODEL` | 图片功能需要 | 图片题识别模型，不继承 `AI_MODEL` |
| `AI_USE_JSON_FORMAT` | 否 | 默认 `true`；服务商拒绝 `response_format` 时设为 `false` |
| `AI_THINKING` | 否 | 全局思考模式，默认 `enabled` |
| `AI_THINKING_ANALYZE` 等 | 否 | 按功能覆盖全局思考模式 |

思考模式按 `AI_THINKING_<功能>`、`AI_THINKING`、`enabled` 的顺序取值：

- `enabled`：不发送 `thinking` 字段，沿用上游默认行为
- `disabled`（也接受 `off`、`false`、`no`、`0`）：发送 `thinking: {"type":"disabled"}`
- `auto`：发送 `thinking: {"type":"auto"}`；只有部分服务商支持

如果带 `response_format: {"type":"json_object"}` 的非流式请求被上游明确拒绝，后端会关闭该模型的 JSON 模式并重试一次；也可直接设置 `AI_USE_JSON_FORMAT=false`。流式请求不发送 `response_format`。单次上游调用总超时为 300 秒。

## 3. 费用和应用内配额

实际费用由服务商、模型、输入输出 token、思考长度和图片数量决定。项目无法给出通用金额；启用前应查看所选服务商的最新定价、免费额度、数据保留与区域政策，并设置服务商侧预算告警或硬上限。

陪学笔记的每日配额是每个家庭的 **AI 生成次数保护**，不是 token 或人民币/美元预算。管理员可以查看和调整：

```bash
docker compose exec backend npm run admin -- usage FAMILY_ID --days=7
docker compose exec backend npm run admin -- update FAMILY_ID --quota=100
```

缓存命中的复习题不会再次生成；新分析、图片识别、新复习题和讲解卡通常会消耗一次配额。上游重试、服务商计费规则与应用配额并不等价，费用仍应以服务商账单为准。

## 4. 首次上线验证

只用虚构内容创建测试家庭，依次验证：

1. 文字题分析能返回结构化结果，并能保存记录。
2. 上传一张无个人信息的测试题图片，识别结果可编辑。
3. 到期复习能流式生成一道题，完成或刷新后页面状态正常。
4. 连续答错后的讲解卡能流式生成，公式和图示可显示。
5. 将配额调小，确认达到上限时返回友好提示。
6. 查看后端日志，确认没有 API key、完整提示词或儿童真实数据被意外记录。

不要把真实儿童姓名、照片或学校信息用于兼容性测试。至少在手机和桌面浏览器各走一次流程。

## 5. 常见失败模式

| 现象 | 优先检查 |
| --- | --- |
| `401` / `403` | API key、模型权限、账户状态、endpoint 所属区域 |
| `400` | 模型名、视觉消息格式、`response_format`、`thinking` 参数 |
| `429` | 应用家庭配额、每分钟保护限流，以及服务商账户限额 |
| `5xx` | 服务商状态、网关日志；稍后重试，避免高频刷新 |
| 300 秒后超时 | 模型拥堵、思考模式、输出上限、反向代理读取超时 |
| JSON 解析失败 | 模型未按提示返回 JSON；尝试更可靠模型或检查截断 |
| 流式内容为空/中断 | SSE `data:` 格式、代理 buffering、连接超时和 `[DONE]` 行为 |
| 图片功能失败 | `AI_VISION_MODEL` 是否支持输入图片、图片大小与内容策略 |

反向代理对 SSE 必须关闭缓冲，读取超时至少 310 秒。生产故障排查见[部署指南](DEPLOYMENT.md)。

## 6. 教育与隐私边界

AI 对开放题、模糊照片、手写内容、答案判断和年龄适配都可能出错，也可能生成看似合理但不正确的解释。生成内容必须先由家长或教师检查；不要把它当作成绩评定、诊断、医疗或专业教育建议。

进行文字分析时，题目、家长观察和相关上下文会发送给配置的服务商；使用图片识别时，所选图片也会发送。项目无法控制第三方服务商的日志、训练、保留和跨境处理。部署者应先阅读服务商的数据政策，遵循适用法律，并尽量删除姓名、学校、面孔和其他识别信息。

## English summary

Peixue requires an operator-supplied, paid Chat Completions-compatible endpoint; it does not bundle a model or credits. Responses/Assistants APIs and tool calling are not currently supported. Cost depends on the selected provider, models, tokens, reasoning, and images. The in-app daily quota counts AI generations, not money or tokens.

Test text analysis, vision, quiz streaming, explanation streaming, JSON behavior, and quota handling with synthetic data before production. Question text, parent notes, context, and selected images are sent to the configured provider. Review its pricing and data policy, set provider-side spending limits, and have an adult verify every generated educational result.
