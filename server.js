// Mosaico IPTV — Proxy para Render.com (Node.js)
import http from "http";
import https from "https";
import { URL } from "url";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
const PORT = process.env.PORT || 3000;

const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect width="96" height="96" rx="22" fill="#141b2d"/><rect x="18" y="18" width="27" height="27" rx="6" fill="#4cc9f0"/><rect x="51" y="18" width="27" height="27" rx="6" fill="#f72585"/><rect x="18" y="51" width="27" height="27" rx="6" fill="#38d9a9"/><rect x="51" y="51" width="27" height="27" rx="6" fill="#ffd166"/></svg>`;
const MANIFEST = JSON.stringify({
  name: "Mosaico IPTV", short_name: "Mosaico", start_url: "/", scope: "/",
  display: "fullscreen", display_override: ["fullscreen", "standalone"], orientation: "any",
  background_color: "#0b0f1a", theme_color: "#0b0f1a",
  icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any maskable" }],
});

const UAS = {
  vlc: "VLC/3.0.20 LibVLC/3.0.20",
  smarters: "IPTVSmartersPlayer",
  tivimate: "TiviMate/4.7.0 (Android 12)",
  browser: "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36",
};

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Range, Content-Type",
    "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges",
  };
}

function fixIp(u) {
  const x = new URL(u);
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(x.hostname)) x.hostname = x.hostname + ".nip.io";
  return x.href;
}

function wrap(u, base, ua) {
  try {
    return "/proxy?url=" + encodeURIComponent(new URL(u, base).href) + (ua ? "&ua=" + encodeURIComponent(ua) : "");
  } catch { return u; }
}

function rewriteHls(text, base, ua) {
  return text.split(/\r?\n/).map((line) => {
    const t = line.trim();
    if (!t) return line;
    if (t.startsWith("#")) return line.replace(/URI="([^"]+)"/g, (_, u) => `URI="${wrap(u, base, ua)}"`);
    return wrap(t, base, ua);
  }).join("\n");
}

function fetchUrl(targetUrl, headers) {
  return new Promise((resolve, reject) => {
    const mod = targetUrl.startsWith("https") ? https : http;
    const req = mod.request(targetUrl, { headers, method: "GET" }, (res) => {
      resolve(res);
    });
    req.on("error", reject);
    req.end();
  });
}

async function fetchFollow(target, headers) {
  let u = target;
  for (let i = 0; i < 8; i++) {
    u = fixIp(u);
    const res = await fetchUrl(u, headers);
    const loc = res.headers["location"];
    if ([301, 302, 303, 307, 308].includes(res.statusCode) && loc) {
      res.resume();
      u = new URL(loc, u).href;
      continue;
    }
    return { upstream: res, finalUrl: u };
  }
  throw new Error("demasiadas redirecciones");
}

function readBody(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", c => chunks.push(c));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost`);

  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, cors());
    return res.end();
  }

  // Manifest
  if (url.pathname === "/manifest.webmanifest") {
    res.writeHead(200, { ...cors(), "content-type": "application/manifest+json" });
    return res.end(MANIFEST);
  }

  // Icon
  if (url.pathname === "/icon.svg") {
    res.writeHead(200, { ...cors(), "content-type": "image/svg+xml" });
    return res.end(ICON);
  }

  // Proxy
  if (url.pathname === "/proxy") {
    if (url.searchParams.get("ping")) {
      res.writeHead(200, { ...cors(), "content-type": "text/plain" });
      return res.end("mosaico-ok");
    }

    const target = url.searchParams.get("url");
    if (!target || !/^https?:\/\//i.test(target)) {
      res.writeHead(400, cors());
      return res.end("Dirección no válida");
    }

    const ua = UAS[url.searchParams.get("ua")] || UAS.vlc;
    const headers = { "User-Agent": ua, "Accept": "*/*" };
    const range = req.headers["range"];
    if (range) headers["Range"] = range;

    let upstream, finalUrl;
    try {
      ({ upstream, finalUrl } = await fetchFollow(target, headers));
    } catch (e) {
      res.writeHead(502, cors());
      return res.end("No se pudo conectar: " + e.message);
    }

    if (url.searchParams.get("debug")) {
      const buf = await readBody(upstream);
      const bodyStart = buf.toString("utf8").replace(/[^\x20-\x7E\n]/g, ".").slice(0, 300);
      res.writeHead(200, { ...cors(), "content-type": "application/json" });
      return res.end(JSON.stringify({
        status: upstream.statusCode,
        redirectedTo: finalUrl !== target ? finalUrl : "",
        server: upstream.headers["server"] || "",
        contentType: upstream.headers["content-type"] || "",
        bodyStart,
      }, null, 2));
    }

    const ct = upstream.headers["content-type"] || "";
    const pathPart = new URL(finalUrl).pathname;
    const maybePlaylist = /mpegurl/i.test(ct) || /\.m3u8?$/i.test(pathPart);

    if (maybePlaylist && upstream.statusCode === 200) {
      const buf = await readBody(upstream);
      const text = buf.toString("utf8");
      const body = text.includes("#EXT-X-") ? rewriteHls(text, finalUrl, url.searchParams.get("ua")) : text;
      res.writeHead(200, { ...cors(), "content-type": "application/vnd.apple.mpegurl", "cache-control": "no-cache" });
      return res.end(body);
    }

    const outHeaders = { ...cors() };
    for (const h of ["content-type", "content-length", "content-range", "accept-ranges", "cache-control"]) {
      if (upstream.headers[h]) outHeaders[h] = upstream.headers[h];
    }
    res.writeHead(upstream.statusCode, outHeaders);
    upstream.pipe(res);
    return;
  }

  // App
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
  res.end(HTML);
});

server.listen(PORT, () => console.log("Mosaico proxy escuchando en puerto " + PORT));
