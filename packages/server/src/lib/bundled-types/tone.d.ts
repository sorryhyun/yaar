/**
 * Type definitions for @bundled/tone — audio synthesis and music library.
 */

declare module '@bundled/tone' {
  type Note = string | number;
  type Time = string | number;
  type NormalRange = number;
  type Frequency = string | number;

  // Core

  interface ToneAudioNodeOptions {
    context?: unknown;
  }

  class ToneAudioNode {
    connect(destination: ToneAudioNode | AudioNode): this;
    disconnect(destination?: ToneAudioNode | AudioNode): this;
    dispose(): this;
    toDestination(): this;
    chain(...nodes: (ToneAudioNode | AudioNode)[]): this;
    fan(...nodes: (ToneAudioNode | AudioNode)[]): this;
  }

  // Destination
  export const Destination: ToneAudioNode & {
    volume: Signal;
    mute: boolean;
  };

  export function getDestination(): typeof Destination;

  // Context / start
  export function start(): Promise<void>;
  export function now(): number;
  export function getContext(): unknown;
  export function setContext(ctx: unknown): void;
  export const context: unknown;
  export const loaded: Promise<void>;

  // Signal
  interface Signal extends ToneAudioNode {
    value: number;
    setValueAtTime(value: number, time: Time): this;
    linearRampToValueAtTime(value: number, endTime: Time): this;
    exponentialRampToValueAtTime(value: number, endTime: Time): this;
    rampTo(value: number, rampTime?: Time, startTime?: Time): this;
    cancelScheduledValues(time?: Time): this;
  }

  // Synths

  interface SynthOptions {
    oscillator?: { type?: 'sine' | 'square' | 'sawtooth' | 'triangle' | 'fmsine' | 'fmsquare' | 'amsine' | 'amsquare' | 'fatsine' | 'fatsquare' | 'pulse' };
    envelope?: { attack?: Time; decay?: Time; sustain?: NormalRange; release?: Time };
    volume?: number;
    portamento?: number;
  }

  export class Synth extends ToneAudioNode {
    volume: Signal;
    constructor(options?: SynthOptions);
    triggerAttack(note: Note, time?: Time, velocity?: NormalRange): this;
    triggerRelease(time?: Time): this;
    triggerAttackRelease(note: Note, duration: Time, time?: Time, velocity?: NormalRange): this;
    setNote(note: Note): this;
    dispose(): this;
  }

  interface PolySynthOptions {
    maxPolyphony?: number;
    voice?: typeof Synth;
    options?: SynthOptions;
    volume?: number;
  }

  export class PolySynth extends ToneAudioNode {
    volume: Signal;
    constructor(options?: PolySynthOptions);
    constructor(voice?: typeof Synth, options?: SynthOptions);
    triggerAttack(notes: Note | Note[], time?: Time, velocity?: NormalRange): this;
    triggerRelease(notes: Note | Note[], time?: Time): this;
    triggerAttackRelease(notes: Note | Note[], duration: Time | Time[], time?: Time, velocity?: NormalRange): this;
    releaseAll(time?: Time): this;
    set(options: Partial<SynthOptions>): this;
    dispose(): this;
  }

  export class MonoSynth extends ToneAudioNode {
    volume: Signal;
    constructor(options?: SynthOptions & { filter?: { Q?: number; type?: string; rolloff?: number }; filterEnvelope?: { attack?: Time; decay?: Time; sustain?: NormalRange; release?: Time; baseFrequency?: Frequency; octaves?: number } });
    triggerAttack(note: Note, time?: Time, velocity?: NormalRange): this;
    triggerRelease(time?: Time): this;
    triggerAttackRelease(note: Note, duration: Time, time?: Time, velocity?: NormalRange): this;
    dispose(): this;
  }

  export class FMSynth extends Synth {
    modulationIndex: Signal;
    harmonicity: Signal;
    constructor(options?: SynthOptions & { modulationIndex?: number; harmonicity?: number });
  }

  export class AMSynth extends Synth {
    harmonicity: Signal;
    constructor(options?: SynthOptions & { harmonicity?: number });
  }

  export class MembraneSynth extends Synth {
    pitchDecay: number;
    octaves: number;
    constructor(options?: SynthOptions & { pitchDecay?: number; octaves?: number });
  }

