/**
 * Type augmentation for bun:test to include @testing-library/jest-dom matchers.
 */
declare module 'bun:test' {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface Matchers<T> {
    toBeInTheDocument(): void;
    toBeVisible(): void;
    toBeEmptyDOMElement(): void;
    toBeDisabled(): void;
    toBeEnabled(): void;
    toBeInvalid(): void;
    toBeRequired(): void;
    toBeValid(): void;
    toContainElement(element: HTMLElement | SVGElement | null): void;
    toContainHTML(htmlText: string): void;
    toHaveAccessibleDescription(description?: string | RegExp): void;
    toHaveAccessibleName(name?: string | RegExp): void;
    toHaveAttribute(attr: string, value?: unknown): void;
    toHaveClass(...classNames: string[]): void;
    toHaveFocus(): void;
    toHaveFormValues(expectedValues: Record<string, unknown>): void;
    toHaveStyle(css: string | Record<string, unknown>): void;
    toHaveTextContent(text: string | RegExp, options?: { normalizeWhitespace: boolean }): void;
    toHaveValue(value: string | string[] | number | null): void;
    toHaveDisplayValue(value: string | RegExp | Array<string | RegExp>): void;
    toBeChecked(): void;
    toBePartiallyChecked(): void;
    toHaveRole(role: string): void;
    toHaveErrorMessage(text?: string | RegExp): void;
    toHaveBeenCalledOnce(): void;
  }
}
