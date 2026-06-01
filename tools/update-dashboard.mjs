import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function formatShanghaiStamp(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  const ymd = `${map.year}${map.month}${map.day}`;
  const hm = `${map.hour}${map.minute}`;
  const human = `${map.year}-${map.month}-${map.day} ${map.hour}:${map.minute} (Asia/Shanghai)`;
  return { ymd, hm, human };
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function* walk(obj) {
  if (!obj || typeof obj !== "object") return;
  if (Array.isArray(obj)) {
    for (const item of obj) yield* walk(item);
    return;
  }
  yield obj;
  for (const value of Object.values(obj)) yield* walk(value);
}

function extractJsonAfter(html, marker) {
  const start = html.indexOf(marker);
  if (start < 0) return null;
  let i = start + marker.length;
  while (i < html.length && /\s/.test(html[i])) i++;
  if (html[i] !== "{" && html[i] !== "[") return null;
  const open = html[i];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inStr = false;
  let esc = false;

  for (let j = i; j < html.length; j++) {
    const ch = html[j];
    if (inStr) {
      if (esc) {
        esc = false;
        continue;
      }
      if (ch === "\\") {
        esc = true;
        continue;
      }
      if (ch === '"') inStr = false;
      continue;
    }

    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) depth--;
    if (depth === 0) return html.slice(i, j + 1);
  }

  return null;
}

function parseRelativeDays(text) {
  if (!text) return null;
  const t = String(text).toLowerCase();
  let m;
  if ((m = t.match(/(\d+)\s*day/))) return Number(m[1]);
  if ((m = t.match(/(\d+)\s*week/))) return Number(m[1]) * 7;
  return null;
}

async function fetchText(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: {
      "accept-language": "en-US,en;q=0.9",
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
      cookie: "CONSENT=YES+",
      ...(opts.headers || {}),
    },
  });
  return await res.text();
}

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: {
      "accept-language": "en-US,en;q=0.9",
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
      cookie: "CONSENT=YES+",
      ...(opts.headers || {}),
    },
  });
  return await res.json();
}

function extractInnertube(html) {
  const apiKey = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/)?.[1] ?? null;
  const clientName = html.match(/"INNERTUBE_CONTEXT_CLIENT_NAME":(\d+)/)?.[1];
  const clientVersion = html.match(/"INNERTUBE_CONTEXT_CLIENT_VERSION":"([^"]+)"/)?.[1] ?? null;
  const visitorData = html.match(/"VISITOR_DATA":"([^"]+)"/)?.[1] ?? null;

  const ctxIdx = html.indexOf('"INNERTUBE_CONTEXT":');
  let context = null;
  if (ctxIdx > 0) {
    const slice = html.slice(ctxIdx);
    const ctxJsonText = extractJsonAfter(slice, '"INNERTUBE_CONTEXT":');
    if (ctxJsonText) context = JSON.parse(ctxJsonText);
  }

  return {
    apiKey,
    clientName: clientName ? Number(clientName) : null,
    clientVersion,
    visitorData,
    context,
  };
}

function findEngagementCommentContinuation(initialData) {
  for (const node of walk(initialData)) {
    const ep = node.engagementPanelSectionListRenderer;
    if (!ep) continue;
    const pid = String(ep.panelIdentifier ?? "");
    if (!pid.includes("comments")) continue;
    for (const inner of walk(ep)) {
      const token = inner?.continuationEndpoint?.continuationCommand?.token;
      if (token) return token;
    }
  }
  return null;
}

function findAnyContinuationToken(obj) {
  for (const node of walk(obj)) {
    const token = node?.continuationEndpoint?.continuationCommand?.token;
    if (token) return token;
  }
  return null;
}

function collectCommentEntitiesFromMutations(mutations) {
  const comments = [];
  for (const m of mutations || []) {
    const p = m?.payload?.commentEntityPayload;
    if (!p) continue;
    const text = p?.properties?.content?.content ?? "";
    if (!text) continue;
    comments.push({
      author: p?.author?.displayName ?? null,
      text,
      published: p?.properties?.publishedTime ?? null,
    });
  }
  return comments;
}

