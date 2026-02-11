/**
 * Type definitions for @bundled/anime — animation library.
 */

declare module '@bundled/anime' {
  interface AnimeParams {
    targets: string | Element | Element[] | NodeList | object | object[];

    // Transforms
    translateX?: number | string | (number | string)[];
    translateY?: number | string | (number | string)[];
    translateZ?: number | string | (number | string)[];
    rotate?: number | string | (number | string)[];
    rotateX?: number | string | (number | string)[];
    rotateY?: number | string | (number | string)[];
    rotateZ?: number | string | (number | string)[];
    scale?: number | (number)[];
    scaleX?: number | (number)[];
    scaleY?: number | (number)[];
    skew?: number | string | (number | string)[];
    skewX?: number | string | (number | string)[];
    skewY?: number | string | (number | string)[];

    // CSS properties (any CSS property works)
    opacity?: number | (number)[];
    backgroundColor?: string | string[];
    color?: string | string[];
    width?: number | string | (number | string)[];
    height?: number | string | (number | string)[];
    top?: number | string | (number | string)[];
    left?: number | string | (number | string)[];
    borderRadius?: number | string | (number | string)[];

    // SVG attributes
    points?: string;
    strokeDashoffset?: number | string | (number | string)[];
    d?: string;

    // Animation timing
    duration?: number;
    delay?: number | ((el: Element, i: number, total: number) => number);
    endDelay?: number;
    easing?: string;

    // Animation behavior
    round?: number;
    loop?: boolean | number;
    direction?: 'normal' | 'reverse' | 'alternate';
    autoplay?: boolean;

    // Keyframes
    keyframes?: AnimeParams[];

    // Callbacks
    begin?: (anim: AnimeInstance) => void;
    update?: (anim: AnimeInstance) => void;
    complete?: (anim: AnimeInstance) => void;
    loopBegin?: (anim: AnimeInstance) => void;
    loopComplete?: (anim: AnimeInstance) => void;
    changeBegin?: (anim: AnimeInstance) => void;
    changeComplete?: (anim: AnimeInstance) => void;

    // Allow any CSS/SVG property
    [key: string]: unknown;
  }

  interface AnimeInstance {
    play(): void;
    pause(): void;
    restart(): void;
    reverse(): void;
    seek(time: number): void;
    finished: Promise<void>;
    began: boolean;
    paused: boolean;
    completed: boolean;
    progress: number;
    currentTime: number;
    duration: number;
  }

  interface AnimeTimelineInstance extends AnimeInstance {
    add(params: AnimeParams, offset?: number | string): AnimeTimelineInstance;
  }

  interface AnimeStatic {
    (params: AnimeParams): AnimeInstance;
    timeline(params?: Partial<AnimeParams>): AnimeTimelineInstance;
    stagger(value: number | string | (number | string)[], options?: {
      start?: number | string;
      from?: number | string | 'first' | 'last' | 'center';
      direction?: 'normal' | 'reverse';
      easing?: string;
      grid?: [number, number];
      axis?: 'x' | 'y';
    }): (el: Element, i: number, total: number) => number;
    set(targets: AnimeParams['targets'], values: Partial<AnimeParams>): void;
    remove(targets: AnimeParams['targets']): void;
    get(targets: Element, prop: string): string | number;
    random(min: number, max: number): number;
    running: AnimeInstance[];

    // Easing functions
    easing: {
      [key: string]: (t: number) => number;
    };
  }

  const anime: AnimeStatic;
  export default anime;
}
