var HermesReadingAssistantZ9 = (() => {
  const HTML_NS = "http://www.w3.org/1999/xhtml";
  const PREF_ROOT = "extensions.hermes-reading-assistant.";
  const PREF_SESSIONS = `${PREF_ROOT}sessions`;
  const PREF_LAST_PORT = `${PREF_ROOT}lastGatewayPort`;
  const PREF_ENDPOINT = `${PREF_ROOT}gatewayEndpoint`;
  const PREF_ENDPOINT_TOKEN = `${PREF_ROOT}gatewayEndpointToken`;
  const FTL_FILE = "hermes-reading-assistant.ftl";

  const config = {
    addonID: "hermes-reading-assistant-z9@altail.local",
    paneID: "hermes-reading-assistant-z9-pane",
    prefPaneID: "hermes-reading-assistant-z9-prefpane",
    prefPaneRegistered: false,
    rootURI: "",
    sectionKey: null,
    styleNodes: new WeakMap(),
    controllers: new Set(),
    controllersByPaper: new Map(),
    pendingSelections: new Map(),
    liveSessions: new Map(),
    sessionPromises: new Map(),
  };

  function log(message) {
    Zotero.debug(`[Hermes Reading Assistant Z9] ${message}`);
  }

  function reportError(error) {
    Zotero.logError(error instanceof Error ? error : new Error(String(error)));
  }

  function prefString(name, fallback = "") {
    try { return Services.prefs.getStringPref(name, fallback); } catch (_) { return fallback; }
  }

  function configuredGateway() {
    const value = prefString(PREF_ENDPOINT).trim();
    if (!value) return null;
    return {
      url: HermesReaderCore.normalizeGatewayURL(value),
      token: prefString(PREF_ENDPOINT_TOKEN).trim(),
    };
  }

  function saveConfiguredGateway(url, token = "") {
    Services.prefs.setStringPref(PREF_ENDPOINT, HermesReaderCore.normalizeGatewayURL(url));
    Services.prefs.setStringPref(PREF_ENDPOINT_TOKEN, HermesReaderCore.text(token).trim());
  }

  function clearConfiguredGateway() {
    Services.prefs.setStringPref(PREF_ENDPOINT, "");
    Services.prefs.setStringPref(PREF_ENDPOINT_TOKEN, "");
  }

  function h(doc, tag, className = "", content = "") {
    const node = doc.createElementNS(HTML_NS, tag);
    if (className) node.className = className;
    if (content !== "") node.textContent = content;
    return node;
  }

  function button(doc, label, className = "") {
    const node = h(doc, "button", className, label);
    node.type = "button";
    return node;
  }

  /**
   * Resolves a PDF attachment to what Hermes needs in order to open the file
   * itself. `path` is only meaningful on the machine that owns this Zotero
   * profile, so the storage-relative form travels alongside it: after sync both
   * machines share the attachment key and filename, but not necessarily the
   * same data directory.
   */
  function pdfFileFromAttachment(attachment) {
    let path = "";
    try { path = HermesReaderCore.text(attachment.getFilePath()); } catch (error) { reportError(error); }
    return {
      key: attachment.key,
      path,
      relativePath: path ? `storage/${attachment.key}/${PathUtils.filename(path)}` : "",
    };
  }

  function paperFromItem(item) {
    if (!item) return null;
    let parent = item;
    if (item.isAttachment?.()) {
      parent = item.parentItemID ? Zotero.Items.get(item.parentItemID) : null;
    } else if (item.isAnnotation?.()) {
      const attachment = item.parentItemID ? Zotero.Items.get(item.parentItemID) : null;
      parent = attachment?.parentItemID ? Zotero.Items.get(attachment.parentItemID) : null;
    }
    if (!parent?.isRegularItem?.()) return null;
    const authors = parent.getCreators().map((creator) => {
      return [creator.firstName, creator.lastName].filter(Boolean).join(" ") || creator.name || "";
    }).filter(Boolean).join(", ");
    const date = HermesReaderCore.text(parent.getField("date"));
    const pdfFiles = parent.getAttachments().map((id) => Zotero.Items.get(id)).filter((attachment) => {
      return attachment?.isPDFAttachment?.();
    }).map((attachment) => pdfFileFromAttachment(attachment));
    const paper = {
      key: parent.key,
      libraryID: parent.libraryID,
      title: HermesReaderCore.text(parent.getField("title")),
      authors,
      year: (date.match(/\d{4}/) || [""])[0],
      doi: HermesReaderCore.text(parent.getField("DOI")),
      pdfFiles,
      pdfKeys: pdfFiles.map((file) => file.key),
    };
    paper.sessionKey = HermesReaderCore.sessionKey(paper);
    paper.zoteroLink = HermesReaderCore.zoteroLink(paper);
    return paper;
  }

  function paperFromReader(reader) {
    const attachmentID = reader?.itemID || reader?._itemID;
    return paperFromItem(attachmentID ? Zotero.Items.get(attachmentID) : null);
  }

  function readSessionStore() {
    try {
      const parsed = JSON.parse(Services.prefs.getStringPref(PREF_SESSIONS, "{}"));
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (_) {
      return {};
    }
  }

  function writeSessionBinding(paper, storedSessionID) {
    const store = readSessionStore();
    store[paper.sessionKey] = {
      storedSessionID,
      title: paper.title,
      zoteroLink: paper.zoteroLink,
      updatedAt: new Date().toISOString(),
    };
    Services.prefs.setStringPref(PREF_SESSIONS, JSON.stringify(store));
  }

  function deleteSessionBinding(paper) {
    const store = readSessionStore();
    if (!(paper.sessionKey in store)) return;
    delete store[paper.sessionKey];
    Services.prefs.setStringPref(PREF_SESSIONS, JSON.stringify(store));
  }

  class GatewayError extends Error {
    constructor(message, code = null, data = null) {
      super(message);
      this.name = "GatewayError";
      this.code = code;
      this.data = data;
    }
  }

  class HermesGateway {
    constructor() {
      this.socket = null;
      this.connectPromise = null;
      this.port = null;
      this.baseURL = "";
      this.wsURL = "";
      this.endpointLabel = "";
      this.requestID = 0;
      this.pending = new Map();
      this.turns = new Map();
      this.heartbeatTimer = null;
      this.connectionListeners = new Set();
    }

    get connected() {
      return this.socket?.readyState === 1;
    }

    onConnection(listener) {
      this.connectionListeners.add(listener);
      return () => this.connectionListeners.delete(listener);
    }

    notifyConnection(state, detail = "") {
      for (const listener of this.connectionListeners) {
        try { listener(state, detail, this.port); } catch (error) { reportError(error); }
      }
    }

    async candidatePorts() {
      const ports = [];
      const add = (value) => {
        const port = Number(value);
        if (Number.isInteger(port) && port > 0 && port < 65536 && !ports.includes(port)) ports.push(port);
      };
      add(Services.prefs.getIntPref(PREF_LAST_PORT, 0));
      try {
        const home = Services.dirsvc.get("Home", Ci.nsIFile).path;
        const ledger = await IOUtils.readJSON(PathUtils.join(home, ".hermes", "spawn-ledger.json"));
        for (const port of HermesReaderCore.servePortsFromLedger(ledger)) add(port);
      } catch (error) {
        log(`spawn ledger unavailable: ${error.message || error}`);
      }
      add(8642);
      return ports;
    }

    async endpoint() {
      const configured = configuredGateway();
      if (configured) {
        const parsed = new URL(configured.url);
        const baseURL = configured.url;
        let token = configured.token;
        if (!token) {
          const response = await Zotero.HTTP.request("GET", `${baseURL}/`, {
            responseType: "text",
            timeout: 4000,
            noCache: true,
          });
          const html = response.responseText || response.response || "";
          token = HermesReaderCore.parseInjectedToken(html);
        }
        if (!token) {
          throw new Error("远程 Hermes 没有提供连接令牌。请确认地址指向 Hermes Desktop 转发端口，或在设置中填写令牌。");
        }
        return {
          baseURL,
          wsURL: HermesReaderCore.gatewayWebSocketURL(configured.url),
          token,
          label: parsed.host,
        };
      }
      const ports = await this.candidatePorts();
      for (const port of ports) {
        try {
          const response = await Zotero.HTTP.request("GET", `http://127.0.0.1:${port}/`, {
            responseType: "text",
            timeout: 1800,
            noCache: true,
          });
          const html = response.responseText || response.response || "";
          const token = HermesReaderCore.parseInjectedToken(html);
          if (!token) continue;
          Services.prefs.setIntPref(PREF_LAST_PORT, port);
          return {
            baseURL: `http://127.0.0.1:${port}`,
            wsURL: `ws://127.0.0.1:${port}`,
            port,
            token,
            label: `本机 · ${port}`,
          };
        } catch (_) {}
      }
      throw new Error("未发现 Hermes。请启动 Hermes Desktop，或在设置中填写局域网/Tailscale 地址。");
    }

    async connect(force = false) {
      if (force) this.close("reconnect");
      if (this.connected) return;
      if (this.connectPromise) return this.connectPromise;
      this.notifyConnection("connecting", "正在连接 Hermes");
      this.connectPromise = this.open().finally(() => {
        this.connectPromise = null;
      });
      return this.connectPromise;
    }

    async open() {
      const { port, token, baseURL, wsURL, label } = await this.endpoint();
      const window = Zotero.getMainWindow();
      if (!window?.WebSocket) throw new Error("当前 Zotero 窗口不提供 WebSocket。");
      const socket = new window.WebSocket(`${wsURL}/api/ws?token=${encodeURIComponent(token)}`);
      this.socket = socket;
      this.port = port;
      this.baseURL = baseURL;
      this.wsURL = wsURL;
      this.endpointLabel = label || wsURL;
      socket.onmessage = (event) => this.handleFrame(event.data);
      try {
        await new Promise((resolve, reject) => {
          let settled = false;
          const settle = (callback, value) => {
            if (settled) return;
            settled = true;
            window.clearTimeout(timer);
            callback(value);
          };
          const timer = window.setTimeout(() => {
            settle(reject, new Error("连接 Hermes 超时。"));
          }, 10000);
          socket.onopen = () => settle(resolve);
          socket.onerror = () => settle(reject, new Error(`无法连接 Hermes（${label || wsURL}）。`));
          socket.onclose = () => settle(reject, new Error(`Hermes 连接已关闭（${label || wsURL}）。`));
        });
      } catch (error) {
        if (this.socket === socket) this.socket = null;
        try { socket.close(); } catch (_) {}
        throw error;
      }
      socket.onerror = () => {
        if (this.socket === socket) this.notifyConnection("error", "Hermes 连接异常");
      };
      socket.onclose = () => {
        if (this.socket === socket) this.handleClose("Hermes 连接已断开");
      };
      this.startHeartbeat(window);
      this.notifyConnection("connected", "Hermes 已连接");
      log(`connected to Hermes on ${this.endpointLabel}`);
    }

    startHeartbeat(window) {
      if (this.heartbeatTimer) window.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = window.setInterval(() => {
        if (!this.connected) return;
        try {
          this.socket.send(JSON.stringify({
            jsonrpc: "2.0",
            id: `heartbeat-${Date.now()}`,
            method: "gateway.ping",
            params: {},
          }));
        } catch (_) {}
      }, 15000);
    }

    handleFrame(raw) {
      let frame;
      try { frame = JSON.parse(String(raw)); } catch (_) { return; }
      if (frame.id !== undefined && frame.id !== null) {
        const pending = this.pending.get(frame.id);
        if (!pending) return;
        this.pending.delete(frame.id);
        pending.window.clearTimeout(pending.timer);
        if (frame.error) {
          pending.reject(new GatewayError(frame.error.message || "Hermes RPC 失败", frame.error.code, frame.error.data));
        } else {
          pending.resolve(frame.result);
        }
        return;
      }
      if (frame.method !== "event" || !frame.params?.type) return;
      this.handleEvent(frame.params);
    }

    handleEvent(event) {
      const turn = this.turns.get(event.session_id);
      if (!turn) return;
      const payload = event.payload || {};
      try {
        if (event.type === "message.delta") {
          turn.text += HermesReaderCore.text(payload.text);
          turn.hooks.onDelta?.(HermesReaderCore.text(payload.text), turn.text);
        } else if (event.type === "reasoning.delta" || event.type === "thinking.delta") {
          turn.hooks.onStatus?.("Hermes 正在分析");
        } else if (event.type === "tool.start" || event.type === "tool.progress") {
          const toolName = payload.name || payload.tool_name || payload.tool || "文献工具";
          turn.hooks.onStatus?.(`正在使用 ${toolName}`);
        } else if (event.type === "approval.request") {
          turn.hooks.onApproval?.(payload, (choice) => this.request("approval.respond", {
            session_id: event.session_id,
            request_id: payload.request_id,
            choice,
          }, 30000));
        } else if (event.type === "clarify.request") {
          turn.hooks.onClarify?.(payload, (answer) => this.request("clarify.respond", {
            request_id: payload.request_id,
            answer,
          }, 30000));
        } else if (event.type === "message.complete") {
          const finalText = HermesReaderCore.text(payload.text) || turn.text;
          if (payload.status === "error" || payload.error) {
            this.finishTurn(event.session_id, new Error(payload.error || finalText || "Hermes 请求失败"));
          } else {
            this.finishTurn(event.session_id, null, finalText);
          }
        } else if (event.type === "error") {
          this.finishTurn(event.session_id, new Error(payload.message || "Hermes 请求失败"));
        }
      } catch (error) {
        this.finishTurn(event.session_id, error);
      }
    }

    finishTurn(sessionID, error = null, value = "") {
      const turn = this.turns.get(sessionID);
      if (!turn) return;
      this.turns.delete(sessionID);
      turn.window.clearTimeout(turn.timer);
      if (error) turn.reject(error);
      else turn.resolve(value);
    }

    request(method, params = {}, timeout = 120000) {
      if (!this.connected) return Promise.reject(new Error("Hermes 尚未连接。"));
      const id = `zotero-${++this.requestID}`;
      const window = Zotero.getMainWindow();
      return new Promise((resolve, reject) => {
        const timer = window.setTimeout(() => {
          if (!this.pending.delete(id)) return;
          reject(new Error(`Hermes 请求超时：${method}`));
        }, timeout);
        this.pending.set(id, { resolve, reject, timer, window });
        try {
          this.socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
        } catch (error) {
          this.pending.delete(id);
          window.clearTimeout(timer);
          reject(error);
        }
      });
    }

    async runTurn(sessionID, prompt, hooks = {}) {
      if (this.turns.has(sessionID)) throw new Error("这篇论文已有一条 Hermes 回复正在生成。");
      const window = Zotero.getMainWindow();
      const resultPromise = new Promise((resolve, reject) => {
        const timer = window.setTimeout(() => {
          this.finishTurn(sessionID, new Error("Hermes 生成超过 15 分钟，已停止等待。"));
        }, 15 * 60 * 1000);
        this.turns.set(sessionID, { hooks, reject, resolve, text: "", timer, window });
      });
      try {
        await this.request("prompt.submit", { session_id: sessionID, text: prompt }, 30000);
      } catch (error) {
        this.finishTurn(sessionID, error);
      }
      return resultPromise;
    }

    async interrupt(sessionID) {
      if (!sessionID || !this.turns.has(sessionID)) return;
      await this.request("session.interrupt", { session_id: sessionID }, 30000);
    }

    handleClose(message) {
      const window = Zotero.getMainWindow();
      if (this.heartbeatTimer && window) window.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
      this.socket = null;
      config.liveSessions.clear();
      config.sessionPromises.clear();
      for (const [id, pending] of this.pending) {
        pending.window.clearTimeout(pending.timer);
        pending.reject(new Error(message));
        this.pending.delete(id);
      }
      for (const sessionID of Array.from(this.turns.keys())) {
        this.finishTurn(sessionID, new Error(message));
      }
      this.notifyConnection("disconnected", message);
    }

    close(reason = "插件已停止") {
      const socket = this.socket;
      this.socket = null;
      if (socket) {
        socket.onclose = null;
        socket.onerror = null;
        socket.onmessage = null;
        try { socket.close(); } catch (_) {}
      }
      this.handleClose(reason);
    }
  }

  const gateway = new HermesGateway();

  /**
   * Every conversation for a paper, straight from the server.
   *
   * Zotero prefs are per-profile, so a binding stored on one machine is
   * invisible to the other. `session.list` is the shared index instead: the
   * plugin tags sessions with `source: "zotero"`, and the first message always
   * starts with the context block, so `itemKey: <key>` shows up in `preview`.
   * Titles are not usable for this — Hermes rewrites them automatically.
   */
  async function listPaperSessions(paper) {
    await gateway.connect();
    const response = await gateway.request("session.list", {}, 30000);
    const sessions = Array.isArray(response?.sessions) ? response.sessions : [];
    return sessions
      .filter((entry) => HermesReaderCore.sessionBelongsToPaper(entry, paper))
      .sort((a, b) => (b.started_at || 0) - (a.started_at || 0));
  }

  async function createPaperSession(paper) {
    return gateway.request("session.create", {
      cols: 100,
      source: "zotero",
      title: `Zotero · ${paper.key} · ${paper.title}`.slice(0, 180),
    }, 120000);
  }

  async function resumePaperSession(paper, sessionID) {
    const response = await gateway.request("session.resume", { session_id: sessionID, cols: 100 }, 120000);
    const session = {
      liveID: response.session_id,
      storedID: response.stored_session_id || sessionID,
      messages: response.messages || [],
    };
    if (!session.liveID) throw new Error("Hermes 没有返回会话 ID。");
    config.liveSessions.set(paper.sessionKey, session);
    writeSessionBinding(paper, session.storedID);
    return session;
  }

  async function ensurePaperSession(paper, forceNew = false) {
    if (!forceNew && config.liveSessions.has(paper.sessionKey) && gateway.connected) {
      return config.liveSessions.get(paper.sessionKey);
    }
    if (!forceNew && config.sessionPromises.has(paper.sessionKey)) {
      return config.sessionPromises.get(paper.sessionKey);
    }
    const promise = (async () => {
      await gateway.connect();
      const stored = forceNew ? null : readSessionStore()[paper.sessionKey]?.storedSessionID;
      let response;
      if (stored) {
        try {
          response = await gateway.request("session.resume", { session_id: stored, cols: 100 }, 120000);
        } catch (error) {
          if (error.code !== 4007) throw error;
          deleteSessionBinding(paper);
        }
      }
      if (!response) {
        response = await gateway.request("session.create", {
          cols: 100,
          source: "zotero",
          title: `Zotero · ${paper.key} · ${paper.title}`.slice(0, 180),
        }, 120000);
      }
      const session = {
        liveID: response.session_id,
        storedID: response.stored_session_id || stored || response.session_id,
        messages: response.messages || [],
      };
      if (!session.liveID) throw new Error("Hermes 没有返回会话 ID。");
      config.liveSessions.set(paper.sessionKey, session);
      writeSessionBinding(paper, session.storedID);
      return session;
    })().finally(() => config.sessionPromises.delete(paper.sessionKey));
    config.sessionPromises.set(paper.sessionKey, promise);
    return promise;
  }

  function registerController(controller) {
    config.controllers.add(controller);
    let bucket = config.controllersByPaper.get(controller.paper.sessionKey);
    if (!bucket) {
      bucket = new Set();
      config.controllersByPaper.set(controller.paper.sessionKey, bucket);
    }
    bucket.add(controller);
  }

  function unregisterController(controller) {
    config.controllers.delete(controller);
    const bucket = config.controllersByPaper.get(controller.paper.sessionKey);
    bucket?.delete(controller);
    if (bucket?.size === 0) config.controllersByPaper.delete(controller.paper.sessionKey);
  }

  /**
   * Renders LaTeX to MathML and imports it as real nodes.
   *
   * `output: "mathml"` keeps this dependency cheap: Gecko draws MathML with its
   * own fonts, so no KaTeX stylesheet or webfont has to ship with the plugin.
   * The model's LaTeX never reaches the DOM as markup — KaTeX parses it and we
   * import only the resulting <math> element from an inert document.
   */
  function appendMath(doc, parent, tex, displayMode) {
    const source = HermesReaderCore.text(tex).trim();
    if (!source) return false;
    try {
      const html = katex.renderToString(source, {
        displayMode,
        output: "mathml",
        strict: "ignore",
        throwOnError: true,
      });
      const parsed = new doc.defaultView.DOMParser().parseFromString(html, "text/html");
      const math = parsed.querySelector("math");
      if (!math) return false;
      const wrapper = h(doc, displayMode ? "div" : "span", `hermes-reader-z9-math${displayMode ? " is-display" : ""}`);
      wrapper.appendChild(doc.importNode(math, true));
      wrapper.title = source;
      parent.appendChild(wrapper);
      return true;
    } catch (error) {
      // Malformed or unsupported LaTeX: show the source rather than nothing.
      log(`math render failed: ${error.message || error}`);
      return false;
    }
  }

  function appendMarkdownInline(doc, parent, value) {
    const source = HermesReaderCore.text(value);
    // Inline math comes first: `^`, `_` and `*` inside LaTeX must not be
    // consumed by the emphasis rules below.
    const tokenPattern = /(\\\([\s\S]*?\\\)|`+[^`\n]*`+|!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|\*\*([^*\n]+)\*\*|__([^_\n]+)__|~~([^~\n]+)~~|\*([^*\n]+)\*|_([^_\n]+)_|<((?:https?:\/\/)[^>\s]+)>)/g;
    let cursor = 0;
    const appendPlain = (plain) => {
      const pieces = HermesReaderCore.text(plain).split("\n");
      pieces.forEach((piece, index) => {
        if (index) parent.appendChild(doc.createElementNS(HTML_NS, "br"));
        if (piece) parent.appendChild(doc.createTextNode(piece));
      });
    };
    let match;
    while ((match = tokenPattern.exec(source))) {
      appendPlain(source.slice(cursor, match.index));
      const token = match[0];
      if (token.startsWith("\\(")) {
        const tex = token.slice(2, -2);
        if (!appendMath(doc, parent, tex, false)) {
          parent.appendChild(h(doc, "code", "hermes-reader-z9-inline-code", tex.trim()));
        }
      } else if (token.startsWith("`")) {
        const code = token.replace(/^`+|`+$/g, "");
        parent.appendChild(h(doc, "code", "hermes-reader-z9-inline-code", code));
      } else if (token.startsWith("![")) {
        // Images are deliberately rendered as a label. Remote images in model
        // output should never be fetched implicitly from an untrusted source.
        parent.appendChild(h(doc, "span", "hermes-reader-z9-image-label", `[图片：${match[2] || "未命名"}]`));
      } else if (token.startsWith("[")) {
        const href = safeMarkdownURL(match[5]);
        if (!href) appendPlain(match[4]);
        else {
          const link = h(doc, "a", "hermes-reader-z9-link", match[4]);
          link.href = href;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          parent.appendChild(link);
        }
      } else if (token.startsWith("<")) {
        const href = safeMarkdownURL(match[11]);
        if (!href) appendPlain(token);
        else {
          const link = h(doc, "a", "hermes-reader-z9-link", href);
          link.href = href;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          parent.appendChild(link);
        }
      } else if (token.startsWith("**") || token.startsWith("__")) {
        const strong = h(doc, "strong");
        appendMarkdownInline(doc, strong, token.slice(2, -2));
        parent.appendChild(strong);
      } else if (token.startsWith("~~")) {
        const del = h(doc, "del");
        appendMarkdownInline(doc, del, token.slice(2, -2));
        parent.appendChild(del);
      } else {
        const emphasis = h(doc, "em");
        appendMarkdownInline(doc, emphasis, token.slice(1, -1));
        parent.appendChild(emphasis);
      }
      cursor = tokenPattern.lastIndex;
    }
    appendPlain(source.slice(cursor));
  }

  function safeMarkdownURL(value) {
    const raw = HermesReaderCore.text(value).trim();
    try {
      const parsed = new URL(raw);
      return ["http:", "https:", "zotero:"].includes(parsed.protocol) ? parsed.href : "";
    } catch (_) {
      return "";
    }
  }

  function renderMarkdown(doc, container, value) {
    container.replaceChildren();
    const lines = HermesReaderCore.text(value).replace(/\r/g, "").split("\n");
    let index = 0;
    const isBlockStart = (line) => {
      return /^\s{0,3}\\\[/.test(line)
        || /^\s{0,3}(#{1,6})\s+/.test(line)
        || /^\s{0,3}(```|~~~)/.test(line)
        || /^\s{0,3}>/.test(line)
        || /^\s{0,3}(?:[-+*]|\d+[.)])\s+/.test(line)
        || /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line);
    };
    const isTableRow = (line) => /^\s*\|?.+\|.+\|?\s*$/.test(line);
    const isTableDivider = (line) => /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
    const tableCells = (line) => {
      const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
      return trimmed.split("|").map((cell) => cell.trim());
    };
    while (index < lines.length) {
      const line = lines[index];
      if (!line.trim()) { index += 1; continue; }
      // Display math: `\[` may sit on its own line with the body following.
      if (/^\s{0,3}\\\[/.test(line)) {
        const mathLines = [line.replace(/^\s{0,3}\\\[/, "")];
        let closed = /\\\]\s*$/.test(line.trim().slice(2));
        index += 1;
        while (!closed && index < lines.length) {
          mathLines.push(lines[index]);
          closed = /\\\]/.test(lines[index]);
          index += 1;
        }
        const tex = mathLines.join("\n").replace(/\\\]\s*$/, "").trim();
        if (!appendMath(doc, container, tex, true)) {
          const pre = h(doc, "pre", "hermes-reader-z9-code-block");
          pre.appendChild(h(doc, "code", "", tex));
          container.appendChild(pre);
        }
        continue;
      }
      const fence = /^\s{0,3}(```|~~~)\s*([^\s]*)\s*$/.exec(line);
      if (fence) {
        const marker = fence[1];
        const codeLines = [];
        index += 1;
        while (index < lines.length && !new RegExp(`^\\s{0,3}${marker}`).test(lines[index])) {
          codeLines.push(lines[index]);
          index += 1;
        }
        if (index < lines.length) index += 1;
        const pre = h(doc, "pre", "hermes-reader-z9-code-block");
        const code = h(doc, "code");
        code.textContent = codeLines.join("\n");
        if (fence[2]) code.dataset.language = fence[2];
        pre.appendChild(code);
        container.appendChild(pre);
        continue;
      }
      const heading = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
      if (heading) {
        const node = h(doc, `h${heading[1].length}`, "hermes-reader-z9-markdown-heading");
        appendMarkdownInline(doc, node, heading[2]);
        container.appendChild(node);
        index += 1;
        continue;
      }
      if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
        container.appendChild(h(doc, "hr", "hermes-reader-z9-markdown-rule"));
        index += 1;
        continue;
      }
      if (/^\s{0,3}>/.test(line)) {
        const quoteLines = [];
        while (index < lines.length && /^\s{0,3}>/.test(lines[index])) {
          quoteLines.push(lines[index].replace(/^\s{0,3}>\s?/, ""));
          index += 1;
        }
        const blockquote = h(doc, "blockquote", "hermes-reader-z9-markdown-quote");
        appendMarkdownInline(doc, blockquote, quoteLines.join("\n"));
        container.appendChild(blockquote);
        continue;
      }
      const listMatch = /^\s{0,3}(?:(\d+)[.)]|[-+*])\s+(.+)$/.exec(line);
      if (listMatch) {
        const ordered = Boolean(listMatch[1]);
        const list = h(doc, ordered ? "ol" : "ul", "hermes-reader-z9-markdown-list");
        while (index < lines.length) {
          const itemMatch = /^\s{0,3}(?:(\d+)[.)]|[-+*])\s+(.+)$/.exec(lines[index]);
          if (!itemMatch || Boolean(itemMatch[1]) !== ordered) break;
          const item = h(doc, "li");
          appendMarkdownInline(doc, item, itemMatch[2]);
          list.appendChild(item);
          index += 1;
        }
        container.appendChild(list);
        continue;
      }
      if (index + 1 < lines.length && isTableRow(line) && isTableDivider(lines[index + 1])) {
        const table = h(doc, "table", "hermes-reader-z9-markdown-table");
        const header = h(doc, "thead");
        const headerRow = h(doc, "tr");
        for (const cellValue of tableCells(line)) {
          const cell = h(doc, "th");
          appendMarkdownInline(doc, cell, cellValue);
          headerRow.appendChild(cell);
        }
        header.appendChild(headerRow);
        table.appendChild(header);
        index += 2;
        const body = h(doc, "tbody");
        while (index < lines.length && isTableRow(lines[index])) {
          const row = h(doc, "tr");
          for (const cellValue of tableCells(lines[index])) {
            const cell = h(doc, "td");
            appendMarkdownInline(doc, cell, cellValue);
            row.appendChild(cell);
          }
          body.appendChild(row);
          index += 1;
        }
        table.appendChild(body);
        container.appendChild(table);
        continue;
      }
      const paragraphLines = [line];
      index += 1;
      while (index < lines.length && lines[index].trim() && !isBlockStart(lines[index])) {
        paragraphLines.push(lines[index]);
        index += 1;
      }
      const paragraph = h(doc, "p", "hermes-reader-z9-markdown-paragraph");
      appendMarkdownInline(doc, paragraph, paragraphLines.join("\n"));
      container.appendChild(paragraph);
    }
  }

  class ChatController {
    constructor(body, paper) {
      this.body = body;
      this.doc = body.ownerDocument;
      this.paper = paper;
      this.session = null;
      this.selection = config.pendingSelections.get(paper.sessionKey) || null;
      this.busy = false;
      this.destroyed = false;
      this.unlistenGateway = gateway.onConnection((state, detail) => {
        if (this.destroyed) return;
        if (state === "connected") this.setConnection(`已连接 · ${gateway.endpointLabel || "Hermes"}`);
        else if (state === "connecting") this.setConnection("连接中");
        else this.setConnection(detail || "未连接", true);
      });
      registerController(this);
      this.render();
      this.load().catch((error) => this.showLoadError(error));
    }

    destroy() {
      this.destroyed = true;
      this.widthObserver?.disconnect();
      this.widthObserver = null;
      this.unlistenGateway?.();
      unregisterController(this);
    }

    render() {
      this.body.replaceChildren();
      const root = h(this.doc, "section", "hermes-reader-z9");
      const head = h(this.doc, "header", "hermes-reader-z9-paper");
      const headText = h(this.doc, "div", "hermes-reader-z9-paper-text");
      const titleNode = h(this.doc, "div", "hermes-reader-z9-title", this.paper.title || "未命名条目");
      titleNode.title = this.paper.title || "";
      const metaNode = h(
        this.doc,
        "div",
        "hermes-reader-z9-meta",
        [HermesReaderCore.shortAuthors(this.paper.authors), this.paper.year].filter(Boolean).join(" · "),
      );
      // The panel is narrow; keep the full list in the tooltip instead.
      metaNode.title = [this.paper.authors, this.paper.year].filter(Boolean).join(" · ");
      headText.append(titleNode, metaNode);
      this.connectionNode = h(this.doc, "span", "hermes-reader-z9-connection", "连接中");
      const headTools = h(this.doc, "div", "hermes-reader-z9-head-tools");
      this.reconnectButton = button(this.doc, "↻", "hermes-reader-z9-icon-button");
      this.reconnectButton.title = "重新连接 Hermes";
      this.reconnectButton.setAttribute("aria-label", "重新连接 Hermes");
      this.reconnectButton.addEventListener("click", () => this.reloadConnection());
      this.settingsButton = button(this.doc, "⚙", "hermes-reader-z9-icon-button hermes-reader-z9-settings-button");
      this.settingsButton.title = "在 Zotero 设置中打开 Hermes 连接";
      this.settingsButton.setAttribute("aria-label", "在 Zotero 设置中打开 Hermes 连接");
      this.settingsButton.addEventListener("click", () => {
        try {
          openConnectionSettings();
        } catch (error) {
          this.setStatus(error.message || error, true);
        }
      });
      headTools.append(this.connectionNode, this.reconnectButton, this.settingsButton);
      head.append(headText, headTools);

      // Conversation picker. The list comes from the server, so both machines
      // see the same conversations for a paper; prefs only remember which one
      // was last open here.
      const sessionRow = h(this.doc, "div", "hermes-reader-z9-session-row");
      this.sessionSelect = h(this.doc, "select", "hermes-reader-z9-session-select");
      this.sessionSelect.title = "本文的对话";
      this.sessionSelect.addEventListener("change", () => {
        const id = this.sessionSelect.value;
        if (id) this.switchSession(id).catch((error) => this.showLoadError(error));
      });
      this.newSessionButton = button(this.doc, "＋", "hermes-reader-z9-icon-button");
      this.newSessionButton.title = "为本文新建一个对话";
      this.newSessionButton.setAttribute("aria-label", "为本文新建一个对话");
      this.newSessionButton.addEventListener("click", () => {
        this.switchSession(null).catch((error) => this.showLoadError(error));
      });
      this.obsidianButton = button(this.doc, "❖", "hermes-reader-z9-icon-button");
      this.obsidianButton.title = "生成 Obsidian 草稿（需确认后才写入）";
      this.obsidianButton.setAttribute("aria-label", "生成 Obsidian 草稿");
      this.obsidianButton.addEventListener("click", () => {
        this.ask(
          "请基于当前论文、本会话中已经核实的结论以及当前 PDF 选区，拟一段可追加到论文笔记的 Markdown。",
          { mode: "obsidian-draft", displayText: "写入 Obsidian" },
        ).catch(reportError);
      });
      sessionRow.append(this.sessionSelect, this.newSessionButton, this.obsidianButton);

      this.selectionNode = h(this.doc, "div", "hermes-reader-z9-selection");
      this.selectionNode.hidden = true;
      const selectionHead = h(this.doc, "div", "hermes-reader-z9-selection-head");
      this.selectionPage = h(this.doc, "span", "hermes-reader-z9-page", "PDF");
      const clearSelection = button(this.doc, "×", "hermes-reader-z9-icon-button");
      clearSelection.title = "移除 PDF 选区";
      clearSelection.setAttribute("aria-label", "移除 PDF 选区");
      clearSelection.addEventListener("click", () => this.setSelection(null));
      selectionHead.append(this.selectionPage, clearSelection);
      this.selectionQuote = h(this.doc, "blockquote", "hermes-reader-z9-quote");
      this.selectionNode.append(selectionHead, this.selectionQuote);

      this.messages = h(this.doc, "div", "hermes-reader-z9-messages");
      this.messages.setAttribute("role", "log");
      this.messages.setAttribute("aria-live", "polite");
      this.empty = h(this.doc, "div", "hermes-reader-z9-empty", "本文尚无对话");
      this.messages.appendChild(this.empty);

      const statusRow = h(this.doc, "div", "hermes-reader-z9-status-row");
      this.status = h(this.doc, "span", "hermes-reader-z9-status", "正在恢复会话");
      this.stop = button(this.doc, "■", "hermes-reader-z9-stop");
      this.stop.title = "停止生成";
      this.stop.setAttribute("aria-label", "停止生成");
      this.stop.hidden = true;
      this.stop.addEventListener("click", () => gateway.interrupt(this.session?.liveID).catch((error) => this.setStatus(error.message, true)));
      statusRow.append(this.status, this.stop);

      const composer = h(this.doc, "div", "hermes-reader-z9-composer");
      this.input = h(this.doc, "textarea", "hermes-reader-z9-input");
      this.input.placeholder = "问当前论文…（回车发送，Shift+回车换行）";
      this.input.rows = 3;
      this.input.addEventListener("keydown", (event) => {
        if (event.key !== "Enter") return;
        // Shift+Enter inserts a newline; IME composition must not be cut off.
        if (event.shiftKey || event.isComposing || event.keyCode === 229) return;
        event.preventDefault();
        this.submit();
      });
      composer.append(this.input);

      root.append(head, sessionRow, this.selectionNode, this.messages, statusRow, composer);
      this.body.appendChild(root);
      this.widthObserver?.disconnect();
      this.widthObserver = observePanelWidth(root);
      if (this.selection) this.setSelection(this.selection);
    }

    resetMessages() {
      this.messages.replaceChildren();
      this.empty = h(this.doc, "div", "hermes-reader-z9-empty", "本文尚无对话");
      this.messages.appendChild(this.empty);
    }

    prepareForReconnect() {
      this.session = null;
      this.resetMessages();
      this.setConnection("连接中");
      this.setStatus("正在连接 Hermes");
    }

    reloadConnection() {
      this.prepareForReconnect();
      gateway.connect(true).then(() => this.load()).catch((error) => this.showLoadError(error));
    }

    renderHistory() {
      const history = HermesReaderCore.visibleHistory(this.session?.messages);
      if (!history.length) return;
      this.empty?.remove();
      for (const message of history) {
        const parsed = message.role === "assistant" ? HermesReaderCore.parseObsidianDraft(message.text) : null;
        this.appendMessage(message.role, parsed ? (parsed.displayText || "已生成 Obsidian 草稿") : message.text, null, message.role === "assistant");
        if (parsed?.draft) this.appendDraft(parsed.draft, true);
      }
    }

    /**
     * Refreshes the picker from the server. Failing here must not break the
     * panel — the active conversation still works without a list.
     */
    async refreshSessionList() {
      if (!this.sessionSelect) return;
      let entries = [];
      try {
        entries = await listPaperSessions(this.paper);
      } catch (error) {
        log(`session list unavailable: ${error.message || error}`);
      }
      if (this.destroyed || !this.sessionSelect.isConnected) return;
      const activeID = this.session?.storedID || "";
      if (activeID && !entries.some((entry) => entry.id === activeID)) {
        entries = [{ id: activeID, title: "当前对话", source: "zotero" }, ...entries];
      }
      this.sessionSelect.replaceChildren();
      for (const entry of entries) {
        const option = this.doc.createElementNS(HTML_NS, "option");
        option.value = entry.id;
        option.textContent = HermesReaderCore.sessionLabel(entry);
        this.sessionSelect.appendChild(option);
      }
      this.sessionSelect.value = activeID;
      this.sessionSelect.hidden = entries.length === 0;
    }

    /** `null` starts a fresh conversation for this paper. */
    async switchSession(sessionID) {
      if (this.busy) {
        this.setStatus("正在生成，请先停止再切换对话", true);
        return;
      }
      this.resetMessages();
      this.setStatus(sessionID ? "正在载入对话" : "正在新建对话");
      config.liveSessions.delete(this.paper.sessionKey);
      this.session = sessionID
        ? await resumePaperSession(this.paper, sessionID)
        : await ensurePaperSession(this.paper, true);
      if (this.destroyed) return;
      this.renderHistory();
      await this.refreshSessionList();
      this.setStatus("就绪");
      this.input.focus();
    }

    async load() {
      this.session = await ensurePaperSession(this.paper);
      if (this.destroyed) return;
      this.setConnection(`已连接 · ${gateway.endpointLabel || "Hermes"}`);
      this.renderHistory();
      this.setStatus("就绪");
      // Non-blocking: the panel is usable before the list arrives.
      this.refreshSessionList().catch((error) => log(`session list failed: ${error.message || error}`));
    }

    showLoadError(error) {
      this.setConnection("未连接", true);
      this.setStatus(error.message || error, true);
      const retry = button(this.doc, "重试连接", "hermes-reader-z9-retry");
      retry.addEventListener("click", () => {
        retry.remove();
        gateway.connect(true).then(() => this.load()).catch((nextError) => this.showLoadError(nextError));
      });
      this.messages.appendChild(retry);
    }

    setConnection(value, error = false) {
      if (!this.connectionNode) return;
      this.connectionNode.textContent = value;
      this.connectionNode.classList.toggle("is-error", error);
    }

    setStatus(value, error = false) {
      this.status.textContent = HermesReaderCore.text(value);
      this.status.classList.toggle("is-error", error);
    }

    setBusy(value) {
      this.busy = value;
      this.input.disabled = value;
      this.stop.hidden = !value;
      if (this.obsidianButton) this.obsidianButton.disabled = value;
      if (this.newSessionButton) this.newSessionButton.disabled = value;
    }

    setSelection(selection) {
      this.selection = selection?.text ? selection : null;
      if (!this.selection) {
        this.selectionNode.hidden = true;
        config.pendingSelections.delete(this.paper.sessionKey);
        return;
      }
      config.pendingSelections.set(this.paper.sessionKey, this.selection);
      this.selectionNode.hidden = false;
      this.selectionPage.textContent = `PDF p. ${this.selection.page}`;
      this.selectionQuote.textContent = this.selection.text;
      this.input.focus();
    }

    setMessageContent(content, value, markdown = true) {
      if (markdown) renderMarkdown(this.doc, content, value);
      else content.textContent = HermesReaderCore.text(value);
    }

    appendMessage(role, value, selection = null, markdown = role === "assistant") {
      this.empty?.remove();
      const article = h(this.doc, "article", `hermes-reader-z9-message hermes-reader-z9-${role}`);
      const label = h(this.doc, "div", "hermes-reader-z9-message-label", role === "user" ? "你" : role === "assistant" ? "Hermes" : "错误");
      const content = h(this.doc, "div", "hermes-reader-z9-message-content");
      this.setMessageContent(content, value, markdown);
      article.append(label);
      if (selection?.text) {
        const quote = h(this.doc, "blockquote", "hermes-reader-z9-inline-quote", `p. ${selection.page} · ${selection.text}`);
        article.appendChild(quote);
      }
      article.appendChild(content);
      this.messages.appendChild(article);
      article.scrollIntoView({ block: "nearest" });
      return { article, content };
    }

    submit() {
      const question = this.input.value.trim();
      if (!question || this.busy) return;
      this.input.value = "";
      this.ask(question).catch(reportError);
    }

    async ask(question, options = {}) {
      const prompt = HermesReaderCore.text(question).trim();
      if (!prompt || this.busy) return false;
      const selection = options.includeSelection === false ? null : this.selection;
      if (options.includeSelection !== false) this.setSelection(null);
      this.setBusy(true);
      this.setStatus("正在发送");
      this.appendMessage("user", options.displayText || prompt, selection);
      const answer = this.appendMessage("assistant", "", null, true);
      answer.article.classList.add("is-streaming");
      try {
        this.session = await ensurePaperSession(this.paper);
        const wirePrompt = HermesReaderCore.buildPrompt({
          paper: this.paper,
          question: prompt,
          selection,
          mode: options.mode || "answer",
          draft: options.draft || null,
          exactContent: options.exactContent || "",
        });
        const finalText = await gateway.runTurn(this.session.liveID, wirePrompt, {
          onDelta: (delta) => {
            answer.content.dataset.rawMarkdown = `${answer.content.dataset.rawMarkdown || ""}${delta}`;
            this.setMessageContent(answer.content, answer.content.dataset.rawMarkdown, true);
            answer.article.scrollIntoView({ block: "nearest" });
          },
          onStatus: (status) => this.setStatus(status),
          onApproval: (payload, respond) => this.appendApproval(payload, respond),
          onClarify: (payload, respond) => this.appendClarification(payload, respond),
        });
        const parsed = HermesReaderCore.parseObsidianDraft(finalText);
        const displayText = parsed.displayText || (parsed.draft ? "已生成 Obsidian 草稿。" : finalText || "Hermes 没有返回正文。");
        answer.content.dataset.rawMarkdown = displayText;
        this.setMessageContent(answer.content, displayText, true);
        if (parsed.draft) {
          if (!parsed.draft.zotero_link) parsed.draft.zotero_link = this.paper.zoteroLink;
          this.appendDraft(parsed.draft, false);
        }
        this.setStatus("完成");
        // Message count and the auto-generated title both change after a turn.
        this.refreshSessionList().catch(() => {});
        return true;
      } catch (error) {
        answer.article.remove();
        this.appendMessage("error", error.message || error);
        this.setStatus("未完成", true);
        return false;
      } finally {
        answer.article.classList.remove("is-streaming");
        this.setBusy(false);
        this.input.focus();
      }
    }

    appendApproval(payload, respond) {
      const card = h(this.doc, "section", "hermes-reader-z9-request");
      card.appendChild(h(this.doc, "div", "hermes-reader-z9-request-title", "Hermes 请求执行操作"));
      const description = payload.command || payload.description || payload.message || payload.tool_name || "请检查 Hermes Desktop 中的操作详情";
      card.appendChild(h(this.doc, "pre", "hermes-reader-z9-request-command", HermesReaderCore.text(description)));
      const actions = h(this.doc, "div", "hermes-reader-z9-request-actions");
      const allow = button(this.doc, "允许一次", "hermes-reader-z9-confirm");
      const deny = button(this.doc, "拒绝", "hermes-reader-z9-secondary");
      const settle = async (choice) => {
        allow.disabled = true;
        deny.disabled = true;
        try {
          await respond(choice);
          card.classList.add("is-settled");
          actions.replaceChildren(h(this.doc, "span", "", choice === "once" ? "已允许" : "已拒绝"));
        } catch (error) {
          allow.disabled = false;
          deny.disabled = false;
          this.setStatus(error.message, true);
        }
      };
      allow.addEventListener("click", () => settle("once"));
      deny.addEventListener("click", () => settle("deny"));
      actions.append(allow, deny);
      card.appendChild(actions);
      this.messages.appendChild(card);
      card.scrollIntoView({ block: "nearest" });
    }

    appendClarification(payload, respond) {
      const card = h(this.doc, "section", "hermes-reader-z9-request");
      const question = payload.question || payload.message || payload.prompt || "Hermes 需要补充信息";
      card.appendChild(h(this.doc, "div", "hermes-reader-z9-request-title", HermesReaderCore.text(question)));
      const input = h(this.doc, "textarea", "hermes-reader-z9-request-input");
      input.rows = 2;
      const send = button(this.doc, "回复", "hermes-reader-z9-confirm");
      send.addEventListener("click", async () => {
        const value = input.value.trim();
        if (!value) return;
        send.disabled = true;
        try {
          await respond(value);
          card.classList.add("is-settled");
          card.replaceChildren(h(this.doc, "span", "", `已回复：${value}`));
        } catch (error) {
          send.disabled = false;
          this.setStatus(error.message, true);
        }
      });
      card.append(input, send);
      this.messages.appendChild(card);
      input.focus();
    }

    appendDraft(draft, restored) {
      draft = {
        ...draft,
        evidence: Array.isArray(draft.evidence) ? draft.evidence : [],
        zotero_link: this.paper.zoteroLink,
      };
      if (!draft.proposed_content.includes(this.paper.zoteroLink)) {
        draft.proposed_content = `${draft.proposed_content}\n\n来源：${this.paper.zoteroLink}`;
      }
      const card = h(this.doc, "section", "hermes-reader-z9-draft");
      const head = h(this.doc, "div", "hermes-reader-z9-draft-head");
      head.append(
        h(this.doc, "strong", "", "Obsidian 拟追加内容"),
        h(this.doc, "span", "hermes-reader-z9-draft-target", draft.note_path || draft.note_title || "论文笔记"),
      );
      const editor = h(this.doc, "textarea", "hermes-reader-z9-draft-editor");
      editor.value = draft.proposed_content;
      editor.rows = Math.min(14, Math.max(6, draft.proposed_content.split("\n").length + 1));
      const evidence = h(this.doc, "details", "hermes-reader-z9-evidence");
      const summary = h(this.doc, "summary", "", `原文依据 ${draft.evidence.length} 条`);
      evidence.appendChild(summary);
      if (draft.evidence.length) {
        for (const source of draft.evidence) {
          evidence.appendChild(h(this.doc, "blockquote", "", `[p. ${source.page} · ${source.locator}] ${source.quote}`));
        }
      } else {
        evidence.appendChild(h(this.doc, "p", "is-warning", "Hermes 未返回结构化原文依据，请确认内容后再写入。"));
      }
      const link = h(this.doc, "div", "hermes-reader-z9-zotero-link", draft.zotero_link || this.paper.zoteroLink);
      const actions = h(this.doc, "div", "hermes-reader-z9-draft-actions");
      const confirm = button(this.doc, "确认写入", "hermes-reader-z9-confirm");
      const dismiss = button(this.doc, "暂不写入", "hermes-reader-z9-secondary");
      confirm.addEventListener("click", async () => {
        const exactContent = editor.value.trim();
        if (!exactContent) {
          this.setStatus("拟追加内容为空，未写入", true);
          return;
        }
        if (!exactContent.includes(this.paper.zoteroLink)) {
          this.setStatus("请保留当前论文的 Zotero 来源链接", true);
          editor.focus();
          return;
        }
        confirm.disabled = true;
        dismiss.disabled = true;
        editor.disabled = true;
        card.classList.add("is-confirmed");
        const submitted = await this.ask("执行已经确认的 Obsidian 追加操作。", {
          mode: "obsidian-write",
          draft,
          exactContent,
          displayText: `确认写入 Obsidian：${draft.note_title || draft.note_path || "论文笔记"}`,
          includeSelection: false,
        });
        if (submitted) {
          actions.replaceChildren(h(this.doc, "span", "hermes-reader-z9-written", "已确认并提交"));
        } else {
          confirm.disabled = false;
          dismiss.disabled = false;
          editor.disabled = false;
          card.classList.remove("is-confirmed");
        }
      });
      dismiss.addEventListener("click", () => card.remove());
      actions.append(confirm, dismiss);
      if (restored) actions.appendChild(h(this.doc, "span", "hermes-reader-z9-restored", "历史草稿"));
      card.append(head, editor, evidence, link, actions);
      this.messages.appendChild(card);
      card.scrollIntoView({ block: "nearest" });
    }
  }

  function openConnectionSettings() {
    Zotero.Utilities.Internal.openPreferences(
      config.prefPaneRegistered ? config.prefPaneID : undefined
    );
  }

  /**
   * Applies the gateway settings saved in Zotero's settings window: one forced
   * reconnect for the shared gateway, then every open panel reloads its session.
   * Throws (without writing prefs) if the address is not a usable URL.
   *
   * @returns {Promise<string>} The normalized address, or "" for local discovery.
   */
  async function applyGatewaySettings(rawURL, token = "") {
    const trimmed = HermesReaderCore.text(rawURL).trim();
    const normalized = trimmed ? HermesReaderCore.normalizeGatewayURL(trimmed) : "";
    if (normalized) saveConfiguredGateway(normalized, token);
    else clearConfiguredGateway();

    config.liveSessions.clear();
    config.sessionPromises.clear();
    const controllers = Array.from(config.controllers);
    for (const controller of controllers) controller.prepareForReconnect();
    try {
      await gateway.connect(true);
    } catch (error) {
      for (const controller of controllers) controller.showLoadError(error);
      throw error;
    }
    for (const controller of controllers) {
      controller.load().catch((error) => controller.showLoadError(error));
    }
    return normalized;
  }

  function initPrefPane(container) {
    const find = (suffix) => container.querySelector(`#hermes-reading-assistant-z9-${suffix}`);
    const endpointInput = find("endpoint");
    const tokenInput = find("token");
    const statusNode = find("status");
    const saveButton = find("save");
    const clearButton = find("clear");
    if (!endpointInput || !tokenInput || !statusNode || !saveButton || !clearButton) {
      reportError(new Error("Hermes 设置面板缺少控件，prefs.xhtml 与 main.js 不一致。"));
      return;
    }

    const setStatus = (value, error = false) => {
      statusNode.textContent = HermesReaderCore.text(value);
      statusNode.style.color = error ? "var(--accent-red, #b42318)" : "var(--fill-secondary, #62666d)";
    };
    const describeConnection = () => {
      if (gateway.connected) return `已连接 · ${gateway.endpointLabel || "Hermes"}`;
      return prefString(PREF_ENDPOINT).trim() ? "未连接（已配置远程地址）" : "未连接（将自动发现本机 Hermes）";
    };

    endpointInput.value = prefString(PREF_ENDPOINT);
    tokenInput.value = prefString(PREF_ENDPOINT_TOKEN);
    setStatus(describeConnection());

    const unlisten = gateway.onConnection((state, detail) => {
      if (state === "connected") setStatus(`已连接 · ${gateway.endpointLabel || "Hermes"}`);
      else if (state === "connecting") setStatus("正在连接 Hermes");
      else setStatus(detail || describeConnection(), state === "error");
    });
    container.ownerGlobal.addEventListener("unload", unlisten, { once: true });

    const apply = async (url, token) => {
      saveButton.disabled = true;
      clearButton.disabled = true;
      setStatus("正在连接 Hermes");
      try {
        endpointInput.value = await applyGatewaySettings(url, token);
        tokenInput.value = prefString(PREF_ENDPOINT_TOKEN);
      } catch (error) {
        setStatus(error.message || error, true);
      } finally {
        saveButton.disabled = false;
        clearButton.disabled = false;
      }
    };

    saveButton.addEventListener("command", () => {
      apply(endpointInput.value, tokenInput.value).catch(reportError);
    });
    clearButton.addEventListener("command", () => {
      endpointInput.value = "";
      tokenInput.value = "";
      apply("", "").catch(reportError);
    });
  }

  async function registerPrefPane() {
    try {
      await Zotero.PreferencePanes.register({
        pluginID: config.addonID,
        id: config.prefPaneID,
        src: "content/prefs.xhtml",
        image: "content/icons/hermes-reader.svg",
        label: Zotero.locale?.startsWith("zh") ? "Hermes 阅读助手" : "Hermes Reading Assistant",
      });
      config.prefPaneRegistered = true;
      log(`registered preference pane ${config.prefPaneID}`);
    } catch (error) {
      // The item pane is the plugin's core surface; losing the settings pane
      // must not take the sidebar down with it.
      reportError(error);
    }
  }

  /**
   * The reader's context pane can lay the item pane out wider than the strip
   * the user actually sees: content then runs underneath item-pane-sidenav and
   * is clipped on the right. No CSS length can express "stop where the sidenav
   * starts", so measure that boundary and clamp the panel to it.
   */
  function clampPanelWidth(root) {
    if (!root.isConnected) return;
    root.style.maxWidth = "";
    let sidenav = null;
    for (let scope = root.parentElement; scope && !sidenav; scope = scope.parentElement) {
      sidenav = scope.querySelector?.("item-pane-sidenav") || null;
    }
    const navRect = sidenav?.getBoundingClientRect();
    if (!navRect?.width) return;
    const rootRect = root.getBoundingClientRect();
    const overflow = rootRect.right - navRect.left;
    if (overflow > 1) {
      root.style.maxWidth = `${Math.max(160, Math.floor(rootRect.width - overflow))}px`;
    }
  }

  function observePanelWidth(root) {
    const window = root.ownerDocument?.defaultView;
    const apply = () => {
      try { clampPanelWidth(root); } catch (error) { reportError(error); }
    };
    apply();
    if (!window?.ResizeObserver) return null;
    // Observe the scroll container, not the panel: clamping the panel would
    // otherwise re-trigger the observer and loop.
    const container = root.closest(".zotero-view-item") || root.parentElement;
    if (!container) return null;
    const observer = new window.ResizeObserver(apply);
    observer.observe(container);
    return observer;
  }

  const bodyControllers = new WeakMap();

  function render({ body, item, paneID }) {
    // `body` is Zotero's live `<div data-type="body">`; it is re-created every
    // time the section element reconnects, and Zotero always passes the current
    // one. Never cache it or try to look it up from the document.
    if (!body?.isConnected) {
      log(`skipped render because section body is not connected for ${paneID}`);
      return;
    }
    bodyControllers.get(body)?.destroy();
    const paper = paperFromItem(item);
    if (!paper) {
      body.replaceChildren(h(body.ownerDocument, "p", "hermes-reader-z9-unavailable", "请选择一篇文献或其 PDF。"));
      return;
    }
    const controller = new ChatController(body, paper);
    bodyControllers.set(body, controller);
  }

  function installWindowResources(window) {
    try { window.MozXULElement.insertFTLIfNeeded(FTL_FILE); } catch (error) { reportError(error); }
    if (config.styleNodes.has(window)) return;
    const style = window.document.createElementNS(HTML_NS, "link");
    style.rel = "stylesheet";
    style.href = config.rootURI + "content/hermes-reader.css";
    style.dataset.hermesReaderZ9Style = "true";
    window.document.documentElement.appendChild(style);
    config.styleNodes.set(window, style);
  }

  function notifySelectionStaged() {
    try {
      const progress = new Zotero.ProgressWindow({ closeOnClick: true });
      progress.changeHeadline("Hermes 阅读助手");
      progress.addDescription("PDF 选区已放入侧栏");
      progress.show();
      progress.startCloseTimer(1800);
    } catch (_) {}
  }

  function focusHermesPane(reader, paper, selection) {
    config.pendingSelections.set(paper.sessionKey, selection);
    const existing = config.controllersByPaper.get(paper.sessionKey);
    for (const controller of existing || []) controller.setSelection(selection);
    const window = Zotero.getMainWindow() || reader?._iframeWindow?.top;
    if (!window) return;
    const activate = () => {
      const doc = window.document;
      if (window.ZoteroContextPane?.collapsed) window.ZoteroContextPane.collapsed = false;
      const escapedKey = window.CSS?.escape
        ? window.CSS.escape(config.sectionKey)
        : String(config.sectionKey).replace(/["\\]/g, "\\$&");
      const selector = `.btn[data-pane="${escapedKey}"]`;
      const matchingButtons = Array.from(doc.querySelectorAll(selector));
      const target = matchingButtons.find((node) => !node.closest("[hidden]")) || matchingButtons[0];
      target?.click();
      const controllers = config.controllersByPaper.get(paper.sessionKey);
      for (const controller of controllers || []) controller.setSelection(selection);
    };
    activate();
    window.setTimeout(activate, 250);
    notifySelectionStaged();
  }

  function registerReaderHandlers() {
    Zotero.Reader.registerEventListener("renderTextSelectionPopup", (event) => {
      const selection = HermesReaderCore.selectionFromParams(event.params);
      const paper = paperFromReader(event.reader);
      if (!paper || !selection.text) return;
      const askButton = event.doc.createElementNS(HTML_NS, "button");
      askButton.type = "button";
      askButton.className = "toolbar-button hermes-reader-z9-selection-button";
      askButton.textContent = "问 Hermes";
      askButton.title = "把当前 PDF 选区放入 Hermes 侧栏";
      askButton.addEventListener("click", () => focusHermesPane(event.reader, paper, selection));
      event.append(askButton);
    }, config.addonID);

    Zotero.Reader.registerEventListener("createAnnotationContextMenu", (event) => {
      const paper = paperFromReader(event.reader);
      const ids = Array.isArray(event.params?.ids) ? event.params.ids : [];
      if (!paper || ids.length !== 1) return;
      const attachmentID = event.reader?.itemID || event.reader?._itemID;
      const attachment = attachmentID ? Zotero.Items.get(attachmentID) : null;
      let annotation = null;
      try { annotation = Zotero.Items.get(ids[0]); } catch (_) {}
      if (!annotation && attachment) {
        annotation = Zotero.Items.getByLibraryAndKey(attachment.libraryID, ids[0]);
      }
      if (!annotation?.isAnnotation?.() || !annotation.annotationText) return;
      event.append({
        label: "问 Hermes（此高亮）",
        onCommand: () => focusHermesPane(event.reader, paper, {
          text: annotation.annotationText,
          page: annotation.annotationPageLabel || "待核对",
          pageLabel: annotation.annotationPageLabel || "",
          pageIndex: null,
        }),
      });
    }, config.addonID);
  }

  async function start({ id, rootURI }) {
    config.addonID = id;
    config.rootURI = rootURI;
    await Zotero.uiReadyPromise;
    for (const window of Zotero.getMainWindows()) installWindowResources(window);
    config.sectionKey = Zotero.ItemPaneManager.registerSection({
      paneID: config.paneID,
      pluginID: config.addonID,
      header: {
        l10nID: "hermes-reading-assistant-section-header",
        icon: "chrome://hermes-reading-assistant-z9/content/icons/hermes-reader.svg",
      },
      sidenav: {
        l10nID: "hermes-reading-assistant-sidenav",
        icon: "chrome://hermes-reading-assistant-z9/content/icons/hermes-reader.svg",
        orderable: true,
      },
      onItemChange: ({ item, setEnabled, setSectionSummary }) => {
        const paper = paperFromItem(item);
        setEnabled(!!paper);
        setSectionSummary(paper ? "Hermes" : "");
      },
      onRender: render,
      onDestroy: ({ body }) => {
        bodyControllers.get(body)?.destroy();
        bodyControllers.delete(body);
      },
    });
    if (!config.sectionKey) throw new Error("无法注册 Hermes 阅读助手侧栏区块。");
    registerReaderHandlers();
    await registerPrefPane();
    log(`registered ${config.sectionKey}`);
  }

  function onMainWindowLoad(window) {
    installWindowResources(window);
  }

  function onMainWindowUnload(window) {
    config.styleNodes.get(window)?.remove();
    config.styleNodes.delete(window);
  }

  function shutdown() {
    for (const controller of Array.from(config.controllers)) controller.destroy();
    gateway.close();
    if (config.sectionKey) {
      Zotero.ItemPaneManager.unregisterSection(config.sectionKey);
      config.sectionKey = null;
    }
    if (config.prefPaneRegistered) {
      try { Zotero.PreferencePanes.unregister(config.prefPaneID); } catch (error) { reportError(error); }
      config.prefPaneRegistered = false;
    }
    for (const window of Zotero.getMainWindows()) onMainWindowUnload(window);
  }

  return { initPrefPane, onMainWindowLoad, onMainWindowUnload, shutdown, start };
})();
