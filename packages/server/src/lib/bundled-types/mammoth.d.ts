/**
 * Type definitions for @bundled/mammoth — .docx to HTML converter.
 */

declare module '@bundled/mammoth' {
  interface ConversionResult {
    /** The generated HTML string */
    value: string;
    /** Warning/info messages from conversion */
    messages: ConversionMessage[];
  }

  interface ConversionMessage {
    type: 'warning' | 'error';
    message: string;
  }

  interface Input {
    /** ArrayBuffer of the .docx file */
    arrayBuffer: ArrayBuffer;
  }

  interface StyleMapping {
    /** Map document styles to HTML elements, e.g. "p[style-name='Heading 1'] => h1:fresh" */
    [pattern: string]: string;
  }

  interface ConversionOptions {
    /** Custom style mappings */
    styleMap?: string[];
    /** Whether to include default style map (default: true) */
    includeDefaultStyleMap?: boolean;
    /** Convert images — return object with src for <img> tag */
    convertImage?: {
      (image: ImageElement): Promise<{ src: string }>;
    };
  }

  interface ImageElement {
    /** Read image as ArrayBuffer */
    read(): Promise<ArrayBuffer>;
    /** Read image as base64 string */
    readAsBase64String(): Promise<string>;
    /** MIME content type (e.g. "image/png") */
    contentType: string;
  }

  /** Convert a .docx file to HTML */
  export function convertToHtml(
    input: Input,
    options?: ConversionOptions,
  ): Promise<ConversionResult>;

  /** Extract raw text from a .docx file */
  export function extractRawText(input: Input): Promise<ConversionResult>;
}
