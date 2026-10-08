import { Suspense } from "react";
import type { Metadata } from "next";
import { ResetForm } from "@/components/auth/forms";

export const metadata: Metadata = { title: "Choose a new password" };
export default function Page() { return <Suspense><ResetForm /></Suspense>; }
