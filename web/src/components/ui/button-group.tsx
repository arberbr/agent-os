"use client";

import * as React from "react";

import { cn } from "@/lib/utils";
import { Separator } from "@/components/ui/separator";

export type ButtonGroupOrientation = "horizontal" | "vertical";

function ButtonGroup({
  className,
  orientation = "horizontal",
  ...props
}: React.ComponentProps<"div"> & { orientation?: ButtonGroupOrientation }) {
  return (
    <div
      role="group"
      data-slot="button-group"
      data-orientation={orientation}
      className={cn(
        "flex",
        orientation === "vertical" ? "flex-col" : "flex-row items-stretch",
        className,
      )}
      {...props}
    />
  );
}

function ButtonGroupText({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex items-center justify-center gap-2 rounded-md border border-border bg-muted px-2.5 py-1 text-sm leading-5 font-medium text-foreground",
        className,
      )}
      {...props}
    />
  );
}

function ButtonGroupSeparator({
  className,
  orientation = "vertical",
  ...props
}: React.ComponentProps<typeof Separator>) {
  return (
    <Separator
      data-slot="button-group-separator"
      orientation={orientation}
      className={cn(orientation === "vertical" ? "mx-px my-1" : "mx-1 my-px", className)}
      {...props}
    />
  );
}

export { ButtonGroup, ButtonGroupSeparator, ButtonGroupText };
