#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const z = require("zod/v4");

const execFileAsync = promisify(execFile);
const PROJECT_ROOT = resolveProjectRoot();
const DEFAULT_SEARCH_LIMIT = 10;
const DEFAULT_SEARCH_PREVIEW = 220;
const DEFAULT_WEREAD_CONTEXT_LIMIT = 5;
const DEFAULT_WEREAD_CONTEXT_PREVIEW = 260;
const DEFAULT_NOTE_MAX_CHARS = 12000;
const DEFAULT_MANIFEST_MAX_CHUNKS = 300;
const MAX_MANIFEST_MAX_CHUNKS = 1000;
const MAX_RAW_MANIFEST_CHARS = 200000;
const IMPORT_ALLOWED_EXTENSIONS = new Set([".epub", ".txt", ".md"]);
const PROGRESS_VERSION = 1;
const RECOVERY_SECTION_HEADING = "阅读恢复区";
const LEGACY_RECOVERY_SECTION_HEADING = "快速恢复区";
const DEFAULT_NOTE_READ_SECTIONS = [
  RECOVERY_SECTION_HEADING,
  "当前理解",
  "下次入口",
];
const NOTE_SECTION_HEADINGS = [
  RECOVERY_SECTION_HEADING,
  "当前理解",
  "下次入口",
  "摘录与想法",
  "段落共读记录",
  "交叉关联",
];
const NOTE_APPEND_SECTIONS = ["摘录与想法", "段落共读记录", "交叉关联"];
const QUICK_RECOVERY_KEYS = [
  "localBookId",
  "localTitle",
  "wereadTitle",
  "author",
  "lastChunkId",
  "nextChunkId",
  "lastPath",
  "nextPath",
  "lastSectionTitle",
  "lastReadAt",
  "noteUpdatedAt",
  "currentThemes",
  "currentMode",
];

function resolveProjectRoot() {
  return path.resolve(__dirname, "..");
}

function normalizePath(value) {
  return path.resolve(String(value)).replace(/\\/g, "/");
}

function normalizeRelativePath(value) {
  return String(value || "").replace(/\\/g, "/");
}

function fileStem(filePath) {
  return path.basename(String(filePath || ""), path.extname(String(filePath || "")));
}

function resolveStateDir(inputStateDir) {
  if (inputStateDir) {
    return path.resolve(inputStateDir);
  }

  if (process.env.READING_STATE_DIR) {
    return path.resolve(process.env.READING_STATE_DIR);
  }

  if (process.env.CYBERBOSS_STATE_DIR) {
    return path.resolve(process.env.CYBERBOSS_STATE_DIR);
  }

  return path.resolve(PROJECT_ROOT, "..", ".cyberboss");
}

async function runNodeScript(scriptName, args, options = {}) {
  const scriptPath = path.join(PROJECT_ROOT, "scripts", scriptName);
  const finalArgs = [scriptPath, ...args];
  const env = {
    ...process.env,
  };

  if (options.stateDir) {
    env.READING_STATE_DIR = options.stateDir;
    env.CYBERBOSS_STATE_DIR = options.stateDir;
  }

  try {
    const result = await execFileAsync(process.execPath, finalArgs, {
      cwd: PROJECT_ROOT,
      env,
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
    });

    const stdout = String(result.stdout || "").trim();
    const stderr = String(result.stderr || "").trim();

    return {
      ok: true,
      stdout,
      stderr,
      json: options.expectJson ? parseMaybeJson(stdout) : null,
    };
  } catch (error) {
    const stdout = String(error.stdout || "").trim();
    const stderr = String(error.stderr || "").trim();
    const exitCode = Number.isInteger(error.code) ? error.code : null;
    const message = stderr || stdout || error.message;

    const failure = new Error(
      `Script failed: ${scriptName} (exitCode=${exitCode ?? "unknown"}) ${message}`
    );
    failure.exitCode = exitCode;
    failure.stdout = stdout;
    failure.stderr = stderr;
    throw failure;
  }
}

