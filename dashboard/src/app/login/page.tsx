"use client";

/**
 * Login page - simple password form for dashboard access.
 * Uses dashboard design system components for consistency.
 */

import { useState, FormEvent, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/dashboard/button";
import { Input } from "@/components/dashboard/input";

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  const from = searchParams.get("from") || "/";

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setIsLoading(true);

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });

      if (response.ok) {
        router.push(from);
        router.refresh();
      } else {
        const data = await response.json();
        setError(data.error || "Invalid password");
      }
    } catch {
      setError("Something went wrong");
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-[var(--d-bg-page)] p-4">
      <div className="w-full max-w-sm">
        <div
          className="bg-[var(--d-bg-surface)] rounded-xl shadow-[var(--d-shadow-modal)] overflow-hidden"
        >
          {/* Header */}
          <div className="px-6 pt-8 pb-2 text-center">
            <h1 className="text-[22px] font-semibold text-[var(--d-text-primary)] tracking-tight">
              vajra
            </h1>
            <p className="mt-2 text-[14px] text-[var(--d-text-secondary)]">
              Enter password to continue
            </p>
          </div>

          {/* Form */}
          <form onSubmit={handleSubmit} className="px-6 pb-8 pt-4">
            <div className="space-y-4">
              <div>
                <Input
                  type="password"
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    if (error) setError("");
                  }}
                  placeholder="Password"
                  autoFocus
                  autoComplete="current-password"
                  error={!!error}
                  size="md"
                />
                {error && (
                  <p className="mt-2 text-[13px] text-[var(--d-error)]">
                    {error}
                  </p>
                )}
              </div>

              <Button
                type="submit"
                disabled={!password}
                loading={isLoading}
                fullWidth
                size="lg"
              >
                Sign in
              </Button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center bg-[var(--d-bg-page)]">
          <div className="text-[14px] text-[var(--d-text-tertiary)]">Loading...</div>
        </div>
      }
    >
      <LoginForm />
    </Suspense>
  );
}
