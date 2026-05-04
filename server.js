const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const multer = require("multer");
const Database = require("better-sqlite3");
const AdmZip = require("adm-zip");

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

const APP_HTML = path.join(__dirname, "app.html");
const DB_PATH = path.join(__dirname, "xeonic.db");
const AI_CHUNK_TOKENS = 800;
const AI_CHUNK_OVERLAP = 80;
const SUPPORTED_EXTENSIONS = [".txt", ".json", ".epub", ".md", ".markdown", ".html", ".htm", ".csv", ".tsv"];
const MAX_ACCOUNT_ID_LENGTH = 120;
const TOKEN_RE = /[A-Za-z0-9]+(?:['.-][A-Za-z0-9]+)*|[^\w\s]/gu;
const SESSIONS = new Map();
const GUEST_RUNS = new Map();

const PLANS = {
  free: { name: "Free", price: 0, runs: 999, max_bytes: 500 * 1024, features: ["Unlimited logged-in runs", "Basic analytics", "Up to 500 KB per upload"] },
  lite: { name: "Lite", price: 4, runs: 999, max_bytes: 5 * 1024 * 1024, features: ["Unlimited logged-in runs", "AI-ready exports", "Up to 5 MB per upload"] },
  starter: { name: "Starter", price: 9, runs: 999, max_bytes: 10 * 1024 * 1024, features: ["Unlimited logged-in runs", "Advanced analytics", "Up to 10 MB per upload"] },
  growth: { name: "Growth", price: 19, runs: 999, max_bytes: 100 * 1024 * 1024, features: ["Unlimited logged-in runs", "Richer analytics", "Up to 100 MB per upload"] },
  pro: { name: "Pro", price: 39, runs: 999, max_bytes: 500 * 1024 * 1024, features: ["Unlimited logged-in runs", "Best analytics", "Up to 500 MB per upload"] },
  business: { name: "Business", price: 199, runs: 999, max_bytes: 10 * 1024 * 1024 * 1024, features: ["Unlimited logged-in runs", "Large-team workflows", "Up to 10 GB per upload"] },
  enterprise: { name: "Enterprise", price: 1000, runs: 999, max_bytes: 30 * 1024 * 1024 * 1024, features: ["Unlimited cleaning runs", "Largest payloads", "Up to 30 GB per upload"] }
};
const GUEST_PLAN = { name: "Guest", runs: 1, max_bytes: 500 * 1024 };

app.use(express.json({ limit: "1mb" }));
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", process.env.ALLOWED_ORIGINS || "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,X-Session-Token,X-Guest-Id");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    email TEXT PRIMARY KEY,
    password_hash TEXT NOT NULL,
    access_code_hash TEXT NOT NULL,
    plan TEXT NOT NULL DEFAULT 'free',
    billing_interval TEXT NOT NULL DEFAULT 'monthly',
    runs_used INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS payments (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    plan TEXT NOT NULL,
    amount INTEGER NOT NULL,
    currency TEXT NOT NULL DEFAULT '$',
    billing_interval TEXT NOT NULL DEFAULT 'monthly',
    status TEXT NOT NULL,
    card_last4 TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    FOREIGN KEY(email) REFERENCES users(email) ON DELETE CASCADE
  );
`);
ensureDemoUser();

app.get("/", (_req, res) => res.sendFile(APP_HTML));
app.get("/plans", (_req, res) => res.json({ plans: serializePlans() }));
app.get("/health", (_req, res) => res.json({
  status: "ok",
  backend: "node",
  supported_extensions: SUPPORTED_EXTENSIONS,
  guest_message_limit_bytes: GUEST_PLAN.max_bytes,
  ai_chunk_tokens: AI_CHUNK_TOKENS,
  ai_chunk_overlap: AI_CHUNK_OVERLAP
}));

app.post("/auth/login", (req, res) => {
  const accountId = normalizeAccountId(req.body.email);
  if (!accountId) return error(res, 400, "Enter your username or email.");
  const user = getUser(accountId);
  if (!user) return error(res, 404, "Account not found. Sign up first.");
  if (!verifySecret(String(req.body.password || ""), user.password_hash)) return error(res, 401, "Password is incorrect.");
  if (!verifySecret(String(req.body.code || ""), user.access_code_hash)) return error(res, 401, "Access code is incorrect for this account.");
  const token = crypto.randomBytes(16).toString("hex");
  SESSIONS.set(token, accountId);
  res.json({ token, user: buildUserResponse(accountId) });
});

app.post("/auth/register", (req, res) => {
  const accountId = normalizeAccountId(req.body.email);
  const password = String(req.body.password || "");
  const code = String(req.body.code || "");
  if (!accountId) return error(res, 400, "Enter a username or email.");
  if (!password) return error(res, 400, "Enter a password.");
  if (!code) return error(res, 400, "Enter an access code.");
  if (getUser(accountId)) return error(res, 400, "Account already exists. Log in instead.");
  createUser(accountId, password, code);
  const token = crypto.randomBytes(16).toString("hex");
  SESSIONS.set(token, accountId);
  res.json({ token, user: buildUserResponse(accountId) });
});

app.get("/me", (req, res) => {
  const email = requireSession(req, res);
  if (!email) return;
  res.json({ user: buildUserResponse(email) });
});

app.post("/checkout", (req, res) => {
  const email = requireSession(req, res);
  if (!email) return;
  const planId = String(req.body.plan_id || "").trim().toLowerCase();
  const billingInterval = String(req.body.billing_interval || "monthly").trim().toLowerCase();
  const plan = PLANS[planId];
  if (!plan) return error(res, 400, "Unknown plan selected.");
  if (!["monthly", "yearly"].includes(billingInterval)) return error(res, 400, "Choose monthly or yearly billing.");

  const amount = billingAmount(plan.price, billingInterval);
  const digits = String(req.body.card_number || "").replace(/\D/g, "");
  if (amount && (digits.length < 4 || !String(req.body.card_name || "").trim())) {
    return error(res, 400, "Enter a card name and at least 4 digits.");
  }
  updateUserPlan(email, planId, billingInterval);
  const payment = {
    id: `pay_${crypto.randomBytes(4).toString("hex")}`,
    plan: planId,
    amount,
    currency: "$",
    billing_interval: billingInterval,
    status: amount ? "paid" : "free",
    card_last4: digits ? digits.slice(-4) : ""
  };
  addPayment(email, payment);
  res.json({ message: `${plan.name} plan activated.`, payment, user: buildUserResponse(email) });
});

app.post("/clean", upload.single("file"), async (req, res) => {
  try {
    const context = getCleaningContext(req, res);
    if (!context) return;
    if (!req.file) return error(res, 400, "Choose a file first.");
    const result = cleanUploadFile(req.file, context.plan, context.effectiveLimit);
    finishRun(context);
    res.json({ ...result, usage: context.usage(), user: context.userResponse() });
  } catch (err) {
    sendCaughtError(res, err);
  }
});

app.post("/clean-batch", upload.array("files"), async (req, res) => {
  try {
    const context = getCleaningContext(req, res);
    if (!context) return;
    const files = req.files || [];
    if (!files.length) return error(res, 400, "Choose at least one file.");
    const results = files.map((file) => cleanUploadFile(file, context.plan, context.effectiveLimit));
    const batchStats = buildBatchStats(results, context.effectiveLimit);
    const combinedText = results
      .filter((item) => item.cleaned_text)
      .map((item) => `### ${item.source_file}\n${item.cleaned_text}`)
      .join("\n\n");
    finishRun(context);
    res.json({
      files: results,
      cleaned_text: combinedText,
      cleaned_lines: combinedText.split(/\r?\n/),
      ai_chunks: results.flatMap((item) => (item.ai_chunks || []).map((chunk) => ({ ...chunk, source_file: item.source_file }))),
      preview_text: combinedText.slice(0, 5000),
      stats: batchStats,
      usage: context.usage(),
      user: context.userResponse()
    });
  } catch (err) {
    sendCaughtError(res, err);
  }
});

