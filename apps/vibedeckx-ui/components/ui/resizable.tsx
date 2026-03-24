"use client"

import { GripVertical } from "lucide-react"
import { Group, Panel, Separator } from "react-resizable-panels"
import type { GroupProps, SeparatorProps } from "react-resizable-panels"

import { cn } from "@/lib/utils"

const ResizablePanelGroup = ({
  className,
  direction,
  ...props
}: Omit<GroupProps, "orientation"> & { direction: "horizontal" | "vertical" }) => (
  <Group
    orientation={direction}
    className={cn(
      "flex h-full w-full",
      direction === "vertical" && "flex-col",
      className
    )}
    {...props}
  />
)

const ResizablePanel = Panel

const ResizableHandle = ({
  withHandle,
  className,
  ...props
}: SeparatorProps & {
  withHandle?: boolean
}) => (
  <Separator
    className={cn(
      "relative flex w-px items-center justify-center bg-border/60 after:absolute after:inset-y-0 after:-left-1 after:-right-1 after:content-[''] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1",
      className
    )}
    {...props}
  >
    {withHandle && (
      <div className="z-10 flex h-4 w-3 items-center justify-center rounded-sm border bg-border">
        <GripVertical className="h-2.5 w-2.5" />
      </div>
    )}
  </Separator>
)

export { ResizablePanelGroup, ResizablePanel, ResizableHandle }
