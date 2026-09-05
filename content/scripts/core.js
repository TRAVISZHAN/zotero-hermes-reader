var HermesReaderCore = (() => {
  const DRAFT_OPEN = "<HERMES_OBSIDIAN_DRAFT>";
  const DRAFT_CLOSE = "</HERMES_OBSIDIAN_DRAFT>";
  const CONTEXT_MARKER = "[ZOTERO_READER_CONTEXT]";
  const QUESTION_MARKER = "[USER_QUESTION]";

  function text(value) {
    return value === null || value === undefined ? "" : String(value);
  }

  function compact(value) {
    return text(value).replace(/\s+/g, " ").trim();
  }

  function normalizeGatewayURL(value) {
    let raw = text(value).trim();
    if (!raw) return "";
    if (!/^[a-z][a-z\d+.-]*:\/\//i.test(raw)) raw = `http://${raw}`;
    let parsed;
    try {
      parsed = new URL(raw);
    } catch (_) {
      throw new Error("Hermes 地址格式无效，请填写 http(s)://host:port。");
    }
    if (!["http:", "https:", "ws:", "wss:"].includes(parsed.protocol)) {
      throw new Error("Hermes 地址只支持 http(s) 或 ws(s)。");
    }
    if (parsed.username || parsed.password) {
      throw new Error("Hermes 地址不能包含用户名或密码。");
    }
    parsed.hash = "";
    parsed.search = "";
    const pathname = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/, "");
    const protocol = parsed.protocol.replace(/^ws/, "http");
    return `${protocol}//${parsed.host}${pathname}`;
  }

  /**
   * WebSocket base for a gateway address, with no trailing slash.
   *
   * `new URL("http://host:8644").pathname` is "/", not "", so appending
   * "/api/ws" to a naively rebuilt base yields "//api/ws" — which the relay
   * routes to its catch-all HTTP proxy instead of the WebSocket handler and
   * answers with 404.
   */
  function gatewayWebSocketURL(value) {
    const parsed = new URL(normalizeGatewayURL(value));
    const protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
    const path = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/, "");
    return `${protocol}//${parsed.host}${path}`;
  }

  function parseInjectedToken(html) {
    const match = /window\.__HERMES_SESSION_TOKEN__\s*=\s*("(?:\\.|[^"\\])*")/.exec(text(html));
    if (!match) return "";
    try {
      const token = JSON.parse(match[1]);
      return typeof token === "string" ? token : "";
    } catch (_) {
      return "";
    }
  }

  function servePortsFromLedger(ledger) {
    const entries = Array.isArray(ledger)
      ? ledger
      : ledger && typeof ledger === "object"
        ? Object.values(ledger)
        : [];
    const ports = [];
    for (const entry of entries) {
      if (!entry || entry.purpose !== "serve") continue;
      const port = Number(entry.port);
      if (Number.isInteger(port) && port > 0 && port < 65536 && !ports.includes(port)) {
        ports.push(port);
      }
    }
    return ports.reverse();
  }

  function parsePosition(value) {
    if (!value) return {};
    if (typeof value === "object") return value;
    if (typeof value !== "string") return {};
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (_) {
      return {};
    }
  }

  function selectionFromParams(params = {}) {
    const annotation = params.annotation || {};
    const position = parsePosition(annotation.position || params.position);
    const selectedText = text(params.text || annotation.text).trim();
    const rawPageIndex = params.pageIndex ?? annotation.pageIndex ?? position.pageIndex;
    const pageIndex = Number.isInteger(Number(rawPageIndex)) ? Number(rawPageIndex) : null;
    const pageLabel = compact(params.pageLabel || annotation.pageLabel || position.pageLabel);
    return {
      text: selectedText,
      pageIndex,
      pageLabel,
      page: pageLabel || (pageIndex === null ? "待核对" : String(pageIndex + 1)),
    };
  }

  /**
   * Physics papers routinely carry 30+ creators, which pushed the panel header
   * past the message list. The full list stays available as a tooltip.
   */
  function shortAuthors(value, keep = 2) {
    const names = text(value).split(",").map((name) => name.trim()).filter(Boolean);
    if (!names.length) return "";
    if (names.length <= keep) return names.join(", ");
    return `${names.slice(0, keep).join(", ")} 等 ${names.length} 人`;
  }

  function zoteroLink(paper) {
    return `zotero://select/library/items/${paper.key}`;
  }

  function sessionKey(paper) {
    return `${paper.libraryID}:${paper.key}`;
  }

  /**
   * Matches a `session.list` entry to a paper. `source` is set by the plugin at
   * creation; `preview` is the head of the first message, which always begins
   * with the context block, so it carries `itemKey: <key>`. Titles are not
   * usable here because Hermes rewrites them.
   */
  function sessionBelongsToPaper(entry, paper) {
    if (!entry || !paper) return false;
    if (text(entry.source) !== "zotero") return false;
    const haystack = `${text(entry.preview)}\n${text(entry.title)}`;
    return new RegExp(`itemKey:\\s*${paper.key}\\b`).test(haystack)
      || haystack.includes(`Zotero · ${paper.key} ·`);
  }

  function sessionLabel(entry, now = Date.now()) {
    const title = compact(entry?.title) || "未命名对话";
    const count = Number(entry?.message_count);
    const started = Number(entry?.started_at);
    const parts = [title.slice(0, 40)];
    if (Number.isFinite(started) && started > 0) {
      const days = Math.floor((now - started * 1000) / 86400000);
      parts.push(days <= 0 ? "今天" : days === 1 ? "昨天" : `${days} 天前`);
    }
    if (Number.isInteger(count) && count > 0) parts.push(`${count} 条`);
    return parts.join(" · ");
  }

  function pdfFileLines(paper) {
    const files = Array.isArray(paper.pdfFiles) ? paper.pdfFiles.filter((file) => file?.path) : [];
    if (!files.length) {
      return [`PDF attachment keys: ${(paper.pdfKeys || []).join(", ") || "未知"}`];
    }
    const lines = [];
    files.forEach((file, index) => {
      const label = files.length > 1 ? ` ${index + 1}` : "";
      lines.push(`PDF${label} attachment key: ${file.key}`);
      lines.push(`PDF${label} file: ${file.path}`);
      if (file.relativePath) {
        lines.push(`PDF${label} file (relative to the Zotero data directory): ${file.relativePath}`);
      }
    });
    return lines;
  }

  function paperContext(paper, selection) {
    const lines = [
      CONTEXT_MARKER,
      `libraryID: ${paper.libraryID}`,
      `itemKey: ${paper.key}`,
      `title: ${paper.title || "未命名条目"}`,
      `authors: ${paper.authors || "未知"}`,
      `year: ${paper.year || "未知"}`,
      `DOI: ${paper.doi || "无"}`,
      ...pdfFileLines(paper),
      `Zotero link: ${zoteroLink(paper)}`,
    ];
    if (selection?.text) {
      lines.push(
        "",
        "PDF selection:",
        `page: ${selection.page || "待核对"}`,
        "verbatim:",
        selection.text,
      );
    }
    return lines.join("\n");
  }

  function evidenceRules() {
    return [
      "Use the Zotero MCP item and its PDF as the primary source.",
      // Tool results stay in the conversation, so a re-fetch buys nothing and
      // costs a round trip. Every turn re-sends these rules, which otherwise
      // reads as a standing instruction to go fetch the paper again.
      "Reuse what this conversation already contains. If the full text or a page has already been read here, work from it — do not fetch it again. Only read something new when this conversation does not already answer it.",
      // Both the Zotero full-text index and Hermes' own document extraction
      // return a flat text blob with no page boundaries, so a page number can
      // only come from a per-page read of the file itself.
      "The PDF file path above is on the machine Hermes runs on. When you need a page number you have not already established in this conversation, read that page with `pdftotext -f N -l N <path>` (poppler) rather than estimating it from a position in the full text.",
      "If the absolute path does not exist, resolve the relative path against the local Zotero data directory before giving up.",
      "For paper results, numerical values, and experimental parameters, include PDF page plus section, figure, table, or equation locators when available.",
      "Mark any locator you could not verify as 待核对. Never invent a page or locator.",
      "Distinguish the paper's result, the authors' interpretation, and your synthesis.",
      "Answer in Chinese unless I explicitly ask for another language.",
    ].join("\n");
  }

  function draftContract(paper) {
    return [
      "This is a draft-only request. Do not write to Obsidian or any file yet.",
      "Return the readable answer first, then append exactly one valid JSON object between the tags below.",
      DRAFT_OPEN,
      JSON.stringify({
        note_title: "建议的论文笔记标题",
        note_path: "可选；建议的 vault 内相对路径",
        proposed_content: "拟追加的 Markdown 原文",
        evidence: [{ quote: "原文依据", page: "PDF 页码", locator: "图/表/公式/章节号或待核对" }],
        zotero_link: zoteroLink(paper),
      }),
      DRAFT_CLOSE,
      "The proposed Markdown must include the Zotero link and put a locator on every factual conclusion.",
    ].join("\n");
  }

  function writeContract(draft, exactContent) {
    return [
      "The user explicitly confirmed the Obsidian write in the Zotero panel.",
      "Write only the exact Markdown below. Use the configured Obsidian vault and append safely without replacing unrelated user-authored content.",
      `Target note title: ${draft.note_title || "由现有论文笔记规则确定"}`,
      `Suggested relative path: ${draft.note_path || "未指定"}`,
      "Exact confirmed Markdown:",
      exactContent,
      "After writing, report the exact note path and summarize what was appended. If the target cannot be resolved safely, do not guess; report the blocker without writing.",
    ].join("\n");
  }

  function buildPrompt({ paper, question, selection = null, mode = "answer", draft = null, exactContent = "" }) {
    const parts = [paperContext(paper, selection), "", evidenceRules(), ""];
    if (mode === "obsidian-draft") parts.push(draftContract(paper), "");
    if (mode === "obsidian-write") parts.push(writeContract(draft || {}, exactContent), "");
    parts.push(QUESTION_MARKER, text(question).trim());
    return parts.join("\n");
  }

  function stripCodeFence(value) {
    return text(value).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  }

  function normalizeEvidence(value) {
    if (!Array.isArray(value)) return [];
    return value.map((entry) => ({
      quote: text(entry?.quote).trim(),
      page: text(entry?.page).trim() || "待核对",
      locator: text(entry?.locator).trim() || "待核对",
    })).filter((entry) => entry.quote || entry.page !== "待核对" || entry.locator !== "待核对");
  }

  function parseObsidianDraft(answer) {
    const source = text(answer);
    const start = source.indexOf(DRAFT_OPEN);
    const end = source.indexOf(DRAFT_CLOSE, start + DRAFT_OPEN.length);
    if (start < 0 || end < 0) return { displayText: source.trim(), draft: null };
    const raw = stripCodeFence(source.slice(start + DRAFT_OPEN.length, end));
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (_) {
      return { displayText: source.trim(), draft: null };
    }
    if (!parsed || typeof parsed !== "object" || !text(parsed.proposed_content).trim()) {
      return { displayText: source.trim(), draft: null };
    }
    const displayText = `${source.slice(0, start)}${source.slice(end + DRAFT_CLOSE.length)}`.trim();
    return {
      displayText,
      draft: {
        note_title: text(parsed.note_title).trim(),
        note_path: text(parsed.note_path).trim(),
        proposed_content: text(parsed.proposed_content).trim(),
        evidence: normalizeEvidence(parsed.evidence),
        zotero_link: text(parsed.zotero_link).trim(),
      },
    };
  }

  function displayUserMessage(value) {
    const source = text(value);
    const marker = source.lastIndexOf(QUESTION_MARKER);
    if (marker >= 0) return source.slice(marker + QUESTION_MARKER.length).trim();
    return source.trim();
  }

  function messageText(content) {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return text(content);
    return content.map((part) => {
      if (typeof part === "string") return part;
      return text(part?.text || part?.content);
    }).filter(Boolean).join("\n");
  }

  /**
   * `session.resume` returns history rows as `{role, text, timestamp, row_id}`.
   * Reading only `content` silently yielded "" for every row, so the filter
   * below dropped the whole history and the panel always came back empty.
   * `content` stays supported for other/older shapes.
   */
  function historyMessageText(message) {
    if (!message || typeof message !== "object") return text(message);
    if (typeof message.text === "string") return message.text;
    if (message.content !== undefined && message.content !== null) return messageText(message.content);
    return messageText(message.text);
  }

  function visibleHistory(messages) {
    if (!Array.isArray(messages)) return [];
    return messages.map((message) => ({
      role: message?.role,
      text: historyMessageText(message),
    })).filter((message) => {
      return (message.role === "user" || message.role === "assistant") && message.text.trim();
    }).map((message) => ({
      role: message.role,
      text: message.role === "user" ? displayUserMessage(message.text) : message.text.trim(),
    })).slice(-40);
  }

  return {
    CONTEXT_MARKER,
    DRAFT_CLOSE,
    DRAFT_OPEN,
    QUESTION_MARKER,
    buildPrompt,
    compact,
    displayUserMessage,
    gatewayWebSocketURL,
    normalizeGatewayURL,
    parseInjectedToken,
    parseObsidianDraft,
    selectionFromParams,
    servePortsFromLedger,
    sessionBelongsToPaper,
    sessionKey,
    sessionLabel,
    shortAuthors,
    text,
    visibleHistory,
    zoteroLink,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = HermesReaderCore;
}