function getCleaningContext(req, res) {
  const token = req.get("x-session-token") || "";
  const email = SESSIONS.get(token);
  const user = email ? getUser(email) : null;
  const guestId = String(req.get("x-guest-id") || "").trim();
  if (!user && !guestId) {
    error(res, 401, "Please log in or use the one free guest clean.");
    return null;
  }
  const plan = user ? PLANS[user.plan] : GUEST_PLAN;
  const runsUsed = user ? user.runs_used : (GUEST_RUNS.get(guestId) || 0);
  if (!user && runsUsed >= GUEST_PLAN.runs) {
    error(res, 403, "Guest limit reached. Log in for unlimited cleaning.");
    return null;
  }
  const context = {
    email,
    user,
    guestId,
    plan,
    runsUsed,
    effectiveLimit: plan.max_bytes,
    usage: () => user ? buildUsage(getUser(email).plan, getUser(email).runs_used) : buildGuestUsage(GUEST_RUNS.get(guestId) || 0),
    userResponse: () => user ? buildUserResponse(email) : null
  };
  return context;
}

function finishRun(context) {
  if (context.user) {
    incrementRuns(context.email);
  } else {
    GUEST_RUNS.set(context.guestId, context.runsUsed + 1);
  }
}

function cleanUploadFile(file, plan, effectiveLimit) {
  const originalName = file.originalname || "uploaded-file";
  const filename = originalName.toLowerCase();
  if (!SUPPORTED_EXTENSIONS.some((ext) => filename.endsWith(ext))) {
    throw httpError(400, `Supported files: ${SUPPORTED_EXTENSIONS.join(", ")}.`);
  }
  if (!file.buffer || !file.buffer.length) throw httpError(400, `${originalName} is empty.`);
  if (file.buffer.length > effectiveLimit) {
    throw httpError(413, `${plan.name} allows uploads up to ${formatSize(effectiveLimit)}. Pick smaller files or change plans.`);
  }

  const text = extractTextForCleaning(file.buffer, filename);
  if (!text.trim()) throw httpError(422, `No readable text could be extracted from ${originalName}.`);
  const textSize = Buffer.byteLength(text, "utf8");
  if (textSize > effectiveLimit) {
    throw httpError(413, `Extracted text from ${originalName} is ${formatSize(textSize)}, above the ${formatSize(effectiveLimit)} plan limit.`);
  }

  const { cleanedText: rawCleanedText, stats } = cleanText(text);
  const { text: cleanedText, truncated } = truncateUtf8(rawCleanedText, effectiveLimit);
  if (!cleanedText.trim()) throw httpError(422, `${originalName} was readable, but no useful text remained after cleaning.`);

  stats.source_file = originalName;
  stats.cleaned_size = Buffer.byteLength(cleanedText, "utf8");
  stats.upload_limit_bytes = effectiveLimit;
  stats.message_limit_bytes = effectiveLimit;
  stats.output_truncated = truncated;
  const tokens = tokenizeText(cleanedText);
  const aiChunks = makeAiChunkRecords(tokens, AI_CHUNK_TOKENS, AI_CHUNK_OVERLAP);
  stats.ai_token_count = tokens.length;
  stats.ai_chunk_count = aiChunks.length;
  stats.ai_chunk_tokens = AI_CHUNK_TOKENS;
  stats.ai_chunk_overlap = AI_CHUNK_OVERLAP;

  return {
    source_file: originalName,
    cleaned_text: cleanedText,
    cleaned_lines: cleanedText.split(/\r?\n/),
    ai_chunks: aiChunks,
    preview_text: cleanedText.slice(0, 5000),
    stats
  };
}

