/**
 * MCP tool result helpers.
 */

/** Create a successful text result */
export const ok = (text: string) => ({
  content: [{ type: 'text' as const, text }],
});

/** Create a result with text and images */
export const okWithImages = (text: string, images: Array<{ data: string; mimeType: string }>) => ({
  content: [
    { type: 'text' as const, text },
    ...images.map((img) => ({
      type: 'image' as const,
      data: img.data,
      mimeType: img.mimeType,
    })),
  ],
});
