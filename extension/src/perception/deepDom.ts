/**
 * Generic deep DOM traversal — one implementation, shared by capture
 * (domCapture.ts), target resolution (resolveElement / resolveTarget),
 * accessible-name IDREF lookup (accessibleName.ts) and PVM (pvm/verify.ts).
 *
 * Scope:
 *   - Phase 6A: descends OPEN shadow roots recursively, including NESTED open
 *     roots; never touches CLOSED shadow roots (`element.shadowRoot` is null).
 *   - Phase 6B: also descends SAME-ORIGIN <iframe> / <frame> contentDocuments,
 *     including NESTED same-origin frames. CROSS-ORIGIN frames are skipped —
 *     `contentDocument` is null for them and every access is try/caught, so a
 *     SecurityError can never reach a caller and no cross-origin content is
 *     ever discovered.
 *
 *   - bounded depth + visited-root set → no infinite recursion, no revisits;
 *   - deterministic order: each root's own matches first, then its open shadow
 *     subtrees, then its same-origin child-frame documents, in host order.
 *
 * No hostnames, no custom-element allowlists, no site logic — pure structure.
 * The top document keeps ownership of the task loop; this module only reads.
 */

const MAX_DEEP_DEPTH = 20;

type QueryRoot = Document | ShadowRoot | Element;

const HOST_DOC = (): Document | null => (typeof document !== "undefined" ? document : null);

function openShadowRoot(el: Element): ShadowRoot | null {
  const sr = (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
  return sr && sr.mode === "open" ? sr : null;
}

/**
 * The contentDocument of a SAME-ORIGIN <iframe>/<frame>, or null. Cross-origin
 * frames return null (never throw); every access is defensively wrapped so a
 * SecurityError can never propagate.
 */
export function sameOriginFrameDoc(el: Element): Document | null {
  const tag = (el.tagName || "").toLowerCase();
  if (tag !== "iframe" && tag !== "frame") return null;
  try {
    const doc = (el as HTMLIFrameElement).contentDocument;
    // A real, reachable Document means same-origin. Cross-origin → null.
    return doc && typeof doc.querySelectorAll === "function" ? doc : null;
  } catch {
    return null;
  }
}

/** URL of the document that owns `el` (its frame's own location), or null. */
export function ownerFrameUrl(el: Element | null | undefined): string | null {
  if (!el) return null;
  try {
    const view = el.ownerDocument?.defaultView as (Window & typeof globalThis) | null | undefined;
    return view?.location?.href ?? null;
  } catch {
    return null;
  }
}

/**
 * Roots reachable from `root` for one level of descent: every element's OPEN
 * shadow root, plus every SAME-ORIGIN child-frame document.
 */
function childRoots(root: QueryRoot): Array<ShadowRoot | Document> {
  let all: Iterable<Element>;
  try {
    all = root.querySelectorAll("*");
  } catch {
    return [];
  }
  const roots: Array<ShadowRoot | Document> = [];
  for (const el of all) {
    const sr = openShadowRoot(el);
    if (sr) roots.push(sr);
    const fd = sameOriginFrameDoc(el);
    if (fd) roots.push(fd);
  }
  return roots;
}

/**
 * `root.querySelectorAll(selector)` that pierces open shadow roots and
 * same-origin child frames.
 */
export function deepQueryAll(selector: string, root: QueryRoot | null = HOST_DOC()): Element[] {
  if (!root) return [];
  const out: Element[] = [];
  const seen = new Set<QueryRoot>();
  const walk = (node: QueryRoot, depth: number): void => {
    if (depth > MAX_DEEP_DEPTH || seen.has(node)) return;
    seen.add(node);
    try {
      for (const el of node.querySelectorAll(selector)) out.push(el);
    } catch {
      /* invalid selector for this root — skip */
    }
    for (const sub of childRoots(node)) {
      if (!seen.has(sub)) walk(sub, depth + 1);
    }
  };
  walk(root, 0);
  return out;
}

/** First deep match (own tree, then open shadow subtrees, then same-origin frames). */
export function deepQueryFirst(selector: string, root: QueryRoot | null = HOST_DOC()): Element | null {
  if (!root) return null;
  const seen = new Set<QueryRoot>();
  const dfs = (node: QueryRoot, depth: number): Element | null => {
    if (depth > MAX_DEEP_DEPTH || seen.has(node)) return null;
    seen.add(node);
    try {
      const hit = node.querySelector(selector);
      if (hit) return hit;
    } catch {
      /* skip */
    }
    for (const sub of childRoots(node)) {
      if (!seen.has(sub)) {
        const r = dfs(sub, depth + 1);
        if (r) return r;
      }
    }
    return null;
  };
  return dfs(root, 0);
}

/**
 * Tree-scoped IDREF resolution (aria-labelledby / aria-controls / aria-owns).
 * Resolves within the referencing element's OWN containing tree — the document
 * (its frame's document) or the shadow root it lives in — and never escapes
 * into an unrelated root or across a frame boundary.
 */
export function idRefLookup(contextEl: Element, id: string): Element | null {
  if (!id || typeof contextEl.getRootNode !== "function") return null;
  const rootNode = contextEl.getRootNode() as Document | ShadowRoot;
  const gebi = (rootNode as { getElementById?: (x: string) => Element | null }).getElementById;
  if (typeof gebi === "function") {
    const found = gebi.call(rootNode, id);
    if (found) return found;
  }
  try {
    return rootNode.querySelector?.(`[id="${id.replace(/["\\]/g, "\\$&")}"]`) ?? null;
  } catch {
    return null;
  }
}

/**
 * `document.activeElement`, recursed through open shadow roots AND same-origin
 * child frames so the ACTUAL focused control is returned rather than its host
 * component or its containing <iframe>.
 */
export function deepActiveElement(): Element | null {
  const doc = HOST_DOC();
  if (!doc) return null;
  let active: Element | null = doc.activeElement;
  const seen = new Set<Element>();
  let depth = 0;
  while (active && depth < MAX_DEEP_DEPTH && !seen.has(active)) {
    seen.add(active);
    const sr = openShadowRoot(active);
    if (sr && sr.activeElement) {
      active = sr.activeElement;
      depth++;
      continue;
    }
    const fd = sameOriginFrameDoc(active);
    if (fd && fd.activeElement) {
      active = fd.activeElement;
      depth++;
      continue;
    }
    return active;
  }
  return active;
}

/**
 * `ancestor.contains(node)` that crosses open shadow boundaries via host links
 * and same-origin frame boundaries via the frameElement link.
 */
export function deepContains(ancestor: Element, node: Node | null): boolean {
  let cur: Node | null = node;
  let guard = 0;
  while (cur && guard < MAX_DEEP_DEPTH * 4) {
    if (cur === ancestor) return true;
    const parent: Node | null = (cur as Node & { parentNode: Node | null }).parentNode;
    if (parent) {
      cur = parent;
    } else {
      // Boundary: shadow root → host; child document → its <iframe> in the parent.
      const host = (cur as unknown as { host?: Element | null }).host;
      if (host) {
        cur = host;
      } else {
        let frameEl: Element | null = null;
        try {
          frameEl = (cur as Document).defaultView?.frameElement ?? null;
        } catch {
          frameEl = null;
        }
        if (!frameEl) return false;
        cur = frameEl;
      }
    }
    guard++;
  }
  return false;
}