function extractTextForCleaning(buffer, filename) {
  if (filename.endsWith(".epub")) return extractEpubText(buffer);
  let text = decodeText(buffer);
  if (filename.endsWith(".json")) text = normalizeJsonText(text);
  else if (filename.endsWith(".html") || filename.endsWith(".htm")) text = markupToText(text);
  else if (filename.endsWith(".md") || filename.endsWith(".markdown")) text = normalizeMarkdownText(text);
  else if (filename.endsWith(".csv") || filename.endsWith(".tsv")) text = normalizeDelimitedText(text, filename.endsWith(".tsv") ? "\t" : ",");
  return text;
}

function decodeText(buffer) {
  const utf8 = buffer.toString("utf8").replace(/^\uFEFF/, "");
  if (!utf8.includes("\uFFFD")) return utf8;
  return buffer.toString("latin1");
}

function normalizeJsonText(text) {
  try {
    const parsed = JSON.parse(text);
    const lines = [];
    flattenJsonValue(parsed, lines);
    return lines.length ? lines.join("\n") : JSON.stringify(parsed);
  } catch {
    return text;
  }
}

function flattenJsonValue(value, lines, currentPath = "") {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => flattenJsonValue(item, lines, currentPath ? `${currentPath}[${index}]` : `[${index}]`));
    return;
  }
  if (typeof value === "object") {
    Object.entries(value).forEach(([key, item]) => flattenJsonValue(item, lines, currentPath ? `${currentPath}.${key}` : key));
    return;
  }
  const rendered = String(value).trim();
  if (rendered) lines.push(currentPath ? `${currentPath}: ${rendered}` : rendered);
}

function normalizeMarkdownText(text) {
  return text
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s*/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s*[-*_]{3,}\s*$/gm, "");
}

function normalizeDelimitedText(text, delimiter) {
  return text.split(/\r?\n/)
    .map((line) => splitDelimitedLine(line, delimiter).map((cell) => cell.trim()).filter(Boolean).join(" | "))
    .filter(Boolean)
    .join("\n");
}

function splitDelimitedLine(line, delimiter) {
  const cells = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"' && line[i + 1] === '"') {
      current += '"';
      i += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === delimiter && !quoted) {
      cells.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells;
}

function extractEpubText(buffer) {
  let zip;
  try {
    zip = new AdmZip(buffer);
  } catch {
    throw httpError(400, "Unable to extract readable text from this EPUB.");
  }
  const entries = zip.getEntries();
  const names = new Set(entries.map((entry) => entry.entryName));
  const byName = new Map(entries.map((entry) => [entry.entryName, entry]));
  const paths = orderedEpubHtmlPaths(byName, names);
  const chapters = paths
    .map((chapterPath) => byName.get(chapterPath))
    .filter(Boolean)
    .map((entry) => markupToText(decodeText(entry.getData())))
    .filter((text) => text.trim());
  if (!chapters.length) throw httpError(400, "Unable to extract readable text from this EPUB.");
  return chapters.join("\n");
}

