import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],

  build: {
    // 编译目标：兼容到 Safari 15（iOS 15 时代）
    target: ["es2020", "edge88", "firefox78", "chrome87", "safari15"],
    cssTarget: ["chrome87", "safari15"],
    assetsInlineLimit: 4096,

    // 分包策略：改写为函数形式，满足新版引擎的要求
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/react/") || id.includes("node_modules/react-dom/")) {
            return "vendor-react";
          }
          if (id.includes("node_modules/lucide-react/")) {
            return "vendor-icons";
          }
        },
      },
    },


    // 打包后如果某个 chunk 超过 600KB 会警告；我们业务代码应该远小于这个
    chunkSizeWarningLimit: 600,
  },

  server: {
    // `npm run dev` works with a backend started on the documented default port.
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3001",
        changeOrigin: true,
      },
    },
  },
});
