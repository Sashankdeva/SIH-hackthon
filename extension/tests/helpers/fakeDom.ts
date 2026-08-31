/**
 * A minimal stand-in for the browser globals the extension touches, so
 * the real pipeline / validator / executor / verifier can be exercised
 * in `node --test` without a headless browser.
 *
 * The point of these tests is to count SIDE EFFECTS — how many times a
 * button was actually clicked, how many input events a field actually
 * received. Stubbing at the executor boundary instead would only prove
 * that a mock was called the expected number of times, which is exactly
 * the assumption that was wrong before. So the fakes sit at the DOM
 * edge and everything above them is production code.
 */

export class FakeElement {
  tagName: string;
  attributes: Record<string, string>;
  textContent: string | null;
  value = "";
  clickCount = 0;
  focusCount = 0;
  dispatched: string[] = [];

  /**
   * When true, clicking this element removes it from the parent
   * elements list — simulates a modal close, list-item delete, or
   * SPA re-render where the clicked element leaves the DOM.
   */
  onClickRemove = false;
  /** Set by installFakeDom so click() can remove itself from the list. */
  _parentList: FakeElement[] | null = null;

  constructor(tagName: string, attributes: Record<string, string> = {}, textContent: string | null = null) {
    this.tagName = tagName.toUpperCase();
    this.attributes = attributes;
    this.textContent = textContent;
  }

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }

  hasAttribute(name: string): boolean {
    return name in this.attributes;
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }

  removeAttribute(name: string): void {
    delete this.attributes[name];
  }

  closest(_selector: string): FakeElement | null {
    return null;
  }

  /** Non-zero so captureDomState doesn't skip it as hidden. */
  getBoundingClientRect(): { width: number; height: number } {
    return { width: 120, height: 24 };
  }

  click(): void {
    this.clickCount++;
    if (this.onClickRemove && this._parentList) {
      const idx = this._parentList.indexOf(this);
      if (idx >= 0) this._parentList.splice(idx, 1);
    }
  }

  focus(): void {
    this.focusCount++;
  }

  blur(): void {
    // no-op for fake DOM
  }

  dispatchEvent(event: { type: string }): boolean {
    this.dispatched.push(event.type);
    return true;
  }

  countDispatched(type: string): number {
    return this.dispatched.filter((t) => t === type).length;
  }
}

export class FakeInputElement extends FakeElement {
  type: string;
  labels: unknown[] = [];

  constructor(type = "text", attributes: Record<string, string> = {}) {
    super("input", attributes);
    this.type = type;
  }
}

export interface FakeEnv {
  elements: FakeElement[];
  /** Every window.scrollBy call. */
  scrollCalls: Array<{ top?: number }>;
  /** Every assignment to location.href. */
  navigations: string[];
  /** Delays passed to setTimeout while the fake env is installed. */
  timeouts: number[];
  /** One entry per outbound request the pipeline made. */
  fetchCalls: Array<{ url: string; body: string }>;
  /** Every message sent via chrome.runtime.sendMessage (ACTION_RESULT etc). */
  sentMessages: object[];
  get href(): string;
  /** Current fake scroll position — updated synchronously by scrollBy. */
  get scrollY(): number;
  /** Queue raw server response(s) or functions returning response objects. */
  respondWith(...responses: Array<object | ((body: string, callIndex: number) => object)>): void;
  /**
   * ISSUE-11: Queue raw text responses for malformed-response testing.
   * Each entry is { status, body } where body is returned verbatim by text()
   * and json() is made to throw (simulating a non-JSON or empty body).
   */
  respondWithRaw(...responses: Array<{ status: number; body: string }>): void;
  /**
   * Simulate a chrome.storage.local.set failure on the next write.
   * The callback will fire with chrome.runtime.lastError set to the given message.
   */
  simulateStorageError(errorMessage: string): void;
  /** Current tab ID returned by GET_TAB_ID messages (default: null). */
  setFakeTabId(tabId: number | null): void;

  restore(): void;
}

type Mutable = Record<string, unknown>;

