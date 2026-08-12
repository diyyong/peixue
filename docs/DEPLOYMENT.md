# 部署指南

## 1. 推荐方式：Docker Compose

### 前置条件

- Docker Engine 24+（或兼容版本）
- Docker Compose v2
- 一个支持 Chat Completions 风格请求和 SSE 流式响应的 AI 服务
- 生产环境中的域名与 HTTPS 终止代理

### 配置

在仓库根目录运行：

```bash
cp .env.example .env
```

必须修改：

| 变量 | 用途 |
| --- | --- |
| `DB_PASSWORD` | 后端访问 MySQL 的密码 |
| `MYSQL_ROOT_PASSWORD` | MySQL root 密码，只用于数据库管理 |
| `AI_ENDPOINT` | 完整的 `/chat/completions` 请求地址 |
| `AI_API_KEY` | 模型供应商密钥 |
| `AI_MODEL` | 默认文本模型 |
| `AI_VISION_MODEL` | 图片题识别模型；不用图片功能时仍建议明确留空并测试失败提示 |
| `APP_PORT` | 对外 Web 端口，默认 `8080` |

可选的 `AI_MODEL_ANALYZE`、`AI_MODEL_QUIZ` 和 `AI_MODEL_EXPLANATION` 会覆盖默认文本模型。空值继承 `AI_MODEL`。

模型兼容性要求：

- 接受 Bearer token 与 JSON 请求
- 返回 `choices[0].message.content`
- 流式时发送 `data:` SSE 帧，并以 `[DONE]` 结束
- 视觉模型接受 OpenAI 风格的多模态消息
- 如不支持 `response_format: {"type":"json_object"}`，设置 `AI_USE_JSON_FORMAT=false`
- 如供应商不接受 `thinking` 参数，保持 `AI_THINKING=enabled`；该模式不会显式发送 `thinking` 字段

不同供应商对字段、模型名和内容政策的兼容程度不同。首次部署必须用虚构题目验证分析、出题、识图和讲解卡四条路径。

详细的配置语义、费用、测试矩阵、常见失败与数据边界见 [AI 服务商兼容、费用与隐私指南](AI_PROVIDER_GUIDE.md)。

### 启动与初始化

```bash
docker compose up -d --build
docker compose ps
```

数据库健康后创建家庭：

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

管理命令：

```bash
docker compose exec backend npm run admin -- list
docker compose exec backend npm run admin -- usage FAMILY_ID --days=7
docker compose exec backend npm run admin -- update FAMILY_ID --quota=200
```

重置密码时同样先用 `read -s` 设置临时变量，再运行：

```bash
read -r -s -p "新的家庭访问密码（至少 12 个字符）: " PEIXUE_FAMILY_PASSWORD
echo
docker compose exec -e PEIXUE_FAMILY_PASSWORD="$PEIXUE_FAMILY_PASSWORD" \
  backend npm run admin -- reset-password FAMILY_ID --password-env
unset PEIXUE_FAMILY_PASSWORD
```

`--password-env` 避免把密码原文写进 shell history；密码仍可能短暂出现在本机进程环境中，因此服务器账户只应授权给可信管理员。

### 生产网络

Compose 默认只把 Nginx 的 Web 端口映射到宿主机，MySQL 与 Express 仅在内部网络可达。生产环境应再用 Caddy、Traefik、Nginx 或云负载均衡器提供 HTTPS，并将公网请求转发到 `APP_PORT`。

不要：

- 给 `mysql` 增加公网 `ports`
- 给 `backend` 增加公网 `ports`
- 在无 HTTPS 的公网地址输入家庭密码或儿童数据
- 把 `.env`、数据库目录或备份放入 Web 根目录

如前后端确实跨域部署，在 `CORS_ORIGIN` 中列出完整来源，多个来源用逗号分隔。生产环境不要使用 `*`。

## 2. 备份与恢复

应用内的“导出”会生成家庭范围 JSON，并包含题目图片。该文件属于敏感数据。

完整 MySQL 备份：

```bash
docker compose exec -T mysql sh -c \
  'exec mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" --single-transaction "$MYSQL_DATABASE"' \
  > peixue-backup.sql
```

将备份立即移动到加密存储，限制文件权限，并按保留策略删除过期副本。

恢复会覆盖或合并真实数据，操作前先停写并再做一次备份。示例命令仅用于已确认目标为空或允许覆盖的数据库：

```bash
docker compose exec -T mysql sh -c \
  'exec mysql -uroot -p"$MYSQL_ROOT_PASSWORD" "$MYSQL_DATABASE"' \
  < peixue-backup.sql
```

## 3. 升级

```bash
docker compose exec -T mysql sh -c \
  'exec mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" --single-transaction "$MYSQL_DATABASE"' \
  > peixue-before-upgrade.sql

git pull --ff-only
docker compose build --pull
docker compose up -d
docker compose ps
curl http://localhost:${APP_PORT:-8080}/api/health
```

后端启动时会运行 schema 迁移。不要跳过升级前备份，也不要同时启动两个不同版本对同一数据库执行迁移。

## 4. 本地源码开发

安装 MySQL 8 并创建数据库和用户后：

```bash
cp .env.example peixue-server/.env
cd peixue-server
npm ci
npm test
npm start
```

后端原生模式默认监听 `127.0.0.1:3001`。

另开一个终端启动前端开发服务器：

```bash
npm --prefix peixue-frontend ci
npm --prefix peixue-frontend run dev
```

Vite 默认打开本地开发站点，并把 `/api` 代理到 `http://127.0.0.1:3001`。提交前运行：

```bash
npm --prefix peixue-frontend run check
node scripts/check-repository.mjs
```

如需不用 Docker 部署静态前端，运行 `npm --prefix peixue-frontend run build`，只发布生成的 `peixue-frontend/dist/`。Web 服务器还需把 `/api/` 反向代理到后端；SSE 路由必须关闭代理缓冲并把读取超时设为至少 310 秒。请保持同等的安全响应头与 SPA fallback，可直接参考 [`peixue-frontend/nginx.conf`](../peixue-frontend/nginx.conf)。不要把 `src/` 当作生产静态文件直接托管。

## 5. 故障排查

```bash
docker compose ps
docker compose logs --tail=200 mysql
docker compose logs --tail=200 backend
curl -i http://localhost:${APP_PORT:-8080}/api/health
```

- `database: error`：检查数据库密码、主机名、磁盘空间和 MySQL 健康状态
- AI 返回 `401/403`：检查 API key、endpoint 与模型权限
- AI 返回 `400`：检查模型名、`response_format` 和 `thinking` 兼容性
- SSE 中途结束：确认反向代理已关闭 buffering，且超时不低于后端的 300 秒
- `wrong_password`：用管理 CLI 确认家庭存在且未过期，必要时重置密码
- 图片请求 `413`：确认最外层代理的请求体上限也至少为 64 MB
