import { animate, stagger } from '@bundled/anime';

/** Fade + slide an element in from below */
export function fadeIn(el: HTMLElement, delay = 0): void {
  animate(el, {
    opacity: [0, 1],
    translateY: [10, 0],
    delay,
    duration: 260,
    ease: 'easeOutCubic',
  });
}

/** Slide in multiple elements with stagger */
export function staggerIn(els: HTMLElement[]): void {
  if (!els.length) return;
  animate(els as unknown as HTMLElement, {
    opacity: [0, 1],
    translateX: [-14, 0],
    duration: 220,
    delay: stagger(40),
    ease: 'easeOutCubic',
  });
}

/** Fade + slide an element out, then remove from DOM */
export function fadeOutRemove(el: HTMLElement): void {
  animate(el, {
    opacity: [1, 0],
    translateX: [0, -14],
    duration: 180,
    ease: 'easeInCubic',
  }).then(() => el.remove());
}

/** Animate a section/panel into view (for mode transitions) */
export function sectionIn(el: HTMLElement): void {
  animate(el, {
    opacity: [0, 1],
    translateY: [8, 0],
    duration: 300,
    ease: 'easeOutCubic',
  });
}

/** Pop in a new element (for timeline blocks) */
export function popIn(el: HTMLElement): void {
  animate(el, {
    opacity: [0, 1],
    scaleX: [0.5, 1],
    duration: 240,
    ease: 'easeOutBack',
  });
}
