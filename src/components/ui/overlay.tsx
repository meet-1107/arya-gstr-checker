"use client";
import * as D from "@radix-ui/react-dialog";
import * as M from "@radix-ui/react-dropdown-menu";
import * as T from "@radix-ui/react-tooltip";
import type { ComponentProps, ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";
import { Button, type ButtonVariant } from "./button";

export function Dialog({
  open, onOpenChange, title, description, children, footer, size = "md",
}: { open: boolean; onOpenChange: (o: boolean) => void; title: string; description?: string; children?: ReactNode; footer?: ReactNode; size?: "sm" | "md" | "lg" }) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-50 bg-overlay backdrop-blur-[1px]" />
        <D.Content
          className={cn(
            "animate-pop fixed left-1/2 top-1/2 z-50 max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border border-line bg-surface shadow-pop",
            { sm: "max-w-sm", md: "max-w-lg", lg: "max-w-2xl" }[size],
          )}
        >
          <div className="flex items-start justify-between gap-4 px-6 pt-6">
            <div>
              <D.Title className="text-base font-semibold tracking-tight">{title}</D.Title>
              <D.Description className={cn("mt-1 text-sm text-muted", !description && "sr-only")}>{description ?? title}</D.Description>
            </div>
            <D.Close aria-label="Close" className="-mr-2 -mt-1 rounded-lg p-2 text-muted hover:bg-surface-hover hover:text-foreground"><X className="size-4" /></D.Close>
          </div>
          {children && <div className="px-6 py-5">{children}</div>}
          {footer && <div className="flex flex-col-reverse gap-2 border-t border-line bg-surface-muted/60 px-6 py-4 sm:flex-row sm:justify-end">{footer}</div>}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

export function ConfirmDialog({
  open, onOpenChange, title, description, confirmLabel = "Confirm", variant = "primary", onConfirm, loading, children,
}: { open: boolean; onOpenChange: (o: boolean) => void; title: string; description?: string; confirmLabel?: string; variant?: ButtonVariant; onConfirm: () => void | Promise<void>; loading?: boolean; children?: ReactNode }) {
  return (
    <Dialog
      open={open} onOpenChange={onOpenChange} title={title} description={description} size="sm"
      footer={<>
        <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={loading}>Cancel</Button>
        <Button variant={variant} onClick={onConfirm} loading={loading}>{confirmLabel}</Button>
      </>}
    >{children}</Dialog>
  );
}

export function Tooltip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <T.Provider delayDuration={200}>
      <T.Root>
        <T.Trigger asChild>{children}</T.Trigger>
        <T.Portal>
          <T.Content sideOffset={6} className="z-[60] max-w-60 rounded-md bg-inverse px-2.5 py-1.5 text-xs text-inverse-foreground shadow-pop">{label}<T.Arrow className="fill-inverse" /></T.Content>
        </T.Portal>
      </T.Root>
    </T.Provider>
  );
}

export const Menu = M.Root;
export const MenuTrigger = M.Trigger;
export function MenuContent({ className, align = "end", ...p }: ComponentProps<typeof M.Content>) {
  return (
    <M.Portal>
      <M.Content align={align} sideOffset={6} className={cn("animate-pop z-[60] min-w-52 rounded-xl border border-line bg-surface p-1.5 shadow-pop", className)} {...p} />
    </M.Portal>
  );
}
export function MenuItem({ className, danger, ...p }: ComponentProps<typeof M.Item> & { danger?: boolean }) {
  return (
    <M.Item
      className={cn("flex cursor-pointer select-none items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm outline-none data-[disabled]:opacity-50 data-[highlighted]:bg-surface-muted [&>svg]:size-4 [&>svg]:text-muted", danger && "text-danger-strong [&>svg]:text-danger-strong", className)}
      {...p}
    />
  );
}
export const MenuLabel = ({ className, ...p }: ComponentProps<typeof M.Label>) => <M.Label className={cn("px-2.5 py-1.5 text-xs font-medium text-muted", className)} {...p} />;
export const MenuSeparator = () => <M.Separator className="my-1.5 h-px bg-line" />;
