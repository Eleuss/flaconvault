import { startTransition } from "react";

/**
 * "Try again" in an error boundary. reset() alone re-renders the server payload the router already holds, and for an
 * error thrown while rendering a server component that payload still carries the error, so it comes straight back.
 * router.refresh() fetches a new payload from the server; both run in one transition so the boundary resets on it.
 */
export function retryBoundary(router: { refresh(): void }, reset: () => void, start: (fn: () => void) => void = startTransition): void {
  start(() => {
    router.refresh();
    reset();
  });
}
