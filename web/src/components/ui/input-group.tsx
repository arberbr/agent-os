"use client";

import * as React from "react";

import { cn } from "@/lib/utils";
import { Button, type ButtonProps, type ButtonSize } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

/**
 * InputGroup — a bordered control frame that hosts a bare input or textarea
 * plus addons (buttons, hints, footers). The frame owns the border and the
 * focus ring; the hosted control itself is chrome-free.
 */

function InputGroup({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="input-group"
      role="group"
      className={cn(
        "relative flex h-10 w-full min-w-0 items-center rounded-md border border-input bg-inset/60 transition-[border-color,box-shadow,background-color] duration-150",
        "focus-within:border-primary focus-within:bg-inset focus-within:shadow-[0_0_0_4px_var(--signal-soft)]",
        "has-[aria-invalid=true]:border-destructive",
        "has-[textarea]:h-auto",
        "has-[div[data-align=block-end]]:h-auto has-[div[data-align=block-end]]:flex-col has-[div[data-align=block-end]]:items-stretch",
        "has-[div[data-align=block-start]]:h-auto has-[div[data-align=block-start]]:flex-col has-[div[data-align=block-start]]:items-stretch",
        className,
      )}
      {...props}
    />
  );
}

export type InputGroupAddonAlign =
  | "inline-start"
  | "inline-end"
  | "block-start"
  | "block-end";

function InputGroupAddon({
  className,
  align = "inline-start",
  ...props
}: React.ComponentProps<"div"> & { align?: InputGroupAddonAlign }) {
  return (
    <div
      role="group"
      data-slot="input-group-addon"
      data-align={align}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("button")) return;
        e.currentTarget.parentElement?.querySelector("input")?.focus();
      }}
      className={cn(
        "flex cursor-text items-center justify-center gap-2 text-sm font-medium text-muted-foreground select-none",
        align === "inline-start" && "order-first py-1.5 pr-0.5 pl-1.5",
        align === "inline-end" && "order-last py-1.5 pr-1.5 pl-0.5",
        align === "block-start" && "order-first w-full justify-start px-2.5 pt-2",
        align === "block-end" && "order-last w-full justify-start px-2.5 pb-2.5",
        className,
      )}
      {...props}
    />
  );
}

export type InputGroupButtonSize = Extract<ButtonSize, "sm" | "default" | "icon-sm" | "icon">;

function InputGroupButton({
  className,
  type = "button",
  variant = "ghost",
  size = "sm",
  ...props
}: Omit<ButtonProps, "size" | "type"> & {
  size?: InputGroupButtonSize;
  type?: "button" | "submit" | "reset";
}) {
  return <Button type={type} variant={variant} size={size} className={className} {...props} />;
}

function InputGroupText({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      className={cn("flex items-center gap-2 text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

function InputGroupInput({
  className,
  ...props
}: React.ComponentProps<typeof Input>) {
  return (
    <Input
      data-slot="input-group-control"
      className={cn(
        "h-auto flex-1 rounded-none border-0 bg-transparent px-1.5 py-1",
        "shadow-none focus-visible:border-0 focus-visible:shadow-none focus-visible:ring-0",
        className,
      )}
      {...props}
    />
  );
}

function InputGroupTextarea({
  className,
  ...props
}: React.ComponentProps<typeof Textarea>) {
  return (
    <Textarea
      data-slot="input-group-control"
      className={cn(
        "flex-1 rounded-none border-0 bg-transparent px-1.5 py-2",
        "shadow-none focus-visible:border-0 focus-visible:shadow-none focus-visible:ring-0",
        className,
      )}
      {...props}
    />
  );
}

export {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupText,
  InputGroupInput,
  InputGroupTextarea,
};
