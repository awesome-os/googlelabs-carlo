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

const debugServer = require('debug')('carlo:server');

/**
 * A wrapper around Puppeteer's HTTPRequest object that allows for a chain
 * of handlers to process the request.
 */
class HttpRequest {
  /**
   * @param {!import('puppeteer-core').HTTPRequest} request The intercepted request from Puppeteer.
   * @param {!Array<Function>} handlers An array of handler functions to process the request.
   */
  constructor(request, handlers) {
    this.request_ = request;
    this.handlers_ = handlers;
    this.done_ = false;
    this.callNextHandler_();
  }

  /**
   * @return {string} The URL of the request.
   */
  url() {
    return this.request_.url();
  }

  /**
   * @return {string} The HTTP method of the request.
   */
  method() {
    return this.request_.method();
  }

  /**
   * @return {!Object<string, string>} HTTP request headers.
   */
  headers() {
    return this.request_.headers();
  }

  /**
   * @return {string} The type of resource requested.
   */
  resourceType() {
    return this.request_.resourceType();
  }

  /**
   * Aborts the request.
   * @param {string} [errorCode='aborted'] The error code to abort with.
   */
  async abort(errorCode = 'aborted') {
    if (this.done_) return;
    this.done_ = true;
    debugServer('abort', this.url());
    await this.request_.abort(errorCode);
  }

  /**
   * Fails the request, which is a specific type of abortion.
   */
  fail() {
    debugServer('fail', this.url());
    return this.abort('failed');
  }

  /**
   * Passes the request to the next handler in the chain.
   * If there are no more handlers, the request is deferred to the browser.
   */
  continue() {
    if (this.done_) return;
    debugServer('continue to next handler', this.url());
    this.callNextHandler_();
  }

  /**
   * Continues the request, allowing it to be handled by the browser's networking stack.
   *
   * @param {Object} [overrides] Optional overrides for the request.
   * @param {string} [overrides.url] If set, the request URL will be changed.
   * @param {string} [overrides.method] If set, the request method will be changed.
   * @param {string} [overrides.postData] If set, the post data will be changed.
   * @param {Object<string, string>} [overrides.headers] If set, the request headers will be changed.
   */
  async deferToBrowser(overrides) {
    if (this.done_) return;
    this.done_ = true;
    debugServer('deferToBrowser', this.url());
    await this.request_.continue(overrides);
  }

  /**
   * Fulfills the request with a custom response.
   *
   * @param {Object} options
   * @param {number} [options.status=200] The HTTP status code.
   * @param {Object<string, string>} [options.headers] The response headers.
   * @param {Buffer|string} [options.body] The response body.
   */
  async fulfill({ status = 200, headers, body }) {
    if (this.done_) return;
    this.done_ = true;
    debugServer('fulfill', this.url());

    const responseHeaders = {};
    if (headers) {
      for (const header of Object.keys(headers)) {
        responseHeaders[header.toLowerCase()] = headers[header];
      }
    }

    if (body && !('content-length' in responseHeaders)) {
      responseHeaders['content-length'] = Buffer.byteLength(body);
    }

    await this.request_.respond({
      status,
      headers: responseHeaders,
      body
    });
  }

  /**
   * @private
   */
  callNextHandler_() {
    const handler = this.handlers_.shift();
    if (handler) {
      handler(this);
    } else {
      // If no more handlers are available, continue the request by default.
      this.deferToBrowser();
    }
  }
}

module.exports = { HttpRequest };
