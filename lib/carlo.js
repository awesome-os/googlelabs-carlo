/**
 * Copyright 2024 Google Inc. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the 'License');
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an 'AS IS' BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';

const path = require('path');
const puppeteer = require('puppeteer-core');
const findChrome = require('./find_chrome');
const {rpc} = require('../rpc');
const debugApp = require('debug')('carlo:app');
const debugServer = require('debug')('carlo:server');
const {Color} = require('./color');
const {HttpRequest} = require('./http_request');

const fs = require('fs');
const util = require('util');
const {URL} = require('url');
const EventEmitter = require('events');
const fsReadFile = util.promisify(fs.readFile);

let testMode = false;

class App extends EventEmitter {
  /**
   * @param {!import('puppeteer-core').Browser} browser Puppeteer browser
   * @param {!Object} options
   */
  constructor(browser, options) {
    super();
    this.browser_ = browser;
    this.options_ = options;
    this.windows_ = new Map();
    this.exposedFunctions_ = new Map();
    this.pendingWindows_ = new Map();
    this.windowSeq_ = 0;
    this.www_ = [];
    this.browserContext_ = browser.defaultBrowserContext();
  }

  async init_() {
    debugApp('Configuring browser');

    this.session_ = await this.browser_.target().createCDPSession();
    if (this.options_.icon) {
      await this.setIcon(this.options_.icon);
    }

    await this.browserContext_.overridePermissions('https://domain', [
      'geolocation',
      'midi',
      'notifications',
      'camera',
      'microphone',
      'clipboard-read',
      'clipboard-write'
    ]);

    this.browser_.on('targetcreated', this.targetCreated_.bind(this));

    const pages = await this.browser_.pages();
    const page = pages.length > 0 ? pages[0] : await this.browser_.newPage();

    let callback;
    const result = new Promise(f => callback = f);
    this.pendingWindows_.set('', { options: this.options_, callback });
    await this.pageCreated_(page);
    return result;
  }

  /**
   * Close the app windows.
   */
  async exit() {
    debugApp('app.exit...');
    if (this.exited_) return;
    this.exited_ = true;
    await this.browser_.close();
    this.emit(App.Events.Exit);
  }

  /**
   * @return {Window | undefined} main window.
   */
  mainWindow() {
    return this.windows_.values().next().value;
  }

  /**
   * @param {!Object=} options
   * @return {!Promise<Window>}
   */
  async createWindow(options = {}) {
    options = { ...this.options_, ...options };
    const seq = String(++this.windowSeq_);
    if (!this.windows_.size) {
      throw new Error('Needs at least one window to create more.');
    }

    const params = [];
    for (const prop of ['top', 'left', 'width', 'height']) {
      if (typeof options[prop] === 'number') {
        params.push(`${prop}=${options[prop]}`);
      }
    }

    const mainWindow = this.mainWindow();
    if (mainWindow) {
        await mainWindow.page_.evaluate(`window.open('about:blank?seq=${seq}', '', '${params.join(',')}')`);
    } else {
        throw new Error('Main window not found to create a new window from.');
    }

    return new Promise(callback => {
      this.pendingWindows_.set(seq, { options, callback });
    });
  }

  /**
   * @return {!Array<!Window>}
   */
  windows() {
    return Array.from(this.windows_.values());
  }

  /**
   * @param {string} name
   * @param {Function} func
   * @return {!Promise<void>}
   */
  async exposeFunction(name, func) {
    this.exposedFunctions_.set(name, func);
    await Promise.all(this.windows().map(window => window.exposeFunction(name, func)));
  }

  /**
   * @param {Function|string} pageFunction
   * @param {...*} args
   * @return {!Promise<*>}
   */
  evaluate(pageFunction, ...args) {
    const mainWindow = this.mainWindow();
    if (!mainWindow) throw new Error("Main window not available for evaluation.");
    return mainWindow.evaluate(pageFunction, ...args);
  }

  /**
   * @param {string=} folder Folder with the web content.
   * @param {string=} prefix Only serve folder for requests with given prefix.
   */
  serveFolder(folder = '', prefix = '') {
    this.www_.push({folder, prefix: wrapPrefix(prefix)});
  }

  /**
   * @param {string} base
   * @param {string=} prefix
   */
  serveOrigin(base, prefix = '') {
    this.www_.push({baseURL: new URL(base + '/'), prefix: wrapPrefix(prefix)});
  }

  /**
   * @param {function(!HttpRequest)} handler
   */
  serveHandler(handler) {
    this.httpHandler_ = handler;
  }

  /**
   * @param {string=} uri
   * @param {...*} params
   * @return {!Promise<*>}
   */
  async load(uri = '', ...params) {
    const mainWindow = this.mainWindow();
    if (!mainWindow) throw new Error("Main window not available for loading content.");
    return mainWindow.load(uri, ...params);
  }

  /**
   * @param {string|!Buffer} icon
   */
  async setIcon(icon) {
    const buffer = typeof icon === 'string' ? await fsReadFile(icon) : icon;
    try {
        await this.session_?.send('Browser.setDockTile', { image: buffer.toString('base64') });
    } catch (e) {
        // Ignore errors, this feature might not be available on all platforms.
    }
  }

  /**
   * @return {!import('puppeteer-core').Browser}
   */
  browserForTest() {
    return this.browser_;
  }

  /**
   * @param {import('puppeteer-core').Target} target
   */
  async targetCreated_(target) {
    if (target.type() === 'page') {
        const page = await target.page();
        if (page) {
            this.pageCreated_(page);
        }
    }
  }

  /**
   * @param {!import('puppeteer-core').Page} page
   */
  async pageCreated_(page) {
    const url = page.url();
    debugApp('Page created at', url);
    const seq = url.startsWith('about:blank?seq=') ? url.substr('about:blank?seq='.length) : '';
    const params = this.pendingWindows_.get(seq);
    const { callback, options } = params || { options: this.options_ };
    this.pendingWindows_.delete(seq);
    const window = new Window(this, page, options || {});
    await window.init_();
    this.windows_.set(page, window);
    if (callback) {
      callback(window);
    }
    this.emit(App.Events.Window, window);
  }

  /**
   * @param {!Window} window
   */
  windowClosed_(window) {
    debugApp('window closed', window.loadURI_);
    this.windows_.delete(window.page_);
    if (this.windows_.size === 0) {
      this.exit();
    }
  }
}

