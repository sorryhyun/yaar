/**
 * Type definitions for @bundled/chart.js — charting/data visualization.
 */

declare module '@bundled/chart.js' {
  type ChartType = 'bar' | 'line' | 'pie' | 'doughnut' | 'radar' | 'polarArea' | 'scatter' | 'bubble';

  interface ChartDataset {
    label?: string;
    data: (number | { x: number; y: number } | { x: number; y: number; r: number } | null)[];
    backgroundColor?: string | string[];
    borderColor?: string | string[];
    borderWidth?: number;
    borderDash?: number[];
    fill?: boolean | string | number;
    tension?: number;
    pointRadius?: number;
    pointBackgroundColor?: string | string[];
    pointBorderColor?: string | string[];
    pointHoverRadius?: number;
    hoverBackgroundColor?: string | string[];
    hoverBorderColor?: string | string[];
    barThickness?: number | 'flex';
    maxBarThickness?: number;
    order?: number;
    stack?: string;
    type?: ChartType;
    yAxisID?: string;
    xAxisID?: string;
    hidden?: boolean;
    [key: string]: unknown;
  }

  interface ChartData {
    labels?: (string | number | Date)[];
    datasets: ChartDataset[];
  }

  interface ScaleOptions {
    type?: 'linear' | 'logarithmic' | 'category' | 'time' | 'timeseries';
    display?: boolean;
    position?: 'top' | 'bottom' | 'left' | 'right';
    title?: {
      display?: boolean;
      text?: string;
      color?: string;
      font?: FontSpec;
    };
    min?: number | string;
    max?: number | string;
    beginAtZero?: boolean;
    stacked?: boolean;
    reverse?: boolean;
    grid?: {
      display?: boolean;
      color?: string;
      drawBorder?: boolean;
      lineWidth?: number;
    };
    ticks?: {
      display?: boolean;
      color?: string;
      font?: FontSpec;
      callback?: (value: number | string, index: number, ticks: unknown[]) => string;
      maxRotation?: number;
      stepSize?: number;
    };
    time?: {
      unit?: 'millisecond' | 'second' | 'minute' | 'hour' | 'day' | 'week' | 'month' | 'quarter' | 'year';
      displayFormats?: Record<string, string>;
      tooltipFormat?: string;
    };
    [key: string]: unknown;
  }

  interface FontSpec {
    family?: string;
    size?: number;
    weight?: string | number;
    style?: 'normal' | 'italic';
  }

  interface LegendOptions {
    display?: boolean;
    position?: 'top' | 'bottom' | 'left' | 'right';
    labels?: {
      color?: string;
      font?: FontSpec;
      boxWidth?: number;
      padding?: number;
      usePointStyle?: boolean;
    };
    onClick?: (event: unknown, legendItem: unknown, legend: unknown) => void;
  }

  interface TooltipOptions {
    enabled?: boolean;
    mode?: 'point' | 'index' | 'nearest' | 'dataset';
    intersect?: boolean;
    backgroundColor?: string;
    titleColor?: string;
    bodyColor?: string;
    borderColor?: string;
    borderWidth?: number;
    callbacks?: {
      title?: (items: unknown[]) => string | string[];
      label?: (item: unknown) => string | string[];
      footer?: (items: unknown[]) => string | string[];
      [key: string]: unknown;
    };
  }

  interface AnimationOptions {
    duration?: number;
    easing?: string;
    delay?: number;
    onProgress?: (animation: unknown) => void;
    onComplete?: (animation: unknown) => void;
  }

  interface ChartOptions {
    responsive?: boolean;
    maintainAspectRatio?: boolean;
    aspectRatio?: number;
    indexAxis?: 'x' | 'y';
    scales?: Record<string, ScaleOptions>;
    plugins?: {
      legend?: LegendOptions;
      tooltip?: TooltipOptions;
      title?: {
        display?: boolean;
        text?: string | string[];
        color?: string;
        font?: FontSpec;
        position?: 'top' | 'bottom' | 'left' | 'right';
      };
      subtitle?: {
        display?: boolean;
        text?: string | string[];
        color?: string;
        font?: FontSpec;
      };
      datalabels?: Record<string, unknown>;
      [key: string]: unknown;
    };
    animation?: AnimationOptions | false;
    interaction?: {
      mode?: 'point' | 'index' | 'nearest' | 'dataset';
      intersect?: boolean;
      axis?: 'x' | 'y' | 'xy';
    };
    onClick?: (event: unknown, elements: unknown[], chart: Chart) => void;
    onHover?: (event: unknown, elements: unknown[], chart: Chart) => void;
    layout?: {
      padding?: number | { top?: number; bottom?: number; left?: number; right?: number };
    };
    [key: string]: unknown;
  }

  interface ChartConfiguration {
    type: ChartType;
    data: ChartData;
    options?: ChartOptions;
    plugins?: unknown[];
  }

  export class Chart {
    data: ChartData;
    options: ChartOptions;
    canvas: HTMLCanvasElement;

    constructor(ctx: HTMLCanvasElement | CanvasRenderingContext2D | string, config: ChartConfiguration);
    update(mode?: 'none' | 'active' | 'resize' | 'reset'): void;
    destroy(): void;
    resize(): void;
    toBase64Image(type?: string, quality?: number): string;
    getDatasetMeta(index: number): { data: unknown[]; hidden: boolean };

    static register(...items: unknown[]): void;
    static defaults: Record<string, unknown>;
  }

  // Registerable components
  export class CategoryScale { static id: string; }
  export class LinearScale { static id: string; }
  export class LogarithmicScale { static id: string; }
  export class TimeScale { static id: string; }
  export class RadialLinearScale { static id: string; }
  export class BarController { static id: string; }
  export class LineController { static id: string; }
  export class PieController { static id: string; }
  export class DoughnutController { static id: string; }
  export class RadarController { static id: string; }
  export class PolarAreaController { static id: string; }
  export class ScatterController { static id: string; }
  export class BubbleController { static id: string; }
  export class BarElement { static id: string; }
  export class LineElement { static id: string; }
  export class PointElement { static id: string; }
  export class ArcElement { static id: string; }
  export class Tooltip { static id: string; }
  export class Legend { static id: string; }
  export class Title { static id: string; }
  export class Filler { static id: string; }

  export const registerables: unknown[];
}
