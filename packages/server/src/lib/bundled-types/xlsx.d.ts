/**
 * Type definitions for @bundled/xlsx — spreadsheet read/write (SheetJS).
 */

declare module '@bundled/xlsx' {
  // Cell types
  interface CellObject {
    /** Cell type: b=boolean, n=number, s=string, d=date, e=error, z=stub */
    t: 'b' | 'n' | 's' | 'd' | 'e' | 'z';
    /** Raw value */
    v?: string | number | boolean | Date;
    /** Formatted text (if available) */
    w?: string;
    /** Formula (without leading =) */
    f?: string;
  }

  interface WorkSheet {
    [cell: string]: CellObject | unknown;
    /** Range string e.g. "A1:Z100" */
    '!ref'?: string;
    /** Merge ranges */
    '!merges'?: Range[];
  }

  interface WorkBook {
    SheetNames: string[];
    Sheets: { [name: string]: WorkSheet };
  }

  interface Range {
    s: CellAddress;
    e: CellAddress;
  }

  interface CellAddress {
    /** Column (0-indexed) */
    c: number;
    /** Row (0-indexed) */
    r: number;
  }

  interface WritingOptions {
    bookType?: 'xlsx' | 'csv' | 'ods';
    type?: 'array' | 'binary' | 'base64' | 'buffer';
    compression?: boolean;
  }

  interface ParsingOptions {
    type?: 'array' | 'binary' | 'base64' | 'buffer';
    cellFormula?: boolean;
    cellStyles?: boolean;
  }

  /** Read a workbook from binary data */
  export function read(data: Uint8Array | ArrayBuffer | string, opts?: ParsingOptions): WorkBook;

  /** Write a workbook to binary data */
  export function write(wb: WorkBook, opts?: WritingOptions): Uint8Array | string;

  export namespace utils {
    /** Create a new empty workbook */
    function book_new(): WorkBook;
    /** Append a worksheet to a workbook */
    function book_append_sheet(wb: WorkBook, ws: WorkSheet, name?: string): void;
    /** Encode a range object to a string like "A1:Z100" */
    function encode_range(range: Range): string;
    /** Decode a range string to a range object */
    function decode_range(range: string): Range;
    /** Encode a cell address to a string like "A1" */
    function encode_cell(cell: CellAddress): string;
    /** Decode a cell string to a cell address */
    function decode_cell(cell: string): CellAddress;
    /** Convert an array of arrays to a worksheet */
    function aoa_to_sheet(data: unknown[][]): WorkSheet;
    /** Convert a worksheet to an array of arrays */
    function sheet_to_json<T = unknown>(ws: WorkSheet, opts?: { header?: 1 | string[]; raw?: boolean }): T[];
    /** Convert a worksheet to CSV string */
    function sheet_to_csv(ws: WorkSheet): string;
  }
}