App.Events = {
  Exit: 'exit',
  Window: 'window'
};

class Window extends EventEmitter {
  /**
   * @param {!App} app
   * @param {!import('puppeteer-core').Page} page
   * @param {!Object} options
   */
  constructor(app, page, options) {
    super();
    this.app_ = app;
    this.options_ = { ...app.options_, ...options };
    this.www_ = [];
    this.page_ = page;
    this.page_.on('close', () => this.closed_());
    this.page_.on('domcontentloaded', () => this.domContentLoaded_());
    this.hostHandle_ = rpc.handle(new HostWindow(this));
  }

  async init_() {
    debugApp('Configuring window');
    const bgcolor = Color.parse(this.options_.bgcolor);
    const bgcolorRGBA = bgcolor.canonicalRGBA();
    this.session_ = await this.page_.createCDPSession();

    await Promise.all([
      this.session_.send('Runtime.evaluate', { expression: 'self.paramsForReuse', returnByValue: true })
        .then(response => { this.paramsForReuse_ = response.result.value; }),
      this.session_.send('Emulation.setDefaultBackgroundColorOverride', {
        color: { r: bgcolorRGBA[0], g: bgcolorRGBA[1], b: bgcolorRGBA[2], a: bgcolorRGBA[3] * 255 }
      }),
      this.getWindowId_().then(windowId => {
          if (windowId) return this.initBounds_(windowId);
      }),
      this.configureRpcOnce_(),
      ...Array.from(this.app_.exposedFunctions_.entries()).map(([name, func]) => this.exposeFunction(name, func))
    ]);
  }

