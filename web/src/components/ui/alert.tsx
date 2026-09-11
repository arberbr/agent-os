"use client";

import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Alert — an inline notice tied to the panel it sits in.
 *
 * The variants are the app's semantic palette, so a message reads at a glance
 * without shouting: info is aqua, success green, warning amber, destructive
 * red, and default is the neutral card. Each one tints its hairline border,
 * its background and its icon; only destructive tints the body text, because
 * an error is the one case where the words themselves carry the signal.
 */
const alertVariants = cva(
  "relative grid w-full gap-0.5 rounded-md border p-3 text-left text-sm [&>svg]:size-4 [&>svg]:mt-0.5 [&>svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "border-border bg-card text-card-foreground [&>svg]:text-muted-foreground",
        info: "border-signal-line bg-signal-soft text-foreground [&>svg]:text-primary",
        success: "border-success/35 bg-success/10 text-foreground [&>svg]:text-success",
        warning: "border-warning/40 bg-warning/10 text-foreground [&>svg]:text-warning",
        destructive:
          "border-destructive/40 bg-destructive/10 text-destructive [&>svg]:text-destructive",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export type AlertVariant = NonNullable<VariantProps<typeof alertVariants>["variant"]>;

const AlertContext = React.createContext<{
  variant?: AlertVariant;
  hasIcon?: boolean;
}>({
  hasIcon: false,
  variant: "default",
});

const hasDirectSvgChild = (children: React.ReactNode): boolean =>
  React.Children.toArray(children).some(
    (child) =>
      React.isValidElement(child) &&
      (child.type === "svg" || typeof child.type === "function"),
  );

export type AlertProps = React.ComponentProps<"div"> & {
  variant?: AlertVariant;
};

const Alert = ({
  variant = "default",
  className,
  children,
  ...props
}: AlertProps) => {
  const hasIcon = hasDirectSvgChild(children);
  return (
    <AlertContext.Provider value={{ hasIcon, variant }}>
      <div
        data-slot="alert"
        data-variant={variant}
        role="alert"
        className={cn(
          alertVariants({ variant }),
          hasIcon && "grid-cols-[auto_1fr] gap-x-2.5",
          className,
        )}
        {...props}
      >
        {children}
      </div>
    </AlertContext.Provider>
  );
};

export type AlertTitleProps = React.ComponentProps<"div">;

const AlertTitle = ({ className, ...props }: AlertTitleProps) => {
  const { hasIcon } = React.useContext(AlertContext);
  return (
    <div
      data-slot="alert-title"
      className={cn("font-medium leading-5", hasIcon && "col-start-2", className)}
      {...props}
    />
  );
};

export type AlertDescriptionProps = React.ComponentProps<"div">;

const AlertDescription = ({ className, ...props }: AlertDescriptionProps) => {
  const { variant, hasIcon } = React.useContext(AlertContext);
  return (
    <div
      data-slot="alert-description"
      className={cn(
        "text-sm leading-5",
        hasIcon && "col-start-2",
        variant === "destructive" ? "text-destructive/90" : "text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
};

export type AlertActionProps = React.ComponentProps<"div">;

const AlertAction = ({ className, ...props }: AlertActionProps) => (
  <div
    data-slot="alert-action"
    className={cn("absolute top-2 right-2", className)}
    {...props}
  />
);

export { Alert, AlertTitle, AlertDescription, AlertAction, alertVariants };
