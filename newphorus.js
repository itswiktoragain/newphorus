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
      if (params[key] !== undefined && params[key] !== null) url.searchParams.set(key, String(params[key]));
    });
    return url;
  }

  async function fetchMetadata(id) {
    var lastError;
    for (var i = 0; i < META_HOSTS.length; i++) {
      try {
        var response = await fetch(META_HOSTS[i] + encodeURIComponent(id) + '?v=' + Date.now(), {cache: 'no-store'});
        if (response.status === 400 || response.status === 404) throw new Error('This project is unshared or does not exist.');
        if (!response.ok) throw new Error('Metadata request failed with HTTP ' + response.status + '.');
        return await response.json();
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error('Could not fetch project metadata.');
  }

  async function fetchProject(id, progress) {
    progress(12, 'Finding project…');
    var metadata = await fetchMetadata(id);
    progress(34, 'Downloading project…');
    var url = 'https://projects.scratch.mit.edu/' + encodeURIComponent(id);
    if (metadata.project_token) url += '?token=' + encodeURIComponent(metadata.project_token);
    var response = await fetch(url, {cache: 'no-store'});
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

  function Player(options) {
    options = options || {};
    if (!window.Scaffolding || !window.Scaffolding.Scaffolding) throw new Error('The Scratch runtime failed to load.');

    this.statusText = options.statusText;
    this.progressBar = options.progressBar;
    this.loadingOverlay = options.loadingOverlay;
    this.errorOverlay = options.errorOverlay;
    this.errorText = options.errorText;
    this.autoStart = options.autoStart === true;
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
    if (typeof this.runtime.setAccentColor === 'function') this.runtime.setAccentColor('#1677ff');
    configureStorage(this.runtime);
    this.runtime.appendTo(options.container);
  }

  Player.prototype.progress = function (value, text) {
    if (this.statusText && text) this.statusText.textContent = text;
    if (this.progressBar) this.progressBar.style.width = Math.max(0, Math.min(100, value)) + '%';
  };

  Player.prototype.showLoading = function () {
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

  Player.prototype.showError = function (error) {
    this.hideLoading();
    if (this.errorText) this.errorText.textContent = error && error.message ? error.message : String(error);
    if (this.errorOverlay) this.errorOverlay.hidden = false;
    console.error(error);
  };

  Player.prototype.finishLoad = function () {
    this.progress(82, 'Starting runtime…');
    if (this.autoStart) {
      this.runtime.greenFlag();
    } else if (this.runtime.vm && typeof this.runtime.vm.start === 'function') {
      this.runtime.vm.start();
    }
    this.loaded = true;
    this.progress(100, this.autoStart ? 'Ready' : 'Ready — press ▶ to start');
    this.hideLoading();
    this.runtime.relayout();
  };

  Player.prototype.loadById = async function (value) {
    var id = parseProjectId(value);
    if (!id) throw new Error('Enter a valid Scratch project URL or numeric project ID.');
    this.showLoading();
    this.progress(5, 'Preparing Newphorus…');
    this.projectId = id;
    try {
      var result = await fetchProject(id, this.progress.bind(this));
      this.projectTitle = result.metadata.title || ('Scratch project ' + id);
      this.progress(68, 'Loading blocks and assets…');
      await this.runtime.loadProject(result.buffer);
      this.finishLoad();
      return {id: id, title: this.projectTitle, url: SCRATCH_PREFIX + id + '/'};
    } catch (error) {
      this.showError(error);
      throw error;
    }
  };

  Player.prototype.loadFile = async function (file) {
    if (!file) throw new Error('No project file selected.');
    var ext = (file.name.split('.').pop() || '').toLowerCase();
    if (['sb', 'sb2', 'sb3'].indexOf(ext) === -1) throw new Error('Unsupported file type. Open a .sb, .sb2, or .sb3 project.');
    this.showLoading();
    this.progress(12, 'Reading ' + file.name + '…');
    this.projectId = '';
    this.projectTitle = file.name;
    try {
      var buffer = await file.arrayBuffer();
      this.progress(58, 'Loading blocks and assets…');
      await this.runtime.loadProject(buffer);
      this.finishLoad();
      return {id: '', title: file.name, url: ''};
    } catch (error) {
      this.showError(error);
      throw error;
    }
  };

  Player.prototype.greenFlag = function () {
    if (this.loaded) this.runtime.greenFlag();
  };

  Player.prototype.stopAll = function () {
    if (this.loaded) this.runtime.stopAll();
  };

  Player.prototype.setTurbo = function (enabled) {
    this.turbo = !!enabled;
    if (this.runtime.vm && typeof this.runtime.vm.setTurboMode === 'function') this.runtime.vm.setTurboMode(this.turbo);
    return this.turbo;
  };

  Player.prototype.toggleTurbo = function () {
    return this.setTurbo(!this.turbo);
  };

  Player.prototype.relayout = function () {
    this.runtime.relayout();
  };

  function requestFullscreen(element, player) {
    var request = element.requestFullscreen || element.webkitRequestFullscreen;
    if (!request) return;
    var result = request.call(element);
    if (result && result.catch) result.catch(console.error);
    setTimeout(player.relayout.bind(player), 50);
  }

  function wireControls(player, fullscreenElement) {
    document.getElementById('flag-button').addEventListener('click', player.greenFlag.bind(player));
    document.getElementById('stop-button').addEventListener('click', player.stopAll.bind(player));
    document.getElementById('turbo-button').addEventListener('click', function (event) {
      event.currentTarget.setAttribute('aria-pressed', player.toggleTurbo() ? 'true' : 'false');
    });
    document.getElementById('fullscreen-button').addEventListener('click', function () {
      requestFullscreen(fullscreenElement, player);
    });
    ['fullscreenchange', 'webkitfullscreenchange'].forEach(function (name) {
      document.addEventListener(name, function () { setTimeout(player.relayout.bind(player), 50); });
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
          '" width="482" height="420" allowfullscreen></iframe>';
        standalone.href = makeURL('app.html', {id: info.id}).href;
      } else {
        scratchLink.hidden = true;
        embedCode.value = 'Local files cannot be embedded by URL.';
        standalone.removeAttribute('href');
      }
      setTimeout(function () { section.scrollIntoView({behavior: 'smooth', block: 'start'}); }, 30);
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
      } catch (error) {}
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
      } catch (error) {}
    }

    fileInput.addEventListener('change', function () {
      loadLocal(fileInput.files && fileInput.files[0]);
      fileInput.value = '';
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
    }
    return player;
  }

  function bootstrapStandalone() {
    var params = new URLSearchParams(location.search);
    var id = parseProjectId(params.get('id'));
    var player = makePlayer(false);
    if (params.get('turbo') === 'true') {
      player.setTurbo(true);
      document.getElementById('turbo-button').setAttribute('aria-pressed', 'true');
    }
    wireControls(player, document.getElementById('app-player'));
    if (!id) {
      player.showError(new Error('No project ID was provided.'));
      return player;
    }
    player.loadById(id).then(function (info) {
      document.title = info.title + ' · Newphorus';
      document.getElementById('project-title').textContent = info.title;
    }).catch(function () {});
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
      if (parent !== window) parent.postMessage({type: 'newphorus-error', id: id, message: error.message}, '*');
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