export function installFakeDom(elements: FakeElement[]): FakeEnv {
  // Wire up parent-list references so onClickRemove can self-remove.
  for (const el of elements) el._parentList = elements;
  const g = globalThis as unknown as Mutable;
  const saved = new Map<string, unknown>();
  const keys = [
    "document",
    "location",
    "window",
    "chrome",
    "fetch",
    "setTimeout",
    "HTMLInputElement",
    "KeyboardEvent",
  ];
  for (const k of keys) saved.set(k, g[k]);

  const scrollCalls: Array<{ top?: number }> = [];
  const navigations: string[] = [];
  const timeouts: number[] = [];
  const fetchCalls: Array<{ url: string; body: string }> = [];
  const sentMessages: object[] = [];
  let currentHref = "http://localhost:8000/start";
  let currentScrollY = 0;

  const fakeLocation = {
    origin: "http://localhost:8000",
    get href(): string {
      return currentHref;
    },
    set href(next: string) {
      navigations.push(next);
      // A real navigation commits asynchronously, but committing it here
      // is the stricter test: it makes verifyUrlChanged report "success"
      // for navigate and "ambiguous" for everything else, which is the
      // exact split that used to decide whether the action ran twice.
      currentHref = next;
    },
  };

  const docListeners: Record<string, Array<(e: unknown) => void>> = {};
  const fakeDocument = {
    title: "Fake Page",
    activeElement: null as FakeElement | null,
    querySelectorAll: () => elements,
    getElementById: (id: string) => elements.find((el) => el.getAttribute("id") === id) ?? null,
    /**
     * Minimal querySelector: supports [data-privy-id="N"] for resolveElement()
     * fallback lookup, and #id selectors. This is the only selector form the
     * extension production code uses against document directly.
     */
    querySelector: (selector: string): FakeElement | null => {
      // [data-privy-id="N"] attribute selector
      const privyIdMatch = /^\[data-privy-id="(\d+)"\]$/.exec(selector);
      if (privyIdMatch) {
        const id = privyIdMatch[1];
        return elements.find((el) => el.getAttribute("data-privy-id") === id) ?? null;
      }
      // #id selector
      if (selector.startsWith("#")) {
        const id = selector.slice(1);
        return elements.find((el) => el.getAttribute("id") === id) ?? null;
      }
      // fieldset[disabled] selector (used in isElementDisabled)
      if (selector === "fieldset[disabled]") return null;
      return null;
    },
    addEventListener: (type: string, listener: (e: unknown) => void) => {
      if (!docListeners[type]) docListeners[type] = [];
      docListeners[type].push(listener);
    },
    removeEventListener: (type: string, listener: (e: unknown) => void) => {
      if (docListeners[type]) {
        docListeners[type] = docListeners[type].filter((l) => l !== listener);
      }
    },
    dispatchEvent: (event: { type: string; detail?: unknown }) => {
      const handlers = docListeners[event.type] || [];
      for (const h of handlers) h(event);
      if (event.type === "privyvision:init-vision") {
        const doneHandlers = docListeners["privyvision:vision-done"] || [];
        for (const h of doneHandlers) h({ type: "privyvision:vision-done" });
      }
      return true;
    },
  };

  const realSetTimeout = saved.get("setTimeout") as typeof setTimeout;

  class FakeKeyboardEvent {
    type: string;
    key: string;
    code: string;
    ctrlKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
    metaKey: boolean;
    constructor(type: string, init: { key?: string; code?: string; ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean; metaKey?: boolean } = {}) {
      this.type = type;
      this.key = init.key ?? "";
      this.code = init.code ?? "";
      this.ctrlKey = !!init.ctrlKey;
      this.shiftKey = !!init.shiftKey;
      this.altKey = !!init.altKey;
      this.metaKey = !!init.metaKey;
    }
  }

  g.document = fakeDocument;
  g.window = {
    scrollBy: (opts: { top?: number }) => {
      scrollCalls.push(opts);
      currentScrollY += opts.top ?? 0;
    },
    get scrollY() { return currentScrollY; },
  };
  g.HTMLInputElement = FakeInputElement;
  g.KeyboardEvent = FakeKeyboardEvent;
  const storageData: Record<string, unknown> = {};
  let nextStorageError: string | null = null;
  let fakeTabId: number | null = null;
  g.chrome = {
    storage: {
      local: {
        get: (keys: string[] | string | null, cb: (result: Record<string, unknown>) => void) => {
          if (!keys) return cb({ ...storageData });
          const keyList = Array.isArray(keys) ? keys : [keys];
          const out: Record<string, unknown> = {};
          for (const k of keyList) {
            if (k in storageData) out[k] = storageData[k];
          }
          cb(out);
        },
        set: (items: Record<string, unknown>, cb?: () => void) => {
          if (nextStorageError !== null) {
            const errMsg = nextStorageError;
            nextStorageError = null;
            // Simulate chrome.runtime.lastError being set during callback
            const savedLastError = (g.chrome as { runtime?: { lastError?: unknown } })?.runtime?.lastError;
            (g.chrome as { runtime: { lastError: { message: string } } }).runtime.lastError = { message: errMsg };
            if (cb) cb();
            (g.chrome as { runtime: { lastError: unknown } }).runtime.lastError = savedLastError;
            return Promise.resolve();
          }
          Object.assign(storageData, items);
          if (cb) cb();
          return Promise.resolve();
        },
        remove: (keys: string[] | string, cb?: () => void) => {
          const keyList = Array.isArray(keys) ? keys : [keys];
          for (const k of keyList) delete storageData[k];
          if (cb) cb();
          return Promise.resolve();
        },
      },
    },
    runtime: {
      getURL: (path: string) => `chrome-extension://fake-id/${path}`,
      lastError: undefined as { message?: string } | undefined,
      // sendMessage is called by sendMessage() in bus.ts from runTask() and pipeline.ts.
      sendMessage: async (msg: object) => {
        sentMessages.push(msg);
        const m = msg as { type?: string; payload?: { payload?: unknown; serverUrl?: string; timeoutMs?: number } };
        if (m.type === "REASON_REQUEST") {
          const bodyStr = JSON.stringify(m.payload?.payload ?? {});
          const targetUrl = m.payload?.serverUrl ?? "http://127.0.0.1:8787/reason";
          const timeoutMs = m.payload?.timeoutMs ?? 10000;
          const controller = new AbortController();
          const timerId = setTimeout(() => controller.abort("Fetch timeout"), timeoutMs);

          try {
            const resp = await (g.fetch as (url: unknown, init?: { method?: string; body?: unknown; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text: () => Promise<string>; json: () => Promise<unknown> }>)(targetUrl, { method: "POST", body: bodyStr, signal: controller.signal });
            clearTimeout(timerId);

            if (!resp.ok) {
              // Mirrors background/index.ts executeRemoteJsonPost: preserve the
              // status, a normalized slug, and a SAFE server error code/detail
              // recovered from the JSON body (never the raw body).
              const known = new Set([400, 401, 403, 404, 408, 409, 410, 413, 415, 422, 429, 500, 502, 503, 504]);
              const out: Record<string, unknown> = {
                ok: false,
                status: resp.status,
                errorClass: resp.status === 401 || resp.status === 403 ? "auth_error" : "http_error",
                error: known.has(resp.status) ? `http_${resp.status}` : "http_error",
              };
              try {
                const bodyText = await resp.text();
                if (bodyText && bodyText.length <= 4096) {
                  const parsed = JSON.parse(bodyText) as Record<string, unknown>;
                  const code = parsed?.error;
                  if (typeof code === "string" && /^[a-z0-9_]{1,40}$/.test(code)) {
                    out.serverErrorCode = code;
                    if (
                      (code === "invalid_request" || code === "action_rejected") &&
                      typeof parsed.detail === "string"
                    ) {
                      const d = parsed.detail.replace(/\s+/g, " ").trim().slice(0, 300);
                      if (d) out.serverDetail = d;
                    }
                  }
                }
              } catch {
                // best-effort only
              }
              return out;
            }
            const text = await resp.text();
            if (!text || !text.trim()) {
              return {
                ok: false,
                status: resp.status,
                errorClass: "empty_response",
                error: "empty_response",
              };
            }
            try {
              const data = JSON.parse(text);
              return {
                ok: true,
                status: 200,
                data,
              };
            } catch {
              return {
                ok: false,
                status: 200,
                errorClass: "invalid_json",
                error: "invalid_json",
              };
            }
          } catch (fetchErr) {
            clearTimeout(timerId);
            const isTimeout =
              (fetchErr instanceof Error && fetchErr.name === "AbortError") ||
              (typeof fetchErr === "string" && fetchErr.includes("timeout"));
            return {
              ok: false,
              status: 0,
              errorClass: isTimeout ? "request_timeout" : "network_error",
              error: isTimeout ? "request_timeout" : "network_error",
            };
          }
        }
        if (m.type === "GET_TAB_ID") {
          return Promise.resolve({ tabId: fakeTabId });
        }
        if (m.type === "HEALTH_CHECK") {
          return { ok: true, status: 200, data: { ok: true, status: "ok", latencyMs: 1 } };
        }
        return { ack: true };
      },
    },
  };
  type ResponseProvider = object | ((body: string, callIndex: number) => object);
  let responseProviders: ResponseProvider[] = [];
  // ISSUE-11: raw text response providers for malformed-response test cases.
  let rawResponseProviders: Array<{ status: number; body: string }> | null = null;

  g.fetch = async (url: unknown, init?: { body?: unknown }) => {
    const bodyStr = String(init?.body ?? "");
    fetchCalls.push({ url: String(url), body: bodyStr });
    const idx = fetchCalls.length - 1;

    // ISSUE-11: if raw response providers are set, use them for malformed-response tests.
    if (rawResponseProviders !== null) {
      const raw = rawResponseProviders[Math.min(idx, Math.max(0, rawResponseProviders.length - 1))];
      const { status, body } = raw ?? { status: 200, body: "" };
      return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => body,
        json: async () => { throw new Error("[fake] this response is not JSON"); },
      };
    }

    let taskIdFromReq = "task-under-test";
    try {
      const parsed = JSON.parse(bodyStr);
      if (parsed.task_id) taskIdFromReq = parsed.task_id;
    } catch {
      // not JSON
    }

    const provider = responseProviders[Math.min(idx, Math.max(0, responseProviders.length - 1))] ?? {};
    const item = typeof provider === "function" ? provider(bodyStr, idx) : provider;

    const statusCode = (item as { _statusCode?: number })._statusCode ?? 200;
    if (statusCode !== 200) {
      return {
        ok: false,
        status: statusCode,
        json: async () => item,
        text: async () => JSON.stringify(item),
      };
    }

    const rawTaskId = (item as { task_id?: string }).task_id;
    const finalTaskId = (!rawTaskId || rawTaskId === "task-under-test") ? taskIdFromReq : rawTaskId;

    const payload = {
      step_id: idx + 1,
      ...item,
      task_id: finalTaskId,
    };


    return {
      ok: true,
      status: 200,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    };
  };

  g.setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
    if (typeof ms === "number") timeouts.push(ms);
    return realSetTimeout(fn, ms, ...rest);
  }) as unknown as typeof setTimeout;

  Object.defineProperty(g, "location", { value: fakeLocation, configurable: true, writable: true });

  return {
    elements,
    scrollCalls,
    navigations,
    timeouts,
    fetchCalls,
    sentMessages,
    get href() {
      return currentHref;
    },
    get scrollY() {
      return currentScrollY;
    },
    respondWith(...next: Array<object | ((body: string, callIndex: number) => object)>) {
      rawResponseProviders = null;
      responseProviders = next;
    },
    respondWithRaw(...next: Array<{ status: number; body: string }>) {
      responseProviders = [];
      rawResponseProviders = next;
    },
    simulateStorageError(errorMessage: string) {
      nextStorageError = errorMessage;
    },
    setFakeTabId(tabId: number | null) {
      fakeTabId = tabId;
    },

    restore() {
      for (const k of keys) {
        if (saved.get(k) === undefined) delete g[k];
        else Object.defineProperty(g, k, { value: saved.get(k), configurable: true, writable: true });
      }
    },
  };
}

/** The raw snake_case shape the server puts on the wire. */
export function serverAction(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    action: "click",
    element_id: null,
    value: null,
    value_ref: null,
    direction: null,
    amount: null,
    url: null,
    confidence: 0.9,
    task_id: "task-under-test",
    step_id: 1,
    ...overrides,
  };
}
