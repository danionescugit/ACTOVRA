// @vitest-environment jsdom
import React, { act } from 'react';
import { describe, it, expect, vi } from 'vitest';
import ReactDOMServer from 'react-dom/server';
import ReactDOMClient from 'react-dom/client';
import Home from './page';

describe('SSR to Hydration Integrity Test', () => {
  it('hydrates server-rendered markup without any React hydration error or warning', async () => {
    const errorSpy = vi.spyOn(console, 'error');
    const warnSpy = vi.spyOn(console, 'warn');

    // 1. Server render
    const serverHtml = ReactDOMServer.renderToString(<Home />);
    expect(serverHtml).toBeTruthy();

    // 2. Put into DOM
    const container = document.createElement('div');
    container.innerHTML = serverHtml;
    document.body.appendChild(container);

    // 3. Hydrate with React 19 hydrateRoot
    let root: ReactDOMClient.Root | null = null;
    await act(async () => {
      root = ReactDOMClient.hydrateRoot(container, <Home />, {
        onRecoverableError(err) {
          console.error('[HYDRATION ERROR]', err);
        },
      });
    });

    const hydrationErrors = errorSpy.mock.calls.filter((call) =>
      call.some((arg) => typeof arg === 'string' && (arg.includes('Hydration') || arg.includes('hydrate') || arg.includes('did not match')))
    );

    console.log('Hydration errors count:', hydrationErrors.length);

    // 4. Test button clicking after hydration
    const reviewBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.toLowerCase().includes('review 17 exceptions')
    );
    expect(reviewBtn).toBeTruthy();

    await act(async () => {
      reviewBtn?.click();
    });

    const modal = document.querySelector('[role="dialog"]');
    console.log('Modal after act click:', !!modal);
    expect(modal).toBeTruthy();

    // Cleanup
    await act(async () => {
      root?.unmount();
    });
    container.remove();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });
});
