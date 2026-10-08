import { tenant } from "@/server/api";
import { container } from "@/server/container";

/** Data for the printable monthly summary (`/reports/summary`). Plan feature `pdfReports`; `reports:read`. */
export const GET = tenant(async ({ ctx }) => ({ summary: await container().reports.summary(ctx) }));
