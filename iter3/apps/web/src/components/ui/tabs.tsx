import * as React from "react";
import { cn } from "@/lib/utils";

export function TabsList({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex items-center gap-2", className)} {...props} />;
}

export function TabsTrigger({
  active,
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }) {
  return (
    <button
      className={cn(
        "min-h-10 rounded-full px-4 text-sm font-bold text-muted-foreground transition-colors",
        active && "bg-foreground text-background",
        className
      )}
      {...props}
    />
  );
}
