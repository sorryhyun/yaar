/** Record signatures and field limits of the zip format (APPNOTE.TXT), shared by reader and writer. */

export const SIG_LOCAL = 0x04034b50;
export const SIG_CENTRAL = 0x02014b50;
export const SIG_EOCD = 0x06054b50;
export const SIG_EOCD64 = 0x06064b50;
export const SIG_EOCD64_LOCATOR = 0x07064b50;

export const LOCAL_HEADER_SIZE = 30;
export const CENTRAL_HEADER_SIZE = 46;
export const EOCD_SIZE = 22;
export const EOCD64_SIZE = 56;
export const EOCD64_LOCATOR_SIZE = 20;

/** A 16- or 32-bit field holding this value defers to the ZIP64 extra field or end record. */
export const MAX_U16 = 0xffff;
export const MAX_U32 = 0xffffffff;

export const EXTRA_ZIP64 = 0x0001;

export const METHOD_STORE = 0;
export const METHOD_DEFLATE = 8;

export const FLAG_ENCRYPTED = 0x1;
export const FLAG_UTF8 = 0x800;

export const VERSION_DEFAULT = 20;
export const VERSION_ZIP64 = 45;

/** "Version made by" host byte for Unix, which is what makes the external attributes a mode. */
export const HOST_UNIX = 3;
export const S_IFMT = 0o170000;
export const S_IFLNK = 0o120000;
export const S_IFREG_644 = 0o100644;