  export class MetalSynth extends ToneAudioNode {
    volume: Signal;
    frequency: Signal;
    constructor(options?: { frequency?: number; envelope?: { attack?: Time; decay?: Time; release?: Time }; harmonicity?: number; modulationIndex?: number; resonance?: number; octaves?: number; volume?: number });
    triggerAttack(time?: Time, velocity?: NormalRange): this;
    triggerRelease(time?: Time): this;
    triggerAttackRelease(duration: Time, time?: Time, velocity?: NormalRange): this;
    dispose(): this;
  }

  export class NoiseSynth extends ToneAudioNode {
    volume: Signal;
    constructor(options?: { noise?: { type?: 'white' | 'brown' | 'pink' }; envelope?: { attack?: Time; decay?: Time; sustain?: NormalRange; release?: Time }; volume?: number });
    triggerAttack(time?: Time, velocity?: NormalRange): this;
    triggerRelease(time?: Time): this;
    triggerAttackRelease(duration: Time, time?: Time, velocity?: NormalRange): this;
    dispose(): this;
  }

  export class PluckSynth extends ToneAudioNode {
    volume: Signal;
    attackNoise: number;
    dampening: Signal;
    resonance: Signal;
    constructor(options?: { attackNoise?: number; dampening?: Frequency; resonance?: NormalRange; volume?: number });
    triggerAttack(note: Note, time?: Time): this;
    dispose(): this;
  }

  // Sampler / Player

  export class Player extends ToneAudioNode {
    volume: Signal;
    playbackRate: number;
    loop: boolean;
    loopStart: Time;
    loopEnd: Time;
    buffer: ToneAudioBuffer;
    loaded: boolean;
    constructor(url?: string | AudioBuffer | ToneAudioBuffer, onload?: () => void);
    start(time?: Time, offset?: Time, duration?: Time): this;
    stop(time?: Time): this;
    seek(offset: Time, when?: Time): this;
    restart(time?: Time, offset?: Time, duration?: Time): this;
    dispose(): this;
  }

  export class Players extends ToneAudioNode {
    volume: Signal;
    loaded: boolean;
    constructor(urls: Record<string, string>, onload?: () => void);
    player(name: string): Player;
    has(name: string): boolean;
    dispose(): this;
  }

  export class Sampler extends ToneAudioNode {
    volume: Signal;
    loaded: boolean;
    constructor(urls: Record<string, string> | { urls: Record<string, string>; baseUrl?: string; onload?: () => void });
    triggerAttack(notes: Note | Note[], time?: Time, velocity?: NormalRange): this;
    triggerRelease(notes: Note | Note[], time?: Time): this;
    triggerAttackRelease(notes: Note | Note[], duration: Time | Time[], time?: Time, velocity?: NormalRange): this;
    releaseAll(time?: Time): this;
    dispose(): this;
  }

  export class ToneAudioBuffer {
    duration: number;
    length: number;
    numberOfChannels: number;
    loaded: boolean;
    constructor(url?: string | AudioBuffer, onload?: () => void);
    static fromUrl(url: string): Promise<ToneAudioBuffer>;
  }

  // Effects

  export class Reverb extends ToneAudioNode {
    decay: number;
    wet: Signal;
    constructor(decay?: number);
    generate(): Promise<this>;
    dispose(): this;
  }

  export class Delay extends ToneAudioNode {
    delayTime: Signal;
    wet: Signal;
    constructor(delayTime?: Time, feedback?: NormalRange);
    dispose(): this;
  }

  export class FeedbackDelay extends ToneAudioNode {
    delayTime: Signal;
    feedback: Signal;
    wet: Signal;
    constructor(delayTime?: Time, feedback?: NormalRange);
    dispose(): this;
  }

  export class Chorus extends ToneAudioNode {
    frequency: Signal;
    delayTime: number;
    depth: NormalRange;
    wet: Signal;
    constructor(frequency?: number, delayTime?: number, depth?: number);
    start(time?: Time): this;
    stop(time?: Time): this;
    dispose(): this;
  }

  export class Distortion extends ToneAudioNode {
    distortion: number;
    wet: Signal;
    constructor(distortion?: number);
    dispose(): this;
  }

