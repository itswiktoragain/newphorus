(function () {
  'use strict';

  var SCRATCH_PREFIX = 'https://scratch.mit.edu/projects/';
  var META_HOSTS = [
    'https://trampoline.turbowarp.org/api/projects/',
    'https://trampoline.turbowarp.xyz/api/projects/'
  ];

  function parseProjectId(value) {
    var text = String(value || '').trim();
    if (/^\d+$/.test(text)) return text;
    var match = text.match(/scratch\.mit\.edu\/projects\/(\d+)/i) || text.match(/(\d{3,})/);
    return match ? match[1] : '';
  }

  function makeURL(path, params) {
    var url = new URL(path, new URL('.', location.href));
    Object.keys(params || {}).forEach(function (key) {
      if (params[key] !== undefined && params[key] !== null) {
        url.searchParams.set(key, String(params[key]));
      }
    });
    return url;
  }

  async function fetchMetadata(id, signal) {
    var lastError;
    for (var i = 0; i < META_HOSTS.length; i++) {
      try {
        var response = await fetch(META_HOSTS[i] + encodeURIComponent(id) + '?v=' + Date.now(), {
          cache: 'no-store',
          signal: signal
        });
        if (response.status === 400 || response.status === 404) {
          throw new Error('This project is unshared or does not exist.');
        }
        if (!response.ok) throw new Error('Metadata request failed with HTTP ' + response.status + '.');
        return await response.json();
      } catch (error) {
        if (error && error.name === 'AbortError') throw error;
        lastError = error;
      }
    }
    throw lastError || new Error('Could not fetch project metadata.');
  }

  async function fetchProject(id, progress, signal) {
    progress(12, 'Finding project…');
    var metadata = await fetchMetadata(id, signal);
    progress(34, 'Downloading project…');
    var url = 'https://projects.scratch.mit.edu/' + encodeURIComponent(id);
    if (metadata.project_token) url += '?token=' + encodeURIComponent(metadata.project_token);
    var response = await fetch(url, {cache: 'no-store', signal: signal});
    if (!response.ok) throw new Error('Project download failed with HTTP ' + response.status + '.');
    var buffer = await response.arrayBuffer();
    progress(60, 'Preparing project…');
    return {buffer: buffer, metadata: metadata};
  }

  function configureStorage(scaffolding) {
    var storage = scaffolding.storage;
    if (!storage || !storage.addWebStore || !storage.AssetType) return;
    storage.addWebStore(
      [storage.AssetType.ImageVector, storage.AssetType.ImageBitmap, storage.AssetType.Sound],
      function (asset) {
        return 'https://assets.scratch.mit.edu/internalapi/asset/' +
          asset.assetId + '.' + asset.dataFormat + '/get/';
      }
    );
  }

  function isAbort(error) {
    return !!(error && error.name === 'AbortError');
  }

  // Based on TurboWarp Packager's pause behavior: pause Scratch threads and its clock,
  // suspend audio, then repair active timers when execution resumes.
  function installPauseController(scaffolding) {
    var vm = scaffolding.vm;
    var runtime = vm.runtime;
    var STATUS_PROMISE_WAIT = 1;
    var STATUS_DONE = 4;
    var paused = false;
    var savedThreads = new WeakMap();
    var audioChange = Promise.resolve();

    function getAudioContext() {
      var engine = scaffolding.audioEngine || runtime.audioEngine;
      return engine && (engine.audioContext || engine._audioContext);
    }

    function shiftTimer(timer, amount) {
      if (timer && typeof timer.startTime === 'number') timer.startTime += amount;
    }

    function setPaused(next) {
      next = !!next;
      if (next === paused) return paused;
      paused = next;

      var audioContext = getAudioContext();
      if (paused) {
        if (audioContext && typeof audioContext.suspend === 'function') {
          audioChange = audioChange.then(function () {
            return audioContext.suspend();
          }).catch(function () {});
        }

        var clock = runtime.ioDevices && runtime.ioDevices.clock;
        if (clock && typeof clock.pause === 'function' && !clock._paused) clock.pause();

        runtime.threads.forEach(function (thread) {
          if (!thread.updateMonitor && !savedThreads.has(thread)) {
            savedThreads.set(thread, {
              pauseTime: runtime.currentMSecs,
              status: thread.status
            });
            thread.status = STATUS_PROMISE_WAIT;
          }
        });

        runtime.emit('PROJECT_RUN_STOP');
        runtime.emit('RUNTIME_PAUSED');
      } else {
        if (audioContext && typeof audioContext.resume === 'function') {
          audioChange = audioChange.then(function () {
            return audioContext.resume();
          }).catch(function () {});
        }

        var resumeClock = runtime.ioDevices && runtime.ioDevices.clock;
        if (resumeClock && typeof resumeClock.resume === 'function' && resumeClock._paused) resumeClock.resume();

        var now = Date.now();
        runtime.threads.forEach(function (thread) {
          var state = savedThreads.get(thread);
          if (!state) return;
          var delta = now - state.pauseTime;
          var stackFrame = typeof thread.peekStackFrame === 'function' ? thread.peekStackFrame() : null;
          if (stackFrame && stackFrame.executionContext) shiftTimer(stackFrame.executionContext.timer, delta);
          if (thread.compatibilityStackFrame) shiftTimer(thread.compatibilityStackFrame.timer, delta);
          shiftTimer(thread.timer, delta);
          thread.status = state.status;
        });
        savedThreads = new WeakMap();
        runtime.emit('RUNTIME_UNPAUSED');
      }

      return paused;
    }

    var originalStepThreads = runtime.sequencer.stepThreads;
    runtime.sequencer.stepThreads = function () {
      if (paused) {
        this.runtime.threads.forEach(function (thread) {
          if (thread.status === STATUS_DONE) return;
          var state = savedThreads.get(thread);
          if (state && thread.status !== STATUS_PROMISE_WAIT) {
            state.status = thread.status;
            thread.status = STATUS_PROMISE_WAIT;
          }
        });
      }
      return originalStepThreads.apply(this, arguments);
    };

    var originalGreenFlag = runtime.greenFlag;
    runtime.greenFlag = function () {
      setPaused(false);
      return originalGreenFlag.apply(this, arguments);
    };

    var originalStartHats = runtime.startHats;
    runtime.startHats = function () {
      if (paused) return [];
      return originalStartHats.apply(this, arguments);
    };

    if (typeof runtime._getMonitorThreadCount === 'function') {
      var originalGetMonitorThreadCount = runtime._getMonitorThreadCount;
      runtime._getMonitorThreadCount = function (threads) {
        var count = originalGetMonitorThreadCount.call(this, threads);
        if (paused) {
          threads.forEach(function (thread) {
            if (savedThreads.has(thread)) count++;
          });
        }
        return count;
      };
    }

    return {
      setPaused: setPaused,
      isPaused: function () { return paused; }
    };
  }

  function Player(options) {
    options = options || {};
    if (!window.Scaffolding || !window.Scaffolding.Scaffolding) {
      throw new Error('The Scratch runtime failed to load.');
    }

    this.container = options.container;
    this.statusText = options.statusText;
    this.progressBar = options.progressBar;
    this.loadingOverlay = options.loadingOverlay;
    this.errorOverlay = options.errorOverlay;
    this.errorText = options.errorText;
    this.startOverlay = options.startOverlay;
    this.autoStart = options.autoStart === true;
    this.projectId = '';
    this.projectTitle = '';
    this.turbo = false;
    this.loaded = false;
    this.activeFetch = null;
    this.loadQueue = Promise.resolve();

    this.runtime = new window.Scaffolding.Scaffolding();
    this.runtime.width = 480;
    this.runtime.height = 360;
    this.runtime.resizeMode = 'preserve-ratio';
    this.runtime.editableLists = true;
    this.runtime.shouldConnectPeripherals = true;
    this.runtime.usePackagedRuntime = false;
    this.runtime.setup();
    if (typeof this.runtime.setAccentColor === 'function') this.runtime.setAccentColor('#111111');
    configureStorage(this.runtime);
    this.pauseController = installPauseController(this.runtime);
    this.runtime.appendTo(this.container);

    var self = this;
    this.container.addEventListener('pointerdown', function () {
      self.unlockAudio();
    }, {passive: true});
  }

  Player.prototype.progress = function (value, text) {
    if (this.statusText && text) this.statusText.textContent = text;
    if (this.progressBar) {
      this.progressBar.style.width = Math.max(0, Math.min(100, value)) + '%';
    }
  };

  Player.prototype.showLoading = function () {
    this.hideStartOverlay();
    if (this.loadingOverlay) {
      this.loadingOverlay.style.removeProperty('display');
      this.loadingOverlay.hidden = false;
      this.loadingOverlay.removeAttribute('aria-hidden');
    }
    if (this.errorOverlay) this.errorOverlay.hidden = true;
  };

  Player.prototype.hideLoading = function () {
    if (this.loadingOverlay) {
      this.loadingOverlay.hidden = true;
      this.loadingOverlay.setAttribute('aria-hidden', 'true');
      this.loadingOverlay.style.setProperty('display', 'none', 'important');
    }
  };

  Player.prototype.showStartOverlay = function () {
    if (!this.startOverlay) return;
    this.startOverlay.hidden = false;
    this.startOverlay.removeAttribute('aria-hidden');
  };

  Player.prototype.hideStartOverlay = function () {
    if (!this.startOverlay) return;
    this.startOverlay.hidden = true;
    this.startOverlay.setAttribute('aria-hidden', 'true');
  };

  Player.prototype.showError = function (error) {
    this.hideLoading();
    this.hideStartOverlay();
    if (this.errorText) this.errorText.textContent = error && error.message ? error.message : String(error);
    if (this.errorOverlay) this.errorOverlay.hidden = false;
    console.error(error);
  };

  Player.prototype.unlockAudio = function () {
    var engine = this.runtime && this.runtime.audioEngine;
    var context = engine && (engine.audioContext || engine._audioContext);
    if (context && context.state !== 'running' && typeof context.resume === 'function') {
      var promise = context.resume();
      if (promise && typeof promise.catch === 'function') promise.catch(function () {});
    }
  };

  Player.prototype.resetProject = async function () {
    this.loaded = false;
    this.hideStartOverlay();
    if (!this.runtime || !this.runtime.vm) return;

    try { this.pauseController.setPaused(false); } catch (error) {}
    try { this.runtime.stopAll(); } catch (error) {}
    try {
      if (typeof this.runtime.vm.clear === 'function') {
        await Promise.resolve(this.runtime.vm.clear());
      }
    } catch (error) {
      console.warn('Could not fully clear the previous project.', error);
    }

    if (this.runtime._monitors && typeof this.runtime._monitors.clear === 'function') {
      this.runtime._monitors.clear();
    }
    var leftovers = this.container.querySelectorAll('.sc-monitor-root, .sc-question-root');
    for (var i = 0; i < leftovers.length; i++) leftovers[i].remove();
  };

  Player.prototype.queueLoad = function (task) {
    if (this.activeFetch) this.activeFetch.abort();
    var controller = new AbortController();
    this.activeFetch = controller;

    var self = this;
    var queued = this.loadQueue.catch(function () {}).then(function () {
      return task(controller);
    });
    this.loadQueue = queued.catch(function () {});

    return queued.finally(function () {
      if (self.activeFetch === controller) self.activeFetch = null;
    });
  };

  Player.prototype.finishLoad = function () {
    this.progress(82, 'Starting runtime…');
    if (this.autoStart) {
      this.unlockAudio();
      this.runtime.greenFlag();
    } else if (this.runtime.vm && typeof this.runtime.vm.start === 'function') {
      this.runtime.vm.start();
    }
    this.loaded = true;
    this.progress(100, this.autoStart ? 'Ready' : 'Ready — click the flag to start');
    this.hideLoading();
    if (!this.autoStart) this.showStartOverlay();
    this.runtime.relayout();
  };

  Player.prototype.loadById = function (value) {
    var id = parseProjectId(value);
    if (!id) return Promise.reject(new Error('Enter a valid Scratch project URL or numeric project ID.'));

    var self = this;
    this.showLoading();
    this.progress(4, 'Loading project…');
    this.projectId = id;

    return this.queueLoad(async function (controller) {
      self.showLoading();
      self.progress(6, 'Clearing previous project…');
      await self.resetProject();
      if (controller.signal.aborted) throw new DOMException('Loading cancelled.', 'AbortError');

      try {
        var result = await fetchProject(id, self.progress.bind(self), controller.signal);
        if (controller.signal.aborted) throw new DOMException('Loading cancelled.', 'AbortError');
        self.projectTitle = result.metadata.title || ('Scratch project ' + id);
        self.progress(68, 'Loading blocks and assets…');
        await self.runtime.loadProject(result.buffer);
        self.finishLoad();
        return {id: id, title: self.projectTitle, url: SCRATCH_PREFIX + id + '/'};
      } catch (error) {
        if (!isAbort(error)) self.showError(error);
        throw error;
      }
    });
  };

  Player.prototype.loadFile = function (file) {
    if (!file) return Promise.reject(new Error('No project file selected.'));
    var ext = (file.name.split('.').pop() || '').toLowerCase();
    if (['sb', 'sb2', 'sb3'].indexOf(ext) === -1) {
      return Promise.reject(new Error('Unsupported file type. Open a .sb, .sb2, or .sb3 project.'));
    }

    var self = this;
    this.showLoading();
    this.progress(4, 'Loading project…');
    this.projectId = '';
    this.projectTitle = file.name;

    return this.queueLoad(async function (controller) {
      self.showLoading();
      self.progress(8, 'Clearing previous project…');
      await self.resetProject();
      if (controller.signal.aborted) throw new DOMException('Loading cancelled.', 'AbortError');

      try {
        self.progress(18, 'Reading ' + file.name + '…');
        var buffer = await file.arrayBuffer();
        if (controller.signal.aborted) throw new DOMException('Loading cancelled.', 'AbortError');
        self.progress(58, 'Loading blocks and assets…');
        await self.runtime.loadProject(buffer);
        self.finishLoad();
        return {id: '', title: file.name, url: ''};
      } catch (error) {
        if (!isAbort(error)) self.showError(error);
        throw error;
      }
    });
  };

  Player.prototype.greenFlag = function () {
    if (!this.loaded) return;
    this.pauseController.setPaused(false);
    this.hideStartOverlay();
    this.unlockAudio();
    this.runtime.greenFlag();
    if (document.activeElement && typeof document.activeElement.blur === 'function') {
      document.activeElement.blur();
    }
  };

  Player.prototype.stopAll = function () {
    if (!this.loaded) return;
    this.pauseController.setPaused(false);
    this.runtime.stopAll();
  };

  Player.prototype.setPaused = function (paused) {
    if (!this.loaded) return false;
    if (paused) this.hideStartOverlay();
    return this.pauseController.setPaused(paused);
  };

  Player.prototype.togglePause = function () {
    return this.setPaused(!this.pauseController.isPaused());
  };

  Player.prototype.isPaused = function () {
    return this.pauseController.isPaused();
  };

  Player.prototype.setTurbo = function (enabled) {
    this.turbo = !!enabled;
    if (this.runtime.vm && typeof this.runtime.vm.setTurboMode === 'function') {
      this.runtime.vm.setTurboMode(this.turbo);
    }
    return this.turbo;
  };

  Player.prototype.toggleTurbo = function () {
    return this.setTurbo(!this.turbo);
  };

  Player.prototype.relayout = function () {
    if (this.runtime) this.runtime.relayout();
  };

  function requestFullscreen(element, player) {
    var request = element.requestFullscreen || element.webkitRequestFullscreen;
    if (!request) return;
    var result = request.call(element);
    if (result && result.catch) result.catch(console.error);
    setTimeout(player.relayout.bind(player), 50);
  }

  function blurActiveElement() {
    if (document.activeElement && typeof document.activeElement.blur === 'function') {
      document.activeElement.blur();
    }
  }

  function syncOpenGLButton(button) {
    if (!button || !window.NewphorusGraphicsMode) return;
    var enabled = window.NewphorusGraphicsMode.enabled;
    button.setAttribute('aria-pressed', enabled ? 'true' : 'false');
    button.textContent = enabled ? 'OpenGL on' : 'OpenGL off';
    button.title = enabled ? 'Use high-performance WebGL rendering' : 'Use low-power compatibility WebGL rendering';
  }

  function wireControls(player, fullscreenElement) {
    var flagButton = document.getElementById('flag-button');
    var pauseButton = document.getElementById('pause-button');
    var stopButton = document.getElementById('stop-button');
    var turboButton = document.getElementById('turbo-button');
    var openGLButton = document.getElementById('opengl-button');
    var fullscreenButton = document.getElementById('fullscreen-button');
    var startOverlay = document.getElementById('start-overlay');

    if (flagButton) flagButton.addEventListener('click', function () {
      player.greenFlag();
      if (pauseButton) pauseButton.setAttribute('aria-pressed', 'false');
    });

    if (startOverlay) startOverlay.addEventListener('click', function () {
      player.greenFlag();
      if (pauseButton) pauseButton.setAttribute('aria-pressed', 'false');
    });

    if (pauseButton) pauseButton.addEventListener('click', function (event) {
      var paused = player.togglePause();
      event.currentTarget.setAttribute('aria-pressed', paused ? 'true' : 'false');
      event.currentTarget.title = paused ? 'Resume project' : 'Pause project';
      blurActiveElement();
    });

    if (stopButton) stopButton.addEventListener('click', function () {
      player.stopAll();
      if (pauseButton) pauseButton.setAttribute('aria-pressed', 'false');
      blurActiveElement();
    });

    if (turboButton) turboButton.addEventListener('click', function (event) {
      event.currentTarget.setAttribute('aria-pressed', player.toggleTurbo() ? 'true' : 'false');
      blurActiveElement();
    });

    syncOpenGLButton(openGLButton);
    if (openGLButton && window.NewphorusGraphicsMode) {
      openGLButton.addEventListener('click', function () {
        window.NewphorusGraphicsMode.setEnabled(!window.NewphorusGraphicsMode.enabled);
      });
    }

    if (fullscreenButton) fullscreenButton.addEventListener('click', function () {
      requestFullscreen(fullscreenElement, player);
      blurActiveElement();
    });

    ['fullscreenchange', 'webkitfullscreenchange'].forEach(function (name) {
      document.addEventListener(name, function () {
        setTimeout(player.relayout.bind(player), 50);
      });
    });
  }

  function makePlayer(autoStart) {
    return new Player({
      container: document.getElementById('stage'),
      statusText: document.getElementById('status-text'),
      progressBar: document.getElementById('progress-bar'),
      loadingOverlay: document.getElementById('loading-overlay'),
      errorOverlay: document.getElementById('error-overlay'),
      errorText: document.getElementById('error-text'),
      startOverlay: document.getElementById('start-overlay'),
      autoStart: autoStart
    });
  }

  function bootstrapHome() {
    var section = document.getElementById('player-section');
    var input = document.getElementById('project-input');
    var fileInput = document.getElementById('project-file');
    var player = makePlayer(false);
    wireControls(player, document.getElementById('stage-shell'));

    function updateUI(info) {
      section.hidden = false;
      document.getElementById('project-title').textContent = info.title || 'Project';
      var scratchLink = document.getElementById('scratch-link');
      var embedCode = document.getElementById('embed-code');
      var standalone = document.getElementById('standalone-link');
      if (info.id) {
        scratchLink.hidden = false;
        scratchLink.href = info.url;
        embedCode.value = '<iframe src="' + makeURL('embed.html', {id: info.id, 'auto-start': 'false'}).href +
          '" width="482" height="412" allowfullscreen></iframe>';
        standalone.href = makeURL('app.html', {id: info.id}).href;
      } else {
        scratchLink.hidden = true;
        embedCode.value = 'Local files cannot be embedded by URL.';
        standalone.removeAttribute('href');
      }
    }

    async function loadId(value, changeHash) {
      var id = parseProjectId(value);
      if (!id) {
        alert('Enter a valid Scratch project URL or numeric project ID.');
        return;
      }
      section.hidden = false;
      if (changeHash && location.hash !== '#' + id) history.pushState(null, '', '#' + id);
      try {
        var info = await player.loadById(id);
        updateUI(info);
        document.title = info.title + ' · Newphorus';
      } catch (error) {
        if (!isAbort(error)) console.error(error);
      }
    }

    document.getElementById('project-form').addEventListener('submit', function (event) {
      event.preventDefault();
      loadId(input.value, true);
    });

    async function loadLocal(file) {
      if (!file) return;
      section.hidden = false;
      try {
        var info = await player.loadFile(file);
        updateUI(info);
        document.title = info.title + ' · Newphorus';
        history.replaceState(null, '', location.pathname + location.search);
      } catch (error) {
        if (!isAbort(error)) console.error(error);
      }
    }

    fileInput.addEventListener('change', function () {
      var file = fileInput.files && fileInput.files[0];
      fileInput.value = '';
      loadLocal(file);
    });

    var dragDepth = 0;
    document.addEventListener('dragenter', function (event) {
      if (!event.dataTransfer || Array.prototype.indexOf.call(event.dataTransfer.types || [], 'Files') === -1) return;
      dragDepth++;
      document.body.classList.add('drag-active');
      event.preventDefault();
    });
    document.addEventListener('dragover', function (event) {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    });
    document.addEventListener('dragleave', function () {
      dragDepth--;
      if (dragDepth <= 0) {
        dragDepth = 0;
        document.body.classList.remove('drag-active');
      }
    });
    document.addEventListener('drop', function (event) {
      event.preventDefault();
      dragDepth = 0;
      document.body.classList.remove('drag-active');
      loadLocal(event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0]);
    });

    var initialId = parseProjectId(location.hash.slice(1));
    if (initialId) {
      input.value = SCRATCH_PREFIX + initialId + '/';
      loadId(initialId, false);
    } else {
      player.hideLoading();
      player.hideStartOverlay();
    }

    return player;
  }

  function bootstrapStandalone() {
    var params = new URLSearchParams(location.search);
    var id = parseProjectId(params.get('id'));
    var player = makePlayer(false);
    if (params.get('turbo') === 'true') {
      player.setTurbo(true);
      var turboButton = document.getElementById('turbo-button');
      if (turboButton) turboButton.setAttribute('aria-pressed', 'true');
    }
    wireControls(player, document.getElementById('app-player'));
    if (!id) {
      player.showError(new Error('No project ID was provided.'));
      return player;
    }
    player.loadById(id).then(function (info) {
      document.title = info.title + ' · Newphorus';
      document.getElementById('project-title').textContent = info.title;
    }).catch(function (error) {
      if (!isAbort(error)) console.error(error);
    });
    return player;
  }

  function bootstrapEmbed() {
    var params = new URLSearchParams(location.search);
    var id = parseProjectId(params.get('id'));
    var showUI = params.get('ui') !== 'false';
    var player = makePlayer(params.get('auto-start') === 'true');
    if (!showUI) document.body.classList.add('ui-hidden');
    wireControls(player, document.documentElement);

    window.addEventListener('message', function (event) {
      if (!event.data || typeof event.data !== 'object') return;
      if (event.data.type === 'start') player.greenFlag();
      if (event.data.type === 'stop') player.stopAll();
      if (event.data.type === 'pause') player.setPaused(true);
      if (event.data.type === 'resume') player.setPaused(false);
      if (event.data.type === 'turbo') player.setTurbo(!!event.data.enabled);
    });

    if (!id) {
      player.showError(new Error('No project ID was provided.'));
      return player;
    }

    player.loadById(id).then(function (info) {
      document.title = info.title + ' · Newphorus';
      if (parent !== window) parent.postMessage({type: 'newphorus-load', id: id, title: info.title}, '*');
    }).catch(function (error) {
      if (!isAbort(error) && parent !== window) {
        parent.postMessage({type: 'newphorus-error', id: id, message: error.message}, '*');
      }
    });
    return player;
  }

  window.Newphorus = {
    Player: Player,
    parseProjectId: parseProjectId,
    bootstrapHome: bootstrapHome,
    bootstrapStandalone: bootstrapStandalone,
    bootstrapEmbed: bootstrapEmbed
  };
}());