  /**
   * @private
   */
  async getWindowId_() {
      const target = this.page_.target();
      // In modern Puppeteer, direct access to _targetInfo is discouraged.
      // We can get the window ID via the CDP session.
      try {
        const { windowId } = (await this.app_.session_?.send('Browser.getWindowForTarget', { targetId: target._targetId }));
        return windowId;
      } catch (e) {
        debugApp('Could not get windowId for target');
        return null;
      }
  }

  /**
   * @param {string} name
   * @param {Function} func
   * @return {!Promise<void>}
   */
  async exposeFunction(name, func) {
    debugApp('Exposing function', name);
    // Functions are now exposed on the page level.
    await this.page_.exposeFunction(name, func);
  }

  /**
   * @param {Function|string} pageFunction
   * @param {...*} args
   * @return {!Promise<*>}
   */
  evaluate(pageFunction, ...args) {
    return this.page_.evaluate(pageFunction, ...args);
  }

  /**
   * @param {string=} folder
   * @param {string=} prefix
   */
  serveFolder(folder = '', prefix = '') {
    this.www_.push({folder, prefix: wrapPrefix(prefix)});
  }

  /**
   * @param {string} base
   * @param {string=} prefix
   */
  serveOrigin(base, prefix = '') {
    this.www_.push({baseURL: new URL(base + '/'), prefix: wrapPrefix(prefix)});
  }

  /**
   * @param {function(!HttpRequest)} handler
   */
  serveHandler(handler) {
    this.httpHandler_ = handler;
  }

  /**
   * @param {string=} uri
   * @param {...*} params
   * @return {!Promise<void>}
   */
  async load(uri = '', ...params) {
    debugApp('Load page', uri);
    this.loadURI_ = uri;
    this.loadParams_ = params;
    await this.initializeInterception_();
    debugApp('Navigating the page to', this.loadURI_);

    const result = new Promise(f => this.domContentLoadedCallback_ = f);
    // 'waitFor' option is deprecated, use 'waitUntil'
    await this.page_.goto(new URL(this.loadURI_, 'https://domain/').toString(), { timeout: 0, waitUntil: 'domcontentloaded' });
    try {
        // This is an experimental feature, so wrap in try-catch
        await this.session_?.send('Page.resetNavigationHistory');
    } catch(e) {
        // Ignore errors if the feature is not available.
    }
    await result;
  }

  /**
   * @private
   */
  async initBounds_(windowId) {
    this.windowId_ = windowId;
    return this.setBounds({
      top: this.options_.top,
      left: this.options_.left,
      width: this.options_.width,
      height: this.options_.height
    });
  }

  /**
   * @return {!import('puppeteer-core').Page}
   */
  pageForTest() {
    return this.page_;
  }

  /**
   * @return {*}
   */
  paramsForReuse() {
    return this.paramsForReuse_;
  }

  /**
   * @private
   */
  async configureRpcOnce_() {
    await this.page_.exposeFunction('receivedFromChild', data => this.receivedFromChild_?.(data));

    const rpcFile = (await fsReadFile(path.join(__dirname, '/../rpc/rpc.js'))).toString();
    const features = [
      require('./features/shortcuts.js'),
      require('./features/file_info.js')
    ];

    // Use evaluateOnNewDocument to ensure RPC is set up early.
    await this.page_.evaluateOnNewDocument((rpcFile, featuresAsStrings) => {
      const module = { exports: {} };
      eval(rpcFile);
      self.rpc = module.exports;
      self.carlo = {};
      let argvCallback;
      const argvPromise = new Promise(f => argvCallback = f);
      self.carlo.loadParams = () => argvPromise;

      function transport(receivedFromParent) {
        self.receivedFromParent = receivedFromParent;
        return window.receivedFromChild;
      }

      self.rpc.initWorld(transport, async(loadParams, win) => {
        argvCallback(loadParams);
        if (document.readyState === 'loading') {
          await new Promise(f => document.addEventListener('DOMContentLoaded', f));
        }
        for (const featureStr of featuresAsStrings) {
            eval(`(${featureStr})`)(win);
        }
      });
    }, rpcFile, features.map(f => f.toString()));
  }

