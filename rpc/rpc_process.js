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

const child_process = require('child_process');
const rpc = require('./rpc'); // Assumes rpc.js is in the same directory

/**
 * Spawns a new Node.js process and establishes an RPC world within it.
 * This function is called from the parent process.
 *
 * @param {string} fileName - The path to the JavaScript file to run in the new process.
 * @param {...*} args - Arguments to pass to the new world's initializer.
 * @returns {Promise<*>} A handle to the object returned by the child world's initializer.
 */
async function spawn(fileName, ...args) {
  // Fork the process. The 'ipc' flag is crucial for enabling the message channel.
  const child = child_process.fork(fileName, [], {
    detached: true,
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'] // stdin, stdout, stderr, ipc
  });

  /**
   * This is the transport function required by rpc.createWorld.
   * It bridges the gap between the generic RPC system and the specific
   * Node.js child_process messaging API.
   * @param {function(object): void} receivedFromChild - The callback that rpc.js provides to handle incoming messages.
   * @returns {function(object): void} A function that can be used to send messages to the child.
   */
  const transport = (receivedFromChild) => {
    // When the child process sends a message, pass it to the RPC system.
    child.on('message', receivedFromChild);
    // Return a function that the RPC system can use to send messages to the child.
    return child.send.bind(child);
  };

  // Create the new RPC world, passing the transport and any initial arguments.
  const { result } = await rpc.createWorld(transport, ...args);

  // When the child process exits, we can optionally clean up.
  child.on('exit', () => console.log(`Child process ${fileName} exited.`));

  return result;
}

/**
 * Initializes the RPC world within a newly spawned child process.
 * This function is called from within the child script.
 *
 * @param {function(...*): Promise<*> | *} initializer - The function to run when the world is initialized.
 *   It receives the arguments passed from the parent's `spawn` call. Its return value
 *   is sent back to the parent.
 */
function init(initializer) {
  /**
   * The transport function for the child's perspective.
   * @param {function(object): void} receivedFromParent - The callback from rpc.js for handling incoming messages.
   * @returns {function(object): void} A function for sending messages to the parent.
   */
  const transport = (receivedFromParent) => {
    // When the parent process sends a message, pass it to the RPC system.
    process.on('message', receivedFromParent);
    // Return a function that the RPC system can use to send messages to the parent.
    return process.send.bind(process);
  };

  // Initialize this process as an RPC world.
  rpc.initWorld(transport, initializer);
}

module.exports = { spawn, init };
