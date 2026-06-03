import * as React from "react";

import { cn } from "~/lib/utils";

/**
 * Tiny modal primitive. We don't use @radix-ui/react-dialog because its CJS
 * dependency chain (react-remove-scroll → react-remove-scroll-bar/constants)
 * doesn't resolve cleanly through Deno's flat node_modules/.deno layout.
 *
 * Intentionally minimal: no focus trap, no Escape-to-close, no portal — the
 * single modal in this app has no close affordance anyway (it transitions
 * "throwing" → "delivered" and the user navigates out via the CTA).
 */
export function Modal({
  open,
  children,
  className,
}: {
  open: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  // Avoid background scrolling while the modal is open without dragging in a
  // helper library.
  React.useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="fade-in-0 animate-in fixed inset-0 bg-black/50" aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        className={cn(
          "fade-in-0 zoom-in-95 relative z-10 grid w-full max-w-lg gap-4 rounded-lg border border-border bg-background p-6 shadow-lg animate-in",
          className,
        )}
      >
        {children}
      </div>
    </div>
  );
}

export function ModalHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("flex flex-col gap-2 text-center", className)} {...props} />;
}

export function ModalTitle({ className, ...props }: React.ComponentProps<"h2">) {
  return (
    <h2
      className={cn("font-grotesque font-semibold text-lg leading-none", className)}
      {...props}
    />
  );
}

export function ModalDescription({ className, ...props }: React.ComponentProps<"p">) {
  return <p className={cn("text-muted-foreground text-sm", className)} {...props} />;
}
