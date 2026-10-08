"use client";
import { useParams } from "next/navigation";
import { GstinView } from "@/components/gstin/gstin-view";

export default function GstinDetailPage() {
  const { gstin } = useParams<{ gstin: string }>();
  return <GstinView gstin={decodeURIComponent(gstin).toUpperCase()} backHref="/gstins" backLabel="All GSTINs" />;
}
