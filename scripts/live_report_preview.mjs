import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const upstream = "https://tm-reports.com";
const server = await createServer({
  root,
  server: {
    host: "127.0.0.1", port: 5173, strictPort: true,
    proxy: {
      "/api": { target: upstream, changeOrigin: true },
      "/data/trading-replays": { target: upstream, changeOrigin: true },
    },
  },
});
await server.listen();
console.log(JSON.stringify({ url: "http://127.0.0.1:5173/portfolio-report", mode: "live", upstream, pid: process.pid }));
server.printUrls();
