import { render } from 'preact';
import './styles/index.css';
import { App } from './app';

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {
      // Non-fatal if SW registration fails in restricted context
    });
  });
}

render(<App />, document.getElementById('app')!);