function orderedEpubHtmlPaths(byName, names) {
  const opfPath = findEpubOpfPath(byName, names);
  if (!opfPath) return sortedEpubHtmlPaths(names);
  const opf = decodeText(byName.get(opfPath).getData());
  const manifest = new Map();
  for (const item of opf.matchAll(/<item\b[^>]*>/gi)) {
    const tag = item[0];
    const id = attr(tag, "id");
    const href = attr(tag, "href");
    const media = attr(tag, "media-type") || "";
    if (id && href && (media.includes("html") || /\.(x?html?|htm)$/i.test(href))) {
      manifest.set(id, normalizeEpubHref(opfPath, href));
    }
  }
  const ordered = [];
  for (const itemRef of opf.matchAll(/<itemref\b[^>]*>/gi)) {
    const idref = attr(itemRef[0], "idref");
    const chapterPath = manifest.get(idref);
    if (chapterPath && names.has(chapterPath) && !ordered.includes(chapterPath)) ordered.push(chapterPath);
  }
  return ordered.length ? ordered : sortedEpubHtmlPaths(names);
}

function findEpubOpfPath(byName, names) {
  if (names.has("META-INF/container.xml")) {
    const container = decodeText(byName.get("META-INF/container.xml").getData());
    const fullPath = /full-path=["']([^"']+)["']/i.exec(container)?.[1];
    if (fullPath && names.has(fullPath)) return fullPath;
  }
  return [...names].filter((name) => name.toLowerCase().endsWith(".opf")).sort()[0] || "";
}

function normalizeEpubHref(opfPath, href) {
  return path.posix.normalize(path.posix.join(path.posix.dirname(opfPath), href)).replace(/^\.\//, "");
}

function sortedEpubHtmlPaths(names) {
  return [...names].filter((name) => /\.(x?html?|htm)$/i.test(name)).sort();
}

function attr(tag, name) {
  return new RegExp(`${name}=["']([^"']+)["']`, "i").exec(tag)?.[1] || "";
}

function markupToText(markup) {
  return htmlUnescape(markup)
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/blockquote|\/section|\/article)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/[ \t]+\n/g, "\n");
}

function cleanText(text) {
  const prepared = preprocessSourceText(text);
  const rawLines = prepared.split(/\r?\n/);
  const originalLines = rawLines.length;
  const originalBytes = Buffer.byteLength(prepared, "utf8");
  const cleanedLines = [];
  const seen = new Set();
  let duplicatesRemoved = 0;
  let discardedShort = 0;
  let discardedEmpty = 0;
  let discardedBoilerplate = 0;
  let discardedAiNoise = 0;
  let junkCharsRemoved = 0;

  for (const line of rawLines) {
    const { normalized, removedChars } = normalizeLine(line);
    junkCharsRemoved += removedChars;
    if (!normalized) { discardedEmpty += 1; continue; }
    if (isBoilerplateLine(normalized)) { discardedBoilerplate += 1; continue; }
    if (isLowValueForAi(normalized)) { discardedAiNoise += 1; continue; }
    if (shouldDropShortLine(normalized)) { discardedShort += 1; continue; }
    const key = canonicalizeForDedup(normalized);
    if (seen.has(key)) { duplicatesRemoved += 1; continue; }
    seen.add(key);
    cleanedLines.push(normalized);
  }

  const cleanedText = cleanedLines.join("\n");
  const cleanedLineCount = cleanedLines.length;
  const cleanedBytes = Buffer.byteLength(cleanedText, "utf8");
  const removedTotal = originalLines - cleanedLineCount;
  const reductionPercent = originalLines ? round((removedTotal / originalLines) * 100, 2) : 0;
  const duplicateRatio = originalLines ? round((duplicatesRemoved / originalLines) * 100, 2) : 0;
  const boilerplateRatio = originalLines ? round((discardedBoilerplate / originalLines) * 100, 2) : 0;
  const avgLineLength = cleanedLineCount ? round(cleanedLines.reduce((sum, line) => sum + line.length, 0) / cleanedLineCount, 2) : 0;
  const avgWordsPerLine = cleanedLineCount ? round(cleanedLines.reduce((sum, line) => sum + line.split(/\s+/).filter(Boolean).length, 0) / cleanedLineCount, 2) : 0;
  const qualityScore = computeQualityScore(originalLines, cleanedLineCount, duplicatesRemoved, discardedBoilerplate, reductionPercent, avgLineLength, originalBytes, cleanedBytes);

  return {
    cleanedText,
    stats: {
      original_lines: originalLines,
      cleaned_lines: cleanedLineCount,
      duplicates_removed: duplicatesRemoved,
      reduction_percent: reductionPercent,
      quality_score: qualityScore,
      original_size: originalBytes,
      cleaned_size: cleanedBytes,
      removed_lines: removedTotal,
      duplicate_ratio: duplicateRatio,
      boilerplate_ratio: boilerplateRatio,
      avg_line_length: avgLineLength,
      avg_words_per_line: avgWordsPerLine,
      discarded_short_lines: discardedShort,
      discarded_empty_lines: discardedEmpty,
      discarded_boilerplate_lines: discardedBoilerplate,
      discarded_ai_noise_lines: discardedAiNoise,
      junk_chars_removed: junkCharsRemoved
    }
  };
}

