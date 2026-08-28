(function () {
  'use strict';

  var SCRATCH_PROJECT_PREFIX = 'https://scratch.mit.edu/projects/';
  var METADATA_HOSTS = [
    'https://trampoline.turbowarp.org/api/projects/',
    'https://trampoline.turbowarp.xyz/api/projects/'
  ];

  function parseProjectId(value) {
    var text = String(value || '').trim();
    if (/^\d+$/.test(text)) return text;
    var match = text.match(/scratch\.mit\.edu\/projects\/(\d+)/i) || text.match(/(\d{3,})/);
    return match ? match[1] : '';
  }

  function getBaseURL() { return new URL('.', window.location.href); }
  function makeURL(path, params) {
    var url = new URL(path, getBaseURL());
    if (params) Object.keys(params).forEach(function (key) {
      if (params[key] !== undefined && params[key] !== null) url.searchParams.set(key, String(params[key]));
    });
    return url;
  }
  function setProgress(element, value) {
    if (element) element.style.width = Math.max(0, Math.min(100, value)) + '%';
  }

  async function fetchMetadata(projectId) {
    var lastError = null;
    for (var i = 0; i < METADATA_HOSTS.length; i++) {
      try {
        var response = await fetch(METADATA_HOSTS[i] + encodeURIComponent(projectId) + '?v=' + Date.now(), { cache: 'no-store' });
        if (response.status === 404 || response.status === 400) throw new Error('This project is unshared or does not exist.');
        if (!response.ok) throw new Error('Metadata request failed with HTTP ' + response.status + '.');
        return await response.json();
      } catch (error) { lastError = error; }
    }
    throw lastError || new Error('Could not fetch project metadata.');
  }

  async function fetchProjectBuffer(projectId, onProgress) {
    onProgress(12, 'Finding project…');
    var metadata = await fetchMetadata(projectId);
    onProgress(34, 'Downloading project…');
    var projectURL = 'https://projects.scratch.mit.edu/' + encodeURIComponent(projectId);
    if (metadata.project_token) projectURL += '?token=' + encodeURIComponent(metadata.project_token);
    var response = await fetch(projectURL, { cache: 'no-store' });
    if (!response.ok) throw new Error('Project download failed with HTTP ' + response.status + '.');
    var buffer = await response.arrayBuffer();
    onProgress(60, 'Preparing project…');
    return { buffer: buffer, metadata: metadata };
  }

  function configureStorage(scaffolding) {
    var storage = scaffolding.storage;
    if (!storage || !storage.addWebStore || !storage.AssetType) return;
    storage.addWebStore(
      [storage.AssetType.ImageVector, storage.AssetType.ImageBitmap, storage.AssetType.Sound],
      function (asset) { return 'https://assets.scratch.mit.edu/internalapi/asset/' + asset.assetId + '.' + asset.dataFormat + '/get/'; }
    );
  }

  function Player(options) {
    options = options || {};
    if (!window.Scaffolding || !window.Scaffolding.Scaffolding) throw new Error('The Scratch runtime failed to load.');
    this.container = options.container;
    this.statusText = options.statusText || null;
    this.progressBar = options.progressBar || null;
    this.loadingOverlay = options.loadingOverlay || null;
    this.errorOverlay = options.errorOverlay || null;
    this.errorText = options.errorText || null;
    this.autoStart = options.autoStart !== false;
    this.projectId = '';
    this.projectTitle = '';
    this.turbo = false;
    this.loaded = false;
    this.runtime = new window.Scaffolding.Scaffolding();
    this.runtime.width = 480;
    this.runtime.height = 360;
    this.runtime.resizeMode = 'preserve-ratio';
    this.runtime.editableLists = true;
    this.runtime.shouldConnectPeripherals = true;
    this.runtime.usePackagedRuntime = false;
    this.runtime.setup();
    configureStorage(this.runtime);
    this.runtime.appendTo(this.container);
  }

  Player.prototype._progress = function (value, text) {
    if (this.statusText && text) this.statusText.textContent = text;
    setProgress(this.progressBar, value);
  };
  Player.prototype._showLoading = function () {
    if (this.loadingOverlay) this.loadingOverlay.hidden = false;
    if (this.errorOverlay) this.errorOverlay.hidden = true;
  };
  Player.prototype._hideLoading = function () { if (this.loadingOverlay) this.loadingOverlay.hidden = true; };
  Player.prototype._showError = function (error) {
    this._hideLoading();
    if (this.errorText) this.errorText.textContent = error && error.message ? error.message : String(error);
    if (this.errorOverlay) this.errorOverlay.hidden = false;
    console.error(error);
  };
  Player.prototype._finishLoad = async function () {
    this._progress(82, 'Starting runtime…');
    this.runtime.start();
    if (this.autoStart) this.runtime.greenFlag();
    this.loaded = true;
    this._progress(100, 'Ready');
    var self = this;
    setTimeout(function () { self._hideLoading(); }, 180);
    this.runtime.relayout();
  };
  Player.prototype.loadById = async function (projectId) {
    projectId = parseProjectId(projectId);
    if (!projectId) throw new Error('Enter a valid Scratch project URL or numeric project ID.');
    this._showLoading();
    this._progress(5, 'Preparing Newphorus…');
    this.projectId = projectId;
    this.projectTitle = '';
    try {
      var result = await fetchProjectBuffer(projectId, this._progress.bind(this));
      this.projectTitle = result.metadata.title || ('Scratch project ' + projectId);
      this._progress(68, 'Loading blocks and assets…');
      await this.runtime.loadProject(result.buffer);
      await this._finishLoad();
      return { id: projectId, title: this.projectTitle, url: SCRATCH_PROJECT_PREFIX + projectId + '/' };
    } catch (error) { this._showError(error); throw error; }
  };
  Player.prototype.loadFile = async function (file) {
    if (!file) throw new Error('No project file selected.');
    var ext = (file.name.split('.').pop() || '').toLowerCase();
    if (['sb', 'sb2', 'sb3'].indexOf(ext) === -1) throw new Error('Unsupported file type. Open a .sb, .sb2, or .sb3 project.');
    this._showLoading();
    this._progress(12, 'Reading ' + file.name + '…');
    this.projectId = '';
    this.projectTitle = file.name;
    try {
      var buffer = await file.arrayBuffer();
      this._progress(58, 'Loading blocks and assets…');
      await this.runtime.loadProject(buffer);
      await this._finishLoad();
      return { id: '', title: file.name, url: '' };
    } catch (error) { this._showError(error); throw error; }
  };
  Player.prototype.greenFlag = function () { if (this.loaded) this.runtime.greenFlag(); };
  Player.prototype.stopAll = function () { if (this.loaded) this.runtime.stopAll(); };
  Player.prototype.setTurbo = function (enabled) {
    this.turbo = !!enabled;
    if (this.runtime.vm && typeof this.runtime.vm.setTurboMode === 'function') this.runtime.vm.setTurboMode(this.turbo);
    return this.turbo;
  };
  Player.prototype.toggleTurbo = function () { return this.setTurbo(!this.turbo); };
  Player.prototype.relayout = function () { this.runtime.relayout(); };

  function enterFullscreen(element, onChange) {
    var request = element.requestFullscreen || element.webkitRequestFullscreen;
    if (!request) return Promise.reject(new Error('Fullscreen is not supported by this browser.'));
    var result = request.call(element);
    if (result && typeof result.then === 'function') return result.then(function () { if (onChange) setTimeout(onChange, 40); });
    if (onChange) setTimeout(onChange, 40);
    return Promise.resolve();
  }

  function bootstrapHome() {
    var section = document.getElementById('player-section');
    var input = document.getElementById('project-input');
    var form = document.getElementById('project-form');
    var fileInput = document.getElementById('project-file');
    var title = document.getElementById('project-title');
    var scratchLink = document.getElementById('scratch-link');
    var embedCode = document.getElementById('embed-code');
    var standaloneLink = document.getElementById('standalone-link');
    var stageShell = document.getElementById('stage-shell');
    var player = new Player({
      container: document.getElementById('stage'), statusText: document.getElementById('status-text'),
      progressBar: document.getElementById('progress-bar'), loadingOverlay: document.getElementById('loading-overlay'),
      errorOverlay: document.getElementById('error-overlay'), errorText: document.getElementById('error-text')
    });

    function updateProjectUI(info) {
      section.hidden = false;
      title.textContent = info.title || 'Project';
      if (info.id) {
        scratchLink.hidden = false;
        scratchLink.href = info.url;
        var embedURL = makeURL('embed.html', { id: info.id });
        embedCode.value = '<iframe src="' + embedURL.href + '" width="482" height="420" allowfullscreen></iframe>';
        standaloneLink.href = makeURL('app.html', { id: info.id }).href;
      } else {
        scratchLink.hidden = true;
        embedCode.value = 'Local files cannot be embedded by URL.';
        standaloneLink.removeAttribute('href');
      }
      setTimeout(function () { section.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 30);
    }

    async function loadId(value, updateHash) {
      var id = parseProjectId(value);
      if (!id) { window.alert('Enter a valid Scratch project URL or numeric project ID.'); return; }
      section.hidden = false;
      if (updateHash && window.location.hash !== '#' + id) history.pushState(null, '', '#' + id);
      try {
        updateProjectUI(await player.loadById(id));
        document.title = player.projectTitle + ' · Newphorus';
      } catch (error) {}
    }

    form.addEventListener('submit', function (event) { event.preventDefault(); loadId(input.value, true); });
    fileInput.addEventListener('change', async function () {
      var file = fileInput.files && fileInput.files[0];
      if (!file) return;
      section.hidden = false;
      try {
        updateProjectUI(await player.loadFile(file));
        document.title = file.name + ' · Newphorus';
        history.replaceState(null, '', window.location.pathname + window.location.search);
      } catch (error) {} finally { fileInput.value = ''; }
    });
    document.getElementById('flag-button').addEventListener('click', function () { player.greenFlag(); });
    document.getElementById('stop-button').addEventListener('click', function () { player.stopAll(); });
    var turboButton = document.getElementById('turbo-button');
    turboButton.addEventListener('click', function () {
      var enabled = player.toggleTurbo();
      turboButton.setAttribute('aria-pressed', enabled ? 'true' : 'false');
    });
    document.getElementById('fullscreen-button').addEventListener('click', function () {
      enterFullscreen(stageShell, player.relayout.bind(player)).catch(function (error) { window.alert(error.message); });
    });
    ['fullscreenchange', 'webkitfullscreenchange'].forEach(function (name) {
      document.addEventListener(name, function () { setTimeout(player.relayout.bind(player), 40); });
    });

    var dragDepth = 0;
    document.addEventListener('dragenter', function (event) {
      if (!event.dataTransfer || !event.dataTransfer.types || Array.prototype.indexOf.call(event.dataTransfer.types, 'Files') === -1) return;
      dragDepth++; document.body.classList.add('drag-active'); event.preventDefault();
    });
    document.addEventListener('dragover', function (event) { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'; });
    document.addEventListener('dragleave', function () { dragDepth--; if (dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('drag-active'); } });
    document.addEventListener('drop', async function (event) {
      event.preventDefault(); dragDepth = 0; document.body.classList.remove('drag-active');
      var file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
      if (!file) return;
      section.hidden = false;
      try { updateProjectUI(await player.loadFile(file)); document.title = file.name + ' · Newphorus'; } catch (error) {}
    });

    var initialId = parseProjectId(window.location.hash.replace(/^#/, ''));
    if (initialId) {
      input.value = SCRATCH_PROJECT_PREFIX + initialId + '/';
      loadId(initialId, false);
    } else document.getElementById('loading-overlay').hidden = true;
    return player;
  }

  function bootstrapStandalone() {
    var params = new URLSearchParams(window.location.search);
    var id = parseProjectId(params.get('id'));
    var player = new Player({
      container: document.getElementById('stage'), statusText: document.getElementById('status-text'),
      progressBar: document.getElementById('progress-bar'), loadingOverlay: document.getElementById('loading-overlay'),
      errorOverlay: document.getElementById('error-overlay'), errorText: document.getElementById('error-text')
    });
    if (params.get('turbo') === 'true') player.setTurbo(true);
    document.getElementById('flag-button').addEventListener('click', player.greenFlag.bind(player));
    document.getElementById('stop-button').addEventListener('click', player.stopAll.bind(player));
    document.getElementById('turbo-button').addEventListener('click', function (event) {
      var enabled = player.toggleTurbo(); event.currentTarget.setAttribute('aria-pressed', enabled ? 'true' : 'false');
    });
    document.getElementById('fullscreen-button').addEventListener('click', function () { enterFullscreen(document.getElementById('app-player'), player.relayout.bind(player)); });
    if (!id) { player._showError(new Error('No project ID was provided.')); return player; }
    player.loadById(id).then(function (info) {
      document.title = info.title + ' · Newphorus';
      document.getElementById('project-title').textContent = info.title;
    }).catch(function () {});
    return player;
  }

  function bootstrapEmbed() {
    var params = new URLSearchParams(window.location.search);
    var id = parseProjectId(params.get('id'));
    var showUI = params.get('ui') !== 'false';
    var autoStart = params.get('auto-start') !== 'false';
    var controls = document.getElementById('embed-controls');
    if (!showUI) { controls.hidden = true; document.body.classList.add('ui-hidden'); }
    var player = new Player({
      container: document.getElementById('stage'), statusText: document.getElementById('status-text'),
      progressBar: document.getElementById('progress-bar'), loadingOverlay: document.getElementById('loading-overlay'),
      errorOverlay: document.getElementById('error-overlay'), errorText: document.getElementById('error-text'), autoStart: autoStart
    });
    document.getElementById('flag-button').addEventListener('click', player.greenFlag.bind(player));
    document.getElementById('stop-button').addEventListener('click', player.stopAll.bind(player));
    document.getElementById('turbo-button').addEventListener('click', function (event) {
      var enabled = player.toggleTurbo(); event.currentTarget.setAttribute('aria-pressed', enabled ? 'true' : 'false');
    });
    document.getElementById('fullscreen-button').addEventListener('click', function () { enterFullscreen(document.documentElement, player.relayout.bind(player)); });
    window.addEventListener('message', function (event) {
      if (!event.data || typeof event.data !== 'object') return;
      if (event.data.type === 'start') player.greenFlag();
      if (event.data.type === 'stop') player.stopAll();
      if (event.data.type === 'turbo') player.setTurbo(!!event.data.enabled);
    });
    if (!id) { player._showError(new Error('No project ID was provided.')); return player; }
    player.loadById(id).then(function (info) {
      document.title = info.title + ' · Newphorus';
      if (window.parent !== window) window.parent.postMessage({ type: 'newphorus-load', id: id, title: info.title }, '*');
    }).catch(function (error) {
      if (window.parent !== window) window.parent.postMessage({ type: 'newphorus-error', id: id, message: error.message }, '*');
    });
    return player;
  }

  window.Newphorus = { Player: Player, parseProjectId: parseProjectId, bootstrapHome: bootstrapHome, bootstrapStandalone: bootstrapStandalone, bootstrapEmbed: bootstrapEmbed };
}());
