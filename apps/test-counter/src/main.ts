export {};
import { createSignal } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { render } from '@bundled/solid-js/web';
import './styles.css';

function App() {
  const [count, setCount] = createSignal(0);

  return html`
    <div class="app">
      <div class="label">클릭 횟수</div>
      <div class="counter">${count}</div>
      <button class="y-btn y-btn-primary" onClick=${() => setCount(c => c + 1)}>
        Hello from DevTools!
      </button>
    </div>
  `;
}

render(() => html`<${App} />`, document.body);
