import { createContext, useContext, useEffect } from 'react';

/**
 * Lets a page fill the admin content column from `lg` up instead of growing
 * past it: <main> becomes a flex column bounded by the window, so the page
 * can give its own panes their own scrollbars while the header, the page's
 * own head (title, tabs) and the bottom bar slot stay where they are.
 *
 * The page's root then needs `lg:flex-1 lg:min-h-0 lg:flex lg:flex-col`, and
 * its scrolling panes `lg:min-h-0 lg:overflow-y-auto`. Below `lg` nothing
 * changes and the column scrolls as a whole.
 */
export const FillViewportContext = createContext<((on: boolean) => void) | null>(null);

/**
 * Fill the content column while the calling component is mounted. The
 * layout counts callers: true on mount adds one, false on unmount removes it.
 */
export function useFillViewport(): void {
  const setFill = useContext(FillViewportContext);
  useEffect(() => {
    if (!setFill) return undefined;
    setFill(true);
    return () => setFill(false);
  }, [setFill]);
}
