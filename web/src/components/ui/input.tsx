"use client";

import * as React from "react";

import { cn } from "@/lib/utils";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-10 w-full min-w-0 rounded-md border border-input bg-inset p-2.5 text-sm text-foreground transition-[color,background-color,border-color,box-shadow] duration-150 outline-none",
        "placeholder:text-muted-foreground",
        "focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-ring/50",
        "disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
        "aria-invalid:border-destructive aria-invalid:ring-destructive/20",
        "[&::file-selector-button]:inline-flex [&::file-selector-button]:h-6 [&::file-selector-button]:border-0 [&::file-selector-button]:bg-transparent [&::file-selector-button]:text-sm [&::file-selector-button]:font-medium [&::file-selector-button]:text-foreground",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
