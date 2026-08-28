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

  const fakeDocument = {
    title: "Fake Page",
    activeElement: null as FakeElement | null,
    querySelectorAll: () => elements,
    getElementById: (id: string) => elements.find((el) => el.getAttribute("id") === id) ?? null,
  };

  const realSetTimeout = saved.get("setTimeout") as typeof setTimeout;

  class FakeKeyboardEvent {
    type: string;
    key: string;
    constructor(type: string, init: { key?: string } = {}) {
      this.type = type;
      this.key = init.key ?? "";
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
  g.chrome = {
    storage: {
      local: {
        // No stored serverUrl -> pipeline falls back to its default.
        get: (_keys: string[], cb: (result: Record<string, unknown>) => void) => cb({}),
        set: async () => undefined,
      },
    },
    runtime: {
      // sendMessage is called by sendMessage() in bus.ts from runTask().
      // In tests we just need it to not throw.
      sendMessage: async (msg: object) => { sentMessages.push(msg); },
    },
  };
  type ResponseProvider = object | ((body: string, callIndex: number) => object);
  let responseProviders: ResponseProvider[] = [];

  g.fetch = async (url: unknown, init?: { body?: unknown }) => {
    const bodyStr = String(init?.body ?? "");
    fetchCalls.push({ url: String(url), body: bodyStr });
    const idx = fetchCalls.length - 1;

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
      responseProviders = next;
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
