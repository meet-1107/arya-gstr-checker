import { clsx, type ClassValue } from "clsx";

/** Class-name helper (clsx). Later classes win by source order in our own component APIs. */
export const cn = (...v: ClassValue[]) => clsx(v);