  export class Phaser extends ToneAudioNode {
    frequency: Signal;
    octaves: number;
    wet: Signal;
    constructor(options?: { frequency?: number; octaves?: number; baseFrequency?: number; wet?: NormalRange });
    dispose(): this;
  }

  export class Tremolo extends ToneAudioNode {
    frequency: Signal;
    depth: Signal;
    wet: Signal;
    constructor(frequency?: number, depth?: number);
    start(time?: Time): this;
    stop(time?: Time): this;
    dispose(): this;
  }

  export class Vibrato extends ToneAudioNode {
    frequency: Signal;
    depth: Signal;
    wet: Signal;
    constructor(frequency?: number, depth?: number);
    dispose(): this;
  }

  export class PingPongDelay extends ToneAudioNode {
    delayTime: Signal;
    feedback: Signal;
    wet: Signal;
    constructor(delayTime?: Time, feedback?: NormalRange);
    dispose(): this;
  }

  export class AutoFilter extends ToneAudioNode {
    frequency: Signal;
    depth: Signal;
    wet: Signal;
    constructor(options?: { frequency?: number; depth?: NormalRange; baseFrequency?: Frequency; octaves?: number });
    start(time?: Time): this;
    stop(time?: Time): this;
    dispose(): this;
  }

  export class AutoPanner extends ToneAudioNode {
    frequency: Signal;
    depth: Signal;
    wet: Signal;
    constructor(frequency?: number);
    start(time?: Time): this;
    stop(time?: Time): this;
    dispose(): this;
  }

  // Processing

  export class Filter extends ToneAudioNode {
    frequency: Signal;
    Q: Signal;
    type: BiquadFilterType;
    constructor(frequency?: Frequency, type?: BiquadFilterType, rolloff?: number);
    dispose(): this;
  }

  export class EQ3 extends ToneAudioNode {
    low: Signal;
    mid: Signal;
    high: Signal;
    lowFrequency: Signal;
    highFrequency: Signal;
    constructor(lowLevel?: number, midLevel?: number, highLevel?: number);
    dispose(): this;
  }

  export class Gain extends ToneAudioNode {
    gain: Signal;
    constructor(gain?: number);
    dispose(): this;
  }

  export class Volume extends ToneAudioNode {
    volume: Signal;
    mute: boolean;
    constructor(volume?: number);
    dispose(): this;
  }

  export class Compressor extends ToneAudioNode {
    threshold: Signal;
    ratio: Signal;
    attack: Signal;
    release: Signal;
    knee: Signal;
    constructor(threshold?: number, ratio?: number);
    dispose(): this;
  }

  export class Limiter extends ToneAudioNode {
    threshold: Signal;
    constructor(threshold?: number);
    dispose(): this;
  }

  export class Panner extends ToneAudioNode {
    pan: Signal;
    constructor(pan?: NormalRange);
    dispose(): this;
  }

  export class Channel extends ToneAudioNode {
    volume: Signal;
    pan: Signal;
    mute: boolean;
    solo: boolean;
    constructor(volume?: number, pan?: number);
    dispose(): this;
  }

  // Sources

  export class Oscillator extends ToneAudioNode {
    frequency: Signal;
    detune: Signal;
    type: string;
    volume: Signal;
    constructor(frequency?: Frequency, type?: string);
    start(time?: Time): this;
    stop(time?: Time): this;
    dispose(): this;
  }

  export class LFO extends ToneAudioNode {
    frequency: Signal;
    min: number;
    max: number;
    type: string;
    constructor(frequency?: Frequency, min?: number, max?: number);
    start(time?: Time): this;
    stop(time?: Time): this;
    dispose(): this;
  }

  export class Noise extends ToneAudioNode {
    type: 'white' | 'brown' | 'pink';
    volume: Signal;
    constructor(type?: 'white' | 'brown' | 'pink');
    start(time?: Time): this;
    stop(time?: Time): this;
    dispose(): this;
  }

  // Transport

  interface TransportClass {
    bpm: Signal;
    state: 'started' | 'stopped' | 'paused';
    position: string;
    seconds: number;
    progress: number;
    loop: boolean;
    loopStart: Time;
    loopEnd: Time;
    swing: number;
    swingSubdivision: Time;
    timeSignature: number | number[];

