import * as React from "react";
import { cn } from "@/lib/utils";

export function Badge({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        "inline-flex min-h-7 items-center rounded-full bg-secondary px-3 text-xs font-semibold text-secondary-foreground",
        className
      )}
      {...props}
    />
  );
}