function parseMaybeJson(text) {
  if (!text) return null;
  return JSON.parse(text);
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readTextFile(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function safeJoin(base, relativePath) {
  const resolvedBase = path.resolve(base);
  const targetPath = path.resolve(resolvedBase, relativePath);
  const normalizedBase = appendSep(resolvedBase.toLowerCase());
  const normalizedTarget = targetPath.toLowerCase();

  if (!normalizedTarget.startsWith(normalizedBase)) {
    throw new Error(`Path escapes base directory: ${relativePath}`);
  }

  return targetPath;
}

function appendSep(value) {
  return value.endsWith(path.sep) ? value : `${value}${path.sep}`;
}

function atomicWriteFile(filePath, content) {
  const normalizedContent = ensureTrailingNewline(
    String(content || "").replace(/\r\n?/g, "\n")
  );
  const directoryPath = path.dirname(filePath);
  fs.mkdirSync(directoryPath, { recursive: true });
  const tempFilePath = path.join(
    directoryPath,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`
  );
  fs.writeFileSync(tempFilePath, normalizedContent, "utf8");
  fs.renameSync(tempFilePath, filePath);
}

function ensureTrailingNewline(text) {
  return text.endsWith("\n") ? text : `${text}\n`;
}

function cleanText(text) {
  return String(text || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripChunkFileTitle(text) {
  const cleaned = cleanText(text);
  const lines = cleaned.split("\n");
  if (!/^#\s+.+$/u.test(lines[0] || "")) {
    return cleaned;
  }

  let index = 1;
  while (index < lines.length && !lines[index].trim()) {
    index += 1;
  }

  return cleanText(lines.slice(index).join("\n"));
}

function emptyProgress() {
  return {
    version: PROGRESS_VERSION,
    books: {},
    recentBooks: [],
  };
}

function createProgressState() {
  return {
    version: PROGRESS_VERSION,
    updatedAt: "",
    books: {},
    recentBooks: [],
  };
}

function getNowIsoString() {
  return new Date().toISOString();
}

function assertSafeBookId(bookId) {
  const value = String(bookId || "").trim();
  if (!value) {
    throw new Error("bookId is required");
  }
  if (value.includes("/") || value.includes("\\") || value.includes("\0")) {
    throw new Error(`Unsafe bookId: ${bookId}`);
  }
  return value;
}

function sanitizeFileName(value) {
  const sanitized = String(value || "")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/[. ]+$/g, "")
    .trim();
  if (!sanitized) {
    throw new Error("bookId cannot be converted to a safe filename");
  }
  return sanitized;
}

function resolveInputPath(inputPath) {
  const rawInput = String(inputPath || "").trim();
  if (!rawInput) {
    throw new Error("input is required");
  }

  const candidates = path.isAbsolute(rawInput)
    ? [path.resolve(rawInput)]
    : [path.resolve(process.cwd(), rawInput), path.resolve(PROJECT_ROOT, rawInput)];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return candidates[0];
}

function validateImportInput(inputPath) {
  const resolvedInputPath = resolveInputPath(inputPath);
  const extension = path.extname(resolvedInputPath).toLowerCase();
  if (!IMPORT_ALLOWED_EXTENSIONS.has(extension)) {
    throw new Error(`Unsupported input format: ${extension || "(none)"}`);
  }
  if (!fs.existsSync(resolvedInputPath)) {
    throw new Error(`Input file does not exist: ${normalizePath(resolvedInputPath)}`);
  }

  return {
    inputPath: resolvedInputPath,
    extension,
  };
}

function buildNoteRelativePath(bookId) {
  return `reading/notes/${sanitizeFileName(bookId)}.md`;
}

function buildNoteFilePath(stateDir, bookId) {
  const readingDir = safeJoin(stateDir, "reading");
  return safeJoin(readingDir, `notes/${sanitizeFileName(bookId)}.md`);
}

function buildBookDirPath(stateDir, bookId) {
  const readingDir = safeJoin(stateDir, "reading");
  return safeJoin(readingDir, `books/${assertSafeBookId(bookId)}`);
}

function buildBookMapPath(stateDir) {
  return safeJoin(stateDir, "reading/book-map.json");
}

function loadBookMapState(stateDir) {
  const bookMapPath = buildBookMapPath(stateDir);
  if (!fs.existsSync(bookMapPath)) {
    return {
      bookMapPath,
      bookMap: {
        version: 1,
        updatedAt: "",
        links: [],
        pending: [],
      },
      exists: false,
    };
  }

  const bookMap = readJsonFile(bookMapPath);
  return {
    bookMapPath,
    bookMap: {
      version: Number(bookMap.version) || 1,
      updatedAt: bookMap.updatedAt || "",
      links: Array.isArray(bookMap.links) ? bookMap.links : [],
      pending: Array.isArray(bookMap.pending) ? bookMap.pending : [],
    },
    exists: true,
  };
}

function findLinkedWereadMapping(bookMap, input) {
  const links = Array.isArray(bookMap.links) ? bookMap.links : [];
  if (input.wereadBookId) {
    const byBookId = links.find((item) => {
      return String(item.wereadBookId || "") === String(input.wereadBookId);
    });
    if (byBookId) {
      return {
        status: "linked",
        matchedBy: "wereadBookId",
        record: byBookId,
      };
    }
  }

  if (input.wereadTitle) {
    const byTitle = links.find((item) => {
      return String(item.wereadTitle || "") === String(input.wereadTitle);
    });
    if (byTitle) {
      return {
        status: "linked",
        matchedBy: "wereadTitle",
        record: byTitle,
      };
    }
  }

  return null;
}

function findPendingWereadMapping(bookMap, input) {
  const pending = Array.isArray(bookMap.pending) ? bookMap.pending : [];
  if (input.wereadBookId) {
    const byBookId = pending.find((item) => {
      return String(item.wereadBookId || "") === String(input.wereadBookId);
    });
    if (byBookId) {
      return {
        status: "pending",
        matchedBy: "wereadBookId",
        record: byBookId,
      };
    }
  }

  if (input.wereadTitle) {
    const byTitle = pending.find((item) => {
      return String(item.wereadTitle || "") === String(input.wereadTitle);
    });
    if (byTitle) {
      return {
        status: "pending",
        matchedBy: "wereadTitle",
        record: byTitle,
      };
    }
  }

  return null;
}

function resolveLocalBookIdFromWereadMapping(stateDir, input) {
  if (input.localBookId) {
    const localBookId = assertSafeBookId(input.localBookId);
    return {
      localBookId,
      mapping: {
        matchedBy: "localBookId",
        status: "linked",
      },
      warnings: [],
    };
  }

  const { bookMapPath, bookMap, exists } = loadBookMapState(stateDir);
  if (!exists) {
    const error = new Error(
      "Cannot resolve localBookId from WeRead book mapping. Please call reading_link_weread_book first or pass localBookId."
    );
    error.bookMapPath = normalizePath(bookMapPath);
    throw error;
  }

  const linked = findLinkedWereadMapping(bookMap, input);
  if (linked) {
    return {
      localBookId: assertSafeBookId(linked.record.localBookId),
      mapping: {
        matchedBy: linked.matchedBy,
        status: "linked",
      },
      warnings: [],
    };
  }

  const pending = findPendingWereadMapping(bookMap, input);
  if (pending) {
    return {
      localBookId: "",
      mapping: {
        matchedBy: pending.matchedBy,
        status: "pending",
      },
      warnings: [
        "WeRead book mapping exists in pending status. Please confirm it first with reading_link_weread_book.",
      ],
    };
  }

  const error = new Error(
    "Cannot resolve localBookId from WeRead book mapping. Please call reading_link_weread_book first or pass localBookId."
  );
  error.bookMapPath = normalizePath(bookMapPath);
  throw error;
}

function loadProgressState(stateDir) {
  const progressPath = safeJoin(stateDir, "reading/progress.json");
  if (!fs.existsSync(progressPath)) {
    return {
      progressPath,
      progressState: createProgressState(),
      created: true,
    };
  }

  const progressState = readJsonFile(progressPath);
  return {
    progressPath,
    progressState: {
      version: PROGRESS_VERSION,
      updatedAt: progressState.updatedAt || "",
      books: progressState.books || {},
      recentBooks: Array.isArray(progressState.recentBooks) ? progressState.recentBooks : [],
    },
    created: false,
  };
}

function moveRecentBookToFront(recentBooks, bookId) {
  return [bookId, ...recentBooks.filter((item) => item !== bookId)];
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => String(item || "").trim())
    .filter(Boolean);
}

function formatQuickRecoveryValue(value) {
  if (Array.isArray(value)) {
    return value.join(", ");
  }
  if (value === null || value === undefined) {
    return "";
  }
  return String(value);
}

function normalizeMarkdownDocument(markdown) {
  const normalized = String(markdown || "").replace(/\r\n?/g, "\n").trimEnd();
  return normalized ? `${normalized}\n` : "";
}

function normalizeSectionContent(content) {
  return String(content || "").replace(/\r\n?/g, "\n").trim();
}

function normalizeNoteMarkdown(markdown) {
  return normalizeMarkdownDocument(markdown).replace(
    new RegExp(`^##\\s+${LEGACY_RECOVERY_SECTION_HEADING}$`, "mu"),
    `## ${RECOVERY_SECTION_HEADING}`
  );
}

function findH2SectionRange(lines, heading) {
  const headingLine = `## ${heading}`;
  const startIndex = lines.findIndex((line) => line.trim() === headingLine);
  if (startIndex === -1) {
    return null;
  }

  let endIndex = lines.length;
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    if (/^##\s+/u.test(lines[index])) {
      endIndex = index;
      break;
    }
  }

  return { startIndex, endIndex };
}

function buildSectionLines(heading, content) {
  const normalizedContent = normalizeSectionContent(content);
  const sectionLines = [`## ${heading}`, ""];
  if (normalizedContent) {
    sectionLines.push(...normalizedContent.split("\n"));
    sectionLines.push("");
  }
  return sectionLines;
}

function getMarkdownSectionContent(markdown, heading) {
  const lines = normalizeNoteMarkdown(markdown).split("\n");
  const range = findH2SectionRange(lines, heading);
  if (!range) {
    return "";
  }

  const contentLines = lines.slice(range.startIndex + 2, range.endIndex);
  return contentLines.join("\n").trim();
}

function upsertMarkdownSection(markdown, heading, content) {
  const normalized = normalizeNoteMarkdown(markdown);
  const lines = normalized ? normalized.split("\n") : [];
  if (lines.length && lines[lines.length - 1] === "") {
    lines.pop();
  }

  const sectionLines = buildSectionLines(heading, content);
  const range = findH2SectionRange(lines, heading);

  if (!range) {
    const nextLines = [...lines];
    if (nextLines.length) {
      nextLines.push("");
    }
    nextLines.push(...sectionLines);
    return ensureTrailingNewline(nextLines.join("\n"));
  }

  const nextLines = [
    ...lines.slice(0, range.startIndex),
    ...sectionLines,
    ...lines.slice(range.endIndex),
  ];
  return ensureTrailingNewline(nextLines.join("\n"));
}

function appendMarkdownSection(markdown, heading, entry) {
  const existingContent = getMarkdownSectionContent(markdown, heading);
  const normalizedEntry = normalizeSectionContent(entry);
  const nextContent = existingContent
    ? `${existingContent}\n\n${normalizedEntry}`
    : normalizedEntry;
  return upsertMarkdownSection(markdown, heading, nextContent);
}

function createNoteSkeleton(bookId, title, author) {
  const displayTitle = title || bookId;
  const displayAuthor = author || "";
  return ensureTrailingNewline(
    [
      `# ${displayTitle}`,
      "",
      `## ${RECOVERY_SECTION_HEADING}`,
      "",
      `- localBookId: ${bookId}`,
      `- localTitle: ${displayTitle}`,
      "- wereadTitle:",
      `- author: ${displayAuthor}`,
      "- lastChunkId:",
      "- nextChunkId:",
      "- lastPath:",
      "- nextPath:",
      "- lastSectionTitle:",
      "- lastReadAt:",
      "- noteUpdatedAt:",
      "- currentThemes:",
      "- currentMode:",
      "",
      "## 当前理解",
      "",
      "暂无。",
      "",
      "## 下次入口",
      "",
      "暂无。",
      "",
      "## 摘录与想法",
      "",
      "## 段落共读记录",
      "",
      "## 交叉关联",
    ].join("\n")
  );
}

function buildQuickRecoveryMarkdown(bookId, title, author, quickRecovery, timestamp) {
  const payload = {
    localBookId: bookId,
    localTitle: title || bookId,
    wereadTitle: "",
    author: author || "",
    lastChunkId: "",
    nextChunkId: "",
    lastPath: "",
    nextPath: "",
    lastSectionTitle: "",
    lastReadAt: "",
    noteUpdatedAt: timestamp,
    currentThemes: "",
    currentMode: "",
    ...(quickRecovery || {}),
  };

  if (!payload.noteUpdatedAt) {
    payload.noteUpdatedAt = timestamp;
  }

  const extraKeys = Object.keys(payload).filter((key) => !QUICK_RECOVERY_KEYS.includes(key));
  const orderedKeys = [...QUICK_RECOVERY_KEYS, ...extraKeys];

  return orderedKeys
    .map((key) => `- ${key}: ${formatQuickRecoveryValue(payload[key])}`)
    .join("\n");
}

function extractMarkdownSection(markdown, heading) {
  return getMarkdownSectionContent(markdown, heading);
}

function extractMarkdownSections(markdown, headings) {
  const normalizedHeadings = Array.from(new Set(headings || []));
  const sections = {};
  for (const heading of normalizedHeadings) {
    sections[heading] = extractMarkdownSection(markdown, heading);
  }
  return sections;
}

function truncateText(text, maxChars) {
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : DEFAULT_NOTE_MAX_CHARS;
  const value = String(text || "");
  if (value.length <= limit) {
    return {
      text: value,
      truncated: false,
    };
  }

  return {
    text: value.slice(0, limit),
    truncated: true,
  };
}

function normalizeRequestedSections(sections) {
  if (!sections || !sections.length) {
    return [...DEFAULT_NOTE_READ_SECTIONS];
  }
  return Array.from(new Set(sections.map((section) => String(section))));
}

function readNoteFile(bookId, stateDir, options = {}) {
  const safeBookId = assertSafeBookId(bookId);
  const notePath = buildNoteFilePath(stateDir, safeBookId);
  const sectionsToRead = normalizeRequestedSections(options.sections);
  const includeFull = Boolean(options.includeFull);
  const maxChars = options.maxChars ?? DEFAULT_NOTE_MAX_CHARS;
  const warnings = [];

  if (!fs.existsSync(notePath)) {
    return {
      ok: true,
      exists: false,
      bookId: safeBookId,
      notePath: normalizePath(notePath),
      sections: {},
      fullText: null,
      warnings,
    };
  }

  const markdown = normalizeNoteMarkdown(fs.readFileSync(notePath, "utf8"));
  const result = {
    ok: true,
    exists: true,
    bookId: safeBookId,
    notePath: normalizePath(notePath),
    sections: extractMarkdownSections(markdown, sectionsToRead),
    fullText: null,
    warnings,
  };

  if (includeFull) {
    const truncated = truncateText(markdown, maxChars);
    result.fullText = truncated.text;
    if (truncated.truncated) {
      result.warnings.push(`fullText truncated to ${maxChars} characters`);
    }
  }

  return result;
}

function resolveRecentBookId(progressState) {
  const recentBook = Array.isArray(progressState.recentBooks)
    ? progressState.recentBooks[0]
    : null;
  if (!recentBook) {
    return null;
  }
  if (typeof recentBook === "string") {
    return recentBook;
  }
  if (recentBook && typeof recentBook === "object" && recentBook.localBookId) {
    return String(recentBook.localBookId);
  }
  return null;
}

function parseIsoTime(value) {
  const timestamp = Date.parse(String(value || ""));
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function findImportedManifest(stateDir, options = {}) {
  const booksDir = safeJoin(stateDir, "reading/books");
  if (!fs.existsSync(booksDir)) {
    return null;
  }

  if (options.bookId) {
    try {
      const { bookDir, manifestPath, manifest } = readBookManifest(options.bookId, stateDir);
      return { bookDir, manifestPath, manifest, matchedBy: "bookId" };
    } catch {
      return null;
    }
  }

  const inputPath = options.inputPath ? normalizePath(options.inputPath) : null;
  const manifests = fs.readdirSync(booksDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const bookDir = safeJoin(booksDir, entry.name);
      const manifestPath = path.join(bookDir, "manifest.json");
      if (!fs.existsSync(manifestPath)) {
        return null;
      }

      try {
        const manifest = readJsonFile(manifestPath);
        const stats = fs.statSync(manifestPath);
        return {
          bookDir,
          manifestPath,
          manifest,
          updatedAt: parseIsoTime(manifest.importedAt) || stats.mtimeMs,
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((left, right) => right.updatedAt - left.updatedAt);

  if (!manifests.length) {
    return null;
  }

  if (inputPath) {
    const bySourcePath = manifests.find((entry) => {
      return normalizePath(entry.manifest.sourcePath || "") === inputPath;
    });
    if (bySourcePath) {
      return { ...bySourcePath, matchedBy: "sourcePath" };
    }
  }

  if (options.title) {
    const byTitle = manifests.find((entry) => {
      return String(entry.manifest.title || "") === String(options.title);
    });
    if (byTitle) {
      return { ...byTitle, matchedBy: "title" };
    }
  }

  return { ...manifests[0], matchedBy: "latest" };
}

function resolveProgressBookEntry(progressState, bookId) {
  if (!bookId) {
    return null;
  }
  return progressState.books?.[bookId] || null;
}

function resolveIndexStatus(manifest, bookDir, includeIndexStatus) {
  if (!includeIndexStatus) {
    return null;
  }

  if (manifest.index) {
    return {
      status: manifest.index.status || "unknown",
      path: normalizeRelativePath(manifest.index.path || "search-index.json"),
      updatedAt: manifest.index.updatedAt ?? null,
    };
  }

  const searchIndexPath = path.join(bookDir, "search-index.json");
  if (fs.existsSync(searchIndexPath)) {
    return {
      status: "built",
      path: "search-index.json",
      updatedAt: "",
    };
  }

  return {
    status: "not_built",
    path: "search-index.json",
    updatedAt: null,
  };
}

function compareBooks(left, right) {
  const leftProgressTime = parseIsoTime(left.progress?.lastReadAt);
  const rightProgressTime = parseIsoTime(right.progress?.lastReadAt);
  if (leftProgressTime || rightProgressTime) {
    if (rightProgressTime !== leftProgressTime) {
      return rightProgressTime - leftProgressTime;
    }
  }

  const leftImportedTime = parseIsoTime(left.importedAt);
  const rightImportedTime = parseIsoTime(right.importedAt);
  if (leftImportedTime || rightImportedTime) {
    if (rightImportedTime !== leftImportedTime) {
      return rightImportedTime - leftImportedTime;
    }
  }

  return String(left.title || "").localeCompare(String(right.title || ""), "zh-CN");
}

function readingListBooks(args = {}) {
  const stateDir = resolveStateDir(args.stateDir);
  const booksDir = safeJoin(stateDir, "reading/books");
  const warnings = [];
  const includeProgress = args.includeProgress !== false;
  const includeIndexStatus = args.includeIndexStatus !== false;
  const includeStats = args.includeStats !== false;

  if (!fs.existsSync(booksDir)) {
    return {
      ok: true,
      stateDir: normalizePath(stateDir),
      booksDir: normalizePath(booksDir),
      count: 0,
      books: [],
      warnings,
    };
  }

  let progressByBookId = {};
  if (includeProgress) {
    const progressPath = safeJoin(stateDir, "reading/progress.json");
    if (fs.existsSync(progressPath)) {
      try {
        const progressState = readJsonFile(progressPath);
        progressByBookId = progressState.books || {};
      } catch (error) {
        warnings.push(`Unable to parse progress.json: ${error.message}`);
      }
    }
  }

  const books = [];
  for (const entry of fs.readdirSync(booksDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;

    const bookDir = safeJoin(booksDir, entry.name);
    const manifestPath = path.join(bookDir, "manifest.json");
    if (!fs.existsSync(manifestPath)) continue;

    try {
      const manifest = readJsonFile(manifestPath);
      const bookId = manifest.bookId || entry.name;
      const progress = includeProgress ? (progressByBookId[bookId] || null) : null;

      books.push({
        bookId,
        title: manifest.title || bookId,
        author: manifest.author || "",
        sourceType: manifest.sourceType || "",
        sourcePath: manifest.sourcePath ? normalizePath(manifest.sourcePath) : "",
        importedAt: manifest.importedAt || "",
        chunkCount: Number(manifest.chunkCount || manifest.chunks?.length || 0),
        rawSectionCount: Number(manifest.rawSectionCount || 0),
        sectionCount: Number(manifest.sectionCount || 0),
        manifestPath: normalizePath(manifestPath),
        bookDir: normalizePath(bookDir),
        index: resolveIndexStatus(manifest, bookDir, includeIndexStatus),
        chunkStats: includeStats
          ? {
              averageChars: Number(manifest.chunkStats?.averageChars || 0),
              minChunkChars: Number(manifest.chunkStats?.minChunkChars || 0),
              maxChunkChars: Number(manifest.chunkStats?.maxChunkChars || 0),
            }
          : null,
        progress,
      });
    } catch (error) {
      warnings.push(`Skipped ${normalizePath(manifestPath)}: ${error.message}`);
    }
  }

  books.sort(compareBooks);

  return {
    ok: true,
    stateDir: normalizePath(stateDir),
    booksDir: normalizePath(booksDir),
    count: books.length,
    books,
    warnings,
  };
}

function normalizeManifestChunks(chunks, options = {}) {
  const includeChunkPreview = options.includeChunkPreview !== false;
  const maxChunks = options.maxChunks ?? DEFAULT_MANIFEST_MAX_CHUNKS;
  const total = Array.isArray(chunks) ? chunks.length : 0;
  const warnings = [];

  if (total > maxChunks) {
    warnings.push(`Chunk list truncated: returned ${maxChunks} of ${total}`);
  }

  const items = (Array.isArray(chunks) ? chunks : [])
    .slice(0, maxChunks)
    .map((chunk) => {
      const item = {
        id: chunk.id,
        title: chunk.title || "",
        sectionTitle: chunk.sectionTitle || "",
        order: Number(chunk.order || 0),
        path: normalizeRelativePath(chunk.path || ""),
        charCount: Number(chunk.charCount || 0),
        wordCount: Number(chunk.wordCount || 0),
        prevId: chunk.prevId ?? null,
        nextId: chunk.nextId ?? null,
        keywords: Array.isArray(chunk.keywords) ? chunk.keywords.slice(0, 20) : [],
      };

      if (includeChunkPreview) {
        item.preview = chunk.preview || "";
      }

      return item;
    });

  return {
    chunks: items,
    warnings,
  };
}

function readingGetManifest(args = {}) {
  const stateDir = resolveStateDir(args.stateDir);
  const bookId = assertSafeBookId(args.bookId);
  const includeChunks = args.includeChunks !== false;
  const includeChunkPreview = args.includeChunkPreview !== false;
  const maxChunks = args.maxChunks ?? DEFAULT_MANIFEST_MAX_CHUNKS;
  const includeRaw = Boolean(args.includeRaw);
  const warnings = [];

  const { bookDir, manifestPath, manifest } = readBookManifest(bookId, stateDir);
  let chunks = [];
  if (includeChunks) {
    const normalized = normalizeManifestChunks(manifest.chunks, {
      includeChunkPreview,
      maxChunks,
    });
    chunks = normalized.chunks;
    warnings.push(...normalized.warnings);
  }

  const response = {
    ok: true,
    bookId: manifest.bookId || bookId,
    title: manifest.title || bookId,
    author: manifest.author || "",
    sourceType: manifest.sourceType || "",
    sourcePath: manifest.sourcePath ? normalizePath(manifest.sourcePath) : "",
    importedAt: manifest.importedAt || "",
    maxChars: Number(manifest.maxChars || 0),
    minChars: Number(manifest.minChars || 0),
    rawSectionCount: Number(manifest.rawSectionCount || 0),
    sectionCount: Number(manifest.sectionCount || 0),
    initialChunkCount: Number(manifest.initialChunkCount || 0),
    chunkCount: Number(manifest.chunkCount || manifest.chunks?.length || 0),
    chunkStats: {
      averageChars: Number(manifest.chunkStats?.averageChars || 0),
      minChunkChars: Number(manifest.chunkStats?.minChunkChars || 0),
      maxChunkChars: Number(manifest.chunkStats?.maxChunkChars || 0),
    },
    index: {
      status: manifest.index?.status || "not_built",
      version: Number(manifest.index?.version || 1),
      path: normalizeRelativePath(manifest.index?.path || "search-index.json"),
      updatedAt: manifest.index?.updatedAt ?? null,
    },
    manifestPath: normalizePath(manifestPath),
    bookDir: normalizePath(bookDir),
    chunks,
    warnings,
  };

  if (includeRaw) {
    const serialized = JSON.stringify(manifest);
    if (serialized.length > MAX_RAW_MANIFEST_CHARS) {
      warnings.push(`rawManifest omitted: serialized manifest exceeds ${MAX_RAW_MANIFEST_CHARS} characters`);
    } else {
      response.rawManifest = manifest;
    }
  }

  return response;
}

function resumeBook(input) {
  const stateDir = resolveStateDir(input.stateDir);
  const progressPath = safeJoin(stateDir, "reading/progress.json");
  if (!fs.existsSync(progressPath)) {
    throw new Error(`progress.json does not exist: ${normalizePath(progressPath)}`);
  }

  const progressState = readJsonFile(progressPath);
  const requestedBookId = input.bookId ? assertSafeBookId(input.bookId) : resolveRecentBookId(progressState);
  if (!requestedBookId) {
    throw new Error("Unable to resolve bookId from input or recentBooks[0]");
  }

  const progress = resolveProgressBookEntry(progressState, requestedBookId);
  if (!progress) {
    throw new Error(`Progress does not exist for bookId: ${requestedBookId}`);
  }

  const note = readNoteFile(requestedBookId, stateDir, {
    sections: DEFAULT_NOTE_READ_SECTIONS,
    includeFull: false,
  });
  const warnings = [...note.warnings];
  let chunk = null;

  if (input.readChunk !== false) {
    const targetChunkId = input.chunkId || progress.nextChunkId || progress.lastChunkId;
    if (!targetChunkId) {
      warnings.push("No chunkId available from input, nextChunkId, or lastChunkId");
    } else {
      try {
        chunk = readingGetChunk({
          bookId: requestedBookId,
          chunkId: targetChunkId,
          stateDir,
        });
      } catch (error) {
        warnings.push(error.message || String(error));
      }
    }
  }

  return {
    ok: true,
    bookId: requestedBookId,
    progress,
    note: {
      exists: note.exists,
      sections: note.exists
        ? note.sections
        : extractMarkdownSections("", DEFAULT_NOTE_READ_SECTIONS),
    },
    chunk,
    warnings,
  };
}

async function readingSearch(args, exact) {
  const stateDir = resolveStateDir(args.stateDir);
  const scriptArgs = buildSearchScriptArgs(args, exact, stateDir);
  const result = await runNodeScript("search-reading-book.js", scriptArgs, {
    stateDir,
    expectJson: true,
  });

  return {
    ok: true,
    stateDir: normalizePath(stateDir),
    ...result.json,
  };
}

function buildSearchScriptArgs(args, exact, stateDir) {
  const scriptArgs = [];
  if (args.bookId) {
    scriptArgs.push("--book-id", args.bookId);
  } else if (args.all) {
    scriptArgs.push("--all");
  } else {
    throw new Error("bookId and all must be exactly one of the two");
  }

  scriptArgs.push("--query", args.query, "--json", "--state-dir", stateDir);

  if (args.limit) {
    scriptArgs.push("--limit", String(args.limit));
  }
  if (args.maxPreview) {
    scriptArgs.push("--max-preview", String(args.maxPreview));
  }
  if (args.includeText) {
    scriptArgs.push("--include-text");
  }
  if (exact) {
    scriptArgs.push("--exact");
  }

  return scriptArgs;
}

function readBookManifest(bookId, stateDir) {
  const safeBookId = assertSafeBookId(bookId);
  const bookDir = buildBookDirPath(stateDir, safeBookId);
  if (!fs.existsSync(bookDir)) {
    throw new Error(`bookId does not exist: ${safeBookId}`);
  }

  const manifestPath = path.join(bookDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`manifest.json does not exist: ${normalizePath(manifestPath)}`);
  }

  return {
    bookDir,
    manifestPath,
    manifest: readJsonFile(manifestPath),
  };
}

function getChunkByIdOrPath(manifest, chunkId, chunkPath) {
  const chunks = Array.isArray(manifest.chunks) ? manifest.chunks : [];
  return chunks.find((chunk) => {
    return (chunkId && chunk.id === chunkId) || (chunkPath && chunk.path === chunkPath);
  }) || null;
}

function readingGetChunk(args) {
  if (!args.chunkId && !args.path) {
    throw new Error("chunkId or path is required");
  }

  const stateDir = resolveStateDir(args.stateDir);
  const safeBookId = assertSafeBookId(args.bookId);
  const { bookDir, manifest } = readBookManifest(safeBookId, stateDir);
  const chunk = getChunkByIdOrPath(manifest, args.chunkId, args.path);
  if (!chunk) {
    throw new Error("chunk does not exist");
  }
  if (chunk.path === "original.md" || /(^|\/)original\.md$/iu.test(String(chunk.path || ""))) {
    throw new Error("original.md cannot be read through this tool");
  }

  const chunkFilePath = safeJoin(bookDir, chunk.path);
  if (!fs.existsSync(chunkFilePath)) {
    throw new Error(`chunk file does not exist: ${chunk.path}`);
  }

  const text = stripChunkFileTitle(fs.readFileSync(chunkFilePath, "utf8"));

  return {
    ok: true,
    stateDir: normalizePath(stateDir),
    bookId: manifest.bookId || safeBookId,
    title: manifest.title || safeBookId,
    author: manifest.author || null,
    chunkId: chunk.id,
    chunkTitle: chunk.title,
    sectionTitle: chunk.sectionTitle || null,
    path: String(chunk.path || "").replace(/\\/g, "/"),
    prevId: chunk.prevId || null,
    nextId: chunk.nextId || null,
    charCount: chunk.charCount || text.length,
    text,
  };
}

function readingGetProgress(args) {
  const stateDir = resolveStateDir(args.stateDir);
  const progressPath = safeJoin(stateDir, "reading/progress.json");
  const progress = fs.existsSync(progressPath) ? readJsonFile(progressPath) : emptyProgress();

  if (!args.bookId) {
    return {
      ok: true,
      stateDir: normalizePath(stateDir),
      progress,
    };
  }

  return {
    ok: true,
    stateDir: normalizePath(stateDir),
    bookId: assertSafeBookId(args.bookId),
    progress: progress.books?.[args.bookId] || null,
  };
}

async function readingBuildIndex(args) {
  const stateDir = resolveStateDir(args.stateDir);
  const scriptArgs = [];
  if (args.bookId) {
    scriptArgs.push("--book-id", args.bookId);
  } else if (args.all) {
    scriptArgs.push("--all");
  } else {
    throw new Error("bookId and all must be exactly one of the two");
  }

  scriptArgs.push("--state-dir", stateDir);

  const result = await runNodeScript("build-reading-search-index.js", scriptArgs, {
    stateDir,
    expectJson: false,
  });

  return {
    ok: true,
    stateDir: normalizePath(stateDir),
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

async function readingLinkWereadBook(args = {}) {
  const stateDir = resolveStateDir(args.stateDir);
  const warnings = [];

  if (args.listPending) {
    const result = await runNodeScript("link-reading-book-map.js", [
      "--list-pending",
      "--state-dir", stateDir,
      "--json",
    ], {
      stateDir,
      expectJson: true,
    });

    return {
      ok: true,
      stateDir: normalizePath(stateDir),
      bookMapPath: normalizePath(buildBookMapPath(stateDir)),
      stdout: result.stdout,
      stderr: result.stderr,
      result: result.json,
      warnings,
    };
  }

  if (!args.wereadTitle && !args.wereadBookId) {
    throw new Error("wereadTitle or wereadBookId is required");
  }

  if (args.confirm && !args.localBookId) {
    throw new Error("confirm=true requires localBookId");
  }

  const scriptArgs = ["--state-dir", stateDir, "--json"];
  if (args.wereadTitle) {
    scriptArgs.push("--weread-title", String(args.wereadTitle));
  }
  if (args.wereadBookId) {
    scriptArgs.push("--weread-book-id", String(args.wereadBookId));
  }
  if (args.wereadAuthor) {
    scriptArgs.push("--weread-author", String(args.wereadAuthor));
  }
  if (args.localBookId) {
    scriptArgs.push("--local-book-id", assertSafeBookId(args.localBookId));
  }
  if (args.confirm) {
    scriptArgs.push("--confirm");
  }

  const result = await runNodeScript("link-reading-book-map.js", scriptArgs, {
    stateDir,
    expectJson: true,
  });

  return {
    ok: true,
    stateDir: normalizePath(stateDir),
    bookMapPath: normalizePath(buildBookMapPath(stateDir)),
    stdout: result.stdout,
    stderr: result.stderr,
    result: result.json,
    warnings,
  };
}

async function readingFindWereadContext(args = {}) {
  const stateDir = resolveStateDir(args.stateDir);
  const warnings = [];
  const mappingResult = resolveLocalBookIdFromWereadMapping(stateDir, {
    localBookId: args.localBookId,
    wereadTitle: args.wereadTitle,
    wereadBookId: args.wereadBookId,
  });
  warnings.push(...mappingResult.warnings);

  if (mappingResult.mapping.status === "pending") {
    return {
      ok: true,
      weread: {
        wereadTitle: String(args.wereadTitle || ""),
        wereadBookId: String(args.wereadBookId || ""),
        markText: String(args.markText || ""),
      },
      localBookId: "",
      mapping: mappingResult.mapping,
      search: {
        query: String(args.markText || ""),
        resultCount: 0,
        results: [],
      },
      chunk: null,
      warnings,
    };
  }

  const localBookId = mappingResult.localBookId;
  const searchResult = await readingSearch({
    bookId: localBookId,
    query: args.markText,
    limit: args.limit ?? DEFAULT_WEREAD_CONTEXT_LIMIT,
    maxPreview: args.maxPreview ?? DEFAULT_WEREAD_CONTEXT_PREVIEW,
    includeText: false,
    stateDir,
  }, true);
  warnings.push(...(Array.isArray(searchResult.warnings) ? searchResult.warnings : []));

  if (!Array.isArray(searchResult.results) || !searchResult.results.length) {
    warnings.push("No exact chunk match found for the given WeRead highlight.");
  }

  let chunk = null;
  if (args.includeChunk !== false && Array.isArray(searchResult.results) && searchResult.results.length) {
    const firstResult = searchResult.results[0];
    try {
      chunk = readingGetChunk({
        bookId: localBookId,
        chunkId: firstResult.chunkId,
        stateDir,
      });
    } catch (error) {
      warnings.push(error.message || String(error));
    }
  }

  return {
    ok: true,
    weread: {
      wereadTitle: String(args.wereadTitle || ""),
      wereadBookId: String(args.wereadBookId || ""),
      markText: String(args.markText || ""),
    },
    localBookId,
    mapping: mappingResult.mapping,
    search: {
      query: String(searchResult.query || args.markText || ""),
      resultCount: Number(searchResult.resultCount || 0),
      results: Array.isArray(searchResult.results) ? searchResult.results : [],
    },
    chunk,
    warnings,
  };
}

async function readingImportBook(args) {
  const stateDir = resolveStateDir(args.stateDir);
  const warnings = [];
  const { inputPath, extension } = validateImportInput(args.input);
  const scriptArgs = ["--input", inputPath, "--state-dir", stateDir];

  if (args.title) {
    scriptArgs.push("--title", args.title);
  }
  if (args.author) {
    scriptArgs.push("--author", args.author);
  }
  if (args.bookId) {
    scriptArgs.push("--book-id", assertSafeBookId(args.bookId));
  }
  if (args.maxChars !== undefined) {
    scriptArgs.push("--max-chars", String(args.maxChars));
  }
  if (args.minChars !== undefined) {
    scriptArgs.push("--min-chars", String(args.minChars));
  }

  const importResult = await runNodeScript("import-reading-book.js", scriptArgs, {
    stateDir,
    expectJson: false,
  });

  const manifestEntry = findImportedManifest(stateDir, {
    bookId: args.bookId,
    inputPath,
    title: args.title,
  });

  let manifest = null;
  let manifestPath = "";
  let bookDir = "";
  let resolvedBookId = args.bookId ? assertSafeBookId(args.bookId) : "";
  let indexStatus = "unknown";
  let chunkCount = 0;
  let resolvedTitle = args.title || fileStem(inputPath);
  let resolvedAuthor = args.author || null;
  let sourceType = extension.slice(1);

  if (manifestEntry) {
    manifest = manifestEntry.manifest;
    manifestPath = normalizePath(manifestEntry.manifestPath);
    bookDir = normalizePath(manifestEntry.bookDir);
    resolvedBookId = manifest.bookId || resolvedBookId;
    resolvedTitle = manifest.title || resolvedTitle;
    resolvedAuthor = manifest.author || resolvedAuthor || null;
    sourceType = manifest.sourceType || sourceType;
    chunkCount = Number(manifest.chunkCount || manifest.chunks?.length || 0);
    indexStatus = manifest.index?.status || "unknown";

    if (manifestEntry.matchedBy === "latest") {
      warnings.push("Manifest matched by latest updated book directory; please verify bookId.");
    } else if (manifestEntry.matchedBy === "title") {
      warnings.push("Manifest matched by title because sourcePath lookup did not resolve uniquely.");
    }
  } else {
    if (!resolvedBookId) {
      resolvedBookId = sanitizeFileName(args.title || fileStem(inputPath));
      warnings.push("bookId inferred from title or input filename because manifest could not be resolved.");
    }
    warnings.push("Import succeeded but manifest.json could not be resolved automatically.");
  }

  let indexBuilt = false;
  let indexStdout = "";
  let indexStderr = "";

  if (args.buildIndex) {
    if (!resolvedBookId) {
      warnings.push("Index build skipped because bookId could not be resolved after import.");
    } else {
      try {
        const indexResult = await readingBuildIndex({
          bookId: resolvedBookId,
          stateDir,
        });
        indexBuilt = true;
        indexStdout = indexResult.stdout;
        indexStderr = indexResult.stderr;

        try {
          const refreshed = readBookManifest(resolvedBookId, stateDir);
          manifest = refreshed.manifest;
          manifestPath = normalizePath(refreshed.manifestPath);
          bookDir = normalizePath(refreshed.bookDir);
          indexStatus = manifest.index?.status || indexStatus;
          chunkCount = Number(manifest.chunkCount || manifest.chunks?.length || chunkCount);
          resolvedTitle = manifest.title || resolvedTitle;
          resolvedAuthor = manifest.author || resolvedAuthor || null;
          sourceType = manifest.sourceType || sourceType;
        } catch {
          warnings.push("Index built, but refreshed manifest could not be loaded.");
        }
      } catch (error) {
        indexStdout = error.stdout || "";
        indexStderr = error.stderr || "";
        warnings.push(`index failed: ${error.message || String(error)}`);
      }
    }
  }

  return {
    ok: true,
    bookId: resolvedBookId || "",
    title: resolvedTitle || "",
    author: resolvedAuthor || "",
    stateDir: normalizePath(stateDir),
    bookDir,
    manifestPath,
    chunkCount,
    sourceType,
    indexStatus,
    stdout: importResult.stdout,
    stderr: importResult.stderr,
    warnings,
    indexBuilt,
    indexStdout,
    indexStderr,
  };
}

function readingUpdateProgress(args) {
  const bookId = assertSafeBookId(args.bookId);
  const stateDir = resolveStateDir(args.stateDir);
  const now = getNowIsoString();
  const { progressPath, progressState } = loadProgressState(stateDir);
  const existingEntry = progressState.books[bookId] || {};
  const nextEntry = {
    ...existingEntry,
    notePath: normalizeRelativePath(args.notePath || existingEntry.notePath || buildNoteRelativePath(bookId)),
    lastReadAt: args.lastReadAt || now,
  };

  const overwriteFields = [
    "title",
    "lastChunkId",
    "nextChunkId",
    "lastPath",
    "nextPath",
    "lastSectionTitle",
    "status",
  ];

  for (const field of overwriteFields) {
    if (args[field] !== undefined) {
      nextEntry[field] = field.endsWith("Path")
        ? normalizeRelativePath(args[field])
        : args[field];
    }
  }

  if (args.currentThemes !== undefined) {
    nextEntry.currentThemes = normalizeStringArray(args.currentThemes);
  } else if (Array.isArray(existingEntry.currentThemes)) {
    nextEntry.currentThemes = existingEntry.currentThemes;
  }

  progressState.books[bookId] = nextEntry;
  progressState.recentBooks = moveRecentBookToFront(progressState.recentBooks, bookId);
  progressState.updatedAt = now;

  atomicWriteFile(progressPath, JSON.stringify(progressState, null, 2));

  return {
    ok: true,
    bookId,
    progressPath: normalizePath(progressPath),
    progress: nextEntry,
  };
}

function readingUpdateNote(args) {
  const bookId = assertSafeBookId(args.bookId);
  const stateDir = resolveStateDir(args.stateDir);
  const notePath = buildNoteFilePath(stateDir, bookId);
  const noteExists = fs.existsSync(notePath);
  const now = args.timestamp || getNowIsoString();
  let markdown = noteExists
    ? normalizeNoteMarkdown(fs.readFileSync(notePath, "utf8"))
    : createNoteSkeleton(bookId, args.title, args.author);
  const updatedSections = [];

  if (args.appendContent !== undefined && String(args.appendContent).length > 20000) {
    throw new Error("appendContent is too long (max 20000 characters)");
  }
  if ((args.appendSection && !args.appendContent) || (!args.appendSection && args.appendContent)) {
    throw new Error("appendSection and appendContent must be provided together");
  }

  if (args.quickRecovery) {
    markdown = upsertMarkdownSection(
      markdown,
      RECOVERY_SECTION_HEADING,
      buildQuickRecoveryMarkdown(bookId, args.title, args.author, args.quickRecovery, now)
    );
    updatedSections.push(RECOVERY_SECTION_HEADING);
  }

  if (args.currentUnderstanding !== undefined) {
    markdown = upsertMarkdownSection(markdown, "当前理解", args.currentUnderstanding);
    updatedSections.push("当前理解");
  }

  if (args.nextEntry !== undefined) {
    markdown = upsertMarkdownSection(markdown, "下次入口", args.nextEntry);
    updatedSections.push("下次入口");
  }

  let appended = {
    section: "",
    heading: "",
  };
  if (args.appendSection && args.appendContent) {
    const heading = args.appendHeading || `${now} · ${bookId}`;
    const entry = `### ${heading}\n\n${String(args.appendContent).trim()}`;
    markdown = appendMarkdownSection(markdown, args.appendSection, entry);
    appended = {
      section: args.appendSection,
      heading,
    };
    updatedSections.push(args.appendSection);
  }

  atomicWriteFile(notePath, markdown);

  return {
    ok: true,
    bookId,
    notePath: normalizePath(notePath),
    created: !noteExists,
    updatedSections,
    appended,
  };
}

function createToolResult(payload) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2),
      },
    ],
    structuredContent: payload,
  };
}

function createToolError(error) {
  const payload = {
    ok: false,
    ...(typeof error.code === "string" ? { code: error.code } : {}),
    error: error.message || String(error),
    exitCode: error.exitCode ?? null,
    stdout: error.stdout || "",
    stderr: error.stderr || "",
  };

  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2),
      },
    ],
    structuredContent: payload,
  };
}

