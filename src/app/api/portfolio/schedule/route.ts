import { readJson, tenant } from "@/server/api";
import { container } from "@/server/container";

/** `{clientIds[] | all:true, schedule: "daily"|"weekly"|"monthly"|null}` — turn scheduled re-verification on/off for clients. */
export const POST = tenant(async ({ req, ctx }) => container().portfolio.setSchedule(ctx, await readJson(req, 1_000_000)));
