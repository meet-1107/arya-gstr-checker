// Client-side response types, derived (type-only) from the server services so they cannot drift.
import type { BulkService, publicJob } from "@/services/bulk";
import type { DashboardService } from "@/services/dashboard";
import type { ImportService, publicImport } from "@/services/imports";
import type { OrgSummary } from "@/services/organizations";
import type { GstinQueryService, ReturnsQueryService } from "@/services/queries";
import type { SubscriptionOverview } from "@/services/subscription";
import type { TeamService } from "@/services/team";
import type { Client } from "@/lib/store/types";
import type { Role } from "@/lib/permissions";

export type { OrgSummary, SubscriptionOverview, Client, Role };
export type DashboardData = Awaited<ReturnType<DashboardService["get"]>>;
export type GstinList = Awaited<ReturnType<GstinQueryService["list"]>>;
export type GstinItem = GstinList["items"][number];
export type GstinDetail = Awaited<ReturnType<GstinQueryService["detail"]>>;
export type ReturnsList = Awaited<ReturnType<ReturnsQueryService["forType"]>>;
export type ReturnItem = ReturnsList["items"][number];
export type JobView = ReturnType<typeof publicJob>;
export type Estimate = Awaited<ReturnType<BulkService["estimate"]>>;
export type VerifyPreview = Awaited<ReturnType<BulkService["estimateVerify"]>>;
export type JobItemsPage = Awaited<ReturnType<BulkService["items"]>>;
export type TeamData = Awaited<ReturnType<TeamService["list"]>>;
export interface ClientPage { items: Client[]; nextCursor?: string }
export interface MeData { user: { uid: string; email: string; name?: string; emailVerified: boolean }; organizations: OrgSummary[] }
export type ImportView = ReturnType<typeof publicImport>;
export type ImportPreview = Awaited<ReturnType<ImportService["preview"]>>;
