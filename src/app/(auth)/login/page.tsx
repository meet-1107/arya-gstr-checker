import { Suspense } from "react";
import type { Metadata } from "next";
import { LoginForm } from "@/components/auth/forms";

export const metadata: Metadata = { title: "Sign in" };
export default function Page() { return <Suspense><LoginForm /></Suspense>; }
