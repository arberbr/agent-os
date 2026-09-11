"use client";

import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Button — one control, one shape, six intents and six sizes.
 *
 * Intents (variant):
 *   default      Solid aqua ("full"). The single most important action on a
 *                screen. Use it once per view; everything else is quieter.
 *   secondary    Filled quiet chip, for the actions that sit beside it.
 *   outline      Hairline border, no fill. Neutral actions on busy surfaces.
 *   ghost        Invisible until hover. Toolbars, row actions, icon buttons.
 *   destructive  Dulled red. Deletes and disconnects.
 *   link         Text only, for inline tertiary actions. Deliberately not
 *                underlined: underlines belong to content links, not controls.
 *
 * Sizes: sm (36px) · default (40px) · lg (44px), plus the square counterparts
 * icon-sm · icon · icon-lg. Icons step with the size: 14 / 16 / 18px.
 *
 * Every variant shares the same radius, press feedback, focus ring, disabled
 * treatment and transition, so buttons read as one family everywhere. Keyboard
 * focus comes from the global :focus-visible outline — the same indicator menu
 * items and links use — rather than a second, button-only treatment.
 */
const buttonVariants = cva(
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium select-none transition-[color,background-color,border-color,box-shadow,transform] duration-150 disabled:pointer-events-none disabled:opacity-50 active:translate-y-px [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        secondary: "bg-secondary text-secondary-foreground hover:bg-accent border border-input hover:bg-accent/80",
        outline: "border border-input bg-transparent hover:bg-surface-2",
        ghost: "bg-transparent hover:bg-surface-2",
        destructive: "bg-destructive/15 text-destructive hover:bg-destructive/25",
        link: "bg-transparent text-primary hover:text-primary/80",
      },
      size: {
        sm: "h-9 gap-1 px-2.5 text-[13px] [&_svg]:size-3.5",
        default: "h-10 px-3.5 text-sm [&_svg]:size-4",
        lg: "h-11 gap-1.5 px-4 text-sm [&_svg]:size-[18px]",
        "icon-sm": "size-9 [&_svg]:size-4",
        icon: "size-10 [&_svg]:size-4",
        "icon-lg": "size-11 [&_svg]:size-[18px]",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export type ButtonVariant = NonNullable<VariantProps<typeof buttonVariants>["variant"]>;
export type ButtonSize = NonNullable<VariantProps<typeof buttonVariants>["size"]>;

export type ButtonProps = React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  };

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: ButtonProps) {
  const Comp = asChild ? Slot : "button";

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
