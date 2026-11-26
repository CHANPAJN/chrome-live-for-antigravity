(() => {
  if (typeof window === 'undefined' || window.__CLIVE_EARLY_GUARD_INSTALLED__) return;
  Object.defineProperty(window, '__CLIVE_EARLY_GUARD_INSTALLED__', {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false
  });

  let activeGuard = null;
  Object.defineProperty(window, '__CLIVE_SET_CAPTURE_GUARD__', {
    value(fn) {
      activeGuard = typeof fn === 'function' ? fn : null;
    },
    configurable: false,
    enumerable: false,
    writable: false
  });

  const earlyCaptureDispatch = (ev) => {
    if (activeGuard) activeGuard(ev);
  };

  for (const evtType of [
    'click',
    'pointerdown',
    'pointermove',
    'pointerup',
    'pointercancel',
    'mousedown',
    'mouseup',
    'contextmenu'
  ]) {
    window.addEventListener(evtType, earlyCaptureDispatch, true);
  }
})();
