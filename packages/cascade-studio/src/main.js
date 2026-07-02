// CascadeStudio ES Module Entry Point
import { CascadeStudioApp } from './CascadeMain.js';

// Build stamp so it's always verifiable which bundle a tab is running
console.log('Chisel build: ' + (typeof BUILD_STAMP !== 'undefined' ? BUILD_STAMP : 'dev (unbundled)'));

// Start the application when the DOM is ready
const app = new CascadeStudioApp();
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => app.start());
} else {
    app.start();
}
