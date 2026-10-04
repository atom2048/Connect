import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';

describe('Ask AI composer FAB visibility', () => {
  it('ties FAB visibility to the dialog lifetime and restores it on every close path', async () => {
    const [askAi, styles] = await Promise.all([
      readFile(new URL('../src/askAi.ts', import.meta.url), 'utf8'),
      readFile(new URL('../src/style.css', import.meta.url), 'utf8'),
    ]);
    expect(askAi).toContain('activeAskAiDialogClose?.()');
    expect(askAi).toContain("document.body.classList.add('ask-ai-open')");
    expect(askAi).toContain("document.body.classList.remove('ask-ai-open')");
    expect(askAi).toContain("document.addEventListener('keydown', onKeyDown)");
    expect(askAi).toContain("document.removeEventListener('keydown', onKeyDown)");
    expect(askAi).toContain("event.key !== 'Escape'");
    expect(askAi).toContain("closeButton?.addEventListener('click', close)");
    expect(askAi).toContain("event.target === overlay) close()");
    expect(askAi).toContain('const onHashChange = (): void => close();');
    expect(askAi).toContain('const onPageHide = (): void => close();');
    expect(styles).toMatch(/body\.ask-ai-open\s+\.composer-fab\s*\{\s*display:\s*none\s*!important;?\s*\}/);
  });
});