  /**
   * @private
   */
  async domContentLoaded_() {
    debugApp('Creating rpc world for page...');
    const transport = receivedFromChild => {
      this.receivedFromChild_ = receivedFromChild;
      return data => {
        const json = JSON.stringify(data);
        if (this.session_ && !this.session_.isClosed()) {
          this.session_.send('Runtime.evaluate', {expression: `self.receivedFromParent(${json})`}).catch(() => {});
        }
      };
    };
    if (this._lastWebWorldId) {
      rpc.disposeWorld(this._lastWebWorldId);
    }
    const { worldId } = await rpc.createWorld(transport, this.loadParams_, this.hostHandle_);
    debugApp('World created', worldId);
    this._lastWebWorldId = worldId;

    if (this.domContentLoadedCallback_) {
        this.domContentLoadedCallback_();
        this.domContentLoadedCallback_ = null;
    }
  }

  /**
   * @private
   */
  async initializeInterception_() {
    debugApp('Initializing network interception...');
    if (this.interceptionInitialized_) return;

    if (this.www_.length + this.app_.www_.length === 0 && !this.httpHandler_ && !this.app_.httpHandler_) return;

    this.interceptionInitialized_ = true;
    // Set request interception at the page level.
    await this.page_.setRequestInterception(true);
    this.page_.on('request', this.requestIntercepted_.bind(this));
  }

  /**
   * @param {import('puppeteer-core').HTTPRequest} request
   */
  async requestIntercepted_(request) {
      debugServer('intercepted:', request.url());
      const handlers = [];
      if (this.httpHandler_) handlers.push(this.httpHandler_);
      if (this.app_.httpHandler_) handlers.push(this.app_.httpHandler_);
      handlers.push(this.handleRequest_.bind(this));
      // The HttpRequest class will need to be adapted to the modern request object.
      // This example assumes HttpRequest is refactored to work with the puppeteer request.
      new HttpRequest(request, handlers);
  }

  /**
   * @param {!HttpRequest} request
   */
  async handleRequest_(request) {
    const url = new URL(request.url());
    debugServer('request url:', url.toString());

    if (url.hostname !== 'domain') {
      return request.continue();
    }

    const urlpathname = url.pathname;
    for (const {prefix, folder, baseURL} of [...this.app_.www_, ...this.www_]) {
      debugServer('prefix:', prefix);
      if (!urlpathname.startsWith(prefix)) continue;

      const pathname = urlpathname.substring(prefix.length);
      debugServer('pathname:', pathname);
      if (baseURL) {
        return request.continue({ url: new URL(pathname, baseURL).toString() });
      }
      const fileName = path.join(folder, pathname);
      if (!fs.existsSync(fileName)) continue;

      const headers = { 'content-type': contentType(request, fileName) };
      const body = await fsReadFile(fileName);
      return request.respond({ headers, body });
    }
    request.continue();
  }

  /**
   * @return {{left: number, top: number, width: number, height: number}}
   */
  async bounds() {
    const { bounds } = await this.app_.session_?.send('Browser.getWindowBounds', { windowId: this.windowId_ });
    return { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height };
  }

  /**
   * @param {{left: (number|undefined), top: (number|undefined), width: (number|undefined), height: (number|undefined)}} bounds
   */
  async setBounds(bounds) {
    await this.app_.session_?.send('Browser.setWindowBounds', { windowId: this.windowId_, bounds });
  }

  async fullscreen() {
    await this.setBounds({ windowState: 'fullscreen' });
  }

  async minimize() {
    await this.setBounds({ windowState: 'minimized' });
  }

  async maximize() {
    await this.setBounds({ windowState: 'maximized' });
  }

  bringToFront() {
    return this.page_.bringToFront();
  }

  close() {
    return this.page_.close();
  }

  /**
   * @private
   */
  closed_() {
    rpc.dispose(this.hostHandle_);
    this.app_.windowClosed_(this);
    this.emit(Window.Events.Close);
  }

  /**
   * @return {boolean}
   */
  isClosed() {
    return this.page_.isClosed();
  }
}

