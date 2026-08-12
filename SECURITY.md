# 安全政策 / Security Policy

## 报告漏洞

请不要为安全漏洞创建公开 Issue，也不要附上真实家庭数据来证明问题。

仓库公开后，请进入 GitHub 仓库的 **Security → Report a vulnerability**，使用 Private Vulnerability Reporting 提交。报告尽量包含：

- 受影响版本或 commit
- 最小化、完全虚构数据的复现步骤
- 可能影响（尤其是跨家庭访问、认证绕过、儿童数据泄露、任意文件/SQL/脚本执行）
- 可行的修复思路（可选）

维护者会确认收到报告、评估影响，并在修复可用后协调披露。项目目前由小规模维护者维护，暂不承诺固定响应时限。

## 支持范围

安全修复只保证进入最新发布版本。部署者应保持后端依赖、MySQL、Nginx 和宿主系统更新。

## 部署者安全清单

- 生产环境使用 HTTPS；只公开前端反向代理端口
- 不直接公开 MySQL 或后端 `3001` 端口
- 为数据库 root、应用数据库用户和每个家庭设置不同的强密码
- 将 `.env` 权限限制为部署账户可读，并确认它未被 Git 跟踪
- 加密数据库卷、应用导出的 JSON 和异地备份
- 限制管理 CLI 与服务器 shell 权限
- 明确告知家庭：哪些题目文字或图片会发送给所选 AI 供应商
- 在公用设备上使用后退出或清除站点数据

## Security reports in English

Do not open a public issue. Once the repository is public, use **Security → Report a vulnerability**. Include the affected version, a reproduction using entirely synthetic data, and the potential impact. Never attach a real family export, child image, password, token, or provider response containing personal data.
