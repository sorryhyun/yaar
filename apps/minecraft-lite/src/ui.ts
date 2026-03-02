import { html, mount } from '@bundled/yaar';

export const BASE_MESSAGE = 'Click to lock mouse. WASD move, Space jump, LMB break/attack, RMB place, E inventory/crafting.';

export function createUI(root: HTMLElement) {
  let hud!: HTMLDivElement;
  let center!: HTMLDivElement;
  let msg!: HTMLDivElement;
  let hotbar!: HTMLDivElement;
  let panel!: HTMLDivElement;

  mount(html`
    <div class="ui-hud" ref=${(el: HTMLDivElement) => { hud = el; }}></div>
    <div class="ui-center" ref=${(el: HTMLDivElement) => { center = el; }}>+</div>
    <div class="ui-msg" ref=${(el: HTMLDivElement) => { msg = el; }}>${BASE_MESSAGE}</div>
    <div class="ui-hotbar" ref=${(el: HTMLDivElement) => { hotbar = el; }}></div>
    <div class="ui-panel" ref=${(el: HTMLDivElement) => { panel = el; }}></div>
  `, root);

  return { hud, center, msg, hotbar, panel };
}
