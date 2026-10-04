let clickShieldUntil = 0;
let shieldInstalled = false;

export function isBackdropDismiss(target: EventTarget | null, currentTarget: EventTarget | null): boolean {
  return target !== null && target === currentTarget;
}

export function armModalClickShield(durationMs = 700): void {
  clickShieldUntil = Math.max(clickShieldUntil, performance.now() + durationMs);
  if (shieldInstalled) return;
  shieldInstalled = true;
  document.addEventListener('click', event => {
    if (performance.now() > clickShieldUntil) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
}
