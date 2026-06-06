export function debounce(fn, wait = 0, options = {}) {
  let timeoutId = null;
  let lastArgs = null;
  let lastThis = null;
  const leading = options.leading === true;
  const trailing = options.trailing !== false;

  function invokeTrailing() {
    timeoutId = null;
    if (!trailing || !lastArgs) {
      lastArgs = null;
      lastThis = null;
      return;
    }

    const args = lastArgs;
    const context = lastThis;
    lastArgs = null;
    lastThis = null;
    fn.apply(context, args);
  }

  function debounced(...args) {
    lastArgs = args;
    lastThis = this;

    const shouldInvokeLeading = leading && timeoutId === null;
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }
    timeoutId = setTimeout(invokeTrailing, wait);

    if (shouldInvokeLeading) {
      const context = lastThis;
      const callArgs = lastArgs;
      lastArgs = null;
      lastThis = null;
      return fn.apply(context, callArgs);
    }
  }

  debounced.cancel = () => {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }
    timeoutId = null;
    lastArgs = null;
    lastThis = null;
  };

  return debounced;
}
