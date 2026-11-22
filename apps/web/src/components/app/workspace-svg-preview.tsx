import { useState } from "react";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@/components/ui/segmented-control";
import { FilesTextPreview } from "./files-text-preview";

export function WorkspaceSvgPreview({
  preview,
  fileName,
}: {
  preview: { src: string; text: string };
  fileName: string;
}) {
  const [view, setView] = useState("preview");
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SegmentedControl
        aria-label="SVG view"
        value={view}
        onValueChange={setView}
        className="m-2 shrink-0 self-start"
      >
        <SegmentedControlItem value="preview">Preview</SegmentedControlItem>
        <SegmentedControlItem value="code">Code</SegmentedControlItem>
      </SegmentedControl>
      {view === "preview" ? (
        <div className="grid min-h-0 flex-1 place-items-center overflow-auto p-6">
          <img
            src={preview.src}
            alt={fileName}
            className="max-h-full w-full max-w-lg object-contain"
          />
        </div>
      ) : (
        <FilesTextPreview text={preview.text} fileName={fileName} />
      )}
    </div>
  );
}
