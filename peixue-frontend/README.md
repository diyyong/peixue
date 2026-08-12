# Peixue frontend / 陪学笔记前端

This directory contains the maintainable React, Vite, and Tailwind source for the Peixue PWA. 本目录是陪学笔记可维护、可重新构建的前端源码。

```bash
npm ci
npm run check
npm run dev
```

The development server proxies `/api` to `http://127.0.0.1:3001`. Production images use the multi-stage [`Dockerfile`](Dockerfile), build `dist/`, and serve it through the checked-in Nginx configuration.

开发时修改 `src/`，不要提交 `node_modules/`、`dist/` 或手工修改压缩产物。测试和截图只能使用虚构家庭数据。

Production-dependency licenses are distributed in [`public/THIRD_PARTY_NOTICES.txt`](public/THIRD_PARTY_NOTICES.txt).