function preprocessSourceText(text) {
  text = normalizeSourceText(text);
  text = stripGutenbergBoilerplate(text);
  if (looksLikeWikiMarkup(text)) text = cleanWikipediaText(text);
  const segments = [];
  for (const rawBlock of splitTextBlocks(text)) {
    const block = rawBlock.trim();
    if (!block || isWikiNoise(block) || !isAcceptableLanguage(block)) continue;
    if (shouldSplitAsParagraph(block)) segments.push(...splitSentences(block));
    else segments.push(block);
  }
  return segments.filter((segment) => segment.trim()).join("\n");
}

function normalizeSourceText(text) {
  return htmlUnescape(text.normalize("NFKC"))
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\u00ad|\u200b/g, "")
    .replace(/(?<=\w)-\n(?=\w)/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|li|h[1-6]|tr|blockquote|section|article)>/gi, "\n")
    .replace(/[ \t]+\n/g, "\n");
}

function stripGutenbergBoilerplate(text) {
  text = text
    .replace(/\*{3}\s*END OF (?:THE|THIS) PROJECT GUTENBERG EBOOK[\s\S]*/i, "")
    .replace(/START: FULL LICENSE\s*[\s\S]*/i, "");
  const startMatch = /\*{3}\s*START OF (?:THE|THIS) PROJECT GUTENBERG EBOOK.*?\*{3}/is.exec(text);
  if (startMatch) text = text.slice(startMatch.index + startMatch[0].length);
  const lines = [];
  let skippingNote = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    const lowered = line.toLowerCase();
    if (lowered.startsWith("transcriber's note") || lowered.startsWith("transcriber note")) {
      skippingNote = true;
      continue;
    }
    if (skippingNote) {
      if (!line) skippingNote = false;
      continue;
    }
    if (!isGutenbergNoiseLine(line)) lines.push(rawLine);
  }
  return lines.join("\n");
}

function isGutenbergNoiseLine(line) {
  const lowered = line.toLowerCase().trim();
  if (!lowered) return false;
  if (lowered.includes("project gutenberg")) return true;
  if ([
    "title:", "author:", "release date:", "language:", "credits:", "produced by",
    "character set encoding:", "posting date:", "most recently updated:",
    "this ebook is for the use of anyone anywhere", "this ebook is made available at no cost",
    "you may copy it, give it away or re-use it", "online distributed proofreading team",
    "proofreading team at", "available by the internet archive"
  ].some((prefix) => lowered.startsWith(prefix))) return true;
  return ["by", "contents", "cover", "start of this project gutenberg ebook", "end of this project gutenberg ebook"].includes(lowered);
}

function normalizeLine(line) {
  const stripped = htmlUnescape(String(line || "").normalize("NFKC")).trim();
  if (!stripped) return { normalized: "", removedChars: 0 };
  let cleaned = stripped
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\[([^\]]+)\]\(https?:\/\/[^)]+\)/gi, "$1")
    .replace(/(?:[A-Za-z]:\\|\/)[\w.\-/\\]+/g, "")
    .replace(/https?:\/\/\S+|https?:\S*|www\.\S+/gi, "")
    .replace(/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, "")
    .replace(/^(?:[-*•·>]+|\d+[.)]|[a-zA-Z][.)])\s+/u, "")
    .replace(/[^\p{L}\p{N}_\s.,!?':;@#%&()\-\/"]/gu, "")
    .replace(/([!?.,;:])\1+/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[\s\t\-_|]+|[\s\t\-_|]+$/g, "")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/([({\[])\s+/g, "$1")
    .replace(/\s+([)}\]])/g, "$1");
  return { normalized: cleaned, removedChars: Math.max(0, stripped.length - cleaned.length) };
}

function looksLikeWikiMarkup(text) {
  const lowered = text.toLowerCase();
  return ["[[", "]]", "{{", "}}", "<ref", "==", "[[category:"].some((marker) => lowered.includes(marker));
}