    start(time?: Time, offset?: Time): this;
    stop(time?: Time): this;
    pause(time?: Time): this;
    toggle(time?: Time): this;
    schedule(callback: (time: number) => void, time: Time): number;
    scheduleRepeat(callback: (time: number) => void, interval: Time, startTime?: Time, duration?: Time): number;
    scheduleOnce(callback: (time: number) => void, time: Time): number;
    clear(eventId: number): this;
    cancel(after?: Time): this;
  }

  export const Transport: TransportClass;
  export function getTransport(): TransportClass;

  // Scheduling

  export class Loop {
    callback: (time: number) => void;
    interval: Time;
    iterations: number;
    mute: boolean;
    playbackRate: number;
    probability: NormalRange;
    progress: NormalRange;
    state: 'started' | 'stopped';
    constructor(callback: (time: number) => void, interval?: Time);
    start(time?: Time): this;
    stop(time?: Time): this;
    cancel(after?: Time): this;
    dispose(): this;
  }

  export class Sequence extends ToneAudioNode {
    events: (Note | Note[] | null)[];
    subdivision: Time;
    loop: boolean | number;
    loopStart: number;
    loopEnd: number;
    playbackRate: number;
    probability: NormalRange;
    progress: NormalRange;
    state: 'started' | 'stopped';
    constructor(callback: (time: number, note: Note) => void, events: (Note | Note[] | null)[], subdivision?: Time);
    start(time?: Time, offset?: number): this;
    stop(time?: Time): this;
    cancel(after?: Time): this;
    dispose(): this;
  }

  export class Part extends ToneAudioNode {
    loop: boolean | number;
    loopStart: Time;
    loopEnd: Time;
    playbackRate: number;
    probability: NormalRange;
    length: number;
    progress: NormalRange;
    state: 'started' | 'stopped';
    constructor(callback: (time: number, value: unknown) => void, events?: [Time, unknown][]);
    start(time?: Time, offset?: Time): this;
    stop(time?: Time): this;
    add(time: Time, value: unknown): this;
    remove(time: Time, value?: unknown): this;
    at(time: Time, value?: unknown): unknown;
    cancel(after?: Time): this;
    dispose(): this;
  }

  export class Pattern extends ToneAudioNode {
    pattern: 'up' | 'down' | 'upDown' | 'downUp' | 'alternateUp' | 'alternateDown' | 'random' | 'randomOnce' | 'randomWalk';
    values: Note[];
    interval: Time;
    state: 'started' | 'stopped';
    constructor(callback: (time: number, note: Note) => void, values: Note[], pattern?: string);
    start(time?: Time): this;
    stop(time?: Time): this;
    dispose(): this;
  }

  // Utility
  export class Frequency {
    constructor(value: Frequency, units?: string);
    toFrequency(): number;
    toMidi(): number;
    toNote(): string;
    transpose(interval: number): Frequency;
    harmonize(intervals: number[]): Frequency[];
    static mtof(midi: number): number;
    static ftom(frequency: number): number;
  }

  export class Time {
    constructor(value: Time, units?: string);
    toSeconds(): number;
    toTicks(): number;
    toFrequency(): number;
    quantize(subdivision: Time, percent?: NormalRange): number;
  }

  export class Draw {
    static schedule(callback: () => void, time: Time): void;
    static cancel(after?: Time): void;
  }

  // Meter / Analysis
  export class Meter extends ToneAudioNode {
    smoothing: number;
    constructor(smoothing?: number);
    getValue(): number | number[];
    dispose(): this;
  }

  export class FFT extends ToneAudioNode {
    size: number;
    constructor(size?: number);
    getValue(): Float32Array;
    dispose(): this;
  }

  export class Waveform extends ToneAudioNode {
    size: number;
    constructor(size?: number);
    getValue(): Float32Array;
    dispose(): this;
  }

  export class Analyser extends ToneAudioNode {
    type: 'fft' | 'waveform';
    size: number;
    constructor(type?: 'fft' | 'waveform', size?: number);
    getValue(): Float32Array;
    dispose(): this;
  }
}
