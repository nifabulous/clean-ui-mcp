import "@testing-library/jest-dom/vitest";

// jsdom does not implement window.matchMedia. Provide a minimal EventTarget-backed
// implementation so the theme module can subscribe to prefers-color-scheme changes
// in tests. The same query string returns the same MediaQueryList instance (per the
// CSSOM spec), so a listener added by the module and a "change" event dispatched by
// a test land on the same object. Tests may stub the `matches` getter (e.g. vi.spyOn)
// to simulate the OS preference, and dispatch a "change" event to simulate OS changes.
const registry = new Map<string, MediaQueryList>();

class TestMediaQueryList extends EventTarget implements MediaQueryList {
  matches = false;
  media: string;
  onchange: ((this: MediaQueryList, ev: MediaQueryListEvent) => unknown) | null = null;

  constructor(media: string) {
    super();
    this.media = media;
  }

  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
  ): void {
    super.addEventListener(type, listener as EventListener);
  }

  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
  ): void {
    super.removeEventListener(type, listener as EventListener);
  }

  addListener(cb: ((this: MediaQueryList, ev: MediaQueryListEvent) => unknown) | null): void {
    if (cb) this.addEventListener("change", cb as EventListener);
  }
  removeListener(cb: ((this: MediaQueryList, ev: MediaQueryListEvent) => unknown) | null): void {
    if (cb) this.removeEventListener("change", cb as EventListener);
  }

  dispatchEvent(event: Event): boolean {
    return super.dispatchEvent(event);
  }
}

if (typeof window.matchMedia !== "function") {
  // @ts-expect-error — installing the polyfill onto window.
  window.matchMedia = (media: string): MediaQueryList => {
    let cached = registry.get(media);
    if (!cached) {
      cached = new TestMediaQueryList(media) as unknown as MediaQueryList;
      registry.set(media, cached);
    }
    return cached;
  };
}

// Reset the shared MQL registry state between tests so theme subscription tests
// start from a clean slate. Registered via vitest's afterEach hook.
import { afterEach } from "vitest";

afterEach(() => {
  for (const mql of registry.values()) {
    mql.matches = false;
  }
});

export {};