function cleanWikipediaText(text) {
  let cleaned = text
    .replace(/<ref[^>]*>[\s\S]*?<\/ref>|<ref[^/>]*\/>/g, "")
    .replace(/\[\[([^|\]]*\|)?([^\]]+)\]\]/g, "$2")
    .replace(/<[^>]+>/g, "");
  while (/\{\{[^{}]*\}\}/.test(cleaned)) cleaned = cleaned.replace(/\{\{[^{}]*\}\}/g, "");
  return cleaned.replace(/\n{3,}/g, "\n\n").replace(/[ \t]+/g, " ").trim();
}

function isWikiNoise(text) {
  const lowered = text.toLowerCase().trim();
  return (text.length < 4 && !looksSentenceLike(text)) || (text.match(/\|/g) || []).length > 3 || lowered.startsWith("*") || lowered.startsWith("#") || lowered.includes("citation needed") || lowered.includes("edit]");
}

function isAcceptableLanguage(text) {
  return !/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/u.test(text);
}

function isBoilerplateLine(text) {
  const lowered = text.toLowerCase().trim();
  if (!lowered) return true;
  if (/^(?:page\s*)?\d+(?:\s*[/-]\s*\d+)?$/.test(lowered)) return true;
  if (/^[\W_]+$/.test(lowered)) return true;
  if (["contents", "table of contents"].includes(lowered)) return true;
  if (isGutenbergNoiseLine(text)) return true;
  if (["copyright", "all rights reserved", "generated by", "footer", "subscribe", "cookie"].some((prefix) => lowered.startsWith(prefix))) return true;
  if (["privacy policy", "terms of use", "sign in", "log in", "advertisement"].includes(lowered)) return true;
  if (lowered.startsWith("http://") || lowered.startsWith("https://") || lowered.startsWith("www.")) return true;
  if (["<html", "<body", "<div", "<p", "<span", "<script", "<style"].some((prefix) => lowered.startsWith(prefix))) return true;
  const symbols = [...lowered].filter((ch) => !/[\p{L}\p{N}\s]/u.test(ch)).length;
  return lowered.length > 0 && symbols / lowered.length > 0.45;
}

function isLowValueForAi(text) {
  const lowered = text.toLowerCase().trim();
  const words = text.split(/\s+/).filter(Boolean);
  const wordCount = words.length;
  if (/^.{1,90}\s+\.{2,}\s*\d+$/.test(text)) return true;
  if (/^\[?\d{1,4}\]?\.?$/.test(text)) return true;
  if (/^(?:[ivxlcdm]+|[IVXLCDM]+)[.)]?$/.test(text)) return true;
  if (/^(?:fig(?:ure)?|image|illustration|plate|map|table)\s*[\d:.-]*\b/i.test(text)) return true;
  if (["chapter ", "section ", "part ", "book ", "volume ", "appendix ", "footnote", "note:", "notes:", "see also", "back to contents", "return to text", "illustrated by", "endnotes", "index"].some((prefix) => lowered.startsWith(prefix)) && wordCount <= 8) return true;
  if (["contents", "table of contents", "list of illustrations", "illustrations", "preface", "introduction", "bibliography", "index", "endnotes", "footnotes"].includes(lowered)) return true;
  if (wordCount < 5 && !looksSentenceLike(text)) return true;
  if (wordCount < 6 && text === text.toUpperCase()) return true;
  const alphaCount = [...text].filter((ch) => /\p{L}/u.test(ch)).length;
  const digitCount = [...text].filter((ch) => /\d/.test(ch)).length;
  if (digitCount > alphaCount && wordCount < 12) return true;
  const usefulWords = words.filter((word) => /[A-Za-z]/.test(word) && word.replace(/[.,;:!?()[\]"']/g, "").length > 2);
  return wordCount >= 5 && usefulWords.length / wordCount < 0.45;
}

function splitTextBlocks(text) {
  const blocks = [];
  for (const paragraph of text.split(/\n\s*\n+/)) {
    const trimmed = paragraph.trim();
    if (!trimmed) continue;
    const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (lines.length > 1) blocks.push(...lines);
    else blocks.push(trimmed);
  }
  return blocks;
}

function splitSentences(text) {
  const abbreviations = ["np.", "itd.", "ul.", "dr.", "prof.", "mjr.", "ppłk.", "gen.", "mr.", "mrs.", "ms.", "sr.", "jr.", "vs.", "etc.", "e.g.", "i.e.", "st.", "no."];
  const parts = text.replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s+/);
  const sentences = [];
  for (const part of parts) {
    if (!part) continue;
    if (sentences.length && abbreviations.some((abbr) => sentences[sentences.length - 1].toLowerCase().endsWith(abbr))) sentences[sentences.length - 1] += ` ${part}`;
    else sentences.push(part);
  }
  return sentences;
}

function looksSentenceLike(text) { return /[.!?]/.test(text); }
function shouldSplitAsParagraph(text) { return looksSentenceLike(text) && text.split(/\s+/).length > 28; }
function shouldDropShortLine(text) {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length >= 3 || looksSentenceLike(text)) return false;
  if (words.length === 1 && text.length < 4) return true;
  return text.length < 12;
}
function canonicalizeForDedup(text) { return text.toLowerCase().replace(/[^\p{L}\p{N}_\s]/gu, "").replace(/\s+/g, " ").trim(); }

