import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";

const port = Number(process.env.PORT ?? 4173);
const root = process.cwd();
const allowedRoots = ["visualization", "dependency_graph.json", "inference_report.json"];
const types: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

createServer((request, response) => {
  const requested = decodeURIComponent((request.url ?? "/").split("?")[0] ?? "/");
  const relative = requested === "/" ? "visualization/index.html" : requested.replace(/^\/+/, "");
  const safe = normalize(relative);
  if (!allowedRoots.some((entry) => safe === entry || safe.startsWith(`${entry}\\`) || safe.startsWith(`${entry}/`))) {
    response.writeHead(403).end("Forbidden");
    return;
  }
  const path = join(root, safe);
  if (!existsSync(path) || !statSync(path).isFile()) {
    response.writeHead(404).end("Not found");
    return;
  }
  response.writeHead(200, { "Content-Type": types[extname(path)] ?? "application/octet-stream" });
  createReadStream(path).pipe(response);
}).listen(port, "127.0.0.1", () => {
  console.log(`Dependency Atlas: http://127.0.0.1:${port}`);
});
