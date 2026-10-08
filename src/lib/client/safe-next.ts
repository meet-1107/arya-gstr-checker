/** Only same-site relative paths are honoured as post-login destinations (prevents open redirects). */
export const safeNext = (n: string | null | undefined): string | null =>
  n && n.startsWith("/") && !n.startsWith("//") && !n.startsWith("/\\") && !/[\u0000-\u001f]/.test(n) ? n : null;