function computeQualityScore(originalLines, cleanedLines, duplicatesRemoved, boilerplateRemoved, reductionPercent, avgLineLength, originalBytes, cleanedBytes) {
  if (!originalLines) return 0;
  const duplicateRatio = duplicatesRemoved / originalLines;
  const boilerplateRatio = boilerplateRemoved / originalLines;
  const reductionRatio = Math.min(1, reductionPercent / 100);
  const densityRatio = cleanedLines / originalLines;
  const charDensity = originalBytes ? cleanedBytes / originalBytes : 0;
  let score = 56;
  score += Math.min(16, avgLineLength / 4.5);
  score += Math.min(12, densityRatio * 12);
  score += Math.min(8, charDensity * 8);
  score += Math.min(10, (1 - duplicateRatio) * 10);
  score -= Math.min(18, duplicateRatio * 42);
  score -= Math.min(14, reductionRatio * 14);
  score -= Math.min(10, boilerplateRatio * 28);
  return Math.max(0, Math.min(100, Math.round(score)));
}

function tokenizeText(text) {
  return text.match(TOKEN_RE) || [];
}

function makeAiChunkRecords(tokens, chunkSize, overlap) {
  if (!tokens.length) return [];
  const records = [];
  const step = chunkSize - overlap;
  for (let start = 0, index = 0; start < tokens.length; start += step, index += 1) {
    const chunk = tokens.slice(start, start + chunkSize);
    if (!chunk.length) continue;
    records.push({
      chunk_id: `chunk-${String(index).padStart(5, "0")}`,
      chunk_index: index,
      start_token: start,
      end_token: start + chunk.length,
      token_count: chunk.length,
      tokens: chunk,
      text: detokenize(chunk)
    });
    if (start + chunkSize >= tokens.length) break;
  }
  return records;
}

