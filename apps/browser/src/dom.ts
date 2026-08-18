/**
 * DOM elements the still-screenshot path shares.
 *
 * The `<img>` is owned by the view but written to by two modules — actions.ts on a
 * refresh and sse.ts on every poll tick — so it lives here, in a module that imports
 * nothing. That is what lets both of them reach it with a plain static import: sse.ts
 * used to `import('./actions')` *inside its 200 ms interval* purely to break the cycle
 * this file removes.
 */

let screenshotEl: HTMLImageElement | null = null;

export function setScreenshotEl(el: HTMLImageElement): void {
  screenshotEl = el;
}

/** Null until the view has mounted; every caller runs on a timer or an event, so both happen. */
export function getScreenshotEl(): HTMLImageElement | null {
  return screenshotEl;
}
