// components/TopBarActions.tsx
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Sun, Moon, LayoutDashboard } from "lucide-react";

/* ——————————————————————————————————————————————
   Light/Dark Mode Toggle — icon-only circular button.
   Shows Sun in dark mode (switch to light), Moon in light mode (switch to dark).
   Persists preference in localStorage, SSR-safe via mounted check.
   —————————————————————————————————————————————— */
function ThemeToggle() {
  const [mounted, setMounted] = useState(false);
  const [isDark, setIsDark] = useState(true);

  useEffect(() => {
    const stored = localStorage.getItem("theme");
    const prefersDark =
      stored === "dark" ||
      (!stored && window.matchMedia("(prefers-color-scheme: dark)").matches);
    setIsDark(prefersDark);
    document.documentElement.setAttribute("data-theme", prefersDark ? "dark" : "light");
    document.documentElement.classList.toggle("dark", prefersDark);
    setMounted(true);
  }, []);

  function toggle() {
    const next = !isDark;
    setIsDark(next);
    document.documentElement.setAttribute("data-theme", next ? "dark" : "light");
    document.documentElement.classList.toggle("dark", next);
    localStorage.setItem("theme", next ? "dark" : "light");
  }

  // Avoid hydration mismatch — render placeholder with same dimensions
  if (!mounted) {
    return <div className="h-10 w-10 rounded-full bg-muted border border-border" />;
  }

  return (
    <button
      onClick={toggle}
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      className="
        relative h-10 w-10 rounded-full
        bg-muted border border-border
        flex items-center justify-center
        cursor-pointer select-none
        transition-all duration-200 ease-in-out
        hover:bg-muted/80 hover:shadow-sm
        active:scale-90
      "
    >
      {/* Sun icon — visible in dark mode */}
      <Sun
        size={18}
        strokeWidth={2}
        className={`
          absolute transition-all duration-[250ms] ease-in-out
          ${isDark
            ? "opacity-100 rotate-0 scale-100"
            : "opacity-0 rotate-90 scale-75"
          }
        `}
      />
      {/* Moon icon — visible in light mode */}
      <Moon
        size={18}
        strokeWidth={2}
        className={`
          absolute transition-all duration-[250ms] ease-in-out
          ${isDark
            ? "opacity-0 -rotate-90 scale-75"
            : "opacity-100 rotate-0 scale-100"
          }
        `}
      />
    </button>
  );
}

/* ——————————————————————————————————————————————
   Dashboard Button — pill-shaped link to /dashboard.
   Uses Next.js <Link> for client-side navigation.
   —————————————————————————————————————————————— */
function DashboardButton() {
  return (
    <Link
      href="/dashboard"
      aria-label="Go to Dashboard"
      className="
        inline-flex items-center gap-2
        rounded-full px-5 py-2.5
        bg-primary text-white text-sm font-medium
        transition-all duration-200 ease-in-out
        hover:bg-primary/90 hover:-translate-y-px
        hover:shadow-[0_4px_12px_rgba(99,102,241,0.25)]
        active:scale-[0.97]
        select-none
      "
    >
      <LayoutDashboard size={16} />
      <span>Dashboard</span>
    </Link>
  );
}

/* ——————————————————————————————————————————————
   TopBarActions — drop-in wrapper for any navbar/header.
   Flex row with both action elements.
   —————————————————————————————————————————————— */
export default function TopBarActions() {
  return (
    <div className="flex items-center gap-3">
      <ThemeToggle />
      <DashboardButton />
    </div>
  );
}
