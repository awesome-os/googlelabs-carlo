
## update lib/http_request => httpRequest 

Key Improvements in the Upgraded Code
Modern API Usage: The constructor now accepts the official HTTPRequest object from Puppeteer, completely removing the need to manage the CDPSession and raw CDP event parameters.
Simplified Actions:
abort(), fail(), deferToBrowser() (previously continue with overrides), and fulfill() now map directly to the cleaner methods on the HTTPRequest object (request.abort(), request.continue(), and request.respond()).
This eliminates the complex manual creation of raw HTTP responses that was required in the fulfill method of the old version.
Clearer Naming: The old continue() method was ambiguous. In the new version, continue() is reserved for passing control to the next handler, while deferToBrowser() is used for passing the request to the browser's network stack, which aligns better with modern API terminology.
Robustness: The code is more robust as it relies on Puppeteer's stable high-level API rather than lower-level CDP commands, which can change between Chrome versions.
Asynchronous Operations: The action methods are now properly async as they await the underlying Puppeteer calls, ensuring correct execution flow.

## update lib/carlo
Summary of Key Changes
Headless Mode: The headless option in puppeteer.launch now accepts 'new' for the new headless mode, which is recommended over the boolean true. The code is updated to reflect this.
Browser Context for Permissions: overridePermissions is now a method on the BrowserContext object, not the Browser. The code now correctly calls it on browser.defaultBrowserContext().
Page Navigation: The waitFor option in page.goto has been deprecated. The modern equivalent is waitUntil, so the code is updated to use waitUntil: 'domcontentloaded'.
CDP Session Creation: Instead of creating a session from the browser's main target, it's now more common and robust to create it from a specific page target. The code now uses page.createCDPSession() within the Window class.
Request Interception: The Network.requestIntercepted event and Network.setRequestInterception command now operate on a per-page basis. The updated code enables interception via page.setRequestInterception(true) and listens for the 'request' event on the page object.
ES6+ and Modern Practices: The code has been updated to use more modern JavaScript features like async/await more consistently and object destructuring for cleaner code.
Error Handling and Optional Chaining: Added optional chaining (?.) for CDP session calls to prevent errors if the session is not available, and included more robust error handling in launch.
HttpRequest Class Adaptation (Assumption): The HttpRequest class, which was not provided, would need to be refactored. The original code passed a CDP payload to its constructor. The upgraded version passes the modern Puppeteer HTTPRequest object, which has methods like continue(), respond(), and abort(). The handleRequest_ method has been updated to use these new methods.