function detokenize(tokens) {
  return tokens.join(" ").replace(/\s+([,.;:!?%)\]}])/g, "$1").replace(/([({\[])\s+/g, "$1");
}

function buildBatchStats(results, messageLimit) {
  const statsList = results.map((item) => item.stats || {});
  const combined = {
    batch_file_count: results.length,
    message_limit_bytes: messageLimit,
    upload_limit_bytes: messageLimit,
    output_truncated: statsList.some((stats) => stats.output_truncated),
    ai_chunk_tokens: AI_CHUNK_TOKENS,
    ai_chunk_overlap: AI_CHUNK_OVERLAP
  };
  const summedKeys = ["original_lines", "cleaned_lines", "duplicates_removed", "removed_lines", "discarded_boilerplate_lines", "discarded_ai_noise_lines", "discarded_short_lines", "junk_chars_removed", "original_size", "cleaned_size", "ai_token_count", "ai_chunk_count"];
  for (const key of summedKeys) combined[key] = statsList.reduce((sum, stats) => sum + Number(stats[key] || 0), 0);
  combined.quality_score = statsList.length ? Math.round(statsList.reduce((sum, stats) => sum + Number(stats.quality_score || 0), 0) / statsList.length) : 0;
  combined.reduction_percent = combined.original_lines ? round((1 - combined.cleaned_lines / combined.original_lines) * 100, 2) : 0;
  combined.duplicate_ratio = combined.original_lines ? round((combined.duplicates_removed / combined.original_lines) * 100, 2) : 0;
  combined.boilerplate_ratio = combined.original_lines ? round((combined.discarded_boilerplate_lines / combined.original_lines) * 100, 2) : 0;
  combined.avg_line_length = combined.cleaned_lines ? round(combined.cleaned_size / combined.cleaned_lines, 2) : 0;
  combined.avg_words_per_line = combined.cleaned_lines
    ? round(statsList.reduce((sum, stats) => sum + Number(stats.avg_words_per_line || 0) * Number(stats.cleaned_lines || 0), 0) / combined.cleaned_lines, 2)
    : 0;
  return combined;
}

function hashSecret(secret) {
  const salt = crypto.randomBytes(16);
  const digest = crypto.pbkdf2Sync(String(secret), salt, 200000, 32, "sha256");
  return `pbkdf2_sha256$200000$${salt.toString("hex")}$${digest.toString("hex")}`;
}

function verifySecret(secret, storedHash) {
  try {
    const [algorithm, iterations, saltHex, digestHex] = String(storedHash || "").split("$");
    if (algorithm !== "pbkdf2_sha256") return false;
    const digest = crypto.pbkdf2Sync(String(secret), Buffer.from(saltHex, "hex"), Number(iterations), Buffer.from(digestHex, "hex").length, "sha256");
    return crypto.timingSafeEqual(digest, Buffer.from(digestHex, "hex"));
  } catch {
    return false;
  }
}

function normalizeAccountId(value) {
  const accountId = String(value || "").trim().toLowerCase();
  if (!accountId || accountId.length > MAX_ACCOUNT_ID_LENGTH) return "";
  return accountId;
}

function getUser(email) {
  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
  if (!user) return null;
  user.payments = db.prepare("SELECT id, plan, amount, currency, billing_interval, status, card_last4 FROM payments WHERE email = ? ORDER BY created_at DESC LIMIT 5").all(email);
  return user;
}

function createUser(email, password, accessCode, plan = "free", billingInterval = "monthly") {
  db.prepare("INSERT INTO users (email, password_hash, access_code_hash, plan, billing_interval, runs_used, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)")
    .run(email, hashSecret(password), hashSecret(accessCode), plan, billingInterval, Math.floor(Date.now() / 1000));
}

function updateUserPlan(email, planId, billingInterval) {
  db.prepare("UPDATE users SET plan = ?, billing_interval = ? WHERE email = ?").run(planId, billingInterval, email);
}

function incrementRuns(email) {
  db.prepare("UPDATE users SET runs_used = runs_used + 1 WHERE email = ?").run(email);
}

function addPayment(email, payment) {
  db.prepare("INSERT INTO payments (id, email, plan, amount, currency, billing_interval, status, card_last4, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(payment.id, email, payment.plan, payment.amount, payment.currency || "$", payment.billing_interval || "monthly", payment.status, payment.card_last4 || "", Math.floor(Date.now() / 1000));
}

function ensureDemoUser() {
  if (getUser("demo@xeonic.dev")) return;
  createUser("demo@xeonic.dev", "demo123", "xeonic", "starter");
  addPayment("demo@xeonic.dev", { id: "pay_demo_001", plan: "starter", amount: 9, currency: "$", billing_interval: "monthly", status: "paid", card_last4: "4242" });
}

function buildUserResponse(email) {
  const user = getUser(email);
  if (!user) throw httpError(401, "Account no longer exists.");
  return {
    email,
    plan_id: user.plan,
    plan_name: PLANS[user.plan].name,
    billing_interval: user.billing_interval || "monthly",
    usage: buildUsage(user.plan, user.runs_used),
    payments: (user.payments || []).slice(0, 5)
  };
}

function buildUsage(planId, runsUsed) {
  const plan = PLANS[planId];
  const allowed = plan.runs;
  return {
    runs_used: runsUsed,
    runs_allowed: allowed,
    runs_remaining: allowed === 999 ? "Unlimited" : Math.max(0, allowed - runsUsed),
    max_bytes: plan.max_bytes,
    message_limit_bytes: plan.max_bytes
  };
}

function buildGuestUsage(runsUsed) {
  return {
    runs_used: runsUsed,
    runs_allowed: GUEST_PLAN.runs,
    runs_remaining: Math.max(0, GUEST_PLAN.runs - runsUsed),
    max_bytes: GUEST_PLAN.max_bytes,
    message_limit_bytes: GUEST_PLAN.max_bytes
  };
}

function serializePlans() {
  return Object.entries(PLANS).map(([id, data]) => ({
    id,
    name: data.name,
    price: data.price,
    currency: "$",
    yearly_price: billingAmount(data.price, "yearly"),
    runs: data.runs,
    max_bytes: data.max_bytes,
    message_limit_bytes: data.max_bytes,
    features: data.features
  }));
}

function billingAmount(monthlyPrice, billingInterval) {
  return billingInterval === "yearly" ? monthlyPrice * 10 : monthlyPrice;
}

function requireSession(req, res) {
  const email = SESSIONS.get(req.get("x-session-token") || "");
  if (!email) {
    error(res, 401, "Please log in to continue.");
    return "";
  }
  return email;
}

function truncateUtf8(text, maxBytes) {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) return { text, truncated: false };
  return { text: buffer.subarray(0, maxBytes).toString("utf8").trimEnd(), truncated: true };
}

function htmlUnescape(text) {
  return String(text)
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([a-f0-9]+);/gi, (_match, code) => String.fromCodePoint(parseInt(code, 16)));
}

function formatSize(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return `${Math.round(bytes / (1024 * 1024 * 1024))} GB`;
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function round(value, places) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function httpError(status, detail) {
  const err = new Error(detail);
  err.status = status;
  return err;
}

function error(res, status, detail) {
  return res.status(status).json({ detail });
}

function sendCaughtError(res, err) {
  const status = err.status || 500;
  return res.status(status).json({ detail: err.message || "Request failed." });
}

const port = Number(process.env.PORT || 8000);
app.listen(port, "0.0.0.0", () => {
  console.log(`Xeonic Node backend running on http://0.0.0.0:${port}`);
});
