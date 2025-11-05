// New test using Jest
// No test runner setup is needed in the file! Jest handles it.

const carlo = require('../lib/carlo');

// Set a longer timeout for this test suite if needed.
// Jest's default is 5 seconds. This increases it to 30 seconds.
jest.setTimeout(30000);

describe('app reuse', () => {
  let app;

  // Jest's `afterEach` hook to ensure the app is closed after the test.
  afterEach(async () => {
    if (app) {
      await app.exit();
      app = null;
    }
  });

  // `fit` is replaced by `it.only` to run a single test.
  // For a normal test, just use `it`.
  it.only('a second launch attempt should pass params to the original window', async () => {
    app = await carlo.launch();

    let newWindow;
    const windowPromise = new Promise(resolve => newWindow = resolve);
    app.on('window', newWindow);

    // Jest has built-in support for testing promises and errors.
    await expect(carlo.launch({ paramsForReuse: { val: 42 } }))
      .rejects.toThrow('already running');

    const window = await windowPromise;
    expect(window.paramsForReuse()).toEqual({ val: 42 });
  });
});
