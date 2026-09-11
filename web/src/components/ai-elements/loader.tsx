"use client";

import { cn } from "@/lib/utils";

/** Streaming indicator shown while an agent is working (no message text yet). */
export const Loader = ({ className, label }: { className?: string; label?: string }) => (
  <div
    aria-label={label ?? "Working"}
    className={cn("flex w-fit items-center gap-1.5 rounded-md px-1 py-2", className)}
    role="status"
  >
    <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:-0.3s]" />
    <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:-0.15s]" />
    <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground" />
  </div>
);
