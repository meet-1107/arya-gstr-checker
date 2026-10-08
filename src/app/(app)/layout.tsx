import { AppFrame } from "@/components/shell/app-frame";

export default function AppLayout({ children }: LayoutProps<"/">) {
  return <AppFrame>{children}</AppFrame>;
}
