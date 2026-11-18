import { useState } from "react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
      <Tabs
        value={view}
        onValueChange={setView}
        className="shrink-0 border-b px-3 py-2"
      >
        <TabsList aria-label="SVG view">
          <TabsTrigger value="preview">Preview</TabsTrigger>
          <TabsTrigger value="code">Code</TabsTrigger>
        </TabsList>
      </Tabs>
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
