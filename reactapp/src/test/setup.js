import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Vitest does not expose global afterEach by default. Testing Library's
// automatic cleanup registration can therefore be skipped, leaving multiple
// mounted roots across tests in the same file (observed in AuthPage/Help).
// Register it explicitly to ensure each test starts with a clean DOM.
afterEach(() => cleanup());

// jsdom deliberately omits layout and scrolling. Keep component tests quiet
// while preserving the browser code paths that call these standard APIs.
if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'scrollTo', {
    configurable: true,
    writable: true,
    value: () => {},
  });
}

if (typeof Element !== 'undefined' && Element.prototype) {
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    configurable: true,
    writable: true,
    value: () => {},
  });
}