Window.Events = {
  Close: 'close',
};


const imageContentTypes = new Map([
  ['jpeg', 'image/jpeg'], ['jpg', 'image/jpeg'], ['svg', 'image/svg+xml'], ['gif', 'image/gif'], ['webp', 'image/webp'],
  ['png', 'image/png'], ['ico', 'image/ico'], ['tiff', 'image/tiff'], ['tif', 'image/tiff'], ['bmp', 'image/bmp']
]);

const fontContentTypes = new Map([
  ['ttf', 'font/opentype'], ['otf', 'font/opentype'], ['ttc', 'font/opentype'], ['woff', 'application/font-woff']
]);

/**
 * @param {import('puppeteer-core').HTTPRequest} request
 * @param {string} fileName
 */
function contentType(request, fileName) {
  const dotIndex = fileName.lastIndexOf('.');
  const extension = fileName.substr(dotIndex + 1);
  const resourceType = request.resourceType();
  switch (resourceType) {
    case 'document': return 'text/html';
    case 'script': return 'text/javascript';
    case 'stylesheet': return 'text/css';
    case 'image':
      return imageContentTypes.get(extension) || 'image/png';
    case 'font':
      return fontContentTypes.get(extension) || 'application/font-woff';
    default: return 'application/octet-stream';
  }
}

/**
 * @param {!Object=} options
 * @return {!Promise<App>}
 */
async function launch(options = {}) {
  debugApp('Launching Carlo', options);
  options = { ...options };
  if (!options.bgcolor) options.bgcolor = '#ffffff';
  options.localDataDir = options.localDataDir || path.join(__dirname, '.local-data');

  const { executablePath, type } = await findChrome(options);
  if (!executablePath) {
    console.error('Could not find Chrome installation, please make sure Chrome browser is installed from https://www.google.com/chrome/.');
    process.exit(1);
  }

  const title = encodeURIComponent(options.title || '');
  const bgcolor = encodeURIComponent(options.bgcolor);
  const paramsForReuse = JSON.stringify(options.paramsForReuse || undefined);

  const targetPage = `data:text/html,<title>${title}</title><style>html{background:${bgcolor};}</style><script>self.paramsForReuse = ${paramsForReuse};</script>`;

  const args = [
    `--app=${targetPage}`,
    `--enable-features=NetworkService,NetworkServiceInProcess`,
  ];

  if (options.args) args.push(...options.args);
  if (typeof options.width === 'number' && typeof options.height === 'number') {
    args.push(`--window-size=${options.width},${options.height}`);
  }
  if (typeof options.left === 'number' && typeof options.top === 'number') {
    args.push(`--window-position=${options.left},${options.top}`);
  }

  try {
    const browser = await puppeteer.launch({
      executablePath,
      pipe: true,
      defaultViewport: null,
      headless: testMode ? 'new' : false, // Updated headless mode
      userDataDir: options.userDataDir || path.join(options.localDataDir, `profile-${type}`),
      args
    });
    const app = new App(browser, options);
    await app.init_();
    return app;
  } catch (e) {
    if (e.message.includes('Target closed')) {
      throw new Error('Could not start the browser or the browser was already running with the given profile.');
    } else {
      throw e;
    }
  }
}

class HostWindow {
  /**
   * @param {!Window} win
   */
  constructor(win) {
    this.window_ = win;
  }

  closeBrowser() {
    setTimeout(() => this.window_.app_.exit(), 0);
  }

  async fileInfo(expression) {
    const { result } = await this.window_.session_?.send('Runtime.evaluate', { expression });
    return this.window_.session_?.send('DOM.getFileInfo', { objectId: result.objectId });
  }
}

function enterTestMode() {
  testMode = true;
}

function wrapPrefix(prefix) {
  let newPrefix = prefix;
  if (!newPrefix.startsWith('/')) newPrefix = '/' + newPrefix;
  if (!newPrefix.endsWith('/')) newPrefix += '/';
  return newPrefix;
}

module.exports = { launch, enterTestMode };
