import { createSignal } from '@bundled/solid-js';

export const [scoreS, setScoreS] = createSignal(0);
export const [hiS, setHiS] = createSignal(0);
export const [linesS, setLinesS] = createSignal(0);
export const [levelS, setLevelS] = createSignal(0);
export const [pausedS, setPausedS] = createSignal(false);
export const [gameOverS, setGameOverS] = createSignal(false);
export const [comboS, setComboS] = createSignal(0);