function guessCommentCount(initialData) {
  for (const node of walk(initialData)) {
    if (typeof node?.commentCount === "number") return node.commentCount;
    if (typeof node?.commentCount === "string" && node.commentCount.trim()) {
      const n = Number(node.commentCount.replace(/[^\d]/g, ""));
      if (Number.isFinite(n) && n > 0) return n;
    }
    const cc = node?.commentsEntryPointHeaderRenderer?.commentCount?.simpleText;
    if (cc) {
      const n = Number(String(cc).replace(/[^\d]/g, ""));
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return null;
}

function isOfficialChannel(channelName) {
  if (!channelName) return false;
  const n = channelName.toLowerCase();
  return n.includes("mobile legends") || n.includes("moonton") || n.includes("mlbb official");
}

function inferSkinGroups(title) {
  const t = String(title ?? "").toUpperCase();
  const groups = [];

  if (t.includes("BELERICK") && t.includes("STARLIGHT")) {
    groups.push({ key: "Belerick — Starlight", category: "Starlight" });
  }
  if (t.includes("HARITH") && (t.includes("STARLIGHT") || t.includes("REBEL EMBERFANG"))) {
    groups.push({ key: "Harith — Rebel Emberfang (Starlight)", category: "Starlight" });
  }

  if (t.includes("BALMOND") && (t.includes("TITAN") || t.includes("TITANS")) && t.includes("COLLECTOR")) {
    groups.push({ key: "Balmond — Titan (Collector)", category: "Collector" });
  }
  if (t.includes("HELCURT") && t.includes("COLLECTOR")) {
    groups.push({ key: "Helcurt — Collector (revamp)", category: "Collector / revamp" });
  }
  if (t.includes("XAVIER") && t.includes("LEGEND")) {
    groups.push({ key: "Xavier — Legend", category: "Legend" });
  }
  if (t.includes("KAGURA") && (t.includes("LEGEND") || t.includes("MAGIC WHEEL"))) {
    groups.push({ key: "Kagura — Legend / Magic Wheel", category: "Legend" });
  }

  if (t.includes("STREET FIGHTER")) {
    groups.push({ key: "MLBB x Street Fighter", category: "Collaboration skins" });
  }
  if (t.includes("JUJUTSU") || t.includes("JUJUTSU KAISEN")) {
    groups.push({ key: "MLBB x Jujutsu Kaisen", category: "Collaboration skins" });
  }

  if (t.includes("UPCOMING SKINS") || t.includes("ALL SKINS") || t.includes("RELEASE DATES") || t.includes("EVENTS")) {
    groups.push({ key: "Roadmap / multiple skins", category: "Multi-skin roundup" });
  }

  if (groups.length === 0) groups.push({ key: "General MLBB new skins", category: "Unspecified / mixed" });
  return groups;
}

function scoreSentiment(comments) {
  const posWords = [
    "love",
    "awesome",
    "amazing",
    "insane",
    "good",
    "great",
    "nice",
    "cool",
    "perfect",
    "fire",
    "clean",
    "beautiful",
    "best",
    "hype",
    "peak",
    "worth",
    "instant buy",
    "instabuy",
  ];
  const negWords = [
    "bad",
    "ugly",
    "trash",
    "boring",
    "lazy",
    "copy",
    "copy paste",
    "expensive",
    "overpriced",
    "scam",
    "rigged",
    "pay to win",
    "not worth",
    "skip",
    "disappoint",
  ];
  const warnWords = ["gacha", "draw", "event", "luck", "diamond", "coa", "token", "money", "price", "resale", "return"];

  let pos = 0;
  let neg = 0;
  let warn = 0;

  for (const c of comments) {
    const text = String(c.text ?? "").toLowerCase();
    if (!text) continue;
    if (posWords.some((w) => text.includes(w))) pos++;
    if (negWords.some((w) => text.includes(w))) neg++;
    if (warnWords.some((w) => text.includes(w))) warn++;
  }

  const total = Math.max(1, comments.length);
  const goodPct = Math.round((pos / total) * 100);
  const badPct = Math.round((neg / total) * 100);
  const warnPct = Math.round((warn / total) * 100);

  return {
    pos,
    neg,
    warn,
    total: comments.length,
    goodPct: clamp(goodPct, 0, 100),
    badPct: clamp(badPct, 0, 100),
    warnPct: clamp(warnPct, 0, 100),
  };
}

function extractTopicTags(comments) {
  const topics = [
    ["Effects/animation", ["effect", "effects", "animation", "anim", "skill", "ult", "recall", "entrance"]],
    ["Model/design", ["model", "design", "outfit", "face", "hair", "texture"]],
    ["Voice/SFX", ["voice", "sound", "sfx", "music"]],
    ["Value/price", ["price", "expensive", "worth", "diamond", "coa", "money", "cheap"]],
    ["Gacha/event", ["gacha", "draw", "event", "token", "rigged", "luck"]],
    ["Revamp/old skin", ["revamp", "rework", "old", "previous"]],
    ["Comparisons", ["better than", "worse", "compare", "similar", "copy", "copy paste"]],
    ["Release/date", ["release", "date", "when", "june", "july", "august", "september", "october", "november", "december"]],
  ];

  const counts = new Map();
  for (const [label] of topics) counts.set(label, 0);

  for (const c of comments) {
    const text = String(c.text ?? "").toLowerCase();
    for (const [label, keys] of topics) {
      if (keys.some((k) => text.includes(k))) counts.set(label, (counts.get(label) || 0) + 1);
    }
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .filter(([, n]) => n > 0)
    .slice(0, 6)
    .map(([label]) => label);
}

function summarizeFeedback(comments) {
  const text = comments.map((c) => String(c.text ?? "")).join("\n").toLowerCase();
  const picks = (pairs) => pairs.filter(([_, keys]) => keys.some((k) => text.includes(k))).map(([label]) => label);

  const praise = picks([
    ["High-quality effects/animations", ["animation", "effects", "insane", "awesome", "amazing"]],
    ["Unique collab feel / not copy-paste", ["not just copy", "copy paste", "unique", "own animation"]],
    ["Model looks clean", ["model", "design", "outfit", "beautiful"]],
  ]).slice(0, 3);

  const complaints = picks([
    ["Value/price concerns", ["expensive", "overpriced", "not worth", "price", "money"]],
    ["Gacha/event fairness worries", ["gacha", "rigged", "luck", "draw", "scam"]],
    ["Copy/paste or reuse allegations", ["copy paste", "copy", "similar"]],
  ]).slice(0, 3);

  const purchaseIntent = picks([
    ["Strong buy intent", ["instant buy", "instabuy", "will buy", "gonna buy", "buy it"]],
    ["Skip / wait sentiment", ["skip", "not buying", "wait", "save"]],
  ]).slice(0, 2);

  return { praise, complaints, purchaseIntent };
}

async function searchRecentVideos(queries) {
  const seen = new Set();
  const videos = [];

  for (const q of queries) {
    const urlBase = `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}&sp=CAISAhAB&hl=en&gl=US`; // sort by upload date
    let html = await fetchText(urlBase);
    if (!html.includes("var ytInitialData =")) {
      // Fallback without sp in case the filter parameter is rejected or a consent variant is served.
      const fallback = `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}&hl=en&gl=US`;
      html = await fetchText(fallback);
    }
    const initialText = extractJsonAfter(html, "var ytInitialData =");
    if (!initialText) continue;
    const data = JSON.parse(initialText);

    for (const node of walk(data)) {
      const vr = node.videoRenderer;
      if (!vr?.videoId) continue;
      if (seen.has(vr.videoId)) continue;

      const published =
        vr.publishedTimeText?.simpleText ||
        vr.publishedTimeText?.runs?.map((r) => r.text).join("") ||
        null;
      const days = parseRelativeDays(published);

      seen.add(vr.videoId);
      videos.push({
        videoId: vr.videoId,
        title: vr.title?.runs?.[0]?.text ?? null,
        channel: vr.longBylineText?.runs?.[0]?.text ?? null,
        publishedText: published,
        relativeDays: days,
        viewsText: vr.viewCountText?.simpleText ?? null,
        searchQuery: q,
      });
    }
  }

  return videos;
}

async function fetchVideoDetailsAndComments(video) {
  const watchUrl = `https://www.youtube.com/watch?v=${video.videoId}&hl=en&gl=US`;
  const watchHtml = await fetchText(watchUrl);

  const playerText = extractJsonAfter(watchHtml, "var ytInitialPlayerResponse =");
  const player = playerText ? JSON.parse(playerText) : null;
  const initialText = extractJsonAfter(watchHtml, "var ytInitialData =");
  const initialData = initialText ? JSON.parse(initialText) : null;

  const tube = extractInnertube(watchHtml);
  const commentToken = initialData ? findEngagementCommentContinuation(initialData) : null;

  const details = {
    title: player?.videoDetails?.title ?? video.title,
    channel: player?.videoDetails?.author ?? video.channel,
    views: player?.videoDetails?.viewCount ? Number(player.videoDetails.viewCount) : null,
    publishDate: player?.microformat?.playerMicroformatRenderer?.publishDate ?? null,
    uploadDate: player?.microformat?.playerMicroformatRenderer?.uploadDate ?? null,
    commentCount: initialData ? guessCommentCount(initialData) : null,
  };

  let comments = [];
  let commentsStatus = "unavailable";

  if (commentToken && tube.apiKey && tube.context) {
    commentsStatus = "loading";
    let continuation = commentToken;
    let pages = 0;

    while (continuation && comments.length < 80 && pages < 4) {
      pages++;
      const nextJson = await fetchJson(`https://www.youtube.com/youtubei/v1/next?key=${tube.apiKey}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(tube.clientName ? { "x-youtube-client-name": String(tube.clientName) } : {}),
          ...(tube.clientVersion ? { "x-youtube-client-version": tube.clientVersion } : {}),
          ...(tube.visitorData ? { "x-goog-visitor-id": tube.visitorData } : {}),
        },
        body: JSON.stringify({ context: tube.context, continuation }),
      });

      const newComments = collectCommentEntitiesFromMutations(
        nextJson?.frameworkUpdates?.entityBatchUpdate?.mutations || [],
      );
      comments.push(...newComments);

      const nextToken = findAnyContinuationToken(nextJson);
      continuation = nextToken && nextToken !== continuation ? nextToken : null;
    }

    if (comments.length > 0) commentsStatus = "loaded";
    else commentsStatus = "empty_after_continuations";
  }

  return {
    ...video,
    watchUrl,
    details,
    commentsStatus,
    comments: comments.slice(0, 80),
  };
}

function buildDashboardHtml({ generatedAtHuman, windowLabel, skins, totals, notes, closestCandidates }) {
  const skinCards = skins
    .map((s) => {
      const tags = s.topicTags
        .map((t) => `<span class="tag info">${escapeHtml(t)}</span>`)
        .join("");

      const commentLabel = s.commentSampleSufficient
        ? `<span class="tag good">评论：已采样</span>`
        : `<span class="tag warn">评论样本不足</span>`;

      const officialLabel = s.officialVideos.length
        ? `<span class="tag neutral">官方视频：${s.officialVideos.length}</span>`
        : `<span class="tag neutral">官方视频：0</span>`;
      const nonOfficialLabel = `<span class="tag neutral">非官方视频：${s.nonOfficialVideos.length}</span>`;

      const sourcesRows = s.videos
        .map((v) => {
          const views = v.details.views ? `${v.details.views.toLocaleString()} 次观看` : (v.viewsText || "-");
          const pub = v.details.publishDate || v.details.uploadDate || v.publishedText || "-";
          const type = isOfficialChannel(v.details.channel) ? "官方" : "非官方";
          const cc =
            v.commentsStatus === "loaded"
              ? `${v.comments.length} 条评论样本`
              : "评论样本不足";
          return `
          <div class="row">
            <div><a href="${escapeHtml(v.watchUrl)}">${escapeHtml(v.details.title)}</a><div class="note">${escapeHtml(v.details.channel || "")}</div></div>
            <div>${escapeHtml(type)}</div>
            <div>${escapeHtml(pub)}</div>
            <div>${escapeHtml(views)} · ${escapeHtml(cc)}</div>
          </div>`;
        })
        .join("");

      const praise = s.summary.praise.length ? s.summary.praise : ["没有明显一致的好评信号"];
      const complaints = s.summary.complaints.length ? s.summary.complaints : ["没有明显一致的吐槽信号"];
      const buy = s.summary.purchaseIntent.length ? s.summary.purchaseIntent : ["购买意愿不明确或分歧较大"];

      return `
      <article class="skin-card">
        <h3>${escapeHtml(s.key)}</h3>
        <div class="meta">
          <span>${escapeHtml(s.category)}</span>
          <span>视频数：${s.videos.length}</span>
          <span>窗口：${escapeHtml(windowLabel)}</span>
        </div>
        <div class="tags">
          ${commentLabel}
          ${officialLabel}
          ${nonOfficialLabel}
          <span class="tag neutral">评论样本：${s.totalComments}</span>
        </div>
        <div class="bars">
          <div class="bar-row">
            <div>正面</div>
            <div class="bar-track"><div class="bar-fill good" style="width:${s.sentiment.goodPct}%"></div></div>
            <div>${s.sentiment.goodPct}%</div>
          </div>
          <div class="bar-row">
            <div>价格/活动</div>
            <div class="bar-track"><div class="bar-fill warn" style="width:${s.sentiment.warnPct}%"></div></div>
            <div>${s.sentiment.warnPct}%</div>
          </div>
          <div class="bar-row">
            <div>负面</div>
            <div class="bar-track"><div class="bar-fill bad" style="width:${s.sentiment.badPct}%"></div></div>
            <div>${s.sentiment.badPct}%</div>
          </div>
        </div>
        <div class="tags">${tags}</div>
        <ul>
          <li><strong>主要好评：</strong> ${escapeHtml(praise.join("; "))}</li>
          <li><strong>主要吐槽：</strong> ${escapeHtml(complaints.join("; "))}</li>
          <li><strong>购买意愿：</strong> ${escapeHtml(buy.join("; "))}</li>
        </ul>
        <p class="note">${escapeHtml(s.conclusion)}</p>
        <div class="table" style="margin-top:12px;">
          <div class="row header">
            <div>视频</div>
            <div>类型</div>
            <div>发布时间</div>
            <div>互动/评论</div>
          </div>
          ${sourcesRows}
        </div>
      </article>`;
    })
    .join("");

  const closestHtml = closestCandidates.length
    ? `
    <section class="panel">
      <h2>未找到 1-7 天内精确命中，显示最近候选</h2>
      <p class="note">本轮没有视频落入 1-7 天窗口，下方列出最接近的相关候选。</p>
      <div class="table">
        <div class="row header">
          <div>视频</div>
          <div>Channel</div>
          <div>Published</div>
          <div>Signal</div>
        </div>
        ${closestCandidates
          .map(
            (v) => `
        <div class="row">
          <div><a href="${escapeHtml(v.watchUrl || `https://www.youtube.com/watch?v=${v.videoId}`)}">${escapeHtml(v.title || v.videoId)}</a></div>
          <div>${escapeHtml(v.channel || "—")}</div>
          <div>${escapeHtml(v.publishedText || "—")}</div>
          <div>${escapeHtml(v.viewsText || "—")}</div>
        </div>`,
          )
          .join("")}
      </div>
    </section>`
    : "";

  const warningPanel = notes.length
    ? `
    <section class="panel" style="border-color: var(--warn); background: #fff7ed;">
      <h2>运行状态</h2>
      <ul>${notes.map((n) => `<li>${escapeHtml(n)}</li>`).join("")}</ul>
    </section>`
    : "";

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="600">
  <title>MLBB New Skin Feedback Dashboard</title>
  <style>
    :root {
      --bg: #f5f7fb;
      --panel: #ffffff;
      --text: #17202a;
      --muted: #667085;
      --line: #d9e1ea;
      --accent: #0f766e;
      --accent-soft: #d9f3ef;
      --good: #15803d;
      --good-soft: #dcfce7;
      --warn: #b45309;
      --warn-soft: #fef3c7;
      --bad: #b91c1c;
      --bad-soft: #fee2e2;
      --info: #1d4ed8;
      --info-soft: #dbeafe;
    }

    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--text); font-family: Arial, "Microsoft YaHei", sans-serif; }
    header { background: var(--panel); border-bottom: 1px solid var(--line); padding: 18px 24px; position: sticky; top: 0; z-index: 2; }
    main { max-width: 1220px; margin: 0 auto; padding: 22px; }
    h1 { font-size: 22px; line-height: 1.25; margin: 0 0 8px; }
    h2 { font-size: 18px; margin: 0 0 14px; }
    h3 { font-size: 16px; margin: 0 0 8px; }
    p { line-height: 1.62; margin: 0 0 12px; }
    a { color: var(--accent); font-weight: 700; }
    .meta { color: var(--muted); display: flex; flex-wrap: wrap; gap: 8px 16px; font-size: 13px; }
    .summary-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; margin-bottom: 16px; }
    .card, .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 16px; }
    .panel { margin-bottom: 16px; }
    .label { color: var(--muted); font-size: 13px; margin-bottom: 6px; }
    .value { font-size: 24px; font-weight: 700; line-height: 1.2; }
    .subvalue { color: var(--muted); font-size: 12px; margin-top: 5px; }
    .skin-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
    .skin-card { border: 1px solid var(--line); border-radius: 8px; padding: 16px; background: #fbfdff; }
    .tags { display: flex; flex-wrap: wrap; gap: 6px; margin: 10px 0 8px; }
    .tag { border-radius: 999px; display: inline-flex; align-items: center; min-height: 24px; padding: 4px 9px; font-size: 12px; font-weight: 700; }
    .tag.good { color: var(--good); background: var(--good-soft); }
    .tag.warn { color: var(--warn); background: var(--warn-soft); }
    .tag.bad { color: var(--bad); background: var(--bad-soft); }
    .tag.info { color: var(--info); background: var(--info-soft); }
    .tag.neutral { color: var(--muted); background: #eef2f7; }
    .bars { display: grid; gap: 10px; margin-top: 10px; }
    .bar-row { display: grid; grid-template-columns: 72px 1fr 42px; gap: 10px; align-items: center; font-size: 13px; }
    .bar-track { height: 10px; border-radius: 999px; background: #edf2f7; overflow: hidden; }
    .bar-fill { height: 100%; border-radius: 999px; }
    .bar-fill.good { background: var(--good); }
    .bar-fill.warn { background: var(--warn); }
    .bar-fill.bad { background: var(--bad); }
    ul { margin: 8px 0 0; padding-left: 20px; }
    li { line-height: 1.55; margin-bottom: 6px; }
    .table { display: grid; gap: 8px; }
    .row { display: grid; grid-template-columns: 1.4fr 0.7fr 0.7fr 1fr; gap: 12px; align-items: start; border-top: 1px solid var(--line); padding-top: 10px; font-size: 13px; }
    .row.header { border-top: 0; color: var(--muted); font-weight: 700; padding-top: 0; }
    .note { color: var(--muted); font-size: 13px; line-height: 1.55; }
    @media (max-width: 860px) {
      header { padding: 16px; }
      main { padding: 16px; }
      .summary-grid, .skin-grid, .row { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <header>
    <h1>MLBB 新皮肤反馈看板</h1>
    <div class="meta">
      <span>自动刷新：每 10 分钟</span>
      <span>监控窗口：视频上线 1-7 天内（含第 1 天和第 7 天）</span>
      <span>生成时间： ${escapeHtml(generatedAtHuman)}</span>
    </div>
  </header>
  <main>
    ${warningPanel}
    <section class="summary-grid">
      <div class="card">
        <div class="label">皮肤/主题分组</div>
        <div class="value">${totals.skins}</div>
        <div class="subvalue">按皮肤或主题合并</div>
      </div>
      <div class="card">
        <div class="label">1-7 天内视频</div>
        <div class="value">${totals.videos}</div>
        <div class="subvalue">跨搜索词去重</div>
      </div>
      <div class="card">
        <div class="label">评论样本</div>
        <div class="value">${totals.comments}</div>
        <div class="subvalue">必要时使用新版评论面板 continuation</div>
      </div>
      <div class="card">
        <div class="label">评论可见性</div>
        <div class="value">${totals.commentOkSkins}/${totals.skins}</div>
        <div class="subvalue">评论样本足够的分组</div>
      </div>
    </section>

    ${closestHtml}

    <section class="panel">
      <h2>皮肤分析卡片</h2>
      <div class="skin-grid">
        ${skinCards || `<div class=\"skin-card\"><h3>未找到精确命中</h3><p class=\"note\">本轮没有检测到上线 1-7 天内的合格视频。</p></div>`}
      </div>
    </section>

    <section class="panel">
      <h2>监控规则</h2>
      <p class="note">
        覆盖官方与非官方 MLBB 新皮肤视频，包括 Collector、Epic、Legend、Special、Elite、活动、联动、返场、重做、painted、annual、投票、爆料、展示和评测。
        评论采样会先读取页面初始结构，必要时再使用 youtubei/v1/next 的新版评论面板 continuation；如果两种方式都失败，仍保留该皮肤命中并标注“评论样本不足”。
      </p>
    </section>
  </main>
</body>
</html>`;
}

async function main() {
  const stamp = formatShanghaiStamp(new Date());
  const versionFile = `dashboard-${stamp.ymd}-${stamp.hm}.html`;

  const queries = [
    "mlbb new skin",
    "mobile legends new skin",
    "mlbb upcoming skins",
    "mlbb collector skin",
    "mlbb starlight skin",
    "mlbb legend skin",
    "mlbb skin revamp",
    "mlbb street fighter skin",
    "mlbb jujutsu kaisen skin",
  ];

  const notes = [];
  const allVideos = await searchRecentVideos(queries);

  const inWindow = allVideos.filter((v) => v.relativeDays != null && v.relativeDays >= 1 && v.relativeDays <= 7);
  const closestCandidates = allVideos
    .filter((v) => v.relativeDays != null && v.relativeDays <= 14)
    .sort((a, b) => (a.relativeDays ?? 999) - (b.relativeDays ?? 999))
    .slice(0, 10);

  if (inWindow.length === 0) notes.push("No qualifying 1–7 day videos were detected from the current query set.");

  const enriched = [];
  for (const v of inWindow) {
    try {
      enriched.push(await fetchVideoDetailsAndComments(v));
    } catch (e) {
      notes.push(`Failed to fetch details/comments for ${v.videoId}: ${String(e?.message || e)}`);
      enriched.push({
        ...v,
        watchUrl: `https://www.youtube.com/watch?v=${v.videoId}`,
        details: { title: v.title, channel: v.channel, views: null, publishDate: null, uploadDate: null, commentCount: null },
        commentsStatus: "error",
        comments: [],
      });
    }
  }

  const skinMap = new Map();
  for (const v of enriched) {
    const inferredGroups = inferSkinGroups(v.details.title || v.title);
    for (const inferred of inferredGroups) {
      const key = inferred.key;
      const item = skinMap.get(key) || {
        key,
        category: inferred.category,
        videos: [],
      };
      item.videos.push(v);
      skinMap.set(key, item);
    }
  }

  const skins = [...skinMap.values()].map((s) => {
    const officialVideos = s.videos.filter((v) => isOfficialChannel(v.details.channel));
    const nonOfficialVideos = s.videos.filter((v) => !isOfficialChannel(v.details.channel));
    const comments = s.videos.flatMap((v) => v.comments || []);
    const sentiment = scoreSentiment(comments);
    const topicTags = extractTopicTags(comments);
    const summary = summarizeFeedback(comments);
    const commentSampleSufficient = comments.length >= 12;

    const conclusionParts = [];
    if (sentiment.total === 0) conclusionParts.push("该分组未采样到评论文本。");
    else {
      if (sentiment.goodPct >= 35) conclusionParts.push("整体情绪偏正面。");
      if (sentiment.badPct >= 25) conclusionParts.push("存在明显负面反馈。");
      if (sentiment.warnPct >= 25) conclusionParts.push("价格、活动机制或抽取成本是反复出现的顾虑。");
      if (!commentSampleSufficient) conclusionParts.push("评论样本不足，仅作方向性参考。");
    }

    return {
      ...s,
      officialVideos,
      nonOfficialVideos,
      totalComments: comments.length,
      commentSampleSufficient,
      sentiment,
      topicTags,
      summary,
      conclusion: conclusionParts.join(" "),
    };
  });

  skins.sort((a, b) => (b.videos.length - a.videos.length) || (b.totalComments - a.totalComments));

  const totals = {
    skins: skins.length,
    videos: enriched.length,
    comments: skins.reduce((acc, s) => acc + s.totalComments, 0),
    commentOkSkins: skins.filter((s) => s.commentSampleSufficient).length,
  };

  const windowLabel = "1–7 days ago (inclusive)";
  const html = buildDashboardHtml({
    generatedAtHuman: stamp.human,
    windowLabel,
    skins,
    totals,
    notes,
    closestCandidates,
  });

  fs.mkdirSync(path.join(ROOT_DIR, "tools"), { recursive: true });
  fs.writeFileSync(path.join(ROOT_DIR, "mlbbnewskin-dashboard.html"), html, "utf8");
  fs.writeFileSync(path.join(ROOT_DIR, versionFile), html, "utf8");

  const indexHtml = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="cache-control" content="no-cache, no-store, must-revalidate">
  <meta http-equiv="pragma" content="no-cache">
  <meta http-equiv="expires" content="0">
  <meta http-equiv="refresh" content="0; url=${escapeHtml(versionFile)}">
  <title>MLBB New Skin Feedback Dashboard</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f6f7f9; color: #17202a; font-family: Arial, "Microsoft YaHei", sans-serif; }
    main { max-width: 620px; padding: 28px; text-align: center; }
    a { color: #0f766e; font-weight: 700; }
  </style>
</head>
<body>
  <main>
    <h1>MLBB 新皮肤反馈看板</h1>
    <p>正在打开看板。如果没有自动跳转，请点击 <a href="${escapeHtml(versionFile)}">${escapeHtml(versionFile)}</a>.</p>
  </main>
  <script>window.location.replace(${JSON.stringify(versionFile)});</script>
</body>
</html>
`;

  fs.writeFileSync(path.join(ROOT_DIR, "index.html"), indexHtml, "utf8");

  console.log(
    JSON.stringify(
      {
        generatedAt: stamp.human,
        versionFile,
        videosInWindow: enriched.length,
        skins: totals.skins,
        commentsSampled: totals.comments,
        commentOkSkins: totals.commentOkSkins,
        notes,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