function invalidArgs(message) {
  const error = new Error(message);
  error.code = "invalid_args";
  return error;
}

function normalizeSearchScope(args) {
  const hasBookId = Boolean(args.bookId);
  const hasAll = args.all === true;
  const allWasProvided = Object.prototype.hasOwnProperty.call(args, "all");

  if (hasBookId && hasAll) {
    throw invalidArgs("bookId and all cannot be used together");
  }

  if (!hasBookId && allWasProvided && !hasAll) {
    throw invalidArgs("all must be true when bookId is omitted");
  }

  if (!hasBookId && !allWasProvided) {
    return { ...args, all: true };
  }

  return args;
}

async function main() {
  const server = new McpServer({
    name: "co-reading-kit",
    version: "0.1.0",
  });

  server.registerTool("reading_search", {
    description: "Search reading chunks by keyword. Omit bookId and all to search all books.",
    inputSchema: {
      bookId: z.string().trim().min(1).optional(),
      all: z.boolean().optional().describe("Set true for all books; defaults to true when bookId and all are omitted."),
      query: z.string().trim().min(1),
      limit: z.number().int().positive().optional(),
      maxPreview: z.number().int().min(80).optional(),
      includeText: z.boolean().optional(),
      stateDir: z.string().optional(),
    },
  }, async (args) => {
    try {
      const normalizedArgs = normalizeSearchScope(args);
      const result = await readingSearch({
        ...normalizedArgs,
        limit: normalizedArgs.limit ?? DEFAULT_SEARCH_LIMIT,
        maxPreview: normalizedArgs.maxPreview ?? DEFAULT_SEARCH_PREVIEW,
        includeText: Boolean(normalizedArgs.includeText),
      }, false);
      return createToolResult(result);
    } catch (error) {
      return createToolError(error);
    }
  });

  server.registerTool("reading_search_exact", {
    description: "Search by exact phrase. Omit bookId and all to search all books.",
    inputSchema: {
      bookId: z.string().trim().min(1).optional(),
      all: z.boolean().optional().describe("Set true for all books; defaults to true when bookId and all are omitted."),
      query: z.string().trim().min(1),
      limit: z.number().int().positive().optional(),
      maxPreview: z.number().int().min(80).optional(),
      includeText: z.boolean().optional(),
      stateDir: z.string().optional(),
    },
  }, async (args) => {
    try {
      const normalizedArgs = normalizeSearchScope(args);
      const result = await readingSearch({
        ...normalizedArgs,
        limit: normalizedArgs.limit ?? DEFAULT_SEARCH_LIMIT,
        maxPreview: normalizedArgs.maxPreview ?? DEFAULT_SEARCH_PREVIEW,
        includeText: Boolean(normalizedArgs.includeText),
      }, true);
      return createToolResult(result);
    } catch (error) {
      return createToolError(error);
    }
  });

  server.registerTool("reading_get_chunk", {
    description: "Read exactly one chunk from a book by chunkId or path.",
    inputSchema: {
      bookId: z.string(),
      chunkId: z.string().optional(),
      path: z.string().optional(),
      stateDir: z.string().optional(),
    },
  }, async (args) => {
    try {
      return createToolResult(readingGetChunk(args));
    } catch (error) {
      return createToolError(error);
    }
  });

  server.registerTool("reading_get_progress", {
    description: "Read reading progress for one book or all books.",
    inputSchema: {
      bookId: z.string().optional(),
      stateDir: z.string().optional(),
    },
  }, async (args) => {
    try {
      return createToolResult(readingGetProgress(args));
    } catch (error) {
      return createToolError(error);
    }
  });

  server.registerTool("reading_build_index", {
    description: "Build reading search index for one book or all books.",
    inputSchema: {
      bookId: z.string().optional(),
      all: z.boolean().optional(),
      stateDir: z.string().optional(),
    },
  }, async (args) => {
    try {
      if (!args.bookId && !args.all) {
        throw new Error("bookId and all must be exactly one of the two");
      }
      if (args.bookId && args.all) {
        throw new Error("bookId and all must be exactly one of the two");
      }

      return createToolResult(await readingBuildIndex(args));
    } catch (error) {
      return createToolError(error);
    }
  });

  server.registerTool("reading_update_progress", {
    description: "Update reading/progress.json for a book.",
    inputSchema: {
      bookId: z.string(),
      title: z.string().optional(),
      lastChunkId: z.string().optional(),
      nextChunkId: z.string().optional(),
      lastPath: z.string().optional(),
      nextPath: z.string().optional(),
      lastSectionTitle: z.string().optional(),
      lastReadAt: z.string().optional(),
      notePath: z.string().optional(),
      currentThemes: z.array(z.string()).optional(),
      status: z.string().optional(),
      stateDir: z.string().optional(),
    },
  }, async (args) => {
    try {
      return createToolResult(readingUpdateProgress(args));
    } catch (error) {
      return createToolError(error);
    }
  });

  server.registerTool("reading_update_note", {
    description: "Update long-term reading notes for a book.",
    inputSchema: {
      bookId: z.string(),
      title: z.string().optional(),
      author: z.string().optional(),
      quickRecovery: z.record(z.string(), z.any()).optional(),
      currentUnderstanding: z.string().optional(),
      nextEntry: z.string().optional(),
      appendSection: z.enum(NOTE_APPEND_SECTIONS).optional(),
      appendHeading: z.string().optional(),
      appendContent: z.string().optional(),
      timestamp: z.string().optional(),
      stateDir: z.string().optional(),
    },
  }, async (args) => {
    try {
      return createToolResult(readingUpdateNote(args));
    } catch (error) {
      return createToolError(error);
    }
  });

  server.registerTool("reading_read_note", {
    description: "Safely read fixed sections from reading notes for a book.",
    inputSchema: {
      bookId: z.string(),
      sections: z.array(z.enum(NOTE_SECTION_HEADINGS)).optional(),
      includeFull: z.boolean().optional(),
      maxChars: z.number().int().positive().optional(),
      stateDir: z.string().optional(),
    },
  }, async (args) => {
    try {
      const stateDir = resolveStateDir(args.stateDir);
      return createToolResult(readNoteFile(args.bookId, stateDir, {
        sections: args.sections,
        includeFull: Boolean(args.includeFull),
        maxChars: args.maxChars ?? DEFAULT_NOTE_MAX_CHARS,
      }));
    } catch (error) {
      return createToolError(error);
    }
  });

  server.registerTool("reading_resume_book", {
    description: "Resume reading by returning progress, recovery note sections, and one chunk.",
    inputSchema: {
      bookId: z.string().optional(),
      readChunk: z.boolean().optional(),
      chunkId: z.string().optional(),
      stateDir: z.string().optional(),
    },
  }, async (args) => {
    try {
      return createToolResult(resumeBook({
        ...args,
        readChunk: args.readChunk !== false,
      }));
    } catch (error) {
      return createToolError(error);
    }
  });

  server.registerTool("reading_import_book", {
    description: "Import a local epub/txt/md file into the reading library.",
    inputSchema: {
      input: z.string(),
      title: z.string().optional(),
      author: z.string().optional(),
      bookId: z.string().optional(),
      maxChars: z.number().int().positive().optional(),
      minChars: z.number().int().positive().optional(),
      stateDir: z.string().optional(),
      buildIndex: z.boolean().optional(),
    },
  }, async (args) => {
    try {
      return createToolResult(await readingImportBook({
        ...args,
        buildIndex: Boolean(args.buildIndex),
      }));
    } catch (error) {
      return createToolError(error);
    }
  });

  server.registerTool("reading_get_manifest", {
    description: "Read one book manifest.json without loading original text or chunk bodies.",
    inputSchema: {
      bookId: z.string(),
      stateDir: z.string().optional(),
      includeChunks: z.boolean().optional(),
      includeChunkPreview: z.boolean().optional(),
      maxChunks: z.number().int().positive().max(MAX_MANIFEST_MAX_CHUNKS).optional(),
      includeRaw: z.boolean().optional(),
    },
  }, async (args) => {
    try {
      return createToolResult(readingGetManifest({
        ...args,
        includeChunks: args.includeChunks !== false,
        includeChunkPreview: args.includeChunkPreview !== false,
        maxChunks: args.maxChunks ?? DEFAULT_MANIFEST_MAX_CHUNKS,
        includeRaw: Boolean(args.includeRaw),
      }));
    } catch (error) {
      return createToolError(error);
    }
  });

  server.registerTool("reading_list_books", {
    description: "List imported local books from the reading library.",
    inputSchema: {
      stateDir: z.string().optional(),
      includeProgress: z.boolean().optional(),
      includeIndexStatus: z.boolean().optional(),
      includeStats: z.boolean().optional(),
    },
  }, async (args) => {
    try {
      return createToolResult(readingListBooks({
        ...args,
        includeProgress: args.includeProgress !== false,
        includeIndexStatus: args.includeIndexStatus !== false,
        includeStats: args.includeStats !== false,
      }));
    } catch (error) {
      return createToolError(error);
    }
  });

  server.registerTool("reading_link_weread_book", {
    description: "Link a WeRead book to a local imported book using reading/book-map.json.",
    inputSchema: {
      wereadTitle: z.string().optional(),
      wereadBookId: z.string().optional(),
      wereadAuthor: z.string().optional(),
      localBookId: z.string().optional(),
      confirm: z.boolean().optional(),
      listPending: z.boolean().optional(),
      stateDir: z.string().optional(),
    },
  }, async (args) => {
    try {
      return createToolResult(await readingLinkWereadBook({
        ...args,
        confirm: Boolean(args.confirm),
        listPending: Boolean(args.listPending),
      }));
    } catch (error) {
      return createToolError(error);
    }
  });

  server.registerTool("reading_find_weread_context", {
    description: "Resolve a WeRead highlight to a local chunk by exact search and optionally read one chunk.",
    inputSchema: {
      markText: z.string(),
      wereadTitle: z.string().optional(),
      wereadBookId: z.string().optional(),
      localBookId: z.string().optional(),
      includeChunk: z.boolean().optional(),
      limit: z.number().int().positive().optional(),
      maxPreview: z.number().int().min(80).optional(),
      stateDir: z.string().optional(),
    },
  }, async (args) => {
    try {
      return createToolResult(await readingFindWereadContext({
        ...args,
        includeChunk: args.includeChunk !== false,
        limit: args.limit ?? DEFAULT_WEREAD_CONTEXT_LIMIT,
        maxPreview: args.maxPreview ?? DEFAULT_WEREAD_CONTEXT_PREVIEW,
      }));
    } catch (error) {
      return createToolError(error);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});

module.exports = {
  resolveProjectRoot,
  resolveStateDir,
  normalizePath,
  runNodeScript,
  readJsonFile,
  safeJoin,
  atomicWriteFile,
  upsertMarkdownSection,
  appendMarkdownSection,
  extractMarkdownSection,
  extractMarkdownSections,
  readNoteFile,
  resumeBook,
  readingImportBook,
  readingGetManifest,
  readingListBooks,
  readingLinkWereadBook,
  readingFindWereadContext,
};
