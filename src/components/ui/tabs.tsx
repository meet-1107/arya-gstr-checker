"use client";
import * as T from "@radix-ui/react-tabs";
import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";

export const Tabs = T.Root;
export const TabsContent = ({ className, ...p }: ComponentProps<typeof T.Content>) => <T.Content className={cn("mt-5 outline-none", className)} {...p} />;
export const TabsList = ({ className, ...p }: ComponentProps<typeof T.List>) => (
  <T.List className={cn("-mb-px flex gap-1 overflow-x-auto border-b border-line", className)} {...p} />
);
export const TabsTrigger = ({ className, ...p }: ComponentProps<typeof T.Trigger>) => (
  <T.Trigger
    className={cn("whitespace-nowrap border-b-2 border-transparent px-3 py-2.5 text-sm font-medium text-muted transition-colors hover:text-foreground data-[state=active]:border-primary data-[state=active]:text-foreground", className)}
    {...p}
  />
);
