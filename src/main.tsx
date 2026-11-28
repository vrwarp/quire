import { render } from 'preact';
import './styles/index.css';
import { App } from './app';
import { ErrorBoundary } from './components/ErrorBoundary';
import { installGlobalDiagnostics } from './engine/diagnostics';

installGlobalDiagnostics();

render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
  document.getElementById('app')!
);
