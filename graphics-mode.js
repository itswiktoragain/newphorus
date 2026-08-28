(function () {
  'use strict';

  var STORAGE_KEY = 'newphorus-opengl';
  var enabled = true;
  try {
    enabled = localStorage.getItem(STORAGE_KEY) !== 'off';
  } catch (error) {}

  var originalGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, attributes) {
    if (type === 'webgl' || type === 'experimental-webgl' || type === 'webgl2') {
      var next = Object.assign({}, attributes || {});
      next.powerPreference = enabled ? 'high-performance' : 'low-power';
      if (!enabled) {
        next.antialias = false;
        next.failIfMajorPerformanceCaveat = false;
      }
      return originalGetContext.call(this, type, next);
    }
    return originalGetContext.call(this, type, attributes);
  };

  window.NewphorusGraphicsMode = {
    enabled: enabled,
    setEnabled: function (next) {
      next = !!next;
      try {
        localStorage.setItem(STORAGE_KEY, next ? 'on' : 'off');
      } catch (error) {}
      location.reload();
    }
  };
}());